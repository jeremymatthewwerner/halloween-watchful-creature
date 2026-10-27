import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AlertCenter, NtfyNotifier, type Notifier } from "../server/alerts.ts";
import { RemoteAuth, SESSION_COOKIE, checkAccess, clientAddress, isLoopback, listenHost, parseCookies, type RequestFacts } from "../server/auth.ts";
import { Remote, parseCommand } from "../server/remote.ts";
import { deleteAllSnapshots } from "../server/snapshots.ts";
import type { DashboardStatus } from "../shared/remote.ts";

const PIN = "271828";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const LOCAL: Partial<RequestFacts> = { socketAddress: "127.0.0.1", host: "localhost:8787" };
const PHONE: Partial<RequestFacts> = { socketAddress: "192.168.1.23", host: "192.168.1.5:8787" };
const req = (over: Partial<RequestFacts>): RequestFacts => ({ method: "GET", path: "/api/health", socketAddress: undefined, ...over });

function signIn(auth: RemoteAuth, client = "192.168.1.23"): string {
  const result = auth.login(client, PIN);
  if (!result.ok) throw new Error("login failed");
  return result.token;
}

describe("addresses", () => {
  it("knows loopback addresses", () => {
    for (const a of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["192.168.1.5", "::ffff:192.168.1.5", "10.0.0.1", "", undefined, "fe80::1"]) expect(isLoopback(a)).toBe(false);
  });

  it("trusts X-Forwarded-For only from a local proxy, and only its last entry", () => {
    expect(clientAddress("127.0.0.1", "192.168.1.23")).toBe("192.168.1.23");
    // A client can't pass as local by claiming an address: the proxy appends the real one last.
    expect(clientAddress("127.0.0.1", "127.0.0.1, 192.168.1.23")).toBe("192.168.1.23");
    expect(clientAddress("192.168.1.23", "127.0.0.1")).toBe("192.168.1.23");
    expect(clientAddress("::1", undefined)).toBe("::1");
  });

  it("parses cookies", () => {
    expect(parseCookies(`a=1; ${SESSION_COOKIE}=tok-en_x; b=2`)[SESSION_COOKIE]).toBe("tok-en_x");
    expect(parseCookies(undefined)).toEqual({});
  });

  it("listens on the LAN only with a PIN", () => {
    expect(listenHost({ pinSet: false }).host).toBe("127.0.0.1");
    expect(listenHost({ pinSet: true }).host).toBe("0.0.0.0");
    const forced = listenHost({ HOST: "0.0.0.0", pinSet: false });
    expect(forced.host).toBe("127.0.0.1");
    expect(forced.warning).toMatch(/REMOTE_PIN/);
    expect(listenHost({ HOST: "192.168.1.5", pinSet: true }).host).toBe("192.168.1.5");
  });
});

describe("RemoteAuth", () => {
  it("is off without a PIN", () => {
    const auth = new RemoteAuth({ pin: "" });
    expect(auth.enabled).toBe(false);
    expect(auth.login("192.168.1.23", "")).toEqual({ ok: false, status: 403 });
    expect(auth.verify("anything")).toBe(false);
  });

  it("starts a session for the right PIN and rejects wrong ones", () => {
    const auth = new RemoteAuth({ pin: PIN });
    expect(auth.login("192.168.1.23", "000000")).toMatchObject({ ok: false, status: 401, attemptsLeft: 4 });
    expect(auth.login("192.168.1.23", 271828)).toMatchObject({ ok: false, status: 401 }); // not a string
    const token = signIn(auth);
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(auth.verify(token)).toBe(true);
    expect(auth.verify(`${token}x`)).toBe(false);
    expect(auth.verify(undefined)).toBe(false);
    auth.logout(token);
    expect(auth.verify(token)).toBe(false);
  });

  it("expires sessions", () => {
    const c = clock();
    const auth = new RemoteAuth({ pin: PIN, now: c.now, sessionMs: 60_000 });
    const token = signIn(auth);
    c.advance(59_000);
    expect(auth.verify(token)).toBe(true);
    c.advance(2_000);
    expect(auth.verify(token)).toBe(false);
  });

  it("locks an address out after 5 wrong PINs, even for the right PIN, until the window passes", () => {
    const c = clock();
    const auth = new RemoteAuth({ pin: PIN, now: c.now });
    for (let i = 0; i < 5; i++) expect(auth.login("192.168.1.66", "123456")).toMatchObject({ status: 401 });
    const locked = auth.login("192.168.1.66", PIN);
    expect(locked).toMatchObject({ ok: false, status: 429 });
    expect(locked.ok === false && locked.status === 429 && locked.retryAfterSeconds).toBeGreaterThan(14 * 60);
    // Another phone is unaffected.
    expect(auth.login("192.168.1.23", PIN).ok).toBe(true);
    c.advance(15 * 60_000 + 1);
    expect(auth.login("192.168.1.66", PIN).ok).toBe(true);
  });

  it("also limits wrong PINs from all addresses together", () => {
    const c = clock();
    const auth = new RemoteAuth({ pin: PIN, now: c.now, maxFailuresPerClient: 5, maxFailuresTotal: 8 });
    for (let i = 0; i < 8; i++) auth.login(`192.168.1.${100 + i}`, "000000");
    expect(auth.login("192.168.1.200", PIN)).toMatchObject({ status: 429 });
  });

  it("a right PIN clears that address's failures", () => {
    const auth = new RemoteAuth({ pin: PIN });
    for (let i = 0; i < 4; i++) auth.login("192.168.1.23", "000000");
    signIn(auth);
    expect(auth.login("192.168.1.23", "000000")).toMatchObject({ status: 401, attemptsLeft: 4 });
  });
});

describe("checkAccess", () => {
  it("lets the local dashboard in without a PIN, with LAN access off or on", () => {
    for (const pin of ["", PIN]) {
      const auth = new RemoteAuth({ pin });
      expect(checkAccess(req({ ...LOCAL }), auth)).toMatchObject({ allow: true, who: "local" });
      expect(checkAccess(req({ ...LOCAL, path: "/api/session", method: "POST", origin: "http://localhost:5173" }), auth)).toMatchObject({ allow: true });
      expect(checkAccess(req({ ...LOCAL, path: "/ws/body", socketAddress: "::1", host: "[::1]:8787" }), auth)).toMatchObject({ allow: true });
      // Through the Vite dev proxy (xfwd).
      expect(checkAccess(req({ ...LOCAL, host: "localhost:5173", forwardedFor: "::1" }), auth)).toMatchObject({ allow: true, who: "local" });
    }
  });

  it("turns away other devices entirely when LAN access is off", () => {
    const auth = new RemoteAuth({ pin: "" });
    expect(checkAccess(req({ ...PHONE }), auth)).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req({ ...PHONE, path: "/remote" }), auth)).toMatchObject({ allow: false, status: 403 });
    // Proxied from another device through Vite.
    expect(checkAccess(req({ ...LOCAL, forwardedFor: "192.168.1.23" }), auth)).toMatchObject({ allow: false, status: 403 });
  });

  it("needs a session cookie for every /api and /ws route, logs and galleries included", () => {
    const auth = new RemoteAuth({ pin: PIN });
    const paths = ["/api/health", "/api/config", "/api/logs", "/api/session-logs", "/api/session-logs/2026-10-31/gallery.html", "/api/session-logs/2026-10-31/snapshots/a.jpg", "/api/remote/stream", "/ws/body"];
    for (const path of paths) expect(checkAccess(req({ ...PHONE, path }), auth)).toMatchObject({ allow: false, status: 401 });
    expect(checkAccess(req({ ...PHONE, path: "/api/remote/command", method: "POST", cookie: `${SESSION_COOKIE}=forged` }), auth)).toMatchObject({ allow: false, status: 401 });
    const cookie = `${SESSION_COOKIE}=${signIn(auth)}`;
    for (const path of ["/api/health", "/api/logs", "/api/session-logs/2026-10-31/gallery.html", "/api/remote/stream"]) {
      expect(checkAccess(req({ ...PHONE, path, cookie }), auth)).toMatchObject({ allow: true, who: "remote" });
    }
  });

  it("serves only the PIN page and PIN check without a session; pages redirect to it", () => {
    const auth = new RemoteAuth({ pin: PIN });
    expect(checkAccess(req({ ...PHONE, path: "/remote" }), auth)).toMatchObject({ allow: true, who: "public" });
    expect(checkAccess(req({ ...PHONE, path: "/remote.js" }), auth)).toMatchObject({ allow: true });
    expect(checkAccess(req({ ...PHONE, path: "/api/remote/login", method: "POST", origin: "http://192.168.1.5:8787" }), auth)).toMatchObject({ allow: true });
    expect(checkAccess(req({ ...PHONE, path: "/" }), auth)).toMatchObject({ allow: false, redirect: "/remote" });
    expect(checkAccess(req({ ...PHONE, path: "/api/session-logs" }), auth)).not.toHaveProperty("redirect", "/remote");
  });

  it("keeps the phone out of the dashboard-only routes, even signed in", () => {
    const auth = new RemoteAuth({ pin: PIN });
    const cookie = `${SESSION_COOKIE}=${signIn(auth)}`;
    for (const path of ["/api/session", "/api/vision", "/api/rehearsal/generate", "/api/rehearsal/generated", "/api/snapshots/delete-all", "/api/conversation", "/api/remote/state", "/api/remote/commands", "/api/remote/alert", "/ws/body"]) {
      expect(checkAccess(req({ ...PHONE, path, method: "POST", cookie }), auth)).toMatchObject({ allow: false, status: 403 });
    }
    // The full dashboard (the brain) isn't for the phone either.
    expect(checkAccess(req({ ...PHONE, path: "/", cookie }), auth)).toMatchObject({ allow: false, redirect: "/remote" });
  });

  it("keeps the phone away from the per-voice clips (making them is billed text-to-speech), even signed in", () => {
    const auth = new RemoteAuth({ pin: PIN });
    const cookie = `${SESSION_COOKIE}=${signIn(auth)}`;
    expect(checkAccess(req({ ...PHONE, path: "/api/clips", method: "POST", cookie }), auth)).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req({ ...PHONE, path: "/api/clips/pumpkin/cedar-australian/lure/01.mp3", cookie }), auth)).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req({ ...LOCAL, path: "/api/clips", method: "POST" }), auth)).toMatchObject({ allow: true, who: "local" });
    // Not a prefix trick: only /api/clips and what's under it.
    expect(checkAccess(req({ ...PHONE, path: "/api/clipsx", cookie }), auth)).toMatchObject({ allow: true, who: "remote" });
  });

  it("keeps the origin check: other sites are refused, the phone's own origin is fine", () => {
    const auth = new RemoteAuth({ pin: PIN });
    const cookie = `${SESSION_COOKIE}=${signIn(auth)}`;
    expect(checkAccess(req({ ...LOCAL, origin: "https://evil.example" }), auth)).toMatchObject({ allow: false, status: 403, reason: "forbidden origin" });
    expect(checkAccess(req({ ...PHONE, cookie, origin: "https://evil.example" }), auth)).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req({ ...PHONE, cookie, origin: "http://192.168.1.5:8787" }), auth)).toMatchObject({ allow: true });
    // A page that rebinds its domain to 127.0.0.1 doesn't count as the local dashboard.
    expect(checkAccess(req({ socketAddress: "127.0.0.1", host: "evil.example:8787", origin: "http://evil.example:8787" }), auth)).toMatchObject({ allow: false, status: 401 });
    expect(checkAccess(req({ socketAddress: "127.0.0.1", host: "evil.example:8787", origin: "http://evil.example:8787" }), new RemoteAuth({ pin: "" }))).toMatchObject({ allow: false, status: 403 });
    expect(checkAccess(req({ socketAddress: "127.0.0.1", host: "evil.example:8787", path: "/api/session-logs" }), auth)).toMatchObject({ allow: false, status: 401 });
  });
});

describe("Remote routes (Hono middleware)", () => {
  const status: DashboardStatus = {
    character: "Jacqueline",
    woken: true,
    needsTap: false,
    autopilot: true,
    voice: "open",
    body: "idle",
    present: false,
    visitors: 0,
    camera: "ok",
    detector: "ok",
    awakeMinutesToday: 3,
    costToday: 0.15,
    capReached: false,
    modes: [],
    lastCommand: null,
  };

  function setup(pin = PIN) {
    const c = clock();
    const remote = new Remote({ remotePin: pin, ntfyTopic: "", ntfyServer: "", ntfyToken: "", arduinoEnabled: true, production: false, bodyStatus: () => "serial /dev/ttyACM0", todayLogUrl: () => "/api/session-logs/2026-10-31/log.html", now: c.now });
    const app = new Hono();
    remote.install(app);
    app.get("/api/health", (ctx) => ctx.json({ ok: true }));
    app.post("/api/session", (ctx) => ctx.json({ started: true }, 201));
    app.post("/api/vision", (ctx) => ctx.json({ error: "down" }, 502));
    app.post("/api/clips", (ctx) => ctx.json({ generated: 30 }));
    const call = (path: string, from: string, init: RequestInit & { host?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("host", init.host ?? (isLoopback(from) ? "localhost:8787" : "192.168.1.5:8787"));
      return app.request(path, { ...init, headers }, { incoming: { socket: { remoteAddress: from } } });
    };
    return { remote, app, call, clock: c };
  }

  it("loopback needs no PIN; the phone gets 401 until it signs in, then a cookie works", async () => {
    const { call } = setup();
    expect((await call("/api/health", "127.0.0.1")).status).toBe(200);
    expect((await call("/api/health", "192.168.1.23")).status).toBe(401);
    const wrong = await call("/api/remote/login", "192.168.1.23", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "999999" }) });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const ok = await call("/api/remote/login", "192.168.1.23", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: PIN }) });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toContain(PIN);
    const cookie = setCookie.split(";")[0]!;
    expect((await call("/api/health", "192.168.1.23", { headers: { cookie } })).status).toBe(200);
    // Signed in or not, the phone can't start a billed session, or make billed clips.
    expect((await call("/api/session", "192.168.1.23", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await call("/api/session", "127.0.0.1", { method: "POST" })).status).toBe(201);
    expect((await call("/api/clips", "192.168.1.23", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await call("/api/clips", "127.0.0.1", { method: "POST" })).status).toBe(200);
  });

  it("form sign-in (no JavaScript) posts the PIN in the body and redirects back", async () => {
    const { call } = setup();
    const res = await call("/api/remote/login", "192.168.1.23", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `pin=${PIN}` });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/remote");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it("rate limits PIN attempts over HTTP with 429 and Retry-After", async () => {
    const { call } = setup();
    const attempt = () => call("/api/remote/login", "192.168.1.66", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "000000" }) });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses the phone entirely without REMOTE_PIN", async () => {
    const { call } = setup("");
    expect((await call("/remote", "192.168.1.23")).status).toBe(403);
    expect((await call("/api/remote/login", "192.168.1.23", { method: "POST", body: JSON.stringify({ pin: "" }) })).status).toBe(403);
    expect((await call("/api/health", "127.0.0.1")).status).toBe(200);
  });

  it("serves the PIN page with a strict CSP", async () => {
    const { call } = setup();
    const res = await call("/remote", "192.168.1.23");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("Jacqueline remote");
  });

  it("relays commands only when the dashboard listens, and the heartbeat clears the offline alert", async () => {
    const { remote, call, clock: c } = setup();
    const cookie = `${SESSION_COOKIE}=${signIn(remote.auth)}`;
    const send = (body: unknown) => call("/api/remote/command", "192.168.1.23", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send({ type: "greet" })).status).toBe(503);

    const state = await call("/api/remote/state", "127.0.0.1", { method: "POST", body: JSON.stringify(status) });
    expect(state.status).toBe(200);
    expect(remote.snapshot()).toMatchObject({ dashboardOnline: true, dashboard: { character: "Jacqueline" } });
    c.advance(46_000);
    remote.tick();
    expect(remote.snapshot().dashboardOnline).toBe(false);
    expect(remote.alerts.isOpen("dashboard-offline")).toBe(true);
    remote.dashboardCheckedIn(status);
    expect(remote.alerts.isOpen("dashboard-offline")).toBe(false);
  });

  it("takes the dashboard's offline-mode alert and its all-clear", async () => {
    const { remote, call } = setup();
    const post = (body: unknown) => call("/api/remote/alert", "127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await post({ kind: "voice-offline", detail: "fetch failed" })).status).toBe(204);
      expect(remote.alerts.isOpen("voice-offline")).toBe(true);
      expect(warn).toHaveBeenCalledWith("[alert] Voice offline: playing recorded greetings: fetch failed");
      expect((await post({ kind: "voice-offline", resolve: true, detail: "live voice back after 95 s offline" })).status).toBe(204);
      expect(remote.alerts.isOpen("voice-offline")).toBe(false);
      expect(log).toHaveBeenCalledWith("[alert] cleared: Voice offline: playing recorded greetings (live voice back after 95 s offline)");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it("counts open phone and dashboard streams, and forgets them when they go away", async () => {
    const { remote, call } = setup();
    expect(remote.streamCounts()).toEqual({ phones: 0, dashboards: 0 });
    const phone = (await call("/api/remote/stream", "127.0.0.1")).body!.getReader();
    const dashboard = (await call("/api/remote/commands", "127.0.0.1")).body!.getReader();
    await phone.read(); // the first snapshot
    expect(remote.streamCounts()).toEqual({ phones: 1, dashboards: 1 });
    await phone.cancel();
    await dashboard.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(remote.streamCounts()).toEqual({ phones: 0, dashboards: 0 });
  });

  it("raises a vision alert once failures pile up", async () => {
    const { remote, call } = setup();
    for (let i = 0; i < 3; i++) await call("/api/vision", "127.0.0.1", { method: "POST" });
    expect(remote.alerts.alerts[0]).toMatchObject({ kind: "vision-errors" });
  });

  it("lets only the dashboard delete all snapshots, even with the phone signed in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "creature-remote-"));
    try {
      const photo = join(dir, "2026-10-31", "snapshots", "18-00-00-arrived.jpg");
      mkdirSync(dirname(photo), { recursive: true });
      writeFileSync(photo, "jpeg");
      const { remote, app, call } = setup();
      // The same handler shape as server/index.ts.
      app.post("/api/snapshots/delete-all", async (ctx) => ctx.json(deleteAllSnapshots(dir)));
      const cookie = `${SESSION_COOKIE}=${signIn(remote.auth)}`;
      const phone = await call("/api/snapshots/delete-all", "192.168.1.23", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: '{"confirm":true}' });
      expect(phone.status).toBe(403);
      expect(existsSync(photo)).toBe(true);
      expect((await call("/api/snapshots/delete-all", "192.168.1.23", { method: "POST", body: '{"confirm":true}' })).status).toBe(401);
      expect(existsSync(photo)).toBe(true);
      const local = await call("/api/snapshots/delete-all", "127.0.0.1", { method: "POST", headers: { "content-type": "application/json" }, body: '{"confirm":true}' });
      expect(local.status).toBe(200);
      expect(await local.json()).toEqual({ days: ["2026-10-31"], files: 1 });
      expect(existsSync(photo)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates commands", () => {
    expect(parseCommand({ type: "greet" }, "1")).toEqual({ id: "1", type: "greet" });
    expect(parseCommand({ type: "say", text: "  Only  one\npiece! " }, "1")).toEqual({ id: "1", type: "say", text: "Only one piece!" });
    expect(parseCommand({ type: "say", text: "x".repeat(301) }, "1")).toBeNull();
    expect(parseCommand({ type: "mode", mode: "candyLow", on: true }, "1")).toMatchObject({ mode: "candyLow", on: true });
    expect(parseCommand({ type: "mode", mode: "../x", on: true }, "1")).toBeNull();
    expect(parseCommand({ type: "reboot" }, "1")).toBeNull();
    expect(parseCommand(null, "1")).toBeNull();
  });
});

describe("AlertCenter", () => {
  function fakeNotifier() {
    const sent: { title: string; text: string }[] = [];
    const notifier: Notifier = { send: async (m) => void sent.push(m) };
    return { sent, notifier };
  }

  it("folds repeats of an open problem into one alert and pushes it once", () => {
    const c = clock();
    const { sent, notifier } = fakeNotifier();
    const alerts = new AlertCenter({ now: c.now, notifier });
    expect(alerts.raise("camera-lost", "no frames")).toBe(true);
    c.advance(1000);
    expect(alerts.raise("camera-lost", "still no frames")).toBe(false);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({ count: 2, detail: "still no frames", resolvedAt: null });
    expect(sent).toHaveLength(1);
  });

  it("pushes the same kind again only after the cooldown, even if it cleared in between", () => {
    const c = clock();
    const { sent, notifier } = fakeNotifier();
    const alerts = new AlertCenter({ now: c.now, notifier, pushEveryMs: 15 * 60_000 });
    alerts.raise("arduino-disconnected");
    alerts.resolve("arduino-disconnected");
    c.advance(60_000);
    alerts.raise("arduino-disconnected");
    expect(alerts.alerts).toHaveLength(2);
    expect(sent).toHaveLength(1);
    c.advance(15 * 60_000);
    alerts.raise("arduino-disconnected");
    expect(sent).toHaveLength(2);
  });

  it("pushes one offline-mode alert however often the voice flaps between offline and back", () => {
    const c = clock();
    const { sent, notifier } = fakeNotifier();
    const alerts = new AlertCenter({ now: c.now, notifier });
    for (let i = 0; i < 5; i++) {
      alerts.raise("voice-offline", "fetch failed");
      c.advance(60_000);
      alerts.resolve("voice-offline", "live voice back");
      c.advance(60_000);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Voice offline: playing recorded greetings" });
    expect(sent[0]!.text).not.toContain("fetch failed"); // fixed text only
    c.advance(15 * 60_000);
    alerts.raise("voice-offline");
    expect(sent).toHaveLength(2);
  });

  it("caps pushes per hour across kinds", () => {
    const c = clock();
    const { sent, notifier } = fakeNotifier();
    const alerts = new AlertCenter({ now: c.now, notifier, maxPushes: 2, pushWindowMs: 60 * 60_000 });
    alerts.raise("camera-lost");
    alerts.raise("detector-failed");
    alerts.raise("voice-errors");
    expect(sent).toHaveLength(2);
    expect(alerts.alerts).toHaveLength(3); // still all on screen
    c.advance(60 * 60_000);
    alerts.raise("cost-cap");
    expect(sent).toHaveLength(3);
  });

  it("never pushes the detail (it can hold anything), only fixed text", () => {
    const { sent, notifier } = fakeNotifier();
    const alerts = new AlertCenter({ notifier });
    alerts.raise("voice-errors", "Visitor said: my name is Emma and I live at 12 Elm St");
    expect(JSON.stringify(sent)).not.toMatch(/Emma|Elm/);
    expect(sent[0]!.title).toBe("Voice session failing");
  });

  it("keeps the newest alerts and notifies listeners", () => {
    const alerts = new AlertCenter({ keep: 2 });
    const listener = vi.fn();
    alerts.subscribe(listener);
    alerts.raise("camera-lost");
    alerts.raise("cost-cap");
    alerts.raise("needs-wake");
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["needs-wake", "cost-cap"]);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe("NtfyNotifier", () => {
  it("POSTs plain text to the topic with ASCII headers", async () => {
    const post = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
    const ntfy = new NtfyNotifier("jacques-Xk3f9QpL2mVw7", "https://ntfy.sh/", "", post as unknown as typeof fetch);
    await ntfy.send({ title: "Camera stopped", text: "The camera stopped.", level: "error" });
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/jacques-Xk3f9QpL2mVw7");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("The camera stopped.");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Title).toBe("Jacqueline: Camera stopped");
    expect(headers.Priority).toBe("high");
    for (const value of Object.values(headers)) expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects topics with odd characters and reports HTTP errors without the URL", async () => {
    expect(() => new NtfyNotifier("a/b")).toThrow(/NTFY_TOPIC/);
    const ntfy = new NtfyNotifier("secret-topic-123", "https://ntfy.sh", "tk_abc", (async () => new Response("no", { status: 403 })) as unknown as typeof fetch);
    await expect(ntfy.send({ title: "x", text: "y", level: "warn" })).rejects.toThrow(/^ntfy answered HTTP 403$/);
  });
});
