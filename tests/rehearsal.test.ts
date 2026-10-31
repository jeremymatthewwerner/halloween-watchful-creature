import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Director } from "../web/director.ts";
import type { Engine, EngineStatus } from "../web/engines/types.ts";
import type { GeneratedVisitor } from "../shared/types.ts";
import {
  DEFAULT_SCRIPT,
  Rehearsal,
  describeGenerated,
  generatedImage,
  generationCostText,
  logDays,
  peopleFor,
  type RehearsalImage,
} from "../web/rehearsal.ts";
import { VisitorTracker, type VisitorEvent } from "../web/visitors.ts";

const A: RehearsalImage = { name: "witch.jpg", dataUrl: "data:image/jpeg;base64,AAAA", source: "upload" };
const B: RehearsalImage = { name: "pirate.jpg", dataUrl: "data:image/jpeg;base64,BBBB", source: "log" };
const C: RehearsalImage = { name: "group.jpg", dataUrl: "data:image/jpeg;base64,CCCC", source: "upload" };

/** Something standing in for real camera detections: rehearsal must ignore these. */
const REAL_PERSON = { x: 0, y: 0, w: 0.5, h: 0.5, area: 0.25, score: 0.9 };

class FakeEngine implements Engine {
  readonly kind = "live" as const;
  status: EngineStatus = "closed";
  remoteStream = null;
  calls: string[] = [];
  connect = vi.fn(async () => {
    this.calls.push("connect");
    this.status = "open";
  });
  close = vi.fn(async () => {
    this.calls.push("close");
    this.status = "closed";
  });
  greet = vi.fn(async (image: string | null, reason: string, opts?: { awayMs?: number; ready?: Promise<boolean> }) => {
    if (opts?.ready && !(await opts.ready)) return;
    this.calls.push(`greet:${reason}:${image}`);
  });
  observe = vi.fn(async (image: string) => void this.calls.push(`observe:${image}`));
  recheck = vi.fn(async (image: string) => void this.calls.push(`recheck:${image}`));
  say = vi.fn();
  setStanding = vi.fn();
  setMicEnabled() {}
  isThinking() {
    return false;
  }
  lastHeardAt() {
    return 0;
  }
  on() {
    return () => {};
  }
}

/**
 * The dashboard's pipeline in miniature, wired as main.ts wires it: a 200 ms detection loop
 * (rehearsal's detection seam → real VisitorTracker → real Director) and the Director's 1 s tick,
 * with frames through rehearsal's capture seam. Runs on vitest's fake timers.
 */
function pipeline(images: RehearsalImage[] = [A, B]) {
  const logs: string[] = [];
  const rehearsal = new Rehearsal({ log: (m) => logs.push(m) });
  rehearsal.addImages(images);
  const engine = new FakeEngine();
  const realCapture = vi.fn(() => "data:image/jpeg;base64,REAL");
  const realDetect = vi.fn(() => [REAL_PERSON]);
  const capture = () => rehearsal.capture(realCapture);
  const director = new Director(
    { engine, capture, isSpeaking: () => false, now: () => Date.now(), log: (m) => logs.push(m) },
    { idleCloseMs: 180_000, backgroundMs: 999_999, recheckCooldownMs: 10_000, sightingGraceMs: 15_000, micGraceMs: 20_000 },
  );
  const tracker = new VisitorTracker({ minArea: 0.03 });
  const events: (VisitorEvent & { at: number })[] = [];
  const start = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    for (const event of tracker.update(rehearsal.detections(realDetect), now)) {
      events.push({ ...event, at: now - start });
      void director.onVisitorEvent(event);
    }
  }, 200);
  const tick = setInterval(() => void director.tick(), 1000);
  return {
    rehearsal,
    engine,
    tracker,
    events,
    logs,
    realCapture,
    realDetect,
    capture,
    types: () => events.map((e) => e.type),
    dispose: () => (clearInterval(loop), clearInterval(tick)),
  };
}

beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 31, 18, 0, 0) }));
afterEach(() => vi.useRealTimers());

describe("Rehearsal seams", () => {
  it("passes the real camera through while off", () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([A]);
    expect(r.capture(() => "real")).toBe("real");
    expect(r.detections(() => [REAL_PERSON])).toEqual([REAL_PERSON]);
    expect(r.detections(() => null)).toBeNull();
  });

  it("replaces frames and detections while on, without calling the real camera or detector", () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([A, B]);
    r.start();
    const real = vi.fn(() => "real");
    const detect = vi.fn(() => [REAL_PERSON, REAL_PERSON]);
    // Nobody pretend is here yet: an empty porch, even if real people are in front of the camera.
    expect(r.capture(real)).toBeNull();
    expect(r.detections(detect)).toEqual([]);

    expect(r.act("arrive")).toBeNull();
    expect(r.capture(real)).toBe(A.dataUrl);
    const one = r.detections(detect) as typeof REAL_PERSON[];
    expect(one).toHaveLength(1);
    expect(one[0]!.area).toBeGreaterThan(0.15); // above the "how close" slider's maximum
    expect(one[0]!.x + one[0]!.w).toBeLessThanOrEqual(1);

    r.act("join");
    const two = r.detections(detect) as typeof REAL_PERSON[];
    expect(two).toHaveLength(2);
    expect(two[0]!.x + two[0]!.w).toBeLessThanOrEqual(two[1]!.x); // side by side, not overlapping

    r.select(1);
    expect(r.capture(real)).toBe(B.dataUrl);
    expect(real).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();

    r.stop();
    expect(r.capture(real)).toBe("real");
    expect(r.detections(detect)).toHaveLength(2);
  });

  it("swap steps out of view for a few seconds, then comes back as the next image", () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([A, B]);
    r.start();
    r.act("arrive");
    r.act("swap");
    expect(r.detections(() => null)).toEqual([]);
    expect(r.capture(() => "real")).toBeNull();
    vi.advanceTimersByTime(2999);
    expect(r.detections(() => null)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.detections(() => null)).toHaveLength(1);
    expect(r.capture(() => "real")).toBe(B.dataUrl);
    // And wraps around.
    r.act("swap");
    vi.advanceTimersByTime(3000);
    expect(r.capture(() => "real")).toBe(A.dataUrl);
  });

  it("explains actions it can't do", () => {
    const r = new Rehearsal({ log: () => {} });
    expect(r.act("arrive")).toMatch(/rehearsal on/);
    r.start();
    expect(r.act("arrive")).toMatch(/image/);
    r.addImages([A]);
    expect(r.act("leave")).toMatch(/Nobody/);
    expect(r.act("swap")).toMatch(/second image/);
    r.act("arrive");
    expect(r.act("arrive")).toMatch(/already/);
  });

  it("keeps the chosen image sensible when images are removed", () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([A, B, C]);
    r.select(2);
    r.removeImage(0);
    expect(r.snapshot().image).toBe(C);
    r.removeImage(1);
    expect(r.snapshot().image).toBe(B);
    r.clearImages();
    expect(r.snapshot()).toMatchObject({ image: null, imageCount: 0 });
  });

  it("remembers when rehearsals ran, to mark their log lines", () => {
    const r = new Rehearsal({ log: () => {} });
    const before = Date.now();
    vi.advanceTimersByTime(1000);
    r.start();
    const during = Date.now();
    vi.advanceTimersByTime(5000);
    expect(r.wasActiveAt(Date.now())).toBe(true); // still running
    r.stop();
    vi.advanceTimersByTime(1000);
    expect(r.wasActiveAt(before)).toBe(false);
    expect(r.wasActiveAt(during)).toBe(true);
    expect(r.wasActiveAt(Date.now())).toBe(false);
  });

  it("tells listeners about changes", () => {
    const r = new Rehearsal({ log: () => {} });
    const seen: boolean[] = [];
    r.onChange((s) => seen.push(s.active));
    r.start();
    r.stop();
    expect(seen).toEqual([true, false]);
  });
});

describe("Rehearsal script runner", () => {
  it("runs its steps on time", async () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([A, B]);
    r.start();
    const done = r.runScript([{ do: "arrive" }, { waitMs: 5000 }, { do: "leave" }]);
    expect(r.snapshot()).toMatchObject({ people: 1, script: "step 2/3: wait 5 s" });
    await vi.advanceTimersByTimeAsync(4999);
    expect(r.snapshot().people).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(r.snapshot()).toMatchObject({ people: 0, script: null });
  });

  it("is cancelled by stopping it, by stopping rehearsal, or by a new script", async () => {
    const logs: string[] = [];
    const r = new Rehearsal({ log: (m) => logs.push(m) });
    r.addImages([A, B]);
    r.start();
    let done = r.runScript([{ waitMs: 1000 }, { do: "arrive" }]);
    r.stopScript();
    await done;
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.snapshot()).toMatchObject({ people: 0, script: null });
    expect(logs).toContain("Rehearsal script stopped");

    done = r.runScript([{ waitMs: 1000 }, { do: "arrive" }]);
    r.stop();
    await done;
    expect(r.snapshot()).toMatchObject({ active: false, people: 0, script: null });

    r.start();
    const first = r.runScript([{ waitMs: 1000 }, { do: "join" }]);
    const second = r.runScript([{ do: "arrive" }]);
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.snapshot().people).toBe(1); // the first script's "join" never ran
  });

  it("logs and skips a step that can't run", async () => {
    const logs: string[] = [];
    const r = new Rehearsal({ log: (m) => logs.push(m) });
    r.addImages([A]);
    r.start();
    await r.runScript([{ do: "arrive" }, { do: "swap" }, { do: "leave" }]);
    expect(logs).toContain('Rehearsal script: skipped "swap" (Add a second image to swap to)');
    expect(r.snapshot().people).toBe(0);
    expect(logs.at(-1)).toBe("Rehearsal script done");
  });

  it("won't run while rehearsal is off", async () => {
    const logs: string[] = [];
    const r = new Rehearsal({ log: (m) => logs.push(m) });
    await r.runScript();
    expect(logs).toEqual(["Rehearsal: turn rehearsal on first"]);
  });
});

describe("Rehearsal through the real tracker and director", () => {
  it("the default script greets, rechecks the new costume, sees them leave and come back", async () => {
    const p = pipeline();
    p.rehearsal.start();
    const done = p.rehearsal.runScript(DEFAULT_SCRIPT);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    p.dispose();

    expect(p.types()).toEqual(["sighted", "arrived", "gap", "left", "sighted", "returned"]);
    const at = (type: string) => p.events.filter((e) => e.type === type).map((e) => e.at);
    expect(at("arrived")[0]).toBeLessThan(1500);
    // Back after the 3 s swap, then settled for a second.
    expect(at("gap")[0]).toBeGreaterThanOrEqual(24_000);
    expect(at("gap")[0]).toBeLessThan(25_000);
    expect(at("left")[0]).toBeGreaterThanOrEqual(38_000);
    const returned = p.events.find((e) => e.type === "returned") as Extract<VisitorEvent, { type: "returned" }>;
    expect(returned.awayMs).toBeGreaterThan(14_000);
    expect(returned.awayMs).toBeLessThan(17_000);

    expect(p.engine.calls).toEqual(["connect", `greet:arrived:${A.dataUrl}`, `recheck:${B.dataUrl}`, `greet:returned:${B.dataUrl}`]);
    // The real camera and detector were never used.
    expect(p.realCapture).not.toHaveBeenCalled();
    expect(p.realDetect).not.toHaveBeenCalled();
  });

  it("a second visitor joining is greeted once the tracker's cooldown allows", async () => {
    const p = pipeline([A, C]);
    p.rehearsal.start();
    p.rehearsal.act("arrive");
    await vi.advanceTimersByTimeAsync(5000);
    p.rehearsal.select(1); // a group photo for the pair
    p.rehearsal.act("join");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(p.types()).toEqual(["sighted", "arrived"]); // within 30 s of the first greeting
    await vi.advanceTimersByTimeAsync(10_000);
    p.dispose();
    expect(p.types()).toEqual(["sighted", "arrived", "grew"]);
    expect(p.events.at(-1)).toMatchObject({ count: 2, from: 1 });
    expect(p.engine.calls.at(-1)).toBe(`greet:grew:${C.dataUrl}`);
  });

  it("leaving rehearsal hands the porch back to the real camera", async () => {
    const p = pipeline();
    p.rehearsal.start();
    p.rehearsal.act("arrive");
    await vi.advanceTimersByTimeAsync(2000);
    p.rehearsal.stop();
    p.realDetect.mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(10_000);
    p.dispose();
    expect(p.types()).toEqual(["sighted", "arrived", "left"]);
    expect(p.realDetect).toHaveBeenCalled();
    expect(p.capture()).toBe("data:image/jpeg;base64,REAL");
  });
});

const generated = (id: string, groupSize: number, costumeLabels: string[]): GeneratedVisitor => ({
  id,
  groupSize,
  costumes: costumeLabels,
  costumeLabels,
  lighting: "dim",
  style: "animated",
  createdAt: "2026-10-18T10:00:00.000Z",
  model: "gpt-image-2.5-flare",
  quality: "low",
  size: "1536x1024",
  costUsd: 0.008,
  costEstimated: false,
});
const SOLO = generatedImage(generated("a-111111", 1, ["dinosaur"]), "data:image/jpeg;base64,SOLO");
const TRIO = generatedImage(generated("b-222222", 3, ["witch", "pirate", "ghost"]), "data:image/jpeg;base64,TRIO");
const PAIR = generatedImage(generated("c-333333", 2, ["ninja", "unicorn"]), "data:image/jpeg;base64,PAIR");

describe("Generated visitors' group size drives the pretend detections", () => {
  it("turns a cached generated visitor into an image carrying its group size", () => {
    expect(TRIO).toMatchObject({ source: "generated", people: 3, dataUrl: "data:image/jpeg;base64,TRIO" });
    expect(TRIO.name).toContain("witch + pirate + ghost");
    expect(describeGenerated(generated("x-000000", 2, ["ninja", "unicorn"]))).toBe("2 visitors: ninja, unicorn · dim light");
    expect(peopleFor(TRIO, 1)).toBe(3);
    expect(peopleFor(A, 1)).toBe(1); // an upload: no known group size
    expect(peopleFor(null, 2)).toBe(2);
  });

  it("shows the estimated cost before generating", () => {
    const estimate = { perImageUsd: 0.01, model: "gpt-image-2.5-flare", quality: "low", size: "1536x1024" };
    expect(generationCostText(3, estimate)).toBe("≈ $0.030 for 3 (gpt-image-2.5-flare, low, 1536x1024)");
    expect(generationCostText(6, { ...estimate, perImageUsd: 0.05 })).toBe("≈ $0.30 for 6 (gpt-image-2.5-flare, low, 1536x1024)");
  });

  it("a group of 3 arrives as 3 people; swapping or picking another image changes the count", () => {
    const r = new Rehearsal({ log: () => {} });
    r.addImages([TRIO, SOLO, A]);
    r.start();
    r.act("arrive");
    expect(r.detections(() => null)).toHaveLength(3);
    expect(r.snapshot().people).toBe(3);

    r.act("swap"); // to the solo dinosaur
    expect(r.detections(() => null)).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(r.detections(() => null)).toHaveLength(1);
    expect(r.capture(() => null)).toBe(SOLO.dataUrl);

    r.act("swap"); // to an upload: keeps the current count
    vi.advanceTimersByTime(3000);
    expect(r.detections(() => null)).toHaveLength(1);

    r.select(0); // straight to the trio, no gap
    expect(r.detections(() => null)).toHaveLength(3);
    r.act("leave");
    r.select(1); // nobody's in view: picking an image doesn't conjure anyone
    expect(r.detections(() => null)).toEqual([]);
  });

  it("“more visitors join” switches to the next bigger group, else adds one", () => {
    const logs: string[] = [];
    const r = new Rehearsal({ log: (m) => logs.push(m) });
    r.addImages([SOLO, TRIO, PAIR]);
    r.start();
    r.act("arrive");
    r.act("join");
    expect(r.snapshot()).toMatchObject({ people: 3, image: TRIO });
    expect(logs.at(-1)).toMatch(/more visitors join \(3 now/);
    r.act("join"); // nothing bigger than 3
    expect(r.snapshot()).toMatchObject({ people: 4, image: TRIO });
    expect(logs.at(-1)).toMatch(/the picture shows 3/);
  });

  it("through the real tracker: a solo visitor swapped for a group of 3 is a gap, then the group grows", async () => {
    const p = pipeline([SOLO, TRIO]);
    p.rehearsal.start();
    p.rehearsal.act("arrive");
    await vi.advanceTimersByTimeAsync(30_000); // past the tracker's 30 s greeting cooldown
    p.rehearsal.act("swap");
    await vi.advanceTimersByTimeAsync(10_000);
    p.dispose();
    expect(p.types()).toEqual(["sighted", "arrived", "gap", "grew"]);
    expect(p.events.find((e) => e.type === "arrived")).toMatchObject({ count: 1 });
    expect(p.events.find((e) => e.type === "gap")).toMatchObject({ count: 3 });
    expect(p.events.find((e) => e.type === "grew")).toMatchObject({ count: 3, from: 1 });
    expect(p.engine.calls[1]).toBe(`greet:arrived:${SOLO.dataUrl}`);
    expect(p.engine.calls).toContain(`greet:grew:${TRIO.dataUrl}`);
  });

  it("through the real tracker: a generated group of 3 arrives with count 3", async () => {
    const p = pipeline([TRIO]);
    p.rehearsal.start();
    p.rehearsal.act("arrive");
    await vi.advanceTimersByTimeAsync(2000);
    p.dispose();
    expect(p.events.find((e) => e.type === "arrived")).toMatchObject({ count: 3 });
    expect(p.tracker.count).toBe(3);
  });
});

describe("logDays", () => {
  it("reads the days from the log list page, newest first, once each", () => {
    const html =
      `<ul><li><a href="/api/session-logs/2026-10-31/log.html">2026-10-31</a> · <a href="/api/session-logs/2026-10-31/log.txt">text</a></li>` +
      `<li><a href="/api/session-logs/2026-10-30/log.html">2026-10-30</a></li></ul>`;
    expect(logDays(html)).toEqual(["2026-10-31", "2026-10-30"]);
    expect(logDays("<li>No logs yet.</li>")).toEqual([]);
  });
});
