import type { Alert, AlertKind } from "../shared/remote.ts";

interface KindInfo {
  level: Alert["level"];
  title: string;
  /** The whole push message: fixed text, so nothing about visitors can ever leave the house. */
  push: string | null;
}

export const ALERT_KINDS: Record<AlertKind, KindInfo> = {
  "camera-lost": { level: "error", title: "Camera stopped", push: "The camera stopped sending pictures. The dashboard is restarting it; check the USB cable if this keeps happening." },
  "detector-failed": { level: "error", title: "Person detector failed", push: "The person detector stopped working, so Jacqueline can't see visitors arrive. The dashboard will reload to fix it." },
  "arduino-disconnected": { level: "warn", title: "Arduino disconnected", push: "The Arduino (eyes) is disconnected. Check its USB cable." },
  "vision-errors": { level: "warn", title: "Vision errors piling up", push: "Several costume looks failed in a row. Check the internet connection and the OpenAI account." },
  "voice-errors": { level: "error", title: "Voice session failing", push: "Jacqueline's voice session keeps failing to start. Check the internet connection and the OpenAI account." },
  "voice-offline": {
    level: "warn",
    title: "Voice offline: playing recorded greetings",
    push: "Jacqueline can't reach her live voice (internet or OpenAI trouble), so she's playing recorded greetings. She keeps retrying and switches back by herself.",
  },
  "cost-cap": { level: "warn", title: "Daily cost cap reached", push: "The daily awake-time cap was reached, so Jacqueline went to sleep. Tap Wake on the remote to keep going tonight." },
  "watchdog-reload": { level: "warn", title: "Dashboard reloaded itself", push: "The dashboard hit trouble and reloaded itself to recover." },
  "needs-wake": { level: "error", title: "Dashboard needs a tap", push: "The dashboard reloaded but the browser blocks sound until someone clicks or taps the dashboard screen once." },
  "dashboard-offline": { level: "error", title: "Dashboard stopped responding", push: "The dashboard stopped checking in with the server. Check the computer by the door." },
};

export interface Notifier {
  /** `click`: a URL the phone opens when the notification is tapped (the night recap's). */
  send(message: { title: string; text: string; level: Alert["level"]; click?: string }): Promise<void>;
}

export interface AlertCenterOptions {
  now?: () => number;
  notifier?: Notifier | null;
  /** At most one push per kind this often (repeats in between only bump the count on screen). */
  pushEveryMs?: number;
  /** At most this many pushes per `pushWindowMs`, all kinds together. */
  maxPushes?: number;
  pushWindowMs?: number;
  /** Alerts kept for the screens. */
  keep?: number;
}

/**
 * Health alerts: the latest few for the dashboard and the phone, plus (optionally) a push to the
 * owner's phone. Repeats of a problem that's still going are folded into one alert with a count.
 */
export class AlertCenter {
  private readonly now: () => number;
  private readonly notifier: Notifier | null;
  private readonly pushEveryMs: number;
  private readonly maxPushes: number;
  private readonly pushWindowMs: number;
  private readonly keep: number;
  private list: Alert[] = [];
  private nextId = 1;
  private readonly lastPushAt = new Map<AlertKind, number>();
  private pushes: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: AlertCenterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.notifier = opts.notifier ?? null;
    this.pushEveryMs = opts.pushEveryMs ?? 15 * 60_000;
    this.maxPushes = opts.maxPushes ?? 6;
    this.pushWindowMs = opts.pushWindowMs ?? 60 * 60_000;
    this.keep = opts.keep ?? 30;
  }

  /** Newest first. */
  get alerts(): Alert[] {
    return this.list.map((a) => ({ ...a }));
  }

  /** Records a problem. Returns whether a push went out. */
  raise(kind: AlertKind, detail = ""): boolean {
    const info = ALERT_KINDS[kind];
    const t = this.now();
    const text = detail.replace(/\s+/g, " ").trim().slice(0, 200);
    const open = this.list.find((a) => a.kind === kind && a.resolvedAt === null);
    if (open) {
      open.count++;
      open.at = t;
      if (text) open.detail = text;
      this.list = [open, ...this.list.filter((a) => a !== open)];
    } else {
      this.list.unshift({ id: this.nextId++, kind, level: info.level, title: info.title, detail: text, firstAt: t, at: t, count: 1, resolvedAt: null });
      this.list.length = Math.min(this.list.length, this.keep);
      console.warn(`[alert] ${info.title}${text ? `: ${text}` : ""}`);
    }
    const pushed = this.maybePush(kind, t);
    this.changed();
    return pushed;
  }

  /** The problem went away by itself (the Arduino came back, frames are flowing again). `detail` is for the log. */
  resolve(kind: AlertKind, detail = ""): void {
    const open = this.list.find((a) => a.kind === kind && a.resolvedAt === null);
    if (!open) return;
    open.resolvedAt = this.now();
    const text = detail.replace(/\s+/g, " ").trim().slice(0, 200);
    console.log(`[alert] cleared: ${open.title}${text ? ` (${text})` : ""}`);
    this.changed();
  }

  isOpen(kind: AlertKind): boolean {
    return this.list.some((a) => a.kind === kind && a.resolvedAt === null);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private maybePush(kind: AlertKind, t: number): boolean {
    const info = ALERT_KINDS[kind];
    if (!this.notifier || !info.push) return false;
    const last = this.lastPushAt.get(kind);
    if (last !== undefined && t - last < this.pushEveryMs) return false;
    this.pushes = this.pushes.filter((at) => t - at < this.pushWindowMs);
    if (this.pushes.length >= this.maxPushes) return false;
    this.pushes.push(t);
    this.lastPushAt.set(kind, t);
    this.notifier.send({ title: info.title, text: info.push, level: info.level }).catch((err: Error) => console.warn(`[alert] push failed: ${err.message}`));
    return true;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A topic name ntfy accepts; it's the only "password" for the topic, so it should be long and random. */
export const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Pushes to the ntfy app (https://ntfy.sh): a plain HTTPS POST of the short text to the topic.
 * Headers are ASCII only (fetch refuses anything else), so the pumpkin comes from a tag.
 */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly topic: string,
    private readonly server = "https://ntfy.sh",
    private readonly token = "",
    private readonly post: typeof fetch = fetch,
  ) {
    if (!NTFY_TOPIC.test(topic)) throw new Error("NTFY_TOPIC may only use letters, digits, - and _ (up to 64)");
  }

  async send(message: { title: string; text: string; level: Alert["level"]; click?: string }): Promise<void> {
    const headers: Record<string, string> = {
      Title: `Jacqueline: ${message.title}`.replace(/[^\x20-\x7e]/g, ""),
      Priority: message.level === "error" ? "high" : "default",
      Tags: "jack_o_lantern",
    };
    if (message.click && /^https?:\/\/[\x21-\x7e]+$/.test(message.click)) headers.Click = message.click;
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.post(`${this.server.replace(/\/+$/, "")}/${this.topic}`, {
      method: "POST",
      headers,
      body: message.text,
      signal: AbortSignal.timeout(10_000),
    });
    // Don't echo the URL: the topic name is the secret.
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
  }
}
