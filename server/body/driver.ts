import type { BodyMessage, BodyMode, BodyState, CharacterInfo, EyePalette } from "../../shared/types.ts";
import { encodeEyeStyle, encodeLevel, encodeModes, encodePalette, encodeState } from "./protocol.ts";

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

/** Drives the Arduino over USB serial, reconnecting if it's unplugged. */
export class SerialSink implements LineSink {
  name = "serial (connecting)";
  private port: { write(data: string): boolean; close(cb?: () => void): void; isOpen: boolean } | null = null;
  private ready = false;
  private stopped = false;

  constructor(
    private readonly path: string,
    private readonly onReady: () => void,
  ) {}

  async start(): Promise<void> {
    let mod: typeof import("serialport");
    try {
      mod = await import("serialport");
    } catch {
      this.name = "serial (module unavailable: run npm install)";
      console.warn("[body] serialport module not installed; body control disabled");
      return;
    }
    const { SerialPort, ReadlineParser } = mod;
    const connect = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const path = this.path === "auto" ? await findArduino(SerialPort) : this.path;
        if (!path) {
          this.name = "serial (no Arduino found)";
          setTimeout(connect, 3000);
          return;
        }
        const port = new SerialPort({ path, baudRate: 115200 });
        const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
        this.port = port;
        this.ready = false;
        this.name = `serial ${path}`;
        // Opening the port resets most Arduinos; wait for READY (or 2.5 s) before sending.
        const readyTimer = setTimeout(() => this.markReady(), 2500);
        parser.on("data", (line: string) => {
          const text = line.trim();
          if (text.startsWith("READY")) {
            clearTimeout(readyTimer);
            this.markReady();
          }
          if (process.env.BODY_DEBUG && text) console.log(`[arduino] ${text}`);
        });
        port.on("close", () => {
          this.port = null;
          this.ready = false;
          this.name = "serial (disconnected)";
          setTimeout(connect, 3000);
        });
        port.on("error", (err: Error) => console.warn(`[body] serial error: ${err.message}`));
        console.log(`[body] connected to ${path}`);
      } catch (err) {
        this.name = "serial (error)";
        console.warn(`[body] ${(err as Error).message}`);
        setTimeout(connect, 3000);
      }
    };
    await connect();
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.onReady();
  }

  write(line: string): void {
    if (this.port?.isOpen && this.ready) this.port.write(`${line}\n`);
  }

  stop(): void {
    this.stopped = true;
    this.port?.close();
  }
}

async function findArduino(SerialPort: typeof import("serialport").SerialPort): Promise<string | undefined> {
  return pickArduinoPort(await SerialPort.list());
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
      case "palette":
        this.palette = { eyes: msg.eyes, eyeStyle: msg.eyeStyle };
        this.sink.write(encodeEyeStyle(msg.eyeStyle));
        for (const line of encodePalette(msg.eyes)) this.sink.write(line);
        break;
    }
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
