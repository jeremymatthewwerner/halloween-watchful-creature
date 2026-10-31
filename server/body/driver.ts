import type { BodyMessage, BodyMode, BodyState, CharacterInfo, EyeFlourish, EyePalette } from "../../shared/types.ts";
import { BODY_BAUD, encodeEyeStyle, encodeFlourish, encodeLevel, encodeModes, encodePalette, encodeState } from "./protocol.ts";

/** Something that can carry protocol lines to the creature's body. */
export interface LineSink {
  readonly name: string;
  write(line: string): void;
}

/** Logs instead of driving hardware; used when no Arduino is attached. */
export class NullSink implements LineSink {
  readonly name = "none";
  private lastLogged = "";
  write(line: string): void {
    // Levels arrive ~30x/s; only log state-ish lines.
    if (line.startsWith("L ") || line === this.lastLogged) return;
    this.lastLogged = line;
    if (process.env.BODY_DEBUG) console.log(`[body] ${line}`);
  }
}

const ARDUINO_VENDOR_IDS = new Set(["2341", "2a03", "1a86", "10c4", "0403", "239a"]);

/** The parts of the serialport module SerialSink uses (a stand-in can be passed for tests). */
export interface SerialModule {
  SerialPort: {
    new (opts: { path: string; baudRate: number }): SerialPortLike;
    list(): Promise<{ path: string; vendorId?: string }[]>;
  };
  ReadlineParser: new (opts: { delimiter: string }) => NodeJS.ReadWriteStream;
}

interface SerialPortLike {
  readonly isOpen: boolean;
  pipe<T extends NodeJS.WritableStream>(dest: T): T;
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  write(data: string): boolean;
  close(cb?: () => void): void;
}

/** Drives the Arduino over USB serial, reconnecting if it's unplugged. */
export class SerialSink implements LineSink {
  name = "serial (connecting)";
  /** The port in use, claimed as soon as it starts opening so nothing else opens it meanwhile. */
  private port: SerialPortLike | null = null;
  private ready = false;
  private stopped = false;
  private connecting = false;
  /**
   * The one pending reconnect. One unplug can fire both "error" and "close"; two tries racing for the
   * port once left the sink holding the one that lost ("Cannot lock port"), so every line went nowhere.
   */
  private retry: ReturnType<typeof setTimeout> | null = null;
  private mod: SerialModule | null = null;

  constructor(
    private readonly path: string,
    private readonly onReady: () => void,
    private readonly load: () => Promise<SerialModule> = async () => (await import("serialport")) as unknown as SerialModule,
  ) {}

  async start(): Promise<void> {
    try {
      this.mod = await this.load();
    } catch {
      this.name = "serial (module unavailable: run npm install)";
      console.warn("[body] serialport module not installed; body control disabled");
      return;
    }
    await this.connect();
  }

  private retryIn(ms: number): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, ms);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.port || !this.mod) return;
    const { SerialPort, ReadlineParser } = this.mod;
    this.connecting = true;
    try {
      const path = this.path === "auto" ? pickArduinoPort(await SerialPort.list()) : this.path;
      if (!path) {
        this.name = "serial (no Arduino found)";
        this.retryIn(3000);
        return;
      }
      const port = new SerialPort({ path, baudRate: BODY_BAUD });
      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
      this.port = port;
      this.ready = false;
      this.name = `serial ${path}`;
      // Opening the port resets most Arduinos; wait for READY (or 2.5 s) before sending.
      const readyTimer = setTimeout(() => this.markReady(port), 2500);
      parser.on("data", (line: string) => {
        const text = String(line).trim();
        if (text.startsWith("READY")) {
          clearTimeout(readyTimer);
          this.markReady(port);
        }
        if (process.env.BODY_DEBUG && text) console.log(`[arduino] ${text}`);
      });
      // Lost (unplugged, or it never opened): let go of it and try again, once.
      const lost = () => {
        clearTimeout(readyTimer);
        if (this.port !== port) return;
        this.port = null;
        this.ready = false;
        this.name = "serial (disconnected)";
        this.retryIn(3000);
      };
      port.on("open", () => console.log(`[body] connected to ${path}`));
      port.on("close", lost);
      port.on("error", (err: Error) => {
        console.warn(`[body] serial error: ${err.message}`);
        if (!port.isOpen) lost();
      });
    } catch (err) {
      this.port = null;
      this.name = "serial (error)";
      console.warn(`[body] ${(err as Error).message}`);
      this.retryIn(3000);
    } finally {
      this.connecting = false;
    }
  }

  private markReady(port: SerialPortLike): void {
    if (this.port !== port || this.ready) return;
    this.ready = true;
    this.onReady();
  }

  write(line: string): void {
    if (this.port?.isOpen && this.ready) this.port.write(`${line}\n`);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.port?.close();
  }
}

/**
 * The Arduino among the serial ports: one whose USB vendor is a known Arduino or USB-serial chip
 * (Arduino, CH340, CP210x, FTDI, Adafruit). Failing that, a likely-named port that reports no
 * vendor at all. A port from some other vendor (a USB-C hub's "usbmodem" port, say) never counts.
 */
export function pickArduinoPort(ports: readonly { path: string; vendorId?: string }[]): string | undefined {
  const match =
    ports.find((p) => p.vendorId && ARDUINO_VENDOR_IDS.has(p.vendorId.toLowerCase())) ??
    ports.find((p) => !p.vendorId && /usbmodem|usbserial|ttyACM|ttyUSB|wchusbserial/i.test(p.path));
  return match?.path;
}

/**
 * Keeps the body in sync with the browser: remembers the current state and palette,
 * replays them when the Arduino (re)connects, and heartbeats while a browser is attached.
 */
export class BodyController {
  private state: BodyState = "sleeping";
  private palette: { eyes: EyePalette; eyeStyle: CharacterInfo["eyeStyle"] } | null = null;
  private lastClientAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private sink: LineSink,
    private readonly modes: readonly BodyMode[],
    private readonly now: () => number = Date.now,
  ) {}

  setSink(sink: LineSink): void {
    this.sink = sink;
  }

  get status(): string {
    return this.sink.name;
  }

  /** Sends modes, palette and state; call when the hardware becomes ready. */
  replay(): void {
    this.sink.write(encodeModes(this.modes));
    if (this.palette) {
      this.sink.write(encodeEyeStyle(this.palette.eyeStyle));
      for (const line of encodePalette(this.palette.eyes)) this.sink.write(line);
    }
    this.sink.write(encodeState(this.state));
  }

  handle(msg: BodyMessage): void {
    this.lastClientAt = this.now();
    switch (msg.type) {
      case "state":
        if (msg.state !== this.state) {
          this.state = msg.state;
          this.sink.write(encodeState(msg.state));
        }
        break;
      case "level":
        this.sink.write(encodeLevel(msg.level));
        break;
      case "flourish":
        this.flourish(msg.effect);
        break;
      case "palette":
        this.palette = { eyes: msg.eyes, eyeStyle: msg.eyeStyle };
        this.sink.write(encodeEyeStyle(msg.eyeStyle));
        for (const line of encodePalette(msg.eyes)) this.sink.write(line);
        break;
    }
  }

  /**
   * Plays a one-shot eye animation over the current state. Not remembered or replayed on
   * reconnect: it's a moment, and stale by the time the Arduino comes back.
   */
  flourish(effect: EyeFlourish): void {
    this.sink.write(encodeFlourish(effect));
  }

  /** Heartbeat only while a browser is talking to us, so the body fails safe if the page dies. */
  tick(): void {
    if (this.now() - this.lastClientAt < 3000) this.sink.write(encodeState(this.state));
  }

  startHeartbeat(intervalMs = 500): void {
    this.timer ??= setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * More than one dashboard can be open (a forgotten tab, a second laptop). Each keeps sending its
 * state, so the eyes would flip between them. Only one drives the body: the newest awake one (any
 * state but sleeping), or the newest if none is awake. When that changes, the new one's palette and
 * state go to the body straight away.
 */
export class BodyClients {
  private readonly clients = new Map<number, { state: BodyState; palette: BodyMessage | null }>();
  private nextId = 0;
  private leader: number | null = null;

  constructor(
    private readonly body: { handle(msg: BodyMessage): void },
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** A dashboard connected; returns its id for handle() and disconnect(). */
  connect(): number {
    const id = this.nextId++;
    this.clients.set(id, { state: "sleeping", palette: null });
    this.elect();
    return id;
  }

  disconnect(id: number): void {
    this.clients.delete(id);
    this.elect();
  }

  handle(id: number, msg: BodyMessage): void {
    const client = this.clients.get(id);
    if (!client) return;
    if (msg.type === "state") client.state = msg.state;
    if (msg.type === "palette") client.palette = msg;
    this.elect();
    if (id === this.leader) this.body.handle(msg);
  }

  private elect(): void {
    let best: number | null = null;
    for (const [id, c] of this.clients) {
      const bestAwake = best !== null && this.clients.get(best)!.state !== "sleeping";
      const awake = c.state !== "sleeping";
      if (best === null || (awake && !bestAwake) || (awake === bestAwake && id > best)) best = id;
    }
    if (best === this.leader) return;
    this.leader = best;
    if (best === null) return;
    const c = this.clients.get(best)!;
    if (this.clients.size > 1) this.log(`[body] ${this.clients.size} dashboards open: following the newest ${c.state === "sleeping" ? "one" : "awake one"}`);
    if (c.palette) this.body.handle(c.palette);
    this.body.handle({ type: "state", state: c.state });
  }
}
