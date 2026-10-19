import { describe, expect, it } from "vitest";
import { OfflineFallback } from "../web/offline.ts";

describe("OfflineFallback", () => {
  it("goes offline on the first failed start, and says so only once", () => {
    const f = new OfflineFallback();
    expect(f.offline).toBe(false);
    expect(f.failed(0)).toBe(true);
    expect(f.offline).toBe(true);
    expect(f.failed(5000)).toBe(false);
    expect(f.failedStarts).toBe(2);
  });

  it("backs off retries, doubling up to the cap", () => {
    const f = new OfflineFallback({ retryMinMs: 5000, retryMaxMs: 60_000 });
    expect(f.retryDue(0)).toBe(true); // nothing failed yet
    const waits: number[] = [];
    let t = 0;
    for (let i = 0; i < 7; i++) {
      f.failed(t);
      waits.push(f.retryIn(t));
      expect(f.retryDue(t + waits.at(-1)! - 1)).toBe(false);
      t += waits.at(-1)!;
      expect(f.retryDue(t)).toBe(true);
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("recovers: reports how long it was offline and resets the backoff", () => {
    const f = new OfflineFallback({ retryMinMs: 5000 });
    expect(f.recovered(100)).toBeNull(); // wasn't offline
    f.failed(1000);
    f.failed(6000);
    expect(f.recovered(96_000)).toBe(95_000);
    expect(f.offline).toBe(false);
    expect(f.retryDue(96_000)).toBe(true);
    f.failed(100_000);
    expect(f.retryIn(100_000)).toBe(5000); // back to the shortest wait
  });

  it("never picks the same recorded greeting twice in a row", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const f = new OfflineFallback({ clipCooldownMs: 0 }, random);
    const picks: number[] = [];
    for (let i = 0; i < 500; i++) picks.push(f.pickClip(16, i)!);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    expect(new Set(picks).size).toBe(16); // and it does use all of them
    // Even when the random source keeps asking for the same one.
    const stuck = new OfflineFallback({ clipCooldownMs: 0 }, () => 0);
    expect([stuck.pickClip(3, 0), stuck.pickClip(3, 1), stuck.pickClip(3, 2)]).toEqual([0, 1, 0]);
  });

  it("plays at most one recorded greeting per cooldown, unless forced, and none without clips", () => {
    const f = new OfflineFallback({ clipCooldownMs: 20_000 });
    expect(f.pickClip(0, 0)).toBeNull();
    expect(f.pickClip(5, 0)).not.toBeNull();
    expect(f.pickClip(5, 19_000)).toBeNull();
    expect(f.pickClip(5, 19_500, true)).not.toBeNull(); // the operator's Greet now
    expect(f.pickClip(5, 39_000)).toBeNull();
    expect(f.pickClip(5, 39_500)).not.toBeNull();
  });
});
