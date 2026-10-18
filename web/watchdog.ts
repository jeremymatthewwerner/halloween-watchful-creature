/**
 * The dashboard's watchdog: notices trouble (camera frames stopped, the person detector failing,
 * the voice session failing to start again and again) and decides what to do: restart the camera,
 * raise an alert, or reload the page (which then wakes again by itself, see loadResume).
 * DOM-free and driven by the caller's clock, so it can be tested with fake time.
 */
import type { AlertKind } from "../shared/remote.ts";

export interface WatchdogOptions {
  /** No new camera frame for this long counts as the camera lost. */
  cameraStallMs: number;
  /** After restarting a stalled camera, reload if frames still haven't come back after this long. */
  cameraRestartGraceMs: number;
  /** This many detector errors in a row means it's broken (it runs ~5 times a second). */
  detectorErrorLimit: number;
  /** Reload after this many voice-session starts in a row failed. */
  voiceFailLimit: number;
  /** Alert when this many voice-session errors happen within `voiceErrorWindowMs`. */
  voiceErrorLimit: number;
  voiceErrorWindowMs: number;
  /** Never reload sooner than this after the page loaded (no reload loops). */
  minUptimeMs: number;
  /** At most this many automatic reloads per `reloadWindowMs`; then only alert. */
  maxReloads: number;
  reloadWindowMs: number;
  /**
   * Whether failing voice sessions may reload the page. Only worth it when the page is known to wake
   * by itself after a reload (sound allowed without a click); otherwise a reload would leave the
   * creature waiting for a click instead of retrying, so it only alerts.
   */
  reloadForVoice: boolean;
}

export const WATCHDOG_DEFAULTS: WatchdogOptions = {
  cameraStallMs: 15_000,
  cameraRestartGraceMs: 20_000,
  detectorErrorLimit: 25,
  voiceFailLimit: 5,
  voiceErrorLimit: 5,
  voiceErrorWindowMs: 5 * 60_000,
  minUptimeMs: 60_000,
  maxReloads: 3,
  reloadWindowMs: 60 * 60_000,
  reloadForVoice: true,
};

export type WatchdogAction =
  | { type: "restartCamera" }
  | { type: "alert"; kind: AlertKind; detail: string }
  | { type: "resolve"; kind: AlertKind }
  | { type: "reload"; reason: string };

type VoiceStatus = "closed" | "connecting" | "open" | "closing";

export class Watchdog {
  private readonly opts: WatchdogOptions;
  private reloads: number[];
  private cameraArmed = false;
  private visible = true;
  private lastCameraTime = NaN;
  private lastFrameAt = 0;
  private cameraRestartedAt: number | null = null;
  private cameraAlerted = false;
  private detectorErrors = 0;
  private detectorBroken: string | null = null;
  private detectorAlerted = false;
  private voice: VoiceStatus = "closed";
  private voiceFails = 0;
  private voiceErrors: number[] = [];
  private voiceAlerted = false;
  private wantReload: string | null = null;
  private gaveUpAlerted = false;
  private reloading = false;
  private queued: WatchdogAction[] = [];

  /** `reloads`: when earlier automatic reloads happened (epoch ms), saved across reloads. */
  constructor(
    private readonly startedAt: number,
    reloads: readonly number[] = [],
    opts: Partial<WatchdogOptions> = {},
  ) {
    this.opts = { ...WATCHDOG_DEFAULTS, ...opts };
    this.reloads = [...reloads];
  }

  /** Earlier reloads plus the one just decided on, to save before reloading. */
  get reloadHistory(): number[] {
    return [...this.reloads];
  }

  /** The camera was (re)started: watch for frames from now on. */
  cameraStarted(now: number): void {
    this.cameraArmed = true;
    this.lastFrameAt = now;
    this.lastCameraTime = NaN;
  }

  /** Call often with the video element's currentTime: it only moves while frames arrive. */
  cameraTime(time: number, now: number): void {
    if (!this.cameraArmed) return;
    if (time === this.lastCameraTime) return;
    const first = Number.isNaN(this.lastCameraTime);
    this.lastCameraTime = time;
    if (first && this.cameraRestartedAt === null && !this.cameraAlerted) {
      this.lastFrameAt = now;
      return;
    }
    this.lastFrameAt = now;
    this.cameraRestartedAt = null;
    if (this.cameraAlerted) {
      this.cameraAlerted = false;
      this.queued.push({ type: "resolve", kind: "camera-lost" });
    }
  }

  /**
   * Hidden tabs may get their video paused or throttled by the browser: don't count that as the camera
   * dying. The stall clock starts over when the page is shown again.
   */
  setVisible(visible: boolean, now: number): void {
    if (visible && !this.visible) this.lastFrameAt = now;
    this.visible = visible;
  }

  get cameraStalled(): boolean {
    return this.cameraAlerted;
  }

  detectorOk(): void {
    this.detectorErrors = 0;
  }

  detectorError(message: string): void {
    if (++this.detectorErrors >= this.opts.detectorErrorLimit) this.detectorBroken ??= `${this.detectorErrors} errors in a row: ${message}`;
  }

  detectorLoadFailed(message: string): void {
    this.detectorBroken ??= `failed to load: ${message}`;
  }

  voiceStatus(status: VoiceStatus): void {
    if (status === "open") {
      this.voiceFails = 0;
      if (this.voiceAlerted) {
        this.voiceAlerted = false;
        this.queued.push({ type: "resolve", kind: "voice-errors" });
      }
    } else if (status === "closed" && this.voice === "connecting") {
      this.voiceFails++;
    }
    this.voice = status;
  }

  voiceError(now: number): void {
    this.voiceErrors = [...this.voiceErrors.filter((at) => now - at < this.opts.voiceErrorWindowMs), now];
  }

  /** Call every couple of seconds; returns what to do now. */
  check(now: number): WatchdogAction[] {
    if (this.reloading) return [];
    const actions = this.queued;
    this.queued = [];

    // Camera: restart it once, then reload if that didn't bring frames back.
    if (this.cameraArmed && this.visible && now - this.lastFrameAt >= this.opts.cameraStallMs) {
      if (this.cameraRestartedAt === null && !this.cameraAlerted) {
        this.cameraAlerted = true;
        this.cameraRestartedAt = now;
        actions.push({ type: "alert", kind: "camera-lost", detail: `no camera frames for ${Math.round((now - this.lastFrameAt) / 1000)} s; restarting the camera` });
        actions.push({ type: "restartCamera" });
      } else if (this.cameraRestartedAt !== null && now - this.cameraRestartedAt >= this.opts.cameraRestartGraceMs) {
        this.wantReload ??= "the camera stopped sending frames";
      }
    }

    if (this.detectorBroken) {
      if (!this.detectorAlerted) {
        this.detectorAlerted = true;
        actions.push({ type: "alert", kind: "detector-failed", detail: this.detectorBroken });
      }
      this.wantReload ??= `the person detector ${this.detectorBroken}`;
    }

    const recentErrors = this.voiceErrors.filter((at) => now - at < this.opts.voiceErrorWindowMs).length;
    if (!this.voiceAlerted && (this.voiceFails >= this.opts.voiceFailLimit || recentErrors >= this.opts.voiceErrorLimit)) {
      this.voiceAlerted = true;
      actions.push({
        type: "alert",
        kind: "voice-errors",
        detail: this.voiceFails >= this.opts.voiceFailLimit ? `${this.voiceFails} voice-session starts failed in a row` : `${recentErrors} voice-session errors in 5 min`,
      });
    }
    if (this.opts.reloadForVoice && this.voiceFails >= this.opts.voiceFailLimit) this.wantReload ??= `${this.voiceFails} voice-session starts failed in a row`;

    if (this.wantReload) {
      this.reloads = this.reloads.filter((at) => now - at < this.opts.reloadWindowMs);
      if (this.reloads.length >= this.opts.maxReloads) {
        if (!this.gaveUpAlerted) {
          this.gaveUpAlerted = true;
          actions.push({
            type: "alert",
            kind: "watchdog-reload",
            detail: `Not reloading again (already ${this.reloads.length} times in the last hour): ${this.wantReload}. Needs a look.`,
          });
        }
      } else if (now - this.startedAt >= this.opts.minUptimeMs) {
        this.reloading = true;
        this.reloads.push(now);
        actions.push({ type: "reload", reason: this.wantReload });
      }
    }
    return actions;
  }
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RESUME_KEY = "creature.resume";
const RELOADS_KEY = "creature.watchdogReloads";
/** A page (re)loaded within this long of being awake picks up where it left off. */
export const RESUME_WITHIN_MS = 15 * 60_000;

export interface ResumeState {
  /** Was awake (camera, mic and voice set up). */
  awake: boolean;
  /** Autopilot was on (kill switch off). */
  autopilot: boolean;
  /** Epoch ms; refreshed while awake. */
  at: number;
  /** Set when the watchdog reloaded the page. */
  reloadReason?: string;
}

/** Whether this page load should wake by itself, and with the kill switch on or off. */
export function loadResume(store: Store | null, now: number): ResumeState | null {
  try {
    const saved = JSON.parse(store?.getItem(RESUME_KEY) ?? "null") as Partial<ResumeState> | null;
    if (!saved || saved.awake !== true || typeof saved.at !== "number" || now - saved.at > RESUME_WITHIN_MS || saved.at > now + 60_000) return null;
    return { awake: true, autopilot: saved.autopilot !== false, at: saved.at, reloadReason: typeof saved.reloadReason === "string" ? saved.reloadReason : undefined };
  } catch {
    return null;
  }
}

export function saveResume(store: Store | null, state: ResumeState): void {
  try {
    store?.setItem(RESUME_KEY, JSON.stringify(state));
  } catch {
    /* private mode: a reload just won't resume */
  }
}

export function loadReloads(store: Store | null): number[] {
  try {
    const list = JSON.parse(store?.getItem(RELOADS_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function saveReloads(store: Store | null, reloads: readonly number[]): void {
  try {
    store?.setItem(RELOADS_KEY, JSON.stringify(reloads.slice(-10)));
  } catch {
    /* ignore */
  }
}

/**
 * Starts (or resumes) an AudioContext. Browsers keep it suspended until someone clicks the page,
 * unless Chrome runs with --autoplay-policy=no-user-gesture-required; resume() then never settles,
 * so give up after `timeoutMs`. Returns whether sound is allowed.
 */
export async function resumeAudio(ctx: { state: string; resume(): Promise<void> }, timeoutMs: number): Promise<boolean> {
  if (ctx.state === "running") return true;
  await Promise.race([ctx.resume().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  return ctx.state === "running";
}
