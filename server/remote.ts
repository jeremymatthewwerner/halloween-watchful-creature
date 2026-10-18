import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { DASHBOARD_ALERT_KINDS, SAY_MAX_CHARS, type AlertKind, type DashboardStatus, type RemoteCommand, type RemoteSnapshot } from "../shared/remote.ts";
import { AlertCenter, NtfyNotifier } from "./alerts.ts";
import { RemoteAuth, checkAccess, clearedSessionCookie, parseCookies, sessionCookie, SESSION_COOKIE, type Access } from "./auth.ts";

/**
 * The phone remote and health alerts. The dashboard stays the brain: it checks in every couple of
 * seconds with its status (POST /api/remote/state) and listens for button presses from the phone
 * (GET /api/remote/commands). The phone gets everything over one stream (GET /api/remote/stream)
 * and sends presses with POST /api/remote/command. All of it sits behind checkAccess().
 */

export interface RemoteOptions {
  remotePin: string;
  ntfyTopic: string;
  ntfyServer: string;
  ntfyToken: string;
  /** False when BODY_SERIAL_PORT=none: no Arduino alerts. */
  arduinoEnabled: boolean;
  /** Production (the Pi kiosk): also alert when the dashboard never opens. */
  production: boolean;
  bodyStatus: () => string;
  todayLogUrl: () => string | null;
  now?: () => number;
  fetch?: typeof fetch;
}

/** No check-in for this long means the dashboard is frozen, crashed or closed. */
export const DASHBOARD_STALE_MS = 45_000;
const ARDUINO_GRACE_MS = 15_000;
const VISION_WINDOW_MS = 5 * 60_000;
const VISION_FAILURES = 3;

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const pageFile = (name: string) => readFileSync(new URL(`./remote-page/${name}`, import.meta.url), "utf8");

export class Remote {
  readonly auth: RemoteAuth;
  readonly alerts: AlertCenter;
  private readonly now: () => number;
  private readonly startedAt: number;
  private dashboard: DashboardStatus | null = null;
  private lastStateAt: number | null = null;
  private readonly commandListeners = new Set<(cmd: RemoteCommand) => void>();
  private readonly snapshotListeners = new Set<() => void>();
  private commandSeq = 0;
  private arduinoConnected = false;
  private arduinoSeen = false;
  private arduinoLastConnectedAt = 0;
  private visionFailures: number[] = [];
  private visionOkStreak = 0;
  private readonly access = new WeakMap<Request, Access>();

  constructor(private readonly opts: RemoteOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.auth = new RemoteAuth({ pin: opts.remotePin, now: this.now });
    const notifier = opts.ntfyTopic ? new NtfyNotifier(opts.ntfyTopic, opts.ntfyServer, opts.ntfyToken, opts.fetch) : null;
    if (notifier && opts.ntfyTopic.length < 16) console.warn("[alert] NTFY_TOPIC is short: anyone who guesses it can read your alerts. Use a long random one.");
    this.alerts = new AlertCenter({ now: this.now, notifier });
    this.alerts.subscribe(() => this.snapshotChanged());
  }

  /** Access for a raw WebSocket upgrade (same rules as HTTP). */
  checkUpgrade(req: IncomingMessage): Access {
    return checkAccess(
      {
        method: "GET",
        path: (req.url ?? "/").split("?")[0]!,
        socketAddress: req.socket.remoteAddress,
        forwardedFor: header(req.headers["x-forwarded-for"]),
        host: header(req.headers.host),
        origin: header(req.headers.origin),
        cookie: header(req.headers.cookie),
      },
      this.auth,
    );
  }

  /** Registers the guard (before every other route) and the remote's own routes. */
  install(app: Hono): void {
    app.use("*", async (c, next) => {
      const raw = c.req.raw;
      const access = checkAccess(
        {
          method: c.req.method,
          path: c.req.path,
          socketAddress: (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress,
          forwardedFor: c.req.header("x-forwarded-for"),
          host: c.req.header("host"),
          origin: c.req.header("origin"),
          cookie: c.req.header("cookie"),
        },
        this.auth,
      );
      if (!access.allow) {
        if (access.redirect) return c.redirect(access.redirect, 302);
        return c.json({ error: access.reason }, access.status);
      }
      this.access.set(raw, access);
      await next();
    });

    // Vision failures piling up (the API down, the account out of credit) are worth an alert.
    app.use("/api/vision", async (c, next) => {
      await next();
      this.visionResult(c.res.status);
    });

    app.get("/remote", (c) => c.html(pageFile("index.html"), 200, PAGE_HEADERS));
    app.get("/remote.js", (c) => c.body(pageFile("remote.js"), 200, { ...PAGE_HEADERS, "content-type": "text/javascript; charset=utf-8" }));

    app.post("/api/remote/login", async (c) => {
      const form = (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded");
      const pin = form ? (await c.req.parseBody())["pin"] : ((await c.req.json().catch(() => ({}))) as { pin?: unknown }).pin;
      const client = this.clientOf(c);
      const result = this.auth.login(client, pin);
      if (result.ok) {
        console.log(`[remote] phone signed in from ${client}`);
        c.header("set-cookie", sessionCookie(result.token, result.maxAgeSeconds));
        return form ? c.redirect("/remote", 303) : c.json({ ok: true });
      }
      if (result.status === 429) {
        console.warn(`[remote] too many wrong PINs; locked for ${result.retryAfterSeconds}s (latest from ${client})`);
        c.header("retry-after", String(result.retryAfterSeconds));
        return c.json({ error: `Too many wrong PINs. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} min.`, retryAfterSeconds: result.retryAfterSeconds }, 429);
      }
      if (result.status === 401) {
        console.warn(`[remote] wrong PIN from ${client} (${result.attemptsLeft} tries left)`);
        return c.json({ error: "Wrong PIN", attemptsLeft: result.attemptsLeft }, 401);
      }
      return c.json({ error: "The phone remote is off (REMOTE_PIN isn't set)" }, 403);
    });

    app.post("/api/remote/logout", (c) => {
      this.auth.logout(parseCookies(c.req.header("cookie"))[SESSION_COOKIE]);
      c.header("set-cookie", clearedSessionCookie);
      return c.json({ ok: true });
    });

    /** Getting here at all means signed in (or on this computer). */
    app.get("/api/remote/me", (c) => {
      const access = this.access.get(c.req.raw);
      return c.json({ ok: true, local: access?.allow === true && access.who === "local" });
    });

    app.get("/api/remote/stream", (c) =>
      streamSSE(c, async (stream) => {
        let sending = Promise.resolve();
        const send = () => {
          sending = sending.then(() => stream.writeSSE({ event: "snapshot", data: JSON.stringify(this.snapshot()) })).catch(() => undefined);
        };
        send();
        this.snapshotListeners.add(send);
        // Also a heartbeat: keeps "seen 3 s ago" fresh and lets the phone notice a dead stream.
        const timer = setInterval(send, 5_000);
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        clearInterval(timer);
        this.snapshotListeners.delete(send);
      }),
    );

    app.post("/api/remote/command", async (c) => {
      const command = parseCommand(await c.req.json().catch(() => null), `r${this.now().toString(36)}-${++this.commandSeq}`);
      if (!command) return c.json({ error: "unknown command" }, 400);
      if (!this.commandListeners.size) return c.json({ error: "The dashboard isn't open, so there's nothing to control." }, 503);
      console.log(`[remote] ${command.type}${command.type === "mode" ? ` ${command.mode} ${command.on ? "on" : "off"}` : ""} from ${this.clientOf(c)}`);
      for (const listener of this.commandListeners) listener(command);
      return c.json({ id: command.id }, 202);
    });

    // --- dashboard-only (checkAccess refuses these to the phone) ---

    app.get("/api/remote/commands", (c) =>
      streamSSE(c, async (stream) => {
        let sending = Promise.resolve();
        const listener = (cmd: RemoteCommand) => {
          sending = sending.then(() => stream.writeSSE({ event: "command", data: JSON.stringify(cmd) })).catch(() => undefined);
        };
        this.commandListeners.add(listener);
        const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined), 10_000);
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        clearInterval(ping);
        this.commandListeners.delete(listener);
      }),
    );

    app.post("/api/remote/state", async (c) => {
      const text = await c.req.text();
      if (text.length > 32_000) return c.json({ error: "too large" }, 413);
      let status: DashboardStatus;
      try {
        status = JSON.parse(text) as DashboardStatus;
      } catch {
        return c.json({ error: "bad JSON" }, 400);
      }
      if (typeof status !== "object" || status === null || typeof status.woken !== "boolean") return c.json({ error: "bad status" }, 400);
      this.dashboardCheckedIn(status);
      return c.json({ alerts: this.alerts.alerts });
    });

    app.post("/api/remote/alert", async (c) => {
      const req = (await c.req.json().catch(() => null)) as { kind?: unknown; detail?: unknown; resolve?: unknown } | null;
      const kind = req?.kind as AlertKind;
      if (!DASHBOARD_ALERT_KINDS.includes(kind)) return c.json({ error: "unknown alert kind" }, 400);
      const detail = typeof req?.detail === "string" ? req.detail : "";
      if (req?.resolve === true) this.alerts.resolve(kind, detail);
      else this.alerts.raise(kind, detail);
      return c.body(null, 204);
    });

    /** Seconds since the dashboard last checked in, or -1 (for the Pi kiosk's watchdog script). */
    app.get("/api/remote/heartbeat", (c) => c.text(String(this.lastStateAt === null ? -1 : Math.floor((this.now() - this.lastStateAt) / 1000))));
  }

  /** Starts watching for a silent dashboard and an unplugged Arduino. */
  start(everyMs = 5_000): NodeJS.Timeout {
    const timer = setInterval(() => this.tick(), everyMs);
    timer.unref();
    return timer;
  }

  tick(): void {
    const t = this.now();
    if (this.lastStateAt !== null && t - this.lastStateAt > DASHBOARD_STALE_MS) {
      if (!this.alerts.isOpen("dashboard-offline")) this.alerts.raise("dashboard-offline", `No check-in for ${Math.round((t - this.lastStateAt) / 1000)} s (frozen, crashed or closed).`);
    } else if (this.lastStateAt === null && this.opts.production && t - this.startedAt > 3 * 60_000) {
      if (!this.alerts.isOpen("dashboard-offline")) this.alerts.raise("dashboard-offline", "The dashboard hasn't opened since the server started.");
    }

    if (!this.opts.arduinoEnabled) return;
    const status = this.opts.bodyStatus();
    const connected = /^serial [^(]/.test(status);
    const flipped = connected !== this.arduinoConnected;
    this.arduinoConnected = connected;
    if (flipped) this.snapshotChanged();
    if (connected) {
      this.arduinoSeen = true;
      this.arduinoLastConnectedAt = t;
      this.alerts.resolve("arduino-disconnected");
    } else if (!this.alerts.isOpen("arduino-disconnected")) {
      if (this.arduinoSeen && t - this.arduinoLastConnectedAt > ARDUINO_GRACE_MS) this.alerts.raise("arduino-disconnected", status);
      else if (!this.arduinoSeen && t - this.startedAt > 60_000) this.alerts.raise("arduino-disconnected", `${status}. Set BODY_SERIAL_PORT=none if you're running without one.`);
    }
  }

  dashboardCheckedIn(status: DashboardStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.dashboard);
    this.dashboard = status;
    this.lastStateAt = this.now();
    this.alerts.resolve("dashboard-offline");
    if (changed) this.snapshotChanged();
  }

  snapshot(): RemoteSnapshot {
    const t = this.now();
    const today = this.opts.todayLogUrl();
    return {
      dashboard: this.dashboard,
      dashboardOnline: this.lastStateAt !== null && t - this.lastStateAt <= DASHBOARD_STALE_MS,
      dashboardSeenAgo: this.lastStateAt === null ? null : Math.round((t - this.lastStateAt) / 1000),
      arduino: { enabled: this.opts.arduinoEnabled, connected: this.arduinoConnected, status: this.opts.bodyStatus() },
      alerts: this.alerts.alerts.slice(0, 15),
      links: { todayLog: today, gallery: today ? today.replace(/log\.html$/, "gallery.html") : null, allLogs: "/api/session-logs" },
    };
  }

  visionResult(status: number): void {
    const t = this.now();
    if (status < 400) {
      if (++this.visionOkStreak >= 3) this.alerts.resolve("vision-errors");
      return;
    }
    if (status < 500) return; // a bad request from the page, not the service failing
    this.visionOkStreak = 0;
    this.visionFailures = [...this.visionFailures.filter((at) => t - at < VISION_WINDOW_MS), t];
    if (this.visionFailures.length >= VISION_FAILURES) this.alerts.raise("vision-errors", `${this.visionFailures.length} costume looks failed in the last 5 min (HTTP ${status}).`);
  }

  private clientOf(c: Context): string {
    return this.access.get(c.req.raw)?.client ?? "?";
  }

  private snapshotChanged(): void {
    for (const listener of this.snapshotListeners) listener();
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** A well-formed command from the phone, or null. */
export function parseCommand(body: unknown, id: string): RemoteCommand | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  switch (b.type) {
    case "sleep":
    case "wake":
    case "greet":
      return { id, type: b.type };
    case "say": {
      const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
      return text && text.length <= SAY_MAX_CHARS ? { id, type: "say", text } : null;
    }
    case "mode":
      return typeof b.mode === "string" && /^[A-Za-z0-9]{1,32}$/.test(b.mode) && typeof b.on === "boolean" ? { id, type: "mode", mode: b.mode, on: b.on } : null;
    default:
      return null;
  }
}
