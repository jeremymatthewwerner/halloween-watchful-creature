import type { Engine, GreetReason } from "./engines/types.ts";
import { OfflineFallback, type OfflineOptions } from "./offline.ts";
import type { VisitorEvent } from "./visitors.ts";

export interface DirectorOptions {
  /** Close the voice session after the porch has been empty this long. */
  idleCloseMs: number;
  /** While visitors are present, refresh what the creature sees this often. */
  backgroundMs: number;
  /** Check presence gaps for someone new at most this often. */
  recheckCooldownMs: number;
  /** A session woken early for a sighting closes after this long if nobody actually arrives. */
  sightingGraceMs: number;
  /**
   * The mic stays on this long after visitors "leave". The camera loses people who stand close, at
   * the edge of the frame or in the dark, and muting at once meant she couldn't hear them.
   */
  micGraceMs: number;
  /** Offline mode's timings (web/offline.ts); the defaults if left out. */
  offline?: Partial<OfflineOptions>;
}

/** Recorded greetings (local audio), for when the live voice can't start. */
export interface RecordedGreetings {
  /** How many are loaded (0: none, so offline mode stays silent). */
  count(): number;
  /** Plays one; returns its text, or undefined if it couldn't. */
  play(index: number): string | undefined;
  /** Whether a recorded clip is playing now. */
  playing(): boolean;
  stop(): void;
}

export interface DirectorDeps {
  engine: Engine;
  capture(): string | null;
  /** Whether the creature's voice is audible right now. */
  isSpeaking(): boolean;
  now(): number;
  log(message: string): void;
  recorded?: RecordedGreetings;
  /** Going offline (true) and back to the live voice (false), for the alert and the server log. */
  onOffline?(offline: boolean, detail: string): void;
  /** Resolves after `ms` (default: a timer); tests pass their own. */
  wait?(ms: number): Promise<void>;
  random?(): number;
}

/** A greeting a recorded clip stood in for, which the live voice gives once it's back. */
interface Owed {
  reason: GreetReason;
  awayMs?: number;
}

/**
 * The behavior brain: reacts to visitors arriving and leaving, keeps the creature's
 * view fresh, gates the mic, and sleeps the (billed) voice session when nobody's around.
 * When the voice session can't start, it plays recorded greetings and keeps retrying (offline mode).
 */
export class Director {
  /** When false (kill switch), the director never connects or greets on its own. */
  autopilot = true;
  readonly fallback: OfflineFallback;
  private present = false;
  /** While nobody's present: when to sleep the voice session (null: not scheduled). */
  private idleCloseAt: number | null = null;
  /** After visitors left: when to mute the mic, if nobody's back by then (null: not scheduled). */
  private muteAt: number | null = null;
  private lastObserveAt = 0;
  private lastRecheckAt = -Infinity;
  private connecting: Promise<boolean> | null = null;
  private owed: Owed | null = null;
  /** The session dropped mid-visit: once it's back, catch up silently (they were greeted already). */
  private catchUp = false;
  private warnedNoClips = false;
  /** The group in view (the tracker's count) and how many times it has grown this visit, for big-group mode. */
  private count = 0;
  private grows = 0;

  constructor(
    private readonly deps: DirectorDeps,
    private readonly opts: DirectorOptions,
  ) {
    deps.engine.setMicEnabled(false);
    this.fallback = new OfflineFallback(opts.offline, deps.random);
  }

  get visitorsPresent(): boolean {
    return this.present;
  }

  /** The live voice isn't working: recorded greetings, retrying in the background. */
  get offline(): boolean {
    return this.fallback.offline;
  }

  async onVisitorEvent(event: VisitorEvent): Promise<void> {
    const { engine, log } = this.deps;
    switch (event.type) {
      case "sighted":
        // Someone just came into view: start waking the voice session now, so it's (nearly)
        // ready by the time they count as arrived. If they don't, it goes back to sleep soon.
        if (!this.autopilot || this.present || engine.status !== "closed") return;
        if (this.offline && !this.fallback.retryDue(this.deps.now())) return;
        log(this.offline ? "Someone's coming into view: trying the live voice again" : "Someone's coming into view: waking the voice session");
        this.idleCloseAt = this.deps.now() + this.opts.sightingGraceMs;
        void this.ensureOpen();
        break;
      case "arrived":
        this.present = true;
        this.idleCloseAt = null;
        this.muteAt = null;
        this.count = event.count;
        this.grows = 0;
        if (!this.autopilot) return;
        log(`Visitors arrived (${event.count})`);
        engine.setMicEnabled(true);
        await this.greetOrRecord({ reason: "arrived" });
        break;
      case "grew":
        this.count = event.count;
        this.grows++;
        if (!this.autopilot) return;
        if (engine.status !== "open") {
          if (this.offline) {
            log(`More visitors (${event.from} → ${event.count}), but the live voice is offline`);
            this.playRecorded("more visitors", { reason: "grew" });
          }
          return;
        }
        log(`More visitors (${event.from} → ${event.count})`);
        await this.greet("grew");
        break;
      case "returned": {
        this.present = true;
        this.idleCloseAt = null;
        this.muteAt = null;
        this.count = event.count;
        this.grows = 0;
        if (!this.autopilot) return;
        engine.setMicEnabled(true);
        // Same people or the next group? The engine compares a fresh look with the last group:
        // new visitors get a full greeting, the same ones get silence or a quick welcome back.
        log(`Someone's here after ${Math.round(event.awayMs / 1000)}s; checking whether they're new`);
        await this.greetOrRecord({ reason: "returned", awayMs: event.awayMs });
        break;
      }
      case "gap": {
        this.count = event.count;
        const seconds = Math.round(event.awayMs / 1000);
        if (!this.autopilot || engine.status !== "open") return;
        if (this.deps.now() - this.lastRecheckAt < this.opts.recheckCooldownMs) {
          log(`Nobody in view for ${seconds}s, then someone again (checked recently)`);
          return;
        }
        log(`Nobody in view for ${seconds}s, then someone again: checking for someone new`);
        this.lastRecheckAt = this.lastObserveAt = this.deps.now();
        const frame = this.deps.capture();
        if (frame) await engine.recheck(frame);
        break;
      }
      case "left":
        this.present = false;
        this.count = this.grows = 0;
        this.idleCloseAt = this.deps.now() + this.opts.idleCloseMs;
        // Nobody to greet or catch up with any more.
        this.owed = null;
        this.catchUp = false;
        log("Visitors left");
        // Not muted yet: someone just out of frame may still be talking (see micGraceMs).
        if (this.autopilot) this.muteAt = this.deps.now() + this.opts.micGraceMs;
        break;
    }
  }

  /** Call about once a second. */
  async tick(): Promise<void> {
    const { engine, now, log } = this.deps;
    if (!this.autopilot) return;
    const t = now();
    if (!this.present && this.muteAt !== null && t >= this.muteAt) {
      this.muteAt = null;
      engine.setMicEnabled(false);
    }
    if (this.present) {
      if (engine.status === "closed") {
        // The session expired, dropped mid-visit or never started: reconnect (on the retry schedule).
        if (this.connecting || !this.fallback.retryDue(t)) return;
        log(this.offline ? "Offline: trying the live voice again" : "Reconnecting voice session");
        engine.setMicEnabled(true);
        const wasOffline = this.offline;
        if (!this.owed) this.catchUp = true;
        if (await this.within(this.ensureOpen())) await this.resumeLive();
        // A drop mid-visit gets one recorded line instead of silence (not every retry after it).
        else if (!wasOffline && this.present) this.playRecorded("the voice session dropped", null);
        return;
      }
      if (engine.status === "open" && (this.owed || this.catchUp)) {
        await this.resumeLive();
        return;
      }
      if (engine.status === "open" && t - this.lastObserveAt >= this.opts.backgroundMs && !this.busy()) {
        await this.observe();
      }
    } else if (engine.status === "open" && this.idleCloseAt !== null && t >= this.idleCloseAt && !this.busy()) {
      this.deps.log("Porch is empty: sleeping the voice session");
      this.idleCloseAt = null;
      await engine.close();
    } else if (this.offline && engine.status === "closed" && !this.connecting && this.fallback.retryDue(t)) {
      // Nobody's here: check now whether the live voice works again, so the next visitor gets it.
      log("Offline: checking whether the live voice works again");
      if ((await this.ensureOpen()) && !this.present) {
        log("The live voice works again: sleeping it until visitors arrive");
        await engine.close();
      }
    }
  }

  /** Operator button: greet whoever is there now (connecting if needed). */
  async greetNow(): Promise<void> {
    this.deps.engine.setMicEnabled(true);
    // On an empty porch (the owner checking it works, say), still sleep again if nobody comes:
    // otherwise nothing schedules the close and the billed session stays open until visitors leave.
    if (!this.present) this.idleCloseAt = this.deps.now() + this.opts.idleCloseMs;
    await this.greetOrRecord({ reason: "manual" }, true);
  }

  /**
   * Operator "Make it say…": says `text` now, waking the voice session first if it's asleep (on an
   * empty porch it sleeps again after the idle timeout, like Greet now). False if it couldn't connect.
   */
  async say(text: string): Promise<boolean> {
    const { engine } = this.deps;
    engine.setMicEnabled(true);
    if (!this.present) this.idleCloseAt = this.deps.now() + this.opts.idleCloseMs;
    if (!(await this.ensureOpen(true))) return false;
    engine.say(text);
    return true;
  }

  /** Kill switch: stop talking, close the session and stay asleep until re-enabled. */
  async sleep(): Promise<void> {
    this.autopilot = false;
    this.owed = null;
    this.catchUp = false;
    this.muteAt = null;
    this.deps.recorded?.stop();
    this.deps.engine.setMicEnabled(false);
    await this.deps.engine.close();
  }

  wake(): void {
    this.autopilot = true;
    if (this.present) this.deps.engine.setMicEnabled(true);
  }

  private busy(): boolean {
    return this.deps.isSpeaking() || this.deps.engine.isThinking();
  }

  /**
   * Greets live if the session opens within connectTimeoutMs (the engine starts looking meanwhile),
   * else plays a recorded greeting and owes the live one. Known to be offline: records right away.
   */
  private async greetOrRecord(want: Owed, force = false): Promise<void> {
    const { engine } = this.deps;
    this.lastObserveAt = this.deps.now();
    if (this.offline && !force && engine.status !== "open") {
      this.playRecorded("offline", want);
      void this.ensureOpen(); // a retry, if one is due; tick() greets live once it works
      return;
    }
    const ready = this.within(this.ensureOpen(force));
    const greeting = engine.greet(this.deps.capture(), want.reason, { awayMs: want.awayMs, count: this.count, grows: this.grows, ready });
    if (!(await ready)) this.playRecorded(this.offline ? "offline" : "the live voice is slow to connect", want, force);
    await greeting;
  }

  /**
   * `ready`: the session connecting; the engine looks meanwhile and greets once it's open.
   * The group's size goes along, so a big group gets one quick group greeting (web/bigGroup.ts).
   */
  private async greet(reason: GreetReason, opts: { awayMs?: number } = {}, ready?: Promise<boolean>): Promise<void> {
    this.lastObserveAt = this.deps.now();
    await this.deps.engine.greet(this.deps.capture(), reason, { ...opts, count: this.count, grows: this.grows, ready });
  }

  private async observe(): Promise<void> {
    this.lastObserveAt = this.deps.now();
    const frame = this.deps.capture();
    if (frame) await this.deps.engine.observe(frame);
  }

  /** The live voice is back mid-visit: give the greeting a recording stood in for, or catch up silently. */
  private async resumeLive(): Promise<void> {
    // Let a recorded line (or anything else) finish first; the next tick tries again.
    if (this.deps.recorded?.playing() || this.busy()) return;
    const owed = this.owed;
    this.owed = null;
    this.catchUp = false;
    if (owed) {
      this.deps.log("The live voice is back: greeting the visitors properly");
      await this.greet(owed.reason, { awayMs: owed.awayMs });
    } else {
      await this.observe();
    }
  }

  /** Plays a recorded greeting (never the last one again, at most one per cooldown), noting what the live voice owes. */
  private playRecorded(why: string, owed: Owed | null, force = false): void {
    // The first owed greeting wins: an arrival's full greeting covers a group that grew meanwhile.
    if (owed && !this.owed) this.owed = owed;
    const recorded = this.deps.recorded;
    const count = recorded?.count() ?? 0;
    if (!recorded || !count) {
      if (!this.warnedNoClips) this.deps.log("No recorded greetings loaded: staying quiet until the live voice works");
      this.warnedNoClips = true;
      return;
    }
    if (recorded.playing() || this.deps.isSpeaking()) return;
    const clip = this.fallback.pickClip(count, this.deps.now(), force);
    if (clip === null) return;
    const text = recorded.play(clip);
    if (text) this.deps.log(`Recorded greeting (${why}): "${text}"`);
  }

  /** `ready`, or false if it hasn't resolved within connectTimeoutMs (the connection carries on). */
  private within(ready: Promise<boolean>): Promise<boolean> {
    const ms = this.fallback.opts.connectTimeoutMs;
    if (this.deps.wait) return Promise.race([ready, this.deps.wait(ms).then(() => false)]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void ready.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  private ensureOpen(force = false): Promise<boolean> {
    const { engine, now } = this.deps;
    if (engine.status === "open") return Promise.resolve(true);
    // After a failed start (bad key, no network), retry on the backoff schedule, not on every event.
    if (!force && !this.connecting && !this.fallback.retryDue(now())) return Promise.resolve(false);
    this.connecting ??= this.attempt().finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** One start; everyone waiting on it shares the outcome, so a failure is counted once. */
  private async attempt(): Promise<boolean> {
    const { engine, now, log } = this.deps;
    try {
      await engine.connect();
    } catch (err) {
      const message = (err as Error).message;
      const wentOffline = this.fallback.failed(now());
      const retry = `next try in ${Math.round(this.fallback.retryIn(now()) / 1000)} s`;
      if (wentOffline) {
        log(`Could not start voice session: ${message}. Offline mode: recorded greetings until the live voice works (${retry})`);
        this.deps.onOffline?.(true, message);
      } else {
        log(`Could not start voice session: ${message} (still offline; ${retry})`);
      }
      return false;
    }
    // Re-read: connect() changed the status since it was last checked.
    const status: string = engine.status;
    if (status !== "open") return false;
    const offlineMs = this.fallback.recovered(now());
    if (offlineMs !== null) {
      const detail = `live voice back after ${duration(offlineMs)} offline`;
      log(`Back online: ${detail}`);
      this.deps.onOffline?.(false, detail);
    }
    return true;
  }
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}
