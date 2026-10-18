/**
 * Offline mode: when the live voice can't start (Wi-Fi down, OpenAI down or slow), the Director
 * plays recorded greetings instead of leaving a visitor in silence, and keeps retrying the live
 * voice with backoff. This is its bookkeeping: whether it's offline, when to retry next, and which
 * recorded greeting to play. DOM-free and driven by the caller's clock, so it's tested with fake time.
 */
import { pickDifferent } from "./ambience.ts";

export interface OfflineOptions {
  /** A greeting waits this long for the live voice to connect, then a recorded one plays instead. */
  connectTimeoutMs: number;
  /** Retries while offline: the first one this soon after a failure, doubling up to retryMaxMs. */
  retryMinMs: number;
  retryMaxMs: number;
  /** At most one recorded greeting this often (a gap or a return right after one stays quiet). */
  clipCooldownMs: number;
}

export const DEFAULT_OFFLINE_OPTIONS: OfflineOptions = {
  connectTimeoutMs: 5000,
  retryMinMs: 5000,
  retryMaxMs: 60_000,
  clipCooldownMs: 20_000,
};

export class OfflineFallback {
  readonly opts: OfflineOptions;
  private down = false;
  private since = 0;
  private failures = 0;
  private retryAt = -Infinity;
  private lastClip: number | null = null;
  private lastClipAt = -Infinity;

  constructor(
    options: Partial<OfflineOptions> = {},
    private readonly random: () => number = Math.random,
  ) {
    this.opts = { ...DEFAULT_OFFLINE_OPTIONS, ...options };
  }

  /** True from the first failed start until a session opens again. */
  get offline(): boolean {
    return this.down;
  }

  /** Failed starts in a row. */
  get failedStarts(): number {
    return this.failures;
  }

  /** A start failed: schedules the next retry. Returns true if this just went offline. */
  failed(now: number): boolean {
    this.failures++;
    this.retryAt = now + this.retryDelay();
    if (this.down) return false;
    this.down = true;
    this.since = now;
    return true;
  }

  /** A session opened. Returns how long it was offline, or null if it wasn't. */
  recovered(now: number): number | null {
    this.failures = 0;
    this.retryAt = -Infinity;
    if (!this.down) return null;
    this.down = false;
    return now - this.since;
  }

  /** Whether it's time to try starting a session again (always, until something fails). */
  retryDue(now: number): boolean {
    return now >= this.retryAt;
  }

  /** Milliseconds until the next retry (0 if one is due). */
  retryIn(now: number): number {
    return Math.max(0, this.retryAt - now);
  }

  /**
   * Which recorded greeting to play now: never the one played last, or null when there are none or
   * one played less than clipCooldownMs ago (`force`, the operator's Greet now, skips the cooldown).
   */
  pickClip(count: number, now: number, force = false): number | null {
    if (count <= 0) return null;
    if (!force && now - this.lastClipAt < this.opts.clipCooldownMs) return null;
    const clip = pickDifferent(count, this.lastClip, this.random);
    this.lastClip = clip;
    this.lastClipAt = now;
    return clip;
  }

  private retryDelay(): number {
    return Math.min(this.opts.retryMaxMs, this.opts.retryMinMs * 2 ** Math.min(20, this.failures - 1));
  }
}
