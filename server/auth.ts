import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who may talk to the server. The dashboard on this computer (loopback) needs nothing. Anything
 * else (the phone remote over home Wi-Fi) is refused unless REMOTE_PIN is set, and then needs a
 * session cookie that it gets by entering the PIN. PIN attempts are rate limited.
 */

export const SESSION_COOKIE = "creature_remote";

/** Paths anyone may load: the PIN page itself and the PIN check. Neither shows or does anything. */
const PUBLIC = new Set(["GET /remote", "GET /remote.js", "POST /api/remote/login"]);

/**
 * Only the dashboard on this computer may use these, even with a PIN: the phone is a remote
 * control, not a second brain, so a lost phone can't start billed sessions or drive the Arduino.
 */
const DASHBOARD_ONLY = [
  "/api/session",
  "/api/vision",
  // Rehearsal: image generation is billed, and deleting cached images can't be undone.
  "/api/rehearsal",
  // "Delete all snapshots now" can't be undone either.
  "/api/snapshots",
  "/api/conversation",
  "/api/remote/state",
  "/api/remote/commands",
  "/api/remote/alert",
  "/api/remote/heartbeat",
  "/ws/body",
];

/** The local dashboard's own origins (the check that was always here). */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  return a === "::1" || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/**
 * The client's address. A request from loopback carrying X-Forwarded-For came through a local
 * proxy (the Vite dev server): the proxy appends the real client last, so only that entry counts
 * (anything before it is whatever the client claimed). From anywhere else the header is ignored.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | undefined): string {
  if (isLoopback(socketAddress) && forwardedFor) {
    const last = forwardedFor.split(",").pop()?.trim();
    if (last) return last;
  }
  return socketAddress ?? "";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export interface RemoteAuthOptions {
  /** REMOTE_PIN; empty means LAN access is off. */
  pin: string;
  now?: () => number;
  /** How long a phone stays signed in. */
  sessionMs?: number;
  /** Wrong PINs allowed per address in `windowMs` before it's locked out. */
  maxFailuresPerClient?: number;
  /** Wrong PINs allowed from all addresses together in `windowMs`. */
  maxFailuresTotal?: number;
  windowMs?: number;
  maxSessions?: number;
}

export type LoginResult =
  | { ok: true; token: string; maxAgeSeconds: number }
  | { ok: false; status: 401; attemptsLeft: number }
  | { ok: false; status: 429; retryAfterSeconds: number }
  | { ok: false; status: 403 };

export class RemoteAuth {
  readonly enabled: boolean;
  private readonly pinHash: Buffer;
  private readonly now: () => number;
  private readonly sessionMs: number;
  private readonly maxPerClient: number;
  private readonly maxTotal: number;
  private readonly windowMs: number;
  private readonly maxSessions: number;
  /** sha256(token) → expiry. Only hashes are kept, so lookups don't leak tokens through timing. */
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();
  private allFailures: number[] = [];

  constructor(opts: RemoteAuthOptions) {
    this.enabled = opts.pin.length > 0;
    this.pinHash = sha256(opts.pin);
    this.now = opts.now ?? Date.now;
    this.sessionMs = opts.sessionMs ?? 24 * 60 * 60_000;
    this.maxPerClient = opts.maxFailuresPerClient ?? 5;
    this.maxTotal = opts.maxFailuresTotal ?? 20;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.maxSessions = opts.maxSessions ?? 20;
  }

  /** Checks a PIN; a right one starts a session (its token goes in the cookie). */
  login(client: string, pin: unknown): LoginResult {
    if (!this.enabled) return { ok: false, status: 403 };
    const t = this.now();
    this.prune(t);
    const mine = this.failures.get(client) ?? [];
    const locked = [mine.length >= this.maxPerClient ? mine : null, this.allFailures.length >= this.maxTotal ? this.allFailures : null].filter(
      (x): x is number[] => x !== null,
    );
    if (locked.length) {
      // Unlocks when the oldest failure in the full window ages out.
      const until = Math.max(...locked.map((list) => list[0]! + this.windowMs));
      return { ok: false, status: 429, retryAfterSeconds: Math.max(1, Math.ceil((until - t) / 1000)) };
    }
    // Hashing both sides gives equal lengths, so the comparison takes the same time for any input.
    const right = typeof pin === "string" && pin.length <= 200 && timingSafeEqual(sha256(pin), this.pinHash);
    if (!right) {
      mine.push(t);
      this.failures.set(client, mine);
      this.allFailures.push(t);
      return { ok: false, status: 401, attemptsLeft: Math.max(0, Math.min(this.maxPerClient - mine.length, this.maxTotal - this.allFailures.length)) };
    }
    this.failures.delete(client);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sha256(token).toString("hex"), t + this.sessionMs);
    // Oldest sessions go first if a lot pile up.
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
    return { ok: true, token, maxAgeSeconds: Math.floor(this.sessionMs / 1000) };
  }

  /** Whether this cookie value is a live session. */
  verify(token: string | undefined): boolean {
    if (!this.enabled || !token || token.length > 200) return false;
    const key = sha256(token).toString("hex");
    const expires = this.sessions.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(sha256(token).toString("hex"));
  }

  private prune(t: number): void {
    const fresh = (list: number[]) => list.filter((at) => t - at < this.windowMs);
    this.allFailures = fresh(this.allFailures);
    for (const [client, list] of this.failures) {
      const kept = fresh(list);
      if (kept.length) this.failures.set(client, kept);
      else this.failures.delete(client);
    }
  }
}

export interface RequestFacts {
  method: string;
  /** Path only, no query string. */
  path: string;
  socketAddress: string | undefined;
  forwardedFor?: string;
  host?: string;
  origin?: string;
  cookie?: string;
}

export type Access =
  | { allow: true; who: "local" | "remote" | "public"; client: string }
  | { allow: false; status: 401 | 403; reason: string; client: string; redirect?: string };

/**
 * The rule for every request and WebSocket upgrade:
 *  - "local": a loopback client that also addressed us as localhost. (The Host check stops a web page
 *    that rebinds its own domain to 127.0.0.1 from passing as the dashboard.)
 *  - otherwise LAN access must be on (REMOTE_PIN), and the request must be public or carry a session
 *    cookie, and may not be a dashboard-only route.
 *  - /api and /ws requests carrying an Origin must come from the dashboard's own localhost origins,
 *    or (for remote clients) from the very host they're talking to.
 */
export function checkAccess(req: RequestFacts, auth: RemoteAuth): Access {
  const client = clientAddress(req.socketAddress, req.forwardedFor);
  const local = isLoopback(client) && LOCAL_HOST.test(req.host ?? "");
  const guarded = req.path.startsWith("/api/") || req.path.startsWith("/ws/");
  if (guarded && req.origin && !LOCAL_ORIGIN.test(req.origin) && (local || !sameHost(req.origin, req.host))) {
    return { allow: false, status: 403, reason: "forbidden origin", client };
  }
  if (local) return { allow: true, who: "local", client };
  if (!auth.enabled) return { allow: false, status: 403, reason: "LAN access is off (set REMOTE_PIN in .env to use the phone remote)", client };
  if (PUBLIC.has(`${req.method} ${req.path}`)) return { allow: true, who: "public", client };
  const page = !guarded && req.method === "GET";
  if (!auth.verify(parseCookies(req.cookie)[SESSION_COOKIE])) {
    return { allow: false, status: 401, reason: "sign in with the PIN at /remote", client, redirect: page ? "/remote" : undefined };
  }
  if (DASHBOARD_ONLY.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
    return { allow: false, status: 403, reason: "only the dashboard on the creature's computer can do that", client };
  }
  // The full dashboard is the brain; on the phone, send them to the remote instead.
  if (page && (req.path === "/" || req.path === "/index.html")) return { allow: false, status: 401, reason: "use /remote", client, redirect: "/remote" };
  return { allow: true, who: "remote", client };
}

function sameHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The Set-Cookie value for a new session (HttpOnly: page scripts can't read it; Strict: other sites can't send it). */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export const clearedSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

/**
 * Where the server listens. Loopback only, unless REMOTE_PIN is set (then all interfaces, so the
 * phone can reach it). HOST overrides that, but never opens the LAN without a PIN.
 */
export function listenHost(env: { HOST?: string; pinSet: boolean }): { host: string; warning?: string } {
  const wanted = env.HOST?.trim() || (env.pinSet ? "0.0.0.0" : "127.0.0.1");
  if (!env.pinSet && !isLoopback(wanted) && wanted !== "localhost") {
    return { host: "127.0.0.1", warning: `HOST=${wanted} ignored: LAN access needs REMOTE_PIN in .env. Listening on 127.0.0.1 only.` };
  }
  return { host: wanted };
}
