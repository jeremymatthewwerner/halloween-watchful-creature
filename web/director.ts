import type { Engine, GreetReason } from "./engines/types.ts";
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
}

export interface DirectorDeps {
  engine: Engine;
  capture(): string | null;
  /** Whether the creature's voice is audible right now. */
  isSpeaking(): boolean;
  now(): number;
  log(message: string): void;
}

/**
 * The behavior brain: reacts to visitors arriving and leaving, keeps the creature's
 * view fresh, gates the mic, and sleeps the (billed) voice session when nobody's around.
 */
export class Director {
  /** When false (kill switch), the director never connects or greets on its own. */
  autopilot = true;
  private present = false;
  /** While nobody's present: when to sleep the voice session (null: not scheduled). */
  private idleCloseAt: number | null = null;
  private lastObserveAt = 0;
  private lastRecheckAt = -Infinity;
  private connecting: Promise<void> | null = null;
  private retryAt = 0;
  /** Visitors are here but weren't greeted (their session failed to start): greet them on reconnect. */
  private owedGreeting = false;

  constructor(
    private readonly deps: DirectorDeps,
    private readonly opts: DirectorOptions,
  ) {
    deps.engine.setMicEnabled(false);
  }

  get visitorsPresent(): boolean {
    return this.present;
  }

  async onVisitorEvent(event: VisitorEvent): Promise<void> {
    const { engine, log } = this.deps;
    switch (event.type) {
      case "sighted":
        // Someone just came into view: start waking the voice session now, so it's (nearly)
        // ready by the time they count as arrived. If they don't, it goes back to sleep soon.
        if (!this.autopilot || this.present || engine.status !== "closed") return;
        log("Someone's coming into view: waking the voice session");
        this.idleCloseAt = this.deps.now() + this.opts.sightingGraceMs;
        void this.ensureOpen();
        break;
      case "arrived":
        this.present = true;
        this.idleCloseAt = null;
        if (!this.autopilot) return;
        log(`Visitors arrived (${event.count})`);
        engine.setMicEnabled(true);
        // The engine starts looking right away, while the session finishes connecting.
        await this.greetWhenOpen("arrived");
        break;
      case "grew":
        if (!this.autopilot || engine.status !== "open") return;
        log(`More visitors (${event.from} → ${event.count})`);
        await this.greet("grew");
        break;
      case "returned": {
        this.present = true;
        this.idleCloseAt = null;
        if (!this.autopilot) return;
        engine.setMicEnabled(true);
        // Same people or the next group? The engine compares a fresh look with the last group:
        // new visitors get a full greeting, the same ones get silence or a quick welcome back.
        log(`Someone's here after ${Math.round(event.awayMs / 1000)}s; checking whether they're new`);
        await this.greetWhenOpen("returned", { awayMs: event.awayMs });
        break;
      }
      case "gap": {
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
        this.owedGreeting = false;
        this.idleCloseAt = this.deps.now() + this.opts.idleCloseMs;
        log("Visitors left");
        if (this.autopilot) engine.setMicEnabled(false);
        break;
    }
  }

  /** Call about once a second. */
  async tick(): Promise<void> {
    const { engine, now } = this.deps;
    if (!this.autopilot) return;
    const t = now();
    if (this.present) {
      if (engine.status === "closed") {
        // During the back-off after a failed start there's nothing to do (and nothing to log) yet.
        if (!this.connecting && t < this.retryAt) return;
        // The session expired or dropped mid-visit: reconnect and catch up silently. If it never
        // started for these visitors, they haven't been greeted yet: greet them now.
        this.deps.log("Reconnecting voice session");
        engine.setMicEnabled(true);
        if (!(await this.ensureOpen())) return;
        if (this.owedGreeting) {
          this.owedGreeting = false;
          this.deps.log("Greeting the visitors the failed start missed");
          await this.greet("arrived");
        } else {
          await this.observe();
        }
        return;
      }
      if (engine.status === "open" && t - this.lastObserveAt >= this.opts.backgroundMs && !this.busy()) {
        await this.observe();
      }
    } else if (engine.status === "open" && this.idleCloseAt !== null && t >= this.idleCloseAt && !this.busy()) {
      this.deps.log("Porch is empty: sleeping the voice session");
      this.idleCloseAt = null;
      await engine.close();
    }
  }

  /** Operator button: greet whoever is there now (connecting if needed). */
  async greetNow(): Promise<void> {
    this.deps.engine.setMicEnabled(true);
    // On an empty porch (the owner checking it works, say), still sleep again if nobody comes:
    // otherwise nothing schedules the close and the billed session stays open until visitors leave.
    if (!this.present) this.idleCloseAt = this.deps.now() + this.opts.idleCloseMs;
    await this.greet("manual", {}, this.ensureOpen(true));
  }

  /** Kill switch: stop talking, close the session and stay asleep until re-enabled. */
  async sleep(): Promise<void> {
    this.autopilot = false;
    this.owedGreeting = false;
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

  /** Greets once the session is open (looking meanwhile); if it couldn't start, owes them the greeting. */
  private async greetWhenOpen(reason: "arrived" | "returned", opts: { awayMs?: number } = {}): Promise<void> {
    const ready = this.ensureOpen();
    await this.greet(reason, opts, ready);
    if (!(await ready) && this.present) this.owedGreeting = true;
  }

  /** `ready`: the session connecting; the engine looks meanwhile and greets once it's open. */
  private async greet(reason: GreetReason, opts: { awayMs?: number } = {}, ready?: Promise<boolean>): Promise<void> {
    this.lastObserveAt = this.deps.now();
    await this.deps.engine.greet(this.deps.capture(), reason, { ...opts, ready });
  }

  private async observe(): Promise<void> {
    this.lastObserveAt = this.deps.now();
    const frame = this.deps.capture();
    if (frame) await this.deps.engine.observe(frame);
  }

  private async ensureOpen(force = false): Promise<boolean> {
    const { engine, now } = this.deps;
    if (engine.status === "open") return true;
    // After a failed start (bad key, no network), don't hammer the API every tick.
    if (!force && !this.connecting && now() < this.retryAt) return false;
    try {
      this.connecting ??= engine.connect().finally(() => (this.connecting = null));
      await this.connecting;
    } catch (err) {
      this.retryAt = now() + 15_000;
      this.deps.log(`Could not start voice session: ${(err as Error).message}`);
      return false;
    }
    // Re-read: connect() changed the status since the check above.
    const status: string = engine.status;
    return status === "open";
  }
}
