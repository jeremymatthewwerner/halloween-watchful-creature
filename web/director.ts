import type { Engine } from "./engines/types.ts";
import type { VisitorEvent } from "./visitors.ts";

export interface DirectorOptions {
  /** Close the voice session after the porch has been empty this long. */
  idleCloseMs: number;
  /** While visitors are present, refresh what the creature sees this often. */
  backgroundMs: number;
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
  private emptySince: number | null = null;
  private lastObserveAt = 0;
  private connecting: Promise<void> | null = null;
  private retryAt = 0;

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
      case "arrived":
        this.present = true;
        this.emptySince = null;
        if (!this.autopilot) return;
        log(`Visitors arrived (${event.count})`);
        engine.setMicEnabled(true);
        if (!(await this.ensureOpen())) return;
        await this.greet("arrived");
        break;
      case "grew":
        if (!this.autopilot || engine.status !== "open") return;
        log(`More visitors (${event.from} → ${event.count})`);
        await this.greet("grew");
        break;
      case "returned":
        // Same group re-detected shortly after "leaving": keep talking, no new greeting.
        this.present = true;
        this.emptySince = null;
        if (!this.autopilot) return;
        log(`Visitors back (${event.count}); not greeting again`);
        engine.setMicEnabled(true);
        if (engine.status !== "open" && (await this.ensureOpen())) await this.observe();
        break;
      case "left":
        this.present = false;
        this.emptySince = this.deps.now();
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
        // The session expired or dropped mid-visit: reconnect and catch up silently.
        this.deps.log("Reconnecting voice session");
        engine.setMicEnabled(true);
        if (await this.ensureOpen()) await this.observe();
        return;
      }
      if (engine.status === "open" && t - this.lastObserveAt >= this.opts.backgroundMs && !this.busy()) {
        await this.observe();
      }
    } else if (
      engine.status === "open" &&
      this.emptySince !== null &&
      t - this.emptySince >= this.opts.idleCloseMs &&
      !this.busy()
    ) {
      this.deps.log("Porch is empty: sleeping the voice session");
      this.emptySince = null;
      await engine.close();
    }
  }

  /** Operator button: greet whoever is there now (connecting if needed). */
  async greetNow(): Promise<void> {
    this.deps.engine.setMicEnabled(true);
    if (await this.ensureOpen(true)) await this.greet("manual");
  }

  /** Kill switch: stop talking, close the session and stay asleep until re-enabled. */
  async sleep(): Promise<void> {
    this.autopilot = false;
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

  private async greet(reason: "arrived" | "grew" | "manual"): Promise<void> {
    this.lastObserveAt = this.deps.now();
    await this.deps.engine.greet(this.deps.capture(), reason);
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
