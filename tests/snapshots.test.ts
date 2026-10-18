import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLog } from "../server/logs.ts";
import { deleteAllSnapshots, pruneSnapshots, startRetention } from "../server/snapshots.ts";
import { DEFAULT_RETENTION_DAYS, dayAge, isExpired, parseRetentionDays, parseSnapshotsSwitch, snapshotPolicy } from "../shared/snapshots.ts";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("snapshot settings", () => {
  it("parses SNAPSHOT_RETENTION_DAYS: a week by default, 0 or off keeps photos forever", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(7);
    expect(parseRetentionDays(undefined)).toBe(7);
    expect(parseRetentionDays("  ")).toBe(7);
    expect(parseRetentionDays("14")).toBe(14);
    expect(parseRetentionDays(" 1 ")).toBe(1);
    expect(parseRetentionDays("0")).toBe(0);
    expect(parseRetentionDays("off")).toBe(0);
    expect(parseRetentionDays("OFF")).toBe(0);
    for (const bad of ["-1", "1.5", "a week", "7d"]) expect(() => parseRetentionDays(bad), bad).toThrow(/SNAPSHOT_RETENTION_DAYS/);
  });

  it("parses SNAPSHOTS, and the older LOG_SNAPSHOTS=false still turns them off", () => {
    expect(parseSnapshotsSwitch(undefined, undefined)).toBe(true);
    expect(parseSnapshotsSwitch("on", undefined)).toBe(true);
    expect(parseSnapshotsSwitch("off", undefined)).toBe(false);
    expect(parseSnapshotsSwitch(" Off ", "true")).toBe(false);
    expect(parseSnapshotsSwitch("false", undefined)).toBe(false);
    expect(parseSnapshotsSwitch(undefined, "false")).toBe(false);
    // Either one saying off wins.
    expect(parseSnapshotsSwitch("on", "false")).toBe(false);
    expect(() => parseSnapshotsSwitch("sometimes", undefined)).toThrow(/SNAPSHOTS must be on or off/);
  });

  it("describes the policy for the dashboard and the log", () => {
    expect(snapshotPolicy(false, 7)).toBe("snapshots off");
    expect(snapshotPolicy(true, 7)).toBe("snapshots on, kept 7 days");
    expect(snapshotPolicy(true, 1)).toBe("snapshots on, kept 1 day");
    expect(snapshotPolicy(true, 0)).toBe("snapshots on, kept until you delete them");
  });
});

describe("retention boundaries", () => {
  // Nov 1, 2026 is when US clocks fall back: the count must not care.
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

  it("counts whole calendar days, not hours", () => {
    expect(dayAge("2026-10-31", at(2026, 10, 31, 0))).toBe(0);
    expect(dayAge("2026-10-31", at(2026, 10, 31, 23))).toBe(0);
    expect(dayAge("2026-10-31", at(2026, 11, 1, 0))).toBe(1);
    expect(dayAge("2026-10-31", at(2026, 11, 7, 23))).toBe(7);
    expect(dayAge("2026-12-31", at(2027, 1, 1))).toBe(1);
    expect(dayAge("2026-11-02", at(2026, 10, 31))).toBe(-2);
  });

  it("ignores folder names that aren't real dates", () => {
    for (const day of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-10-32", "26-10-31", "2026-10-31x", "../2026-10-31"]) {
      expect(dayAge(day, at(2030, 1, 1)), day).toBeNull();
      expect(isExpired(day, 1, at(2030, 1, 1)), day).toBe(false);
    }
  });

  it("keeps Halloween's photos through Nov 7 with 7 days, and removes them on Nov 8", () => {
    expect(isExpired("2026-10-31", 7, at(2026, 10, 31))).toBe(false);
    expect(isExpired("2026-10-31", 7, at(2026, 11, 7, 23))).toBe(false);
    expect(isExpired("2026-10-31", 7, at(2026, 11, 8, 0))).toBe(true);
    // 1 day: yesterday's photos stay, the day before's go.
    expect(isExpired("2026-10-31", 1, at(2026, 11, 1))).toBe(false);
    expect(isExpired("2026-10-31", 1, at(2026, 11, 2))).toBe(true);
    // A clock set wrong (a folder from the future) never counts as old.
    expect(isExpired("2027-10-31", 1, at(2026, 11, 2))).toBe(false);
  });

  it("never expires anything with 0 (keep forever)", () => {
    expect(isExpired("2000-01-01", 0, at(2026, 11, 8))).toBe(false);
    expect(isExpired("2000-01-01", -3, at(2026, 11, 8))).toBe(false);
  });
});

describe("pruning old snapshots", () => {
  let base = "";
  afterEach(() => {
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  /** A log dir with real SessionLog days: Halloween (2 photos) and Nov 6 (1 photo). */
  function fixture() {
    base = mkdtempSync(join(tmpdir(), "creature-snapshots-"));
    const dir = join(base, "logs");
    let now = new Date(2026, 9, 31, 18, 0, 0);
    const log = new SessionLog(dir, "Test", () => now);
    log.snapshot(PIXEL, "arrived", "A dinosaur.");
    now = new Date(2026, 9, 31, 18, 5, 0);
    log.snapshot(PIXEL, "grew", "A dinosaur and a <witch>.", "NEW");
    log.conversation("creature", "Roar-some!", now.getTime());
    now = new Date(2026, 10, 6, 19, 0, 0);
    log.snapshot(PIXEL, "manual", "A ghost.");
    const read = (day: string, file: string) => readFileSync(join(dir, day, file), "utf8");
    return { dir, read };
  }

  it("removes only the photos of days past the retention, keeping log.txt and marking log.html", () => {
    const { dir, read } = fixture();
    const txtBefore = read("2026-10-31", "log.txt");
    const recentHtml = read("2026-11-06", "log.html");
    expect(pruneSnapshots(dir, 7, new Date(2026, 10, 7, 23, 59))).toEqual({ days: [], files: 0 });
    expect(readdirSync(join(dir, "2026-10-31", "snapshots"))).toHaveLength(2);

    expect(pruneSnapshots(dir, 7, new Date(2026, 10, 8, 0, 1))).toEqual({ days: ["2026-10-31"], files: 2 });
    expect(readdirSync(join(dir, "2026-10-31", "snapshots"))).toEqual([]);
    expect(read("2026-10-31", "log.txt")).toBe(txtBefore);
    const html = read("2026-10-31", "log.html");
    expect(html).not.toContain('<img src="snapshots/');
    expect(html).not.toContain('href="snapshots/');
    expect(html.match(/📷 photo removed after 7 days/g)).toHaveLength(2);
    // The captions and the rest of the log stay.
    expect(html).toContain("A dinosaur and a &lt;witch&gt;.");
    expect(html).toContain("Roar-some!");
    // The newer day is untouched.
    expect(readdirSync(join(dir, "2026-11-06", "snapshots"))).toEqual(["19-00-00-manual.png"]);
    expect(read("2026-11-06", "log.html")).toBe(recentHtml);

    // Running again (the next day) finds nothing new and leaves the files alone.
    expect(pruneSnapshots(dir, 7, new Date(2026, 10, 9))).toEqual({ days: [], files: 0 });
    expect(read("2026-10-31", "log.html")).toBe(html);
  });

  it("keeps everything forever with 0", () => {
    const { dir } = fixture();
    expect(pruneSnapshots(dir, 0, new Date(2036, 0, 1))).toEqual({ days: [], files: 0 });
    expect(readdirSync(join(dir, "2026-10-31", "snapshots"))).toHaveLength(2);
    const stop = startRetention(dir, 0, { log: () => {}, warn: () => {} });
    stop();
    expect(readdirSync(join(dir, "2026-10-31", "snapshots"))).toHaveLength(2);
  });

  it("does nothing when there's no log folder yet", () => {
    base = mkdtempSync(join(tmpdir(), "creature-snapshots-"));
    expect(pruneSnapshots(join(base, "missing"), 7)).toEqual({ days: [], files: 0 });
    expect(deleteAllSnapshots(join(base, "missing"))).toEqual({ days: [], files: 0 });
  });

  it("deletes every photo, today's included, for the dashboard's button", () => {
    const { dir, read } = fixture();
    const txt = read("2026-11-06", "log.txt");
    expect(deleteAllSnapshots(dir)).toEqual({ days: ["2026-10-31", "2026-11-06"], files: 3 });
    expect(readdirSync(join(dir, "2026-11-06", "snapshots"))).toEqual([]);
    expect(read("2026-11-06", "log.txt")).toBe(txt);
    expect(read("2026-11-06", "log.html")).toContain("📷 photo deleted");
    expect(read("2026-11-06", "log.html")).not.toContain("<img");
    // Today's log keeps working afterwards.
    const log = new SessionLog(dir, "Test", () => new Date(2026, 10, 6, 20, 0, 0));
    expect(log.snapshot(PIXEL, "arrived", "A robot.")).toBe("snapshots/20-00-00-arrived.png");
    expect(read("2026-11-06", "log.html")).toContain('<img src="snapshots/20-00-00-arrived.png"');
  });

  it("runs at start and then daily, and logs what it removed", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 7, 12) });
    const { dir } = fixture();
    const lines: string[] = [];
    const stop = startRetention(dir, 7, { log: (t: string) => lines.push(t), warn: (t: string) => lines.push(`warn ${t}`) }, 1000);
    expect(lines).toEqual([]);
    vi.setSystemTime(new Date(2026, 10, 8, 12));
    vi.advanceTimersByTime(1000);
    expect(lines).toEqual(["[privacy] removed 2 snapshots older than 7 days (2026-10-31)"]);
    vi.setSystemTime(new Date(2026, 10, 14, 12));
    vi.advanceTimersByTime(1000);
    expect(lines).toEqual(["[privacy] removed 2 snapshots older than 7 days (2026-10-31)", "[privacy] removed 1 snapshot older than 7 days (2026-11-06)"]);
    stop();
  });
});

describe("path safety", () => {
  let base = "";
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (path: string, content = "keep me") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  /** Every file under `root` (following no links) with its content, to compare before and after. */
  function listing(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(root, p)] = e.isSymbolicLink() ? "(link)" : readFileSync(p, "utf8");
      }
    };
    walk(root);
    return out;
  }

  it("deletes only snapshot-named regular files in real day folders inside the log dir", () => {
    base = mkdtempSync(join(tmpdir(), "creature-safety-"));
    const logs = join(base, "logs");
    const outside = join(base, "outside");
    // Outside the log dir: a folder that looks just like a day, and a lone photo.
    put(join(outside, "snapshots", "18-00-00-arrived.jpg"));
    put(join(outside, "18-00-00-arrived.jpg"));
    put(join(outside, "log.html"), '<a href="snapshots/18-00-00-arrived.jpg" target="_blank"><img src="snapshots/18-00-00-arrived.jpg" alt="x"></a>');
    put(join(base, "18-00-00-arrived.jpg"));

    // The one file that should go.
    const doomed = join(logs, "2020-01-01", "snapshots", "18-00-00-arrived.jpg");
    put(doomed, "old photo");
    // Same old day, but not snapshot files.
    put(join(logs, "2020-01-01", "snapshots", "notes.txt"));
    put(join(logs, "2020-01-01", "snapshots", "18-00-00-arrived.jpg.bak"));
    put(join(logs, "2020-01-01", "snapshots", "portrait.jpg"));
    put(join(logs, "2020-01-01", "snapshots", "18-00-00-dir.jpg", "18-00-00-inner.jpg")); // a folder named like a photo
    put(join(logs, "2020-01-01", "18-00-00-arrived.jpg")); // not in snapshots/
    put(join(logs, "2020-01-01", "log.txt"), "18:00:00 snapshot snapshots/18-00-00-arrived.jpg  arrived A cat.\n");
    symlinkSync(join(outside, "18-00-00-arrived.jpg"), join(logs, "2020-01-01", "snapshots", "18-00-01-link.jpg"));
    // Folders that aren't real, valid day folders.
    put(join(logs, "not-a-day", "snapshots", "18-00-00-arrived.jpg"));
    put(join(logs, "2020-13-45", "snapshots", "18-00-00-arrived.jpg"));
    put(join(logs, "18-00-00-arrived.jpg"));
    symlinkSync(outside, join(logs, "2020-01-02")); // a day folder that's a link out
    mkdirSync(join(logs, "2020-01-03"));
    symlinkSync(join(outside, "snapshots"), join(logs, "2020-01-03", "snapshots")); // snapshots/ that's a link out
    mkdirSync(join(logs, "2020-01-04", "snapshots"), { recursive: true });
    symlinkSync(join(outside, "log.html"), join(logs, "2020-01-04", "log.html")); // log.html that's a link out

    const before = listing(base);
    // Reach the log dir through a "..": it's resolved first, and still only its own days count.
    expect(pruneSnapshots(join(logs, "..", "logs"), 1, new Date(2026, 9, 31))).toEqual({ days: ["2020-01-01"], files: 1 });
    const after = listing(base);
    expect(existsSync(doomed)).toBe(false);
    const gone = Object.keys(before).filter((p) => !(p in after));
    expect(gone).toEqual([relative(base, doomed)]);
    for (const [p, content] of Object.entries(after)) expect(content, p).toBe(before[p]);

    // Deleting all also leaves everything but snapshot files in real day folders alone. The
    // 2020-13-45 folder is named like a day, so its photo goes too; nothing outside does.
    expect(deleteAllSnapshots(logs)).toEqual({ days: ["2020-13-45"], files: 1 });
    const final = listing(base);
    expect(Object.keys(after).filter((p) => !(p in final))).toEqual([join("logs", "2020-13-45", "snapshots", "18-00-00-arrived.jpg")]);
    expect(readFileSync(join(outside, "log.html"), "utf8")).toContain('<img src="snapshots/18-00-00-arrived.jpg"');
    expect(readFileSync(join(outside, "snapshots", "18-00-00-arrived.jpg"), "utf8")).toBe("keep me");
  });

  it("does nothing when the log dir is a file", () => {
    base = mkdtempSync(join(tmpdir(), "creature-safety-"));
    put(join(base, "logs"), "not a folder");
    expect(deleteAllSnapshots(join(base, "logs"))).toEqual({ days: [], files: 0 });
    expect(readFileSync(join(base, "logs"), "utf8")).toBe("not a folder");
  });
});
