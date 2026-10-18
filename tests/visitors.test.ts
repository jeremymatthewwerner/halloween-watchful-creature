import { describe, expect, it } from "vitest";
import { VisitorTracker, type VisitorEvent } from "../web/visitors.ts";

const person = (area = 0.1) => ({ area });

/** Feeds frames every 200 ms; returns the events (without "sighted", unless asked) with their timestamps. */
function run(tracker: VisitorTracker, frames: number[], start = 0, withSightings = false): { t: number; e: VisitorEvent }[] {
  const out: { t: number; e: VisitorEvent }[] = [];
  frames.forEach((count, i) => {
    const t = start + i * 200;
    for (const e of tracker.update(Array.from({ length: count }, () => person()), t)) {
      if (withSightings || e.type !== "sighted") out.push({ t, e });
    }
  });
  return out;
}

describe("VisitorTracker", () => {
  it("greets once after someone is seen for arriveMs", () => {
    const tracker = new VisitorTracker();
    const events = run(tracker, [1, 1, 1, 1, 1, 1, 1, 1]);
    expect(events).toEqual([{ t: 800, e: { type: "arrived", count: 1 } }]);
    expect(tracker.state).toBe("present");
  });

  it("reports a sighting the moment someone appears on an empty porch, before they count as arrived", () => {
    const tracker = new VisitorTracker();
    const events = run(tracker, [0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1], 0, true);
    // A short-lived sighting, then a second one that becomes an arrival.
    expect(events.map((x) => `${x.t}:${x.e.type}`)).toEqual(["200:sighted", "1400:sighted", "2200:arrived"]);
  });

  it("ignores people who are too far away", () => {
    const tracker = new VisitorTracker({ minArea: 0.05 });
    for (let t = 0; t < 3000; t += 200) expect(tracker.update([person(0.01)], t)).toEqual([]);
    expect(tracker.state).toBe("empty");
  });

  it("tolerates brief detection dropouts while arriving", () => {
    const tracker = new VisitorTracker();
    const events = run(tracker, [1, 1, 0, 1, 1, 1]);
    expect(events.map((x) => x.e.type)).toEqual(["arrived"]);
  });

  it("resets an arrival after a long dropout", () => {
    const tracker = new VisitorTracker();
    const events = run(tracker, [1, 1, 0, 0, 0, 0]);
    expect(events).toEqual([]);
    expect(tracker.state).toBe("empty");
  });

  it("reports left only after leaveMs of nobody", () => {
    const tracker = new VisitorTracker({ leaveMs: 1000 });
    run(tracker, [1, 1, 1, 1, 1]);
    const events = run(tracker, [0, 0, 0, 0, 0, 0, 0], 1000);
    expect(events).toEqual([{ t: 2000, e: { type: "left" } }]);
    expect(tracker.state).toBe("empty");
  });

  it("does not re-greet the same group stepping briefly out of frame", () => {
    const tracker = new VisitorTracker({ leaveMs: 2000 });
    run(tracker, [1, 1, 1, 1, 1]);
    const events = run(tracker, [0, 0, 0, 1, 1, 1, 1, 1], 1000);
    expect(events).toEqual([]);
    expect(tracker.state).toBe("present");
  });

  it("reports a gap once someone is back in view for a second after a few seconds away, but not after a blip", () => {
    const tracker = new VisitorTracker({ leaveMs: 8000, gapMs: 2000, gapSettleMs: 1000 });
    run(tracker, [1, 1, 1, 1, 1]);
    expect(run(tracker, [0, 0, 0, 1, 1], 1000)).toEqual([]); // 600 ms blip
    // 3 s away (maybe someone else), back at t=6000, settled at t=7000.
    const events = run(tracker, [...Array(15).fill(0), 1, 1, 1, 1, 1, 1], 3000);
    expect(events).toEqual([{ t: 7000, e: { type: "gap", count: 1, awayMs: 3000 } }]);
    expect(tracker.state).toBe("present");
  });

  it("waits for someone stepping back in to settle: a blip restarts the wait, leaving cancels it", () => {
    const tracker = new VisitorTracker({ leaveMs: 8000, gapMs: 2000, gapSettleMs: 1000 });
    run(tracker, [1, 1, 1, 1, 1]);
    // Away 3 s, back at t=4000, a blip at t=4600, back at t=4800: settled at t=5800.
    const events = run(tracker, [...Array(15).fill(0), 1, 1, 1, 0, 1, 1, 1, 1, 1, 1], 1000);
    expect(events).toEqual([{ t: 5800, e: { type: "gap", count: 1, awayMs: 3000 } }]);
    // Glimpsed for half a second, then gone for good: no gap check, just left.
    const tracker2 = new VisitorTracker({ leaveMs: 8000, gapMs: 2000, gapSettleMs: 1000 });
    run(tracker2, [1, 1, 1, 1, 1]);
    expect(run(tracker2, [...Array(15).fill(0), 1, 1, ...Array(45).fill(0)], 1000).map((x) => x.e.type)).toEqual(["left"]);
  });

  it("emits grew when a bigger group is stable, respecting the cooldown", () => {
    const tracker = new VisitorTracker({ growMs: 400, growCooldownMs: 3000 });
    run(tracker, [1, 1, 1, 1, 1]); // arrived at t=800
    // Second person shows up at t=1000; cooldown blocks until t>=3800.
    const frames = Array.from({ length: 20 }, () => 2);
    const events = run(tracker, frames, 1000);
    expect(events).toEqual([{ t: 3800, e: { type: "grew", count: 2, from: 1 } }]);
  });

  it("treats someone re-detected soon after leaving as the same group (no re-greet)", () => {
    const tracker = new VisitorTracker({ leaveMs: 400, regreetAfterMs: 60000 });
    const events = [...run(tracker, [1, 1, 1, 1, 1, 0, 0, 0, 0]), ...run(tracker, [1, 1, 1, 1, 1], 5000)];
    // Last seen at t=800; seen again and confirmed at t=5800, so about 5 s away.
    expect(events.map((x) => x.e)).toEqual([{ type: "arrived", count: 1 }, { type: "left" }, { type: "returned", count: 1, awayMs: 4800 }]);
  });

  it("greets a new group once enough time has passed since the last one left", () => {
    const tracker = new VisitorTracker({ leaveMs: 400, regreetAfterMs: 60000 });
    const events = [...run(tracker, [1, 1, 1, 1, 1, 0, 0, 0, 0]), ...run(tracker, [2, 2, 2, 2, 2], 70000)];
    // (Within the window they'd be "returned"; past it, a plain arrival.)
    expect(events.map((x) => x.e)).toEqual([{ type: "arrived", count: 1 }, { type: "left" }, { type: "arrived", count: 2 }]);
  });

  it("uses conservative defaults so detection flicker doesn't trigger greetings", () => {
    const tracker = new VisitorTracker();
    run(tracker, [1, 1, 1, 1, 1]); // arrived
    // 6 s of nothing then back: still the same visit, no greeting; just a gap (once they've settled) to check for a swap.
    const events = run(tracker, [...Array(30).fill(0), 1, 1, 1, 1, 1, 1], 1000);
    expect(events).toEqual([{ t: 8000, e: { type: "gap", count: 1, awayMs: 6000 } }]);
    // A brief second box (2 s) doesn't count as a bigger group.
    expect(run(tracker, Array(10).fill(2), 20000)).toEqual([]);
  });
});
