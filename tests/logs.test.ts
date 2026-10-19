import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LogBuffer, SessionLog, captureConsole, logEventId, wantsSnapshot } from "../server/logs.ts";
import { Transcript } from "../web/transcript.ts";

describe("LogBuffer", () => {
  it("keeps the most recent lines and notifies subscribers", () => {
    const logs = new LogBuffer(3, "boot1");
    const seen: string[] = [];
    const unsubscribe = logs.subscribe((e) => seen.push(e.text));
    for (const text of ["a", "b", "c", "d"]) logs.push("info", text);
    unsubscribe();
    logs.push("info", "e");
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(logs.since().map((e) => e.text)).toEqual(["c", "d", "e"]);
  });

  it("replays only unseen lines to a reconnecting client, and everything after a restart", () => {
    const logs = new LogBuffer(10, "boot2");
    const [a] = [logs.push("info", "a"), logs.push("warn", "b")];
    expect(logs.since(logEventId(a!)).map((e) => e.text)).toEqual(["b"]);
    expect(logs.since("old-boot:1").map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("survives a subscriber that throws", () => {
    const logs = new LogBuffer();
    logs.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => logs.push("info", "still fine")).not.toThrow();
  });
});

describe("captureConsole", () => {
  it("mirrors console output into the buffer and restores the console", () => {
    const printed: unknown[][] = [];
    const fake = { log: (...a: unknown[]) => printed.push(a), info: () => {}, warn: () => {}, error: () => {} } as unknown as Console;
    const logs = new LogBuffer();
    const restore = captureConsole(logs, fake);
    fake.log("[vision] took %d ms", 42);
    fake.error(new Error("bad"));
    restore();
    fake.log("after restore");
    expect(printed[0]).toEqual(["[vision] took %d ms", 42]);
    const entries = logs.since();
    expect(entries.map((e) => e.level)).toEqual(["info", "error"]);
    expect(entries[0]!.text).toBe("[vision] took 42 ms");
    expect(entries[1]!.text).toContain("Error: bad");
  });

  it("doesn't loop when a subscriber logs", () => {
    const fake = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Console;
    const logs = new LogBuffer();
    const restore = captureConsole(logs, fake);
    logs.subscribe((e) => fake.log(`echo ${e.text}`));
    fake.log("hi");
    restore();
    expect(logs.since().map((e) => e.text)).toEqual(["hi"]);
  });
});

describe("SessionLog", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes server lines, conversation and snapshots to one log per day, across restarts", () => {
    dir = mkdtempSync(join(tmpdir(), "creature-log-"));
    const at = new Date(2026, 9, 31, 18, 5, 9);
    const first = new SessionLog(dir, "Test", () => at);
    first.start("engine live");
    first.server({ at: at.getTime(), level: "warn", text: "[vision] slow <b>" });
    first.conversation("visitor", "Trick or treat!", at.getTime());
    first.conversation("creature", "Magnifique!", at.getTime());
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const name = first.snapshot(pixel, "returned", "One visitor in a top hat.", "NEW");
    expect(first.snapshot("data:text/html;base64,AAAA", "arrived", "nope")).toBeNull();
    // A restart the same day appends to the same files.
    new SessionLog(dir, "Test", () => at).start("restarted");

    const day = join(dir, "2026-10-31");
    expect(name).toBe("snapshots/18-05-09-returned.png");
    expect(existsSync(join(day, name!))).toBe(true);
    expect(readdirSync(join(day, "snapshots"))).toHaveLength(1);
    const txt = readFileSync(join(day, "log.txt"), "utf8");
    expect(txt).toContain("18:05:09 visitor  Trick or treat!");
    expect(txt).toContain("18:05:09 creature Magnifique!");
    expect(txt).toContain("snapshot snapshots/18-05-09-returned.png  returned [NEW] One visitor in a top hat.");
    expect(txt.match(/server started/g)).toHaveLength(2);
    const html = readFileSync(join(day, "log.html"), "utf8");
    expect(html.match(/<!doctype html>/g)).toHaveLength(1);
    expect(html).toContain('<a href="snapshots/18-05-09-returned.png" target="_blank"><img src="snapshots/18-05-09-returned.png"');
    expect(html).toContain("[vision] slow &lt;b&gt;");
  });
});

describe("SessionLog with snapshots off", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("logs the caption of a look but writes no photo", () => {
    dir = mkdtempSync(join(tmpdir(), "creature-log-"));
    const log = new SessionLog(dir, "Test", () => new Date(2026, 9, 31, 18, 5, 9));
    log.look("arrived", "One visitor in a <ninja> costume.", "NEW");
    const day = join(dir, "2026-10-31");
    expect(readdirSync(join(day, "snapshots"))).toEqual([]);
    expect(readFileSync(join(day, "log.txt"), "utf8")).toContain("18:05:09 look     arrived [NEW] One visitor in a <ninja> costume.");
    const html = readFileSync(join(day, "log.html"), "utf8");
    expect(html).toContain("📷 snapshots off");
    expect(html).toContain("One visitor in a &lt;ninja&gt; costume.");
    expect(html).not.toContain("<img");
  });
});

describe("rehearsal in the log", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("marks rehearsal conversation lines", () => {
    dir = mkdtempSync(join(tmpdir(), "creature-log-"));
    const at = new Date(2026, 9, 31, 18, 5, 9);
    const log = new SessionLog(dir, "Test", () => at);
    log.conversation("creature", "Real hello!", at.getTime());
    log.conversation("creature", "Pretend hello!", at.getTime(), true);
    const txt = readFileSync(join(dir, "2026-10-31", "log.txt"), "utf8");
    expect(txt).toContain("18:05:09 creature Real hello!");
    expect(txt).toContain("18:05:09 creature [REHEARSAL] Pretend hello!");
    const html = readFileSync(join(dir, "2026-10-31", "log.html"), "utf8");
    expect(html).toContain('<div class="row creature rehearsal"><time>18:05:09</time><span class="text">[REHEARSAL] Pretend hello!</span>');
  });

  it("saves snapshots of greetings and new looks, never of rehearsal frames", () => {
    expect(wantsSnapshot("arrived", undefined)).toBe(true);
    expect(wantsSnapshot("background", "CHANGED")).toBe(true);
    expect(wantsSnapshot("recheck", "NEW")).toBe(true);
    expect(wantsSnapshot("background", "SAME")).toBe(false);
    expect(wantsSnapshot("arrived", undefined, true)).toBe(false);
    expect(wantsSnapshot("recheck", "NEW", true)).toBe(false);
  });
});

describe("Transcript.takeFinished", () => {
  it("returns notes at once and speech after a pause, each only once", () => {
    const t = new Transcript(2500);
    t.add("system", "Visitors arrived (1)", 0);
    t.add("creature", "Bonsoir, ", 100);
    t.add("creature", "mes amis!", 1000);
    expect(t.takeFinished(1500).map((l) => l.text)).toEqual(["Visitors arrived (1)"]);
    expect(t.takeFinished(3400)).toEqual([]);
    const [line] = t.takeFinished(3500);
    expect(line).toMatchObject({ who: "creature", text: "Bonsoir, mes amis!", start: 100 });
    t.add("visitor", "I'm a wiz", 4000);
    expect(t.takeFinished(4100, true).map((l) => l.text)).toEqual(["I'm a wiz"]);
    expect(t.takeFinished(99999, true)).toEqual([]);
  });
});
