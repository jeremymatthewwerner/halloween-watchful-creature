import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGallery, galleryItems, parseLogText, scoreLine } from "../server/gallery.ts";
import { SessionLog } from "../server/logs.ts";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("costume gallery", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A day's log.txt written by the real SessionLog, with two greetings. */
  function fixtureLog(): string {
    dir = mkdtempSync(join(tmpdir(), "creature-gallery-"));
    let now = new Date(2026, 9, 31, 18, 0, 0);
    const log = new SessionLog(dir, "Test", () => now);
    const at = (h: number, m: number, s: number) => new Date(2026, 9, 31, h, m, s).getTime();
    log.start("engine live");
    log.server({ at: at(18, 0, 1), level: "info", text: "[vision] arrived in 900 ms: One visitor in a green dinosaur costume." });
    now = new Date(at(18, 0, 2));
    log.snapshot(PIXEL, "arrived", "One visitor in a green dinosaur costume with a sparkly tail.", undefined);
    // Conversation lines arrive a few seconds late, after the snapshot line, and out of order.
    log.conversation("creature", "Hello there!", at(18, 0, 0));
    log.conversation("visitor", "Trick or treat!", at(18, 0, 3));
    log.conversation("creature", "Wow, a green dinosaur with a sparkly tail! That tail is shining like the moon!", at(18, 0, 5));
    log.conversation("creature", "Take one piece, please. Happy haunting!", at(18, 0, 20));
    now = new Date(at(18, 10, 0));
    log.snapshot(PIXEL, "returned", "Two visitors: a witch with a purple hat\nand a tiny pumpkin.", "NEW");
    log.conversation("creature", "A witch in a purple hat and a tiny pumpkin! You two are a magic pair!", at(18, 10, 4));
    // Much later: too far from any snapshot to count.
    log.conversation("creature", "A witch! Purple hat! Tiny pumpkin! So good!", at(18, 30, 0));
    return readFileSync(join(dir, "2026-10-31", "log.txt"), "utf8");
  }

  it("parses log.txt lines, joining continuation lines", () => {
    const lines = parseLogText(fixtureLog());
    expect(lines[0]).toMatchObject({ time: "18:00:00", tag: "=====" });
    const snap = lines.filter((l) => l.tag === "snapshot");
    expect(snap).toHaveLength(2);
    expect(snap[1]!.text).toContain("purple hat\nand a tiny pumpkin");
  });

  it("pairs each snapshot with its caption and the creature's best nearby line", () => {
    const items = galleryItems(fixtureLog());
    expect(items).toEqual([
      {
        time: "18:00:02",
        file: "snapshots/18-00-02-arrived.png",
        label: "arrived",
        verdict: undefined,
        caption: "One visitor in a green dinosaur costume with a sparkly tail.",
        line: "Wow, a green dinosaur with a sparkly tail! That tail is shining like the moon!",
      },
      {
        time: "18:10:00",
        file: "snapshots/18-10-00-returned.png",
        label: "returned",
        verdict: "NEW",
        caption: "Two visitors: a witch with a purple hat\nand a tiny pumpkin.",
        line: "A witch in a purple hat and a tiny pumpkin! You two are a magic pair!",
      },
    ]);
  });

  it("prefers lines about the costume over short hellos", () => {
    const caption = "A knight with a silver shield.";
    expect(scoreLine("What a shiny silver shield, brave knight!", caption)).toBeGreaterThan(scoreLine("Hi!", caption));
    expect(scoreLine("Hello there, welcome to my porch tonight!", caption)).toBeLessThan(scoreLine("Sir knight, that shield gleams!", caption));
  });

  it("ignores the creature's rehearsal lines", () => {
    const items = galleryItems(
      "19:00:00 snapshot snapshots/19-00-00-manual.jpg  manual One ghost in a white sheet.\n" +
        "19:00:05 creature [REHEARSAL] What a spooky ghost in a white sheet, wow!\n" +
        "19:00:09 creature Boo to you too!\n",
    );
    expect(items[0]!.line).toBe("Boo to you too!");
  });

  it("leaves the line out when the creature said nothing near a snapshot", () => {
    const items = galleryItems("19:00:00 snapshot snapshots/19-00-00-manual.jpg  manual One ghost.\n19:05:00 creature Much later.\n");
    expect(items).toHaveLength(1);
    expect(items[0]!.line).toBeUndefined();
  });

  it("builds a page with escaped text, images that exist and a privacy note", () => {
    const logText = fixtureLog() + "18:20:00 snapshot snapshots/18-20-00-manual.jpg  manual A <script>alert(1)</script> costume.\n";
    const html = buildGallery({ day: "2026-10-31", logText, snapshots: new Set(["snapshots/18-00-02-arrived.png", "snapshots/18-10-00-returned.png"]) });
    expect(html).toContain("Family only");
    expect(html).toContain("other people's kids");
    expect(html).toContain('<img src="snapshots/18-00-02-arrived.png"');
    expect(html).toContain("Came back · someone new");
    expect(html).toContain("A &lt;script&gt;alert(1)&lt;/script&gt; costume.");
    expect(html).not.toContain("<script>alert");
    // The third snapshot's file is missing: it shows without a photo.
    expect(html).not.toContain('src="snapshots/18-20-00-manual.jpg"');
    expect(html).toContain("photo not saved");
    expect(html).toContain("3 greetings");
    expect(html).not.toMatch(/share\(|navigator\.share|upload/i);
  });

  it("shows words only when snapshots are turned off, and says when there's nothing yet", () => {
    const off = buildGallery({ day: "2026-10-31", logText: fixtureLog(), snapshots: null });
    expect(off).not.toContain("<img");
    expect(off).toContain("LOG_SNAPSHOTS=false");
    expect(off).toContain("A witch in a purple hat");
    expect(buildGallery({ day: "2026-10-31", logText: "18:00:00 ===== server started: x\n", snapshots: new Set() })).toContain("No costume snapshots");
  });
});
