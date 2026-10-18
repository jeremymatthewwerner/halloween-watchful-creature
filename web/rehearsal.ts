/**
 * Rehearsal mode: pretend visitors walk up, using sample images instead of the real camera.
 *
 * It plugs into the normal pipeline through two seams, so nothing downstream changes:
 * - `capture(real)`: the camera frame the Director and engine send to vision. While rehearsing,
 *   it's the chosen sample image (or nothing when no pretend visitor is in view).
 * - `detections(real)`: the person boxes fed to the VisitorTracker. While rehearsing, they're
 *   synthetic boxes for the pretend visitors and the real detector isn't run at all.
 * The tracker and Director then do exactly what they'd do for real people (arrived, gap, grew,
 * left, returned), and the real voice and vision APIs answer (and bill) as usual.
 *
 * Pure logic (no DOM) so it can be unit tested with fake timers.
 */
import type { DetectedPerson } from "./vision.ts";

export interface RehearsalImage {
  name: string;
  /** A data:image/... URL, kept in memory only. */
  dataUrl: string;
  source: "upload" | "log";
}

export type RehearsalAction = "arrive" | "leave" | "swap" | "join";

export type ScriptStep = { do: RehearsalAction; label?: string } | { waitMs: number };

/** Arrive, swap costume, leave, and come back: exercises arrived, gap/recheck, left and returned. */
export const DEFAULT_SCRIPT: readonly ScriptStep[] = [
  { do: "arrive" },
  { waitMs: 20_000 },
  { do: "swap" },
  { waitMs: 10_000 },
  { do: "leave" },
  { waitMs: 15_000 },
  { do: "arrive", label: "returns" },
];

export interface RehearsalOptions {
  /**
   * "Swap" steps out of view this long before coming back with the next image. Longer than the
   * tracker's gapMs (2 s) and shorter than leaveMs (8 s), so it reads as a gap: maybe someone new.
   */
  swapGapMs: number;
  /** Box area (fraction of the frame) of each pretend visitor: above any "how close" setting. */
  boxArea: number;
}

export const DEFAULT_REHEARSAL_OPTIONS: RehearsalOptions = { swapGapMs: 3000, boxArea: 0.24 };

export interface RehearsalDeps {
  log(text: string): void;
  /** Epoch ms, for marking which log lines happened during a rehearsal. */
  now?(): number;
}

/** What the panel shows; sent to listeners on every change. */
export interface RehearsalSnapshot {
  active: boolean;
  people: number;
  /** True while a swap has the pretend visitor out of view. */
  steppedOut: boolean;
  image: RehearsalImage | null;
  index: number;
  imageCount: number;
  /** "step 3/7: swap", or null when no script is running. */
  script: string | null;
}

const describeStep = (step: ScriptStep): string =>
  "waitMs" in step ? `wait ${Math.round(step.waitMs / 1000)} s` : (step.label ?? step.do);

export class Rehearsal {
  private _active = false;
  private people = 0;
  private steppedOut = false;
  private swapTimer: ReturnType<typeof setTimeout> | null = null;
  private images: RehearsalImage[] = [];
  private index = 0;
  private scriptRun = 0;
  private scriptStatus: string | null = null;
  private cancelWait: (() => void) | null = null;
  /** When rehearsals ran (epoch ms); `to` is null while one is running. */
  private windows: { from: number; to: number | null }[] = [];
  private readonly listeners = new Set<(s: RehearsalSnapshot) => void>();
  private readonly opts: RehearsalOptions;
  private readonly now: () => number;

  constructor(
    private readonly deps: RehearsalDeps,
    options: Partial<RehearsalOptions> = {},
  ) {
    this.opts = { ...DEFAULT_REHEARSAL_OPTIONS, ...options };
    this.now = deps.now ?? Date.now;
  }

  get active(): boolean {
    return this._active;
  }

  // --- seams ---

  /** The frame to send to vision: the sample image while rehearsing, else the real camera's. */
  capture(real: () => string | null): string | null {
    if (!this._active) return real();
    return this.visible() > 0 ? (this.images[this.index]?.dataUrl ?? null) : null;
  }

  /**
   * Person boxes for the tracker: synthetic ones while rehearsing (the real detector isn't
   * called, so real people in front of the camera are ignored), else the real ones.
   */
  detections<T>(real: () => T): T | DetectedPerson[] {
    if (!this._active) return real();
    const n = this.visible();
    const w = Math.min(0.3, 0.9 / Math.max(n, 1));
    const h = Math.min(0.95, this.opts.boxArea / w);
    return Array.from({ length: n }, (_, i) => ({
      x: 0.05 + i * (0.9 / n) + (0.9 / n - w) / 2,
      y: Math.max(0, 0.95 - h),
      w,
      h,
      area: w * h,
      score: 1,
    }));
  }

  /** Whether something logged at this time (epoch ms) happened during a rehearsal. */
  wasActiveAt(at: number): boolean {
    return this.windows.some((w) => at >= w.from && (w.to === null || at <= w.to));
  }

  // --- images ---

  addImages(images: readonly RehearsalImage[]): void {
    if (!images.length) return;
    const wasEmpty = this.images.length === 0;
    this.images.push(...images);
    if (wasEmpty) this.index = 0;
    this.changed();
  }

  removeImage(i: number): void {
    if (i < 0 || i >= this.images.length) return;
    this.images.splice(i, 1);
    if (this.index >= this.images.length) this.index = Math.max(0, this.images.length - 1);
    else if (i < this.index) this.index--;
    this.changed();
  }

  clearImages(): void {
    this.images = [];
    this.index = 0;
    this.changed();
  }

  /** Makes image `i` the camera frame right away (no gap): the next background look sees it. */
  select(i: number): void {
    if (i < 0 || i >= this.images.length) return;
    this.index = i;
    this.changed();
  }

  get imageList(): readonly RehearsalImage[] {
    return this.images;
  }

  // --- on / off ---

  start(): void {
    if (this._active) return;
    this._active = true;
    this.people = 0;
    this.steppedOut = false;
    this.windows.push({ from: this.now(), to: null });
    if (this.windows.length > 50) this.windows.shift();
    this.deps.log("REHEARSAL on: the real camera is ignored; pretend visitors use the real voice and vision APIs (billed as usual)");
    this.changed();
  }

  stop(): void {
    if (!this._active) return;
    this.stopScript();
    this.clearSwap();
    this.people = 0;
    this._active = false;
    const open = this.windows.at(-1);
    if (open && open.to === null) open.to = this.now();
    this.deps.log("REHEARSAL off: back to the real camera");
    this.changed();
  }

  // --- pretend visitors ---

  /** Runs one action; returns a reason if it can't. */
  act(action: RehearsalAction): string | null {
    if (!this._active) return "Turn rehearsal on first";
    if ((action === "arrive" || action === "join") && !this.images.length) return "Add a sample image first";
    switch (action) {
      case "arrive":
        if (this.people > 0 && !this.steppedOut) return "A pretend visitor is already here";
        this.clearSwap();
        this.people = Math.max(1, this.people);
        this.deps.log(`Rehearsal: a visitor arrives (${this.imageName()})`);
        break;
      case "leave":
        if (this.people === 0) return "Nobody's here";
        this.clearSwap();
        this.people = 0;
        this.deps.log("Rehearsal: the visitors leave");
        break;
      case "join":
        this.people = Math.max(2, this.people + 1);
        this.deps.log(`Rehearsal: another visitor joins (${this.people} now, ${this.imageName()})`);
        break;
      case "swap": {
        if (this.images.length < 2) return "Add a second image to swap to";
        this.index = (this.index + 1) % this.images.length;
        if (this.people === 0) {
          this.deps.log(`Rehearsal: next image ready (${this.imageName()})`);
          break;
        }
        // Out of view for a few seconds, then back in the new costume: the tracker reports a gap.
        this.clearSwap();
        this.steppedOut = true;
        this.deps.log(`Rehearsal: visitor steps out for ${Math.round(this.opts.swapGapMs / 1000)} s and comes back as ${this.imageName()}`);
        this.swapTimer = setTimeout(() => {
          this.swapTimer = null;
          this.steppedOut = false;
          this.changed();
        }, this.opts.swapGapMs);
        break;
      }
    }
    this.changed();
    return null;
  }

  /**
   * Runs a timed sequence of actions. Starting another script, or stopping rehearsal, cancels it.
   * Resolves when it finishes or is cancelled; a step that can't run is logged and skipped.
   */
  async runScript(steps: readonly ScriptStep[] = DEFAULT_SCRIPT): Promise<void> {
    if (!this._active) {
      this.deps.log("Rehearsal: turn rehearsal on first");
      return;
    }
    this.stopScript();
    const run = ++this.scriptRun;
    this.deps.log(`Rehearsal script: ${steps.map(describeStep).join(", ")}`);
    for (const [i, step] of steps.entries()) {
      if (run !== this.scriptRun) return;
      this.scriptStatus = `step ${i + 1}/${steps.length}: ${describeStep(step)}`;
      this.changed();
      if ("waitMs" in step) {
        if (!(await this.wait(step.waitMs))) return;
      } else {
        const problem = this.act(step.do);
        if (problem) this.deps.log(`Rehearsal script: skipped "${describeStep(step)}" (${problem})`);
      }
    }
    if (run !== this.scriptRun) return;
    this.scriptStatus = null;
    this.deps.log("Rehearsal script done");
    this.changed();
  }

  stopScript(): void {
    if (this.scriptStatus === null) return;
    this.scriptRun++;
    this.cancelWait?.();
    this.scriptStatus = null;
    this.deps.log("Rehearsal script stopped");
    this.changed();
  }

  get scriptRunning(): boolean {
    return this.scriptStatus !== null;
  }

  snapshot(): RehearsalSnapshot {
    return {
      active: this._active,
      people: this.people,
      steppedOut: this.steppedOut,
      image: this.images[this.index] ?? null,
      index: this.index,
      imageCount: this.images.length,
      script: this.scriptStatus,
    };
  }

  onChange(listener: (s: RehearsalSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private visible(): number {
    return this.steppedOut ? 0 : this.people;
  }

  private imageName(): string {
    return this.images[this.index]?.name ?? "no image";
  }

  private clearSwap(): void {
    if (this.swapTimer) clearTimeout(this.swapTimer);
    this.swapTimer = null;
    this.steppedOut = false;
  }

  /** Resolves true after `ms`, or false if the script is cancelled first. */
  private wait(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelWait = null;
        resolve(true);
      }, ms);
      this.cancelWait = () => {
        clearTimeout(timer);
        this.cancelWait = null;
        resolve(false);
      };
    });
  }

  private changed(): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }
}

/** The days in the server's log list page (/api/session-logs), in its order (newest first). */
export function logDays(html: string): string[] {
  const days = [...html.matchAll(/\/api\/session-logs\/(\d{4}-\d\d-\d\d)\/log\.html/g)].map((m) => m[1]!);
  return [...new Set(days)];
}
