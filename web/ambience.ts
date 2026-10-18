/**
 * Decides when to play local porch sounds between visitors: spooky ambience (synthesized) and
 * "lure" call-outs (pre-recorded clips) for people walking by who aren't close enough to count.
 * Neither ever opens the (billed) voice session. Pure logic (no DOM) so it can be unit tested
 * with fake timestamps; `web/porchSounds.ts` does the actual audio.
 */

export const AMBIENT_SOUNDS = ["creak", "owl", "thunder", "wind", "cackle", "howl", "bell"] as const;
export type AmbientSound = (typeof AMBIENT_SOUNDS)[number];

export interface AmbienceOptions {
  /** Shortest wait between ambient sounds. */
  ambienceMinMs: number;
  /** Longest wait between ambient sounds. */
  ambienceMaxMs: number;
  /** Shortest wait between call-outs. */
  lureCooldownMs: number;
  /** Up to this much is added to each call-out's cooldown at random, so it doesn't sound like a timer. */
  lureJitterMs: number;
  /** Someone far away must be in view this long before a call-out (not just a detection blip). */
  lureSeenMs: number;
  /** Detection gaps shorter than this don't reset "someone far away is in view". */
  lureDropoutMs: number;
  /** No call-outs this soon after visitors were close or the creature talked (don't call back kids who just left). */
  lureAfterVisitMs: number;
}

export const DEFAULT_AMBIENCE_OPTIONS: AmbienceOptions = {
  ambienceMinMs: 20_000,
  ambienceMaxMs: 60_000,
  lureCooldownMs: 45_000,
  lureJitterMs: 15_000,
  lureSeenMs: 1000,
  lureDropoutMs: 1000,
  lureAfterVisitMs: 30_000,
};

/** What's happening on the porch right now. */
export interface PorchView {
  /** Nobody close enough to count as a visitor (VisitorTracker state is "empty"). */
  porchEmpty: boolean;
  /** People the detector sees who are too far away to count. */
  farPeople: number;
  /** The creature is talking or about to (voice audible, or the engine is thinking). */
  talking: boolean;
  /** False when the operator's kill switch is on: stay silent. */
  autopilot: boolean;
  /** Settings toggles. */
  ambience: boolean;
  lure: boolean;
  /** How many call-out clips are loaded (0: lure is unavailable). */
  lureClips: number;
  /** What the player is playing now. */
  playing: "ambience" | "lure" | null;
}

export type AmbienceAction = { type: "stop" } | { type: "ambience"; sound: AmbientSound } | { type: "lure"; clip: number };

/** A random index in [0, count), never `last` when there's a choice. */
export function pickDifferent(count: number, last: number | null, random: () => number = Math.random): number {
  if (count <= 1 || last === null || last < 0 || last >= count) return Math.min(count - 1, Math.floor(random() * count));
  // Pick among the other count - 1 entries, skipping over `last`.
  const i = Math.min(count - 2, Math.floor(random() * (count - 1)));
  return i >= last ? i + 1 : i;
}

export class AmbienceScheduler {
  private readonly opts: AmbienceOptions;
  private nextAmbienceAt: number | null = null;
  private lastSound: number | null = null;
  private lastClip: number | null = null;
  private nextLureAt = -Infinity;
  /** Last time visitors were close or the creature was talking. */
  private lastActiveAt = -Infinity;
  private farSince: number | null = null;
  private lastFarAt = -Infinity;

  constructor(
    options: Partial<AmbienceOptions> = {},
    private readonly random: () => number = Math.random,
  ) {
    this.opts = { ...DEFAULT_AMBIENCE_OPTIONS, ...options };
  }

  /** Changes the shortest wait between call-outs (the Settings field). */
  setLureCooldown(ms: number): void {
    const change = ms - this.opts.lureCooldownMs;
    this.opts.lureCooldownMs = ms;
    if (Number.isFinite(this.nextLureAt)) this.nextLureAt += change;
  }

  /** Call several times a second; returns what the player should do now. */
  update(view: PorchView, now: number): AmbienceAction[] {
    const o = this.opts;
    if (!view.porchEmpty || view.talking) this.lastActiveAt = now;
    this.trackFarAway(view, now);

    // Someone's close, the creature is speaking, or the kill switch is on: silence, right away.
    if (!view.autopilot || !view.porchEmpty || view.talking) {
      this.nextAmbienceAt = null; // wait a fresh delay once the porch is quiet again
      return view.playing ? [{ type: "stop" }] : [];
    }
    if ((view.playing === "ambience" && !view.ambience) || (view.playing === "lure" && !view.lure)) {
      this.nextAmbienceAt = null;
      return [{ type: "stop" }];
    }

    const farInView = this.farSince !== null && this.lastFarAt - this.farSince >= o.lureSeenMs && now - this.lastFarAt <= o.lureDropoutMs;
    if (
      view.lure &&
      view.lureClips > 0 &&
      farInView &&
      view.playing !== "lure" &&
      now >= this.nextLureAt &&
      now - this.lastActiveAt >= o.lureAfterVisitMs
    ) {
      const clip = pickDifferent(view.lureClips, this.lastClip, this.random);
      this.lastClip = clip;
      this.nextLureAt = now + o.lureCooldownMs + this.random() * o.lureJitterMs;
      this.nextAmbienceAt = null;
      const lure: AmbienceAction = { type: "lure", clip };
      return view.playing === "ambience" ? [{ type: "stop" }, lure] : [lure];
    }

    if (!view.ambience) {
      this.nextAmbienceAt = null;
      return [];
    }
    if (this.nextAmbienceAt === null) {
      this.nextAmbienceAt = now + this.ambienceDelay();
      return [];
    }
    if (now < this.nextAmbienceAt || view.playing !== null) return [];
    const index = pickDifferent(AMBIENT_SOUNDS.length, this.lastSound, this.random);
    this.lastSound = index;
    this.nextAmbienceAt = now + this.ambienceDelay();
    return [{ type: "ambience", sound: AMBIENT_SOUNDS[index]! }];
  }

  private ambienceDelay(): number {
    const { ambienceMinMs: min, ambienceMaxMs: max } = this.opts;
    return min + this.random() * Math.max(0, max - min);
  }

  /** Someone far away counts as "in view" once seen for lureSeenMs, tolerating short dropouts. */
  private trackFarAway(view: PorchView, now: number): void {
    const far = view.porchEmpty && view.farPeople > 0;
    if (far) {
      if (this.farSince === null || now - this.lastFarAt > this.opts.lureDropoutMs) this.farSince = now;
      this.lastFarAt = now;
    } else if (now - this.lastFarAt > this.opts.lureDropoutMs) {
      this.farSince = null;
    }
  }
}
