/**
 * Turns noisy per-frame person detections into stable visitor events.
 * Pure logic (no DOM) so it can be unit tested with fake timestamps.
 */

export interface VisitorOptions {
  /** Minimum box area (fraction of the frame) for a person to count as "close". */
  minArea: number;
  /** A person must be seen this long before we greet. */
  arriveMs: number;
  /** Detection gaps shorter than this don't reset an arrival. */
  dropoutMs: number;
  /** Nobody seen for this long means the group left. */
  leaveMs: number;
  /**
   * Someone reappearing after nobody was seen for at least this long (but under leaveMs) is
   * reported as a "gap": one person may have stepped out and another in.
   */
  gapMs: number;
  /** A bigger group must be stable this long to count as "grew". */
  growMs: number;
  /** Minimum time between greetings for the same group. */
  growCooldownMs: number;
  /**
   * Someone re-appearing within this long after "left" is reported as "returned" (with how long
   * they were away) instead of "arrived", so the director can decide whether it's the same group.
   */
  regreetAfterMs: number;
}

export const DEFAULT_VISITOR_OPTIONS: VisitorOptions = {
  minArea: 0.03,
  arriveMs: 700,
  dropoutMs: 500,
  leaveMs: 8000,
  gapMs: 2000,
  growMs: 2500,
  growCooldownMs: 30000,
  regreetAfterMs: 90000,
};

export type PresenceState = "empty" | "arriving" | "present" | "leaving";

export type VisitorEvent =
  | { type: "arrived"; count: number }
  | { type: "grew"; count: number; from: number }
  /** The same group came back soon after leaving (e.g. detection flicker): don't greet again. */
  | { type: "returned"; count: number; awayMs: number }
  /** Nobody was visible for a few seconds, under leaveMs: maybe a different person now. */
  | { type: "gap"; count: number; awayMs: number }
  | { type: "left" };

export interface PersonBox {
  /** Fraction of the frame covered by the person's bounding box (0..1). */
  area: number;
}

export class VisitorTracker {
  state: PresenceState = "empty";
  /** Size of the current group (people close enough to talk to). */
  count = 0;
  private since = 0;
  private lastSeenAt = 0;
  private lastGreetAt = -Infinity;
  private lastLeftAt = -Infinity;
  private growSince: number | null = null;
  private shrinkSince: number | null = null;
  private readonly opts: VisitorOptions;

  constructor(options: Partial<VisitorOptions> = {}) {
    this.opts = { ...DEFAULT_VISITOR_OPTIONS, ...options };
  }

  /** How close (box area as a fraction of the frame) someone must be to count as a visitor. */
  setMinArea(minArea: number): void {
    this.opts.minArea = minArea;
  }

  update(people: readonly PersonBox[], now: number): VisitorEvent[] {
    const close = people.filter((p) => p.area >= this.opts.minArea).length;
    if (close > 0) this.lastSeenAt = now;
    const events: VisitorEvent[] = [];

    switch (this.state) {
      case "empty":
        if (close > 0) {
          this.state = "arriving";
          this.since = now;
        }
        break;

      case "arriving":
        if (close === 0) {
          if (now - this.lastSeenAt > this.opts.dropoutMs) this.state = "empty";
        } else if (now - this.since >= this.opts.arriveMs) {
          this.state = "present";
          this.count = close;
          this.lastGreetAt = now;
          this.growSince = this.shrinkSince = null;
          // "left" fires leaveMs after the last sighting, so add it back to get the real gap.
          const awayMs = now - this.lastLeftAt + this.opts.leaveMs;
          const returning = now - this.lastLeftAt < this.opts.regreetAfterMs;
          events.push(returning ? { type: "returned", count: close, awayMs } : { type: "arrived", count: close });
        }
        break;

      case "present":
        if (close === 0) {
          this.state = "leaving";
          this.since = now;
          break;
        }
        this.trackGroupSize(close, now, events);
        break;

      case "leaving":
        if (close > 0) {
          // Back in view: a detection blip, or (after a longer gap) maybe someone else.
          this.state = "present";
          const awayMs = now - this.since;
          if (awayMs >= this.opts.gapMs) events.push({ type: "gap", count: close, awayMs });
          this.trackGroupSize(close, now, events);
        } else if (now - this.since >= this.opts.leaveMs) {
          this.state = "empty";
          this.count = 0;
          this.lastLeftAt = now;
          events.push({ type: "left" });
        }
        break;
    }
    return events;
  }

  private trackGroupSize(close: number, now: number, events: VisitorEvent[]): void {
    if (close > this.count) {
      this.shrinkSince = null;
      this.growSince ??= now;
      if (now - this.growSince >= this.opts.growMs && now - this.lastGreetAt >= this.opts.growCooldownMs) {
        events.push({ type: "grew", count: close, from: this.count });
        this.count = close;
        this.lastGreetAt = now;
        this.growSince = null;
      }
    } else if (close < this.count) {
      this.growSince = null;
      this.shrinkSince ??= now;
      if (now - this.shrinkSince >= this.opts.leaveMs) {
        this.count = close;
        this.shrinkSince = null;
      }
    } else {
      this.growSince = this.shrinkSince = null;
    }
  }
}
