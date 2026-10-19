import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NtfyNotifier, type Notifier } from "../server/alerts.ts";
import { RemoteAuth, SESSION_COOKIE, checkAccess, isLoopback, listenHost } from "../server/auth.ts";
import { SessionLog } from "../server/logs.ts";
import {
  NightRecapPush,
  RECAP_SENT_FILE,
  buildRecap,
  buildRecapData,
  duration,
  eveningDay,
  halfHourLabel,
  headline,
  installRecap,
  parseRecapAt,
  peopleInCaption,
  phoneBaseUrl,
  shortName,
  visitorGroups,
} from "../server/recap.ts";
import { parseLogText } from "../server/gallery.ts";
import { Remote } from "../server/remote.ts";

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DAY = "2026-10-31";
const PIN = "271828";

const WITCH_AND_DINO = "Two visitors: a witch with a purple hat (standout: a broom with glowing bristles) and a green dinosaur (standout: a sparkly tinsel tail).";
const ASTRONAUTS = "Three visitors: an astronaut (standout: a helmet with blinking lights), a bumblebee (standout: wobbly antennae) and a knight (standout: a cardboard shield).";

let dir = "";
let snapshots: Set<string> = new Set();

/**
 * One night written by the real SessionLog: six real groups (one whose look failed), a costume
 * change and a same-group return that aren't new groups, a near-duplicate group, a rehearsal, and
 * a snapshot deleted afterwards.
 */
function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), "creature-recap-"));
  let now = new Date(2026, 9, 31, 17, 55, 0);
  const log = new SessionLog(dir, "Test", () => now);
  const at = (h: number, m: number, s = 0) => new Date(2026, 9, 31, h, m, s).getTime();
  const note = (h: number, m: number, s: number, text: string, rehearsal = false) => log.conversation("system", text, at(h, m, s), rehearsal);
  const vision = (h: number, m: number, s: number, text: string) => log.server({ at: at(h, m, s), level: "info", text: `[vision] ${text}` });
  const snap = (h: number, m: number, s: number, label: string, caption: string, verdict?: string) => {
    now = new Date(at(h, m, s));
    log.snapshot(PIXEL, label, caption, verdict);
  };
  log.start("engine live");

  note(18, 0, 0, "Voice session open");
  note(18, 0, 1, "Visitors arrived (2)");
  vision(18, 0, 3, `arrived in 900 ms: ${WITCH_AND_DINO}`);
  snap(18, 0, 3, "arrived", WITCH_AND_DINO);
  log.conversation("creature", "Hi there!", at(18, 0, 2));
  log.conversation("creature", "A witch with a broom of glowing bristles and a dinosaur with a sparkly tinsel tail! Gold medals all round!", at(18, 0, 6));
  // Same kids, new hat: a snapshot, but not a new group.
  vision(18, 1, 30, "background (CHANGED) in 800 ms: CHANGED: the witch now wears a pumpkin hat (standout: a pumpkin hat).");
  snap(18, 1, 30, "background", "CHANGED: the witch now wears a pumpkin hat (standout: a pumpkin hat).", "CHANGED");
  note(18, 3, 0, "Visitors left");
  note(18, 6, 0, "Voice session closed");

  // The look failed (no vision line), but the detector saw one visitor.
  note(18, 40, 0, "Voice session open");
  note(18, 40, 2, "Visitors arrived (1)");
  note(18, 44, 0, "Voice session closed");

  note(19, 5, 0, "Voice session open");
  note(19, 5, 1, "Visitors arrived (3)");
  vision(19, 5, 3, `arrived in 900 ms: ${ASTRONAUTS}`);
  snap(19, 5, 3, "arrived", ASTRONAUTS);
  log.conversation("creature", "An astronaut with a blinking helmet, a wobbly bumblebee and a brave knight! Three thumbs up, and I don't even have thumbs!", at(19, 5, 8));
  note(19, 6, 0, "More visitors (3 → 5)");
  vision(19, 6, 2, "grew in 900 ms: Five visitors: an astronaut, a bumblebee, a knight, and two new ghosts (standout: floaty sheets).");
  snap(19, 6, 2, "grew", "Five visitors: an astronaut, a bumblebee, a knight, and two new ghosts (standout: floaty sheets).");
  vision(19, 12, 0, "returned (NEW) in 900 ms: NEW: One visitor in a ghost sheet (standout: glow-in-the-dark eyes).");
  snap(19, 12, 0, "returned", "NEW: One visitor in a ghost sheet (standout: glow-in-the-dark eyes).", "NEW");
  log.conversation("creature", "Ooh, a ghost with glow-in-the-dark eyes! Spooky-cute, ten out of ten!", at(19, 12, 4));
  vision(19, 20, 0, "returned (SAME) in 900 ms: SAME: One visitor in a ghost sheet (standout: glow-in-the-dark eyes).");
  snap(19, 20, 0, "returned", "SAME: One visitor in a ghost sheet (standout: glow-in-the-dark eyes).", "SAME");
  // The witch and the dinosaur, back after a while: a group again, but not a second top costume.
  note(19, 25, 0, "Visitors arrived (2)");
  vision(19, 25, 2, `arrived in 900 ms: ${WITCH_AND_DINO}`);
  snap(19, 25, 2, "arrived", WITCH_AND_DINO);
  note(19, 28, 0, "Voice session closed");

  // Rehearsal: none of this counts.
  note(19, 40, 0, "Voice session open", true);
  note(19, 40, 1, "Visitors arrived (4)", true);
  vision(19, 40, 3, "[REHEARSAL] arrived in 900 ms: Four visitors: four pirates (standout: a parrot made of socks).");
  log.conversation("creature", "Four pirates with a parrot made of socks! Arr, what a crew of fine pirates you are!", at(19, 40, 6), true);
  note(19, 45, 0, "Voice session closed", true);

  note(19, 50, 0, "Kill switch: asleep until you press Wake");

  // A snapshot deleted since (retention, or by hand).
  rmSync(join(dir, DAY, "snapshots", "19-12-00-returned.png"));
  snapshots = new Set(["snapshots/18-00-03-arrived.png", "snapshots/18-01-30-background.png", "snapshots/19-05-03-arrived.png", "snapshots/19-06-02-grew.png", "snapshots/19-20-00-returned.png", "snapshots/19-25-02-arrived.png"]);
  return readFileSync(join(dir, DAY, "log.txt"), "utf8");
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("night recap stats", () => {
  it("counts groups and people, leaving out rehearsals, changes and same-group returns", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    expect(r.groups.map((g) => [g.time, g.kind, g.people, g.counted])).toEqual([
      ["18:00:01", "arrived", 2, "detector"],
      ["18:40:02", "arrived", 1, "detector"], // its look failed, still a visitor
      ["19:05:01", "arrived", 3, "detector"],
      ["19:06:00", "joined", 2, "detector"], // 3 → 5
      ["19:12:00", "new", 1, "description"],
      ["19:25:00", "arrived", 2, "detector"],
    ]);
    expect(r.people).toBe(11);
  });

  it("finds the busiest half hour and fills the chart's empty half hours", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    expect(r.halfHours.map((h) => [halfHourLabel(h.start), h.groups])).toEqual([
      ["6:00–6:30 pm", 1],
      ["6:30–7:00 pm", 1],
      ["7:00–7:30 pm", 4],
    ]);
    expect(r.busiest).toMatchObject({ groups: 4, people: 8 });
    expect(halfHourLabel(r.busiest!.start)).toBe("7:00–7:30 pm");
    expect(halfHourLabel(11 * 3600 + 1800)).toBe("11:30 am–12:00 pm");
  });

  it("adds up awake time from voice sessions (not rehearsal ones) and the time on duty", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    expect(r.awakeSeconds).toBe((6 + 4 + 23) * 60);
    expect(r.voiceSessions).toBe(3);
    expect(r.onDuty).toEqual({ from: 18 * 3600, to: 19 * 3600 + 50 * 60 });
    expect(r.asleepAt).toBe(19 * 3600 + 50 * 60);
    expect(duration(r.awakeSeconds)).toBe("33 min");
    expect(duration(6120)).toBe("1 h 42 min");
  });

  it("an open voice session ends at a server restart", () => {
    const text = ["18:00:00 note     Voice session open", "18:10:00 server   still going", "18:30:00 ===== server started: engine live", "18:31:00 note     Visitors arrived (1)"].join("\n");
    expect(buildRecapData({ day: DAY, logText: text, snapshots: null }).awakeSeconds).toBe(600);
  });

  it("picks one standout costume per group, skipping near-duplicates and same-group snapshots", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    const files = r.costumes.map((c) => c.file);
    expect(files).toContain("snapshots/18-00-03-arrived.png");
    expect(files).toContain("snapshots/19-05-03-arrived.png");
    expect(files).toContain("snapshots/19-12-00-returned.png");
    // The costume change belongs to the first group, the SAME return to the ghost's, and the
    // witch and dinosaur back later are a near-duplicate of the first greeting.
    expect(files).not.toContain("snapshots/18-01-30-background.png");
    expect(files).not.toContain("snapshots/19-20-00-returned.png");
    expect(files).not.toContain("snapshots/19-25-02-arrived.png");
    const first = r.costumes.find((c) => c.file === "snapshots/18-00-03-arrived.png")!;
    expect(first.standouts).toEqual(["a broom with glowing bristles", "a sparkly tinsel tail"]);
    expect(first.line).toMatch(/glowing bristles/);
    // Photos still on disk come first.
    expect(r.costumes[r.costumes.length - 1]!.file).toBe("snapshots/19-12-00-returned.png");
  });

  it("handles a deleted snapshot with a placeholder, and photos turned off", () => {
    const logText = fixture();
    const page = buildRecap({ day: DAY, logText, snapshots });
    expect(page).not.toContain('src="/api/session-logs/2026-10-31/snapshots/19-12-00-returned.png"');
    expect(page).toContain("photo no longer saved");
    expect(page).toContain('src="/api/session-logs/2026-10-31/snapshots/18-00-03-arrived.png"');
    const off = buildRecap({ day: DAY, logText, snapshots: null });
    expect(off).not.toContain("<img");
    expect(off).toContain("photos are off");
  });

  it("keeps the best lines and never rehearsal ones", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.some((l) => /glowing bristles/.test(l.text))).toBe(true);
    expect(r.lines.some((l) => l.text === "Hi there!")).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/pirate|parrot|REHEARSAL/i);
  });

  it("reads people counts from descriptions", () => {
    expect(peopleInCaption("Two visitors: a witch and a ghost.")).toBe(2);
    expect(peopleInCaption("One visitor in a cape (standout: silver stars), another visitor as a cat (standout: a bell collar).")).toBe(2);
    expect(peopleInCaption("3 people in matching costumes.")).toBe(3);
    expect(peopleInCaption("Too dark to tell.")).toBe(1);
    // Without the note, a vision line still counts.
    const text = `18:00:03 server   [vision] arrived in 900 ms: ${ASTRONAUTS}`;
    expect(visitorGroups(parseLogText(text))).toMatchObject([{ kind: "arrived", people: 3, counted: "description" }]);
  });

  it("builds a page in the log's colors with the method explained and text escaped", () => {
    const page = buildRecap({ day: DAY, logText: `${fixture()}18:59:00 note     Visitors arrived (1)\n18:59:01 server   [vision] arrived in 9 ms: <script>alert(1)</script>\n`, snapshots, name: "Jacques" });
    expect(page).toContain("#120a1c");
    expect(page).toContain("#ff7a1a");
    expect(page).toContain("How these are counted");
    expect(page).toContain("Jacques's best lines");
    expect(page).toContain("7:00–7:30 pm");
    expect(page).not.toContain("<script>");
    expect(page).toContain("Family only");
  });

  it("says so when there were no visitors, even with rehearsals", () => {
    const page = buildRecap({ day: DAY, logText: "19:40:01 note     [REHEARSAL] Visitors arrived (4)\n", snapshots: null });
    expect(page).toContain("No visitors in this day's log (rehearsals don't count)");
  });

  it("writes a headline with numbers and times only", () => {
    const r = buildRecapData({ day: DAY, logText: fixture(), snapshots });
    expect(headline(r, "Jacques")).toBe("Jacques met 6 groups tonight (about 11 people), busiest 7:00–7:30 pm (4 groups). Awake 33 min.");
    expect(shortName("Jacques O'Lantern, Pumpkin Critic")).toBe("Jacques");
    expect(shortName("Sir Reginald Bonesworth, Skeleton Butler")).toBe("Sir Reginald");
  });
});

describe("recap page access", () => {
  function setup(pin: string) {
    const remote = new Remote({ remotePin: pin, ntfyTopic: "", ntfyServer: "", ntfyToken: "", arduinoEnabled: false, production: false, bodyStatus: () => "none", todayLogUrl: () => null, recapUrl: () => "/recap" });
    const app = new Hono();
    remote.install(app);
    installRecap(app, { logDir: dir, logSnapshots: true, now: () => new Date(2026, 10, 1, 9, 0) });
    const call = (path: string, from: string, headers: Record<string, string> = {}) => {
      const h = new Headers(headers);
      if (!h.has("host")) h.set("host", isLoopback(from) ? "localhost:8787" : "192.168.1.5:8787");
      return app.request(path, { headers: h }, { incoming: { socket: { remoteAddress: from } } });
    };
    return { remote, call };
  }
  beforeEach(() => void fixture());

  it("serves the local dashboard without a PIN, and /recap goes to last night", async () => {
    const { call, remote } = setup("");
    const res = await call(`/recap/${DAY}`, "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Top costumes");
    const latest = await call("/recap", "127.0.0.1");
    expect(latest.status).toBe(302);
    expect(latest.headers.get("location")).toBe(`/recap/${DAY}`);
    expect((await call("/recap/2026-11-02", "127.0.0.1")).status).toBe(404);
    expect((await call("/recap/..%2F..%2Fetc", "127.0.0.1")).status).toBe(404);
    expect(remote.snapshot().links.recap).toBe("/recap");
  });

  it("is never served to another device without REMOTE_PIN (and the server stays on loopback)", async () => {
    const { call } = setup("");
    for (const path of [`/recap/${DAY}`, "/recap"]) {
      const res = await call(path, "192.168.1.23");
      expect(res.status).toBe(403);
      expect(await res.text()).not.toMatch(/witch|snapshots\//);
    }
    // Through the dev proxy from another device.
    expect((await call(`/recap/${DAY}`, "127.0.0.1", { "x-forwarded-for": "192.168.1.23" })).status).toBe(403);
    expect(listenHost({ pinSet: false }).host).toBe("127.0.0.1");
    expect(listenHost({ HOST: "0.0.0.0", pinSet: false }).host).toBe("127.0.0.1");
  });

  it("sends a phone that isn't signed in to the PIN page, and shows a signed-in phone the recap", async () => {
    const { call, remote } = setup(PIN);
    const res = await call(`/recap/${DAY}`, "192.168.1.23");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/remote");
    expect(await res.text()).not.toMatch(/witch|snapshots\//);
    expect((await call(`/recap/${DAY}`, "192.168.1.23", { cookie: `${SESSION_COOKIE}=forged` })).status).toBe(302);
    const token = remote.auth.login("192.168.1.23", PIN);
    if (!token.ok) throw new Error("login failed");
    const signedIn = await call(`/recap/${DAY}`, "192.168.1.23", { cookie: `${SESSION_COOKIE}=${token.token}` });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain("glowing bristles");
  });

  it("a page rebinding its domain to 127.0.0.1 isn't the dashboard; the photos need a session too", async () => {
    const { call } = setup(PIN);
    expect((await call(`/recap/${DAY}`, "127.0.0.1", { host: "evil.example:8787" })).status).toBe(302);
    expect((await setup("").call(`/recap/${DAY}`, "127.0.0.1", { host: "evil.example:8787" })).status).toBe(403);
    const auth = new RemoteAuth({ pin: PIN });
    const photo = { method: "GET", path: `/api/session-logs/${DAY}/snapshots/18-00-03-arrived.png`, socketAddress: "192.168.1.23", host: "192.168.1.5:8787" };
    expect(checkAccess(photo, auth)).toMatchObject({ allow: false, status: 401 });
  });
});

describe("end-of-night push", () => {
  function fake() {
    const sent: { title: string; text: string; click?: string }[] = [];
    const notifier: Notifier = { send: async (m) => void sent.push(m) };
    return { sent, notifier };
  }
  function pusher(over: Partial<ConstructorParameters<typeof NightRecapPush>[0]> & { at?: Date } = {}) {
    let now = over.at ?? new Date(2026, 9, 31, 20, 0);
    const { sent, notifier } = fake();
    const push = new NightRecapPush({ logDir: dir, notifier, atMinutes: null, sleepMs: 15 * 60_000, baseUrl: null, name: "Jacques", now: () => now, ...over });
    return { push, sent, advance: (ms: number) => (now = new Date(now.getTime() + ms)), set: (d: Date) => (now = d) };
  }
  beforeEach(() => {
    fixture();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("pushes once the kill switch has been on for a while, then never again that day", async () => {
    const { push, sent, advance } = pusher();
    push.dashboardStatus({ woken: true, autopilot: false });
    advance(10 * 60_000);
    expect(await push.tick()).toBe(false);
    // Waking again resets the wait (a short break isn't the end of the night).
    push.dashboardStatus({ woken: true, autopilot: true });
    push.dashboardStatus({ woken: true, autopilot: false });
    advance(10 * 60_000);
    expect(await push.tick()).toBe(false);
    advance(5 * 60_000);
    expect(await push.tick()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("Jacques met 6 groups tonight (about 11 people), busiest 7:00–7:30 pm (4 groups). Awake 33 min.");
    advance(60_000);
    expect(await push.tick()).toBe(false);
    expect(await push.push(DAY)).toBe(false);
    expect(sent).toHaveLength(1);
    // A restarted server remembers.
    expect(existsSync(join(dir, DAY, RECAP_SENT_FILE))).toBe(true);
    const again = pusher({ atMinutes: 20 * 60 });
    expect(await again.push.tick()).toBe(false);
    expect(again.sent).toHaveLength(0);
  });

  it("pushes at RECAP_AT, with a link only when the phone can reach the server", async () => {
    const { push, sent, set } = pusher({ atMinutes: 22 * 60, sleepMs: null, baseUrl: "http://192.168.1.5:8787", at: new Date(2026, 9, 31, 21, 59) });
    expect(await push.tick()).toBe(false);
    set(new Date(2026, 9, 31, 22, 0));
    expect(await push.tick()).toBe(true);
    expect(sent[0]!.text).toMatch(/\nRecap: http:\/\/192\.168\.1\.5:8787\/recap\/2026-10-31$/);
    expect(sent[0]!.click).toBe("http://192.168.1.5:8787/recap/2026-10-31");

    const noLink = pusher({ atMinutes: 22 * 60, sleepMs: null, at: new Date(2026, 9, 31, 23, 0) });
    rmSync(join(dir, DAY, RECAP_SENT_FILE));
    expect(await noLink.push.tick()).toBe(true);
    expect(noLink.sent[0]!.text).not.toMatch(/http/);
    expect(noLink.sent[0]!.click).toBeUndefined();
  });

  it("an after-midnight push recaps the evening before", async () => {
    const { push, sent } = pusher({ atMinutes: 30, sleepMs: null, at: new Date(2026, 10, 1, 0, 45) });
    expect(eveningDay(new Date(2026, 10, 1, 0, 45))).toBe(DAY);
    expect(eveningDay(new Date(2026, 10, 1, 12, 0))).toBe("2026-11-01");
    expect(await push.tick()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("never sends photos, captions or anything a visitor said", async () => {
    const { push, sent } = pusher();
    await push.push(DAY);
    const all = JSON.stringify(sent);
    expect(all).not.toMatch(/snapshots|\.png|\.jpg|witch|dinosaur|ghost|bristles|thumbs/i);
  });

  it("doesn't use up the day on a night with no visitors, and retries a failed push later", async () => {
    const empty = mkdtempSync(join(tmpdir(), "creature-recap-empty-"));
    try {
      const log = new SessionLog(empty, "Test", () => new Date(2026, 9, 31, 18, 0));
      log.start("engine live");
      const { push, sent } = pusher({ logDir: empty });
      expect(await push.push(DAY)).toBe(false);
      expect(sent).toHaveLength(0);
      expect(push.alreadySent(DAY)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    let fail = true;
    const sent: string[] = [];
    let now = new Date(2026, 9, 31, 22, 0);
    const push = new NightRecapPush({
      logDir: dir,
      notifier: { send: async (m) => (fail ? Promise.reject(new Error("offline")) : void sent.push(m.text)) },
      atMinutes: 22 * 60,
      sleepMs: null,
      baseUrl: null,
      now: () => now,
      retryMs: 10 * 60_000,
    });
    expect(await push.tick()).toBe(false);
    expect(push.alreadySent(DAY)).toBe(false);
    fail = false;
    now = new Date(now.getTime() + 5 * 60_000);
    expect(await push.tick()).toBe(false); // still waiting to retry
    now = new Date(now.getTime() + 5 * 60_000);
    expect(await push.tick()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("ntfy gets the link as a Click header (ASCII only)", async () => {
    const post = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    const ntfy = new NtfyNotifier("jacques-Xk3f9QpL2mVw7", "https://ntfy.sh", "", post as unknown as typeof fetch);
    await ntfy.send({ title: "Tonight's recap", text: "Jacques met 6 groups tonight.", level: "warn", click: "http://192.168.1.5:8787/recap/2026-10-31" });
    const headers = post.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Click).toBe("http://192.168.1.5:8787/recap/2026-10-31");
    expect(headers.Title).toBe("Jacques: Tonight's recap");
    await ntfy.send({ title: "x", text: "y", level: "warn", click: "javascript:alert(1)" });
    expect((post.mock.calls[1]![1]!.headers as Record<string, string>).Click).toBeUndefined();
  });
});

describe("recap settings", () => {
  it("parses RECAP_AT", () => {
    expect(parseRecapAt("22:00")).toBe(1320);
    expect(parseRecapAt(" 7:30 ")).toBe(450);
    expect(parseRecapAt("")).toBeNull();
    expect(parseRecapAt(undefined)).toBeNull();
    expect(() => parseRecapAt("10pm")).toThrow(/RECAP_AT/);
    expect(() => parseRecapAt("24:00")).toThrow(/RECAP_AT/);
  });

  it("links only to an address the phone can reach", () => {
    const interfaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun0: [{ address: "fe80::1", family: "IPv6", internal: false }],
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
    } as unknown as NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
    const base = { host: "0.0.0.0", port: 8787, interfaces };
    // No PIN: the server only answers this computer, so no link at all.
    expect(phoneBaseUrl({ ...base, pinSet: false, remoteUrl: "http://jacques.local:8787" })).toBeNull();
    expect(phoneBaseUrl({ ...base, pinSet: true })).toBe("http://192.168.1.5:8787");
    expect(phoneBaseUrl({ ...base, pinSet: true, remoteUrl: "http://jacques.local:8787/" })).toBe("http://jacques.local:8787");
    expect(phoneBaseUrl({ ...base, pinSet: true, remoteUrl: "http://x/ y" })).toBeNull();
    expect(phoneBaseUrl({ ...base, pinSet: true, host: "192.168.1.9" })).toBe("http://192.168.1.9:8787");
    expect(phoneBaseUrl({ ...base, pinSet: true, interfaces: { lo0: interfaces.lo0 } })).toBeNull();
  });
});
