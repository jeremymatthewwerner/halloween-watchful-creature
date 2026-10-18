import { describe, expect, it } from "vitest";
import { AMBIENT_SOUNDS, AmbienceScheduler, pickDifferent, type AmbienceAction, type PorchView } from "../web/ambience.ts";

const quiet: PorchView = {
  porchEmpty: true,
  farPeople: 0,
  talking: false,
  autopilot: true,
  ambience: true,
  lure: true,
  lureClips: 12,
  playing: null,
};

/** A repeatable "random" sequence. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Runs the scheduler every 200 ms from `start` to `end` with the given view (or a function of
 * time), pretending each sound plays for `playMs`. Returns the actions with their timestamps.
 */
function run(
  scheduler: AmbienceScheduler,
  view: Partial<PorchView> | ((t: number) => Partial<PorchView>),
  start: number,
  end: number,
  playMs = 3000,
): { t: number; a: AmbienceAction }[] {
  const out: { t: number; a: AmbienceAction }[] = [];
  let playing: PorchView["playing"] = null;
  let endsAt = 0;
  for (let t = start; t < end; t += 200) {
    if (playing && t >= endsAt) playing = null;
    const v = typeof view === "function" ? view(t) : view;
    for (const a of scheduler.update({ ...quiet, ...v, playing }, t)) {
      out.push({ t, a });
      if (a.type === "stop") playing = null;
      else {
        playing = a.type;
        endsAt = t + playMs;
      }
    }
  }
  return out;
}

describe("pickDifferent", () => {
  it("never picks the same index twice in a row", () => {
    const random = seeded(7);
    let last: number | null = null;
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const next = pickDifferent(5, last, random);
      expect(next).not.toBe(last);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(5);
      seen.add(next);
      last = next;
    }
    expect(seen.size).toBe(5);
  });

  it("handles one choice and random() at its edges", () => {
    expect(pickDifferent(1, 0, () => 0.5)).toBe(0);
    expect(pickDifferent(3, 2, () => 0.9999999)).toBe(1);
    expect(pickDifferent(3, 0, () => 0)).toBe(1);
    expect(pickDifferent(3, null, () => 0.9999999)).toBe(2);
  });
});

describe("AmbienceScheduler: ambience", () => {
  it("plays sounds on an empty porch every 20–60 s, never the same twice in a row", () => {
    const s = new AmbienceScheduler({}, seeded(3));
    const events = run(s, {}, 0, 30 * 60_000).filter((x) => x.a.type === "ambience");
    expect(events.length).toBeGreaterThan(25);
    expect(events[0]!.t).toBeGreaterThanOrEqual(20_000);
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.t - events[i - 1]!.t;
      expect(gap).toBeGreaterThanOrEqual(20_000);
      expect(gap).toBeLessThanOrEqual(60_200);
      expect(events[i]!.a).not.toEqual(events[i - 1]!.a);
    }
    const sounds = new Set(events.map((x) => (x.a.type === "ambience" ? x.a.sound : "")));
    expect(sounds.size).toBe(AMBIENT_SOUNDS.length);
  });

  it("stops immediately when someone comes close, and stays silent while they're there", () => {
    const s = new AmbienceScheduler({ ambienceMinMs: 1000, ambienceMaxMs: 1000 }, seeded());
    const events = run(s, (t) => ({ porchEmpty: t < 2000 || t >= 60_000 }), 0, 61_000, 10_000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["1000:ambience", "2000:stop"]);
  });

  it("stops immediately when the creature talks, and waits a fresh delay after", () => {
    const s = new AmbienceScheduler({ ambienceMinMs: 5000, ambienceMaxMs: 5000 }, seeded());
    const events = run(s, (t) => ({ talking: t >= 6000 && t < 8000 }), 0, 14_000, 10_000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["5000:ambience", "6000:stop", "13000:ambience"]);
  });

  it("is silent while the kill switch is on or the toggle is off", () => {
    expect(run(new AmbienceScheduler({}, seeded()), { autopilot: false, farPeople: 1 }, 0, 10 * 60_000)).toEqual([]);
    expect(run(new AmbienceScheduler({}, seeded()), { ambience: false, lure: false, farPeople: 1 }, 0, 10 * 60_000)).toEqual([]);
  });

  it("stops a playing sound when its toggle is switched off", () => {
    const s = new AmbienceScheduler({ ambienceMinMs: 1000, ambienceMaxMs: 1000 }, seeded());
    const events = run(s, (t) => ({ ambience: t < 2000 }), 0, 4000, 10_000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["1000:ambience", "2000:stop"]);
  });

  it("waits for a sound to finish before the next one", () => {
    const s = new AmbienceScheduler({ ambienceMinMs: 1000, ambienceMaxMs: 1000 }, seeded());
    const events = run(s, {}, 0, 12_000, 5000);
    expect(events.map((x) => x.t)).toEqual([1000, 6000, 11_000]);
  });
});

describe("AmbienceScheduler: lure", () => {
  const lureOnly = { ambience: false };

  it("calls out once someone far away has been in view for a moment", () => {
    const s = new AmbienceScheduler({}, seeded());
    const events = run(s, (t) => ({ ...lureOnly, farPeople: t >= 2000 ? 1 : 0 }), 0, 5000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["3000:lure"]);
  });

  it("ignores a one-frame detection blip", () => {
    const s = new AmbienceScheduler({}, seeded());
    expect(run(s, (t) => ({ ...lureOnly, farPeople: t === 2000 ? 1 : 0 }), 0, 10_000)).toEqual([]);
  });

  it("respects the cooldown and never repeats a clip twice in a row", () => {
    const s = new AmbienceScheduler({ lureCooldownMs: 45_000, lureJitterMs: 15_000 }, seeded(11));
    const events = run(s, { ...lureOnly, farPeople: 2 }, 0, 60 * 60_000);
    expect(events.length).toBeGreaterThan(55);
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.t - events[i - 1]!.t;
      expect(gap).toBeGreaterThanOrEqual(45_000);
      expect(gap).toBeLessThanOrEqual(60_200);
      expect(events[i]!.a).not.toEqual(events[i - 1]!.a);
    }
    const clips = new Set(events.map((x) => (x.a.type === "lure" ? x.a.clip : -1)));
    expect(clips.size).toBe(12);
  });

  it("uses the configured cooldown, including a change made later", () => {
    const s = new AmbienceScheduler({ lureCooldownMs: 20_000, lureJitterMs: 0 }, seeded());
    let events = run(s, { ...lureOnly, farPeople: 1 }, 0, 50_000);
    expect(events.map((x) => x.t)).toEqual([1000, 21_000, 41_000]);
    s.setLureCooldown(60_000);
    events = run(s, { ...lureOnly, farPeople: 1 }, 50_000, 200_000);
    expect(events.map((x) => x.t)).toEqual([101_000, 161_000]);
  });

  it("never calls out while visitors are close, the creature talks, or the kill switch is on", () => {
    for (const view of [{ porchEmpty: false }, { talking: true }, { autopilot: false }, { lure: false }, { lureClips: 0 }]) {
      const s = new AmbienceScheduler({}, seeded());
      expect(run(s, { ...lureOnly, farPeople: 1, ...view }, 0, 5 * 60_000)).toEqual([]);
    }
  });

  it("doesn't call back visitors who just left", () => {
    const s = new AmbienceScheduler({ lureAfterVisitMs: 30_000 }, seeded());
    // Close until 10 s, then walking away (still visible, but far) for a minute.
    const events = run(s, (t) => ({ ...lureOnly, porchEmpty: t >= 10_000, farPeople: t >= 10_000 ? 1 : 0 }), 0, 70_000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["39800:lure"]);
  });

  it("waits after the creature talks, too", () => {
    const s = new AmbienceScheduler({ lureAfterVisitMs: 30_000 }, seeded());
    const events = run(s, (t) => ({ ...lureOnly, farPeople: 1, talking: t < 5000 }), 0, 40_000);
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["34800:lure"]);
  });

  it("interrupts ambience for a call-out, then stops the call-out if someone comes close", () => {
    const s = new AmbienceScheduler({ ambienceMinMs: 1000, ambienceMaxMs: 1000 }, seeded());
    const events = run(
      s,
      (t) => ({ farPeople: t >= 2000 && t < 4000 ? 1 : 0, porchEmpty: t < 4000 }),
      0,
      5000,
      10_000,
    );
    expect(events.map((x) => `${x.t}:${x.a.type}`)).toEqual(["1000:ambience", "3000:stop", "3000:lure", "4000:stop"]);
  });
});
