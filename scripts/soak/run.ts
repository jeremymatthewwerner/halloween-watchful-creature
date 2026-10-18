/**
 * Soak test: `npm run soak` (options: --hours 4, --seed 1031, --sample 20, --out <dir>, --headful,
 * --no-build, --chrome <path>). See docs/SOAK_TEST.md.
 *
 * Runs the real server (production build, BODY_SERIAL_PORT=none, temp log dir) against a local mock
 * of OpenAI, and the real dashboard in headless Chrome with fake camera and mic, in rehearsal mode,
 * with WebRTC replaced by a fake GPT-Live session (scripts/soak/pageHooks.ts). Then it plays a whole
 * Halloween evening of visitors, compressed, plus phone-remote presses, log and remote streams that
 * keep reconnecting, a stalled reader and an OpenAI outage, while sampling memory, timers, streams
 * and disk. No real OpenAI calls are possible: the server gets a fake key and the mock's URL.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { awakeWindows, greetings, merge, outside, type Append, type Span } from "./analysis.ts";
import { Cdp, nodeInspectorUrl } from "./cdp.ts";
import { leakChecks, formatChecks, maxOf, toCsv, type Check, type Sample } from "./metrics.ts";
import { seeded, startMockOpenAI } from "./mockOpenAI.ts";
import { soakPageHooks, type PageHookOptions, type SoakAppend, type SoakPageSnapshot } from "./pageHooks.ts";
import { planEvening, quietWindows, type Step } from "./scenario.ts";

// --- options ------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const HOURS = Number(option("hours", "4"));
const SEED = Number(option("seed", "1031"));
const SAMPLE_MS = Number(option("sample", "20")) * 1000;
const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(option("out", join(tmpdir(), `creature-soak-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`)));
const CHROME =
  option("chrome", "") ||
  process.env.CHROME_PATH ||
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p)) ||
  "";
/** How many sample images (group sizes 1–4, two each), "generated" through the real server and the mock. */
const GROUP_SIZES = [1, 1, 2, 2, 3, 3, 4, 4];

const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const say = (text: string) => console.log(`[soak] ${text}`);

// --- children and cleanup ---------------------------------------------------------------------------
const children: ChildProcess[] = [];
let cleaningUp = false;
function cleanup(): void {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("exit", cleanup);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolvePort(port));
    });
  });
}

function dirStats(dir: string): { bytes: number; files: number; snapshots: number } {
  let bytes = 0;
  let files = 0;
  let snapshots = 0;
  const walk = (d: string) => {
    for (const name of existsSync(d) ? readdirSync(d) : []) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        bytes += st.size;
        files++;
        if (d.endsWith("snapshots")) snapshots++;
      }
    }
  };
  walk(dir);
  return { bytes, files, snapshots };
}

// --- a tiny SSE client, for the streams that keep reconnecting ----------------------------------------
interface SseClient {
  close(abrupt: boolean): void;
  readonly events: number;
  readonly lastId: string | undefined;
}

function sse(port: number, path: string, opts: { lastEventId?: string; onData?(event: string, data: string): void; stall?: boolean } = {}): SseClient {
  let events = 0;
  let lastId = opts.lastEventId;
  let buffer = "";
  let res: http.IncomingMessage | null = null;
  const req = http.get({ host: "127.0.0.1", port, path, headers: { accept: "text/event-stream", ...(lastId && { "last-event-id": lastId }) } }, (r) => {
    res = r;
    if (opts.stall) {
      r.pause(); // never read: the server's writes back up
      return;
    }
    r.setEncoding("utf8");
    r.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) lastId = line.slice(3).trim();
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        events++;
        opts.onData?.(event, data.join("\n"));
      }
    });
    r.on("error", () => undefined);
  });
  req.on("error", () => undefined);
  return {
    close(abrupt) {
      const socket = req.socket;
      if (abrupt && socket && !socket.destroyed) socket.resetAndDestroy();
      else req.destroy();
    },
    get events() {
      return events;
    },
    get lastId() {
      return lastId;
    },
  };
}

// --- the in-page helpers the timeline drives (the real rehearsal panel's buttons) ----------------------
const UI = `window.__soakUi ||= (() => {
  const press = (emoji) => {
    const b = [...document.querySelectorAll(".rehearsal .buttons button")].find((x) => x.textContent.startsWith(emoji));
    if (!b) return "no button " + emoji;
    if (b.disabled) return "button disabled " + emoji;
    b.click();
    return null;
  };
  const chosen = () => [...document.querySelectorAll(".rehearsal-thumbs [data-name]")];
  const current = () => chosen().findIndex((c) => c.classList.contains("current"));
  const pick = (i) => {
    const list = chosen();
    if (!list.length) return;
    let k = i % list.length;
    if (k === current()) k = (k + 1) % list.length; // a new group never looks like the last one
    list[k].click();
  };
  return {
    awake: () => document.getElementById("start-card")?.hidden === true,
    generated: () => document.querySelectorAll(".rehearsal-thumbs.generated .thumb").length,
    addGenerated: () => document.querySelectorAll(".rehearsal-thumbs.generated .thumb").forEach((c) => c.click()),
    names: () => chosen().map((c) => c.dataset.name),
    rehearsing: () => document.body.classList.contains("rehearsing"),
    startRehearsal: () => { const t = document.querySelector(".rehearsal-toggle input"); if (t && !t.checked) t.click(); },
    arrive: (i, keep) => { if (!keep) pick(i); return press("🚶"); },
    flicker: (i) => { pick(i); const p = press("🚶"); setTimeout(() => press("👋"), 300); return p; },
    leave: () => press("👋"),
    join: () => press("👯"),
    swap: () => press("🔁"),
  };
})();`;

/** Cartoonish porch pictures with N figures, as JPEG base64 (rendered by Chrome: Node has no JPEG encoder). */
function renderVisitorImages(sizes: number[]): string[] {
  return sizes.map((n, k) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d")!;
    const sky = ctx.createLinearGradient(0, 0, 0, 1024);
    sky.addColorStop(0, "#1b1040");
    sky.addColorStop(1, `hsl(${(k * 47) % 360} 40% 25%)`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 1536, 1024);
    // Texture so the JPEG is about as big as a real camera frame.
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `hsla(${Math.random() * 360} 60% 50% / 0.25)`;
      ctx.fillRect(Math.random() * 1536, Math.random() * 1024, 2 + Math.random() * 18, 2 + Math.random() * 18);
    }
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) * 1536) / n;
      ctx.fillStyle = `hsl(${(k * 90 + i * 70) % 360} 70% 55%)`;
      ctx.fillRect(x - 110, 420, 220, 520);
      ctx.beginPath();
      ctx.arc(x, 330, 95, 0, Math.PI * 2);
      ctx.fillStyle = "#f2c9a0";
      ctx.fill();
      ctx.fillStyle = `hsl(${(k * 30 + i * 110) % 360} 80% 40%)`;
      ctx.beginPath();
      ctx.moveTo(x - 120, 270);
      ctx.lineTo(x, 60 + Math.random() * 80);
      ctx.lineTo(x + 120, 270);
      ctx.fill();
    }
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!;
  });
}

/** Serializes a function for the page. tsx (esbuild keepNames) may wrap functions in __name(). */
const pageFn = (fn: (...a: never[]) => unknown, ...callArgs: unknown[]) => `var __name = (f) => f;\n(${fn.toString()})(${callArgs.map((a) => JSON.stringify(a)).join(", ")})`;

const SERVER_STATS = `JSON.stringify((() => {
  const resources = {};
  for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] || 0) + 1;
  return { ...process.memoryUsage(), resources };
})())`;

async function main(): Promise<void> {
  if (!CHROME) throw new Error("No Chrome found: pass --chrome <path> or set CHROME_PATH");
  mkdirSync(OUT, { recursive: true });
  const logDir = join(OUT, "logs");
  const cacheDir = join(OUT, "rehearsal-cache");
  const profile = join(OUT, "chrome-profile");
  const emptyEnv = join(OUT, "empty.env");
  writeFileSync(emptyEnv, "# the soak test ignores the project's .env\n");

  const plan = planEvening({ hours: HOURS, seed: SEED, images: GROUP_SIZES });
  say(
    `evening: ${HOURS} h, ${plan.groups} groups, ${plan.flickers} passers-by; compressed to ~${Math.round(plan.wallMs / 60_000)} min ` +
      `(gaps ÷${plan.gapSpeed}, visits ÷${plan.staySpeed}; IDLE_CLOSE_SECONDS=${plan.settings.idleCloseSeconds}, BACKGROUND_FRAME_SECONDS=${plan.settings.backgroundFrameSeconds})`,
  );
  say(`output: ${OUT}`);

  if (!flag("no-build")) {
    say("building the dashboard (npm run build)…");
    const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
    if (build.status !== 0) throw new Error("npm run build failed");
  }

  // --- mock OpenAI -------------------------------------------------------------------------------
  const mock = await startMockOpenAI({ random: seeded(SEED), failRate: { live: 0.02, responses: 0.02 }, latencyMs: { min: 150, max: 1200 } });
  say(`mock OpenAI at ${mock.url}`);

  // --- the real server, pointed at the mock -----------------------------------------------------------
  const port = await freePort();
  const inspectPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: emptyEnv,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    OPENAI_API_KEY: "sk-soak-fake-key-not-real",
    OPENAI_API_BASE: mock.url,
    ENGINE: "live",
    CHARACTER: "pumpkin",
    VOICE: "",
    BODY_SERIAL_PORT: "none",
    LOG_DIR: logDir,
    LOG_SNAPSHOTS: "true",
    REHEARSAL_CACHE_DIR: cacheDir,
    IDLE_CLOSE_SECONDS: String(plan.settings.idleCloseSeconds),
    BACKGROUND_FRAME_SECONDS: String(plan.settings.backgroundFrameSeconds),
    REMOTE_PIN: "",
    NTFY_TOPIC: "",
    NTFY_TOKEN: "",
  };
  if (!env.OPENAI_API_BASE?.startsWith("http://127.0.0.1:")) throw new Error("refusing to run: the API base isn't the local mock");
  const serverLog = createWriteStream(join(OUT, "server.log"));
  const server = spawn(process.execPath, [`--inspect=127.0.0.1:${inspectPort}`, "--import", "tsx", "server/index.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(server);
  const serverLines = { alerts: 0, errors: 0, warnings: 0 };
  const scan = (chunk: Buffer) => {
    serverLog.write(chunk);
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.includes("[alert]") && !line.includes("cleared")) serverLines.alerts++;
      if (/\b(Error|TypeError|ReferenceError|Unhandled)\b/.test(line)) serverLines.errors++;
    }
  };
  server.stdout!.on("data", scan);
  server.stderr!.on("data", scan);
  server.on("exit", (code) => {
    if (!cleaningUp) say(`❌ the server exited (code ${code})`);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    if (i > 150) throw new Error("the server didn't start (see server.log)");
    await sleep(200);
  }
  const nodeCdp = await Cdp.connect(await nodeInspectorUrl(inspectPort));
  say(`server on ${base} (inspector ${inspectPort})`);

  // --- Chrome ------------------------------------------------------------------------------------
  const chrome = spawn(
    CHROME,
    [
      ...(flag("headful") ? [] : ["--headless=new"]),
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--mute-audio",
      "--window-size=1400,1000",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  children.push(chrome);
  chrome.stderr!.on("data", () => undefined);
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; !existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2; i++) {
    if (i > 150) throw new Error(`Chrome didn't start (${CHROME})`);
    await sleep(200);
  }
  const [devPort, devPath] = readFileSync(portFile, "utf8").split("\n");
  const browser = await Cdp.connect(`ws://127.0.0.1:${devPort}${devPath}`);
  const { targetId } = await browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const page = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => browser.send<T>(method, params, sessionId);
  const evaluate = <T = unknown>(expression: string, timeoutMs?: number) => browser.evaluate<T>(expression, sessionId, timeoutMs);
  await page("Page.enable");
  await page("Runtime.enable");
  await page("Performance.enable");
  const pageErrors: string[] = [];
  const pageLog = createWriteStream(join(OUT, "page-console.log"));
  browser.on("Runtime.exceptionThrown", (p, sid) => {
    if (sid !== sessionId) return;
    const details = p.exceptionDetails as { text?: string; exception?: { description?: string } };
    const text = details.exception?.description ?? details.text ?? "?";
    pageErrors.push(text);
    pageLog.write(`${new Date().toISOString()} EXCEPTION ${text}\n`);
  });
  browser.on("Runtime.consoleAPICalled", (p, sid) => {
    if (sid !== sessionId) return;
    const parts = (p.args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? "")));
    pageLog.write(`${new Date().toISOString()} ${String(p.type)} ${parts.join(" ")}\n`);
  });
  let loads = 0;
  browser.on("Page.loadEventFired", (_p, sid) => {
    if (sid === sessionId) loads++;
  });

  // Sample images: rendered by Chrome, handed out by the mock's image endpoint, saved by the real server.
  const rendered = await evaluate<string[]>(pageFn(renderVisitorImages as (...a: never[]) => unknown, GROUP_SIZES), 60_000);
  const bySize = new Map<number, Buffer[]>();
  rendered.forEach((b64, i) => bySize.set(GROUP_SIZES[i]!, [...(bySize.get(GROUP_SIZES[i]!) ?? []), Buffer.from(b64, "base64")]));
  mock.setImages(bySize);
  for (const size of [1, 2, 3, 4]) {
    const res = await fetch(`${base}/api/rehearsal/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 2, groupSize: size }) });
    if (res.status !== 201) throw new Error(`generating sample visitors failed: HTTP ${res.status} ${await res.text()}`);
  }

  const hooks: PageHookOptions = { seed: SEED, realSnapshots: true, dropChance: 0.04, ignoreChance: 0.08 };
  await page("Page.addScriptToEvaluateOnNewDocument", { source: pageFn(soakPageHooks as (...a: never[]) => unknown, hooks) });

  /** Opens the dashboard (or recovers after a reload): awake, sample images chosen, rehearsal on. */
  const setUp = async () => {
    for (let i = 0; !(await evaluate<boolean>(`${UI}; __soakUi.awake()`).catch(() => false)); i++) {
      if (i > 300) throw new Error("the dashboard didn't wake (see page-console.log)");
      await sleep(200);
    }
    for (let i = 0; (await evaluate<number>(`${UI}; __soakUi.generated()`)) < GROUP_SIZES.length; i++) {
      if (i > 100) throw new Error("the generated visitors didn't show up in the rehearsal panel");
      await sleep(200);
    }
    if ((await evaluate<string[]>(`${UI}; __soakUi.names()`)).length < GROUP_SIZES.length) await evaluate(`${UI}; __soakUi.addGenerated()`);
    for (let i = 0; (await evaluate<string[]>(`${UI}; __soakUi.names()`)).length < GROUP_SIZES.length; i++) {
      if (i > 100) throw new Error("couldn't add the sample images");
      await sleep(200);
    }
    await evaluate(`${UI}; __soakUi.startRehearsal()`);
  };
  await page("Page.navigate", { url: `http://localhost:${port}/?autowake` });
  await setUp();
  const names = await evaluate<string[]>(`${UI}; __soakUi.names()`);
  say(`dashboard awake in rehearsal mode with ${names.length} sample images (${names.map((n) => /👥(\d)/.exec(n)?.[1]).join(",")} people)`);
  const loadsAtStart = loads;

  // --- background traffic: streams that come and go, a stalled reader -------------------------------------
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  let running = true;
  const rng = seeded(SEED + 1);
  const clients = new Set<SseClient>();
  let sseReconnects = 0;
  let logEvents = 0;
  const acks = new Map<string, { ok: boolean; message: string }>();
  const churn = async (path: string, minS: number, maxS: number, onData?: (event: string, data: string) => void) => {
    let lastId: string | undefined;
    while (running) {
      const client = sse(port, path, { lastEventId: lastId, onData });
      clients.add(client);
      sseReconnects++;
      await sleep((minS + rng() * (maxS - minS)) * 1000);
      lastId = client.lastId;
      logEvents += path === "/api/logs" ? client.events : 0;
      client.close(rng() < 0.5);
      clients.delete(client);
      await sleep(500 + rng() * 4000);
    }
  };
  const background = [
    churn("/api/logs", 5, 60),
    churn("/api/logs", 20, 120),
    // A phone on the remote: its snapshots also show which commands the dashboard ran.
    churn("/api/remote/stream", 20, 150, (event, data) => {
      if (event !== "snapshot") return;
      const last = (JSON.parse(data) as { dashboard?: { lastCommand?: { id: string; ok: boolean; message: string } | null } }).dashboard?.lastCommand;
      if (last) acks.set(last.id, { ok: last.ok, message: last.message });
    }),
  ];
  // A client that connects and never reads (a phone that dropped off the Wi-Fi), for 3 minutes.
  const stallAt = plan.wallMs * 0.3;
  background.push(
    (async () => {
      await sleep(stallAt);
      if (!running) return;
      const stalled = sse(port, "/api/logs", { stall: true });
      clients.add(stalled);
      await sleep(180_000);
      stalled.close(true);
      clients.delete(stalled);
    })(),
  );

  // --- sampling -----------------------------------------------------------------------------------
  const samples: Sample[] = [];
  const appends: Append[] = [];
  const sessions: Span[] = [];
  const sample = async (): Promise<Sample> => {
    const s: Sample = { t: at() };
    try {
      await nodeCdp.send("HeapProfiler.collectGarbage");
      const m = JSON.parse(await nodeCdp.evaluate<string>(SERVER_STATS)) as NodeJS.MemoryUsage & { resources: Record<string, number> };
      Object.assign(s, { serverRss: m.rss, serverHeapUsed: m.heapUsed, serverHeapTotal: m.heapTotal, serverExternal: m.external, serverTimeouts: m.resources.Timeout ?? 0, serverSockets: m.resources.TCPSocketWrap ?? 0 });
    } catch (err) {
      say(`server stats failed: ${(err as Error).message}`);
    }
    try {
      const started = performance.now();
      const health = (await (await fetch(`${base}/api/health`)).json()) as { streams: { logs: number; phones: number; dashboards: number } };
      s.healthMs = Math.round(performance.now() - started);
      Object.assign(s, { sseLogs: health.streams.logs, ssePhones: health.streams.phones, sseDashboards: health.streams.dashboards });
      const age = Number(await (await fetch(`${base}/api/remote/heartbeat`)).text());
      if (age >= 0) s.heartbeatAgeS = age;
    } catch (err) {
      say(`health check failed: ${(err as Error).message}`);
    }
    try {
      await page("HeapProfiler.collectGarbage");
      const { metrics } = await page<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics");
      const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? NaN;
      Object.assign(s, {
        browserHeapUsed: metric("JSHeapUsedSize"),
        browserHeapTotal: metric("JSHeapTotalSize"),
        domNodes: metric("Nodes"),
        jsListeners: metric("JSEventListeners"),
        audioHandlers: metric("AudioHandlers"),
        documents: metric("Documents"),
      });
      const snap = await evaluate<SoakPageSnapshot>("__soak.snapshot()");
      Object.assign(s, {
        pageTimeouts: snap.timeouts,
        pageIntervals: snap.intervals,
        pageEventSources: snap.eventSources,
        pageWebSockets: snap.webSockets,
        sessionsOpen: snap.sessionsOpen,
        sessionsStarted: snap.sessionsStarted,
        sessionMinutes: snap.sessionMs / 60_000,
        fetchInflight: snap.fetchInflight,
        slowFetches: snap.slowFetches,
        maxLagMs: snap.maxLagMs,
        oversizeAppends: snap.oversizeAppends,
        domAttached: snap.domAttached,
      });
      const drained = await evaluate<{ appends: SoakAppend[]; sessions: { from: number; to: number }[] }>("__soak.drain()");
      for (const a of drained.appends) appends.push({ t: a.at - t0, type: a.type });
      for (const x of drained.sessions) sessions.push([x.from - t0, x.to - t0]);
    } catch (err) {
      say(`page stats failed: ${(err as Error).message}`);
    }
    const disk = dirStats(logDir);
    Object.assign(s, { logBytes: disk.bytes, snapshotFiles: disk.snapshots, mockVision: mock.stats.calls.responses ?? 0, mockSessions: mock.stats.calls.live ?? 0 });
    return s;
  };
  const sampler = (async () => {
    while (running) {
      const s = await sample();
      samples.push(s);
      writeFileSync(join(OUT, "samples.csv"), toCsv(samples));
      if (samples.length % 6 === 1) {
        say(
          `t=${Math.round(s.t / 60_000)} min · server heap ${(s.serverHeapUsed! / MB).toFixed(1)} MB rss ${(s.serverRss! / MB).toFixed(0)} MB · ` +
            `page heap ${(s.browserHeapUsed! / MB).toFixed(1)} MB, ${s.domNodes} nodes, ${s.jsListeners} listeners · sessions ${s.sessionsStarted} · ` +
            `vision ${s.mockVision} · logs ${(s.logBytes! / MB).toFixed(1)} MB`,
        );
      }
      // A reload (the watchdog's) loses rehearsal mode: set it up again and carry on.
      if (loads > loadsAtStart && !(await evaluate<boolean>(`${UI}; __soakUi.rehearsing()`).catch(() => false))) {
        say("⚠️ the page reloaded: setting rehearsal up again");
        await setUp().catch((err: Error) => say(`set-up after reload failed: ${err.message}`));
      }
      await sleep(SAMPLE_MS - (at() - s.t));
    }
  })();

  // --- the evening ---------------------------------------------------------------------------------------
  const sent: { at: number; id: string; type: string }[] = [];
  const problems: string[] = [];
  for (const step of plan.steps) {
    await sleep(step.at - at());
    try {
      let problem: string | null = null;
      switch (step.do) {
        case "arrive":
          problem = await evaluate<string | null>(`${UI}; __soakUi.arrive(${step.image}, ${step.kind === "return-soon" || step.kind === "return-later"})`);
          break;
        case "flicker":
          problem = await evaluate<string | null>(`${UI}; __soakUi.flicker(${step.image})`);
          break;
        case "leave":
        case "join":
        case "swap":
          problem = await evaluate<string | null>(`${UI}; __soakUi.${step.do}()`);
          break;
        case "remote": {
          const res = await fetch(`${base}/api/remote/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(step.command) });
          const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
          if (body.id) sent.push({ at: at(), id: body.id, type: step.command.type });
          else problem = `remote ${step.command.type}: HTTP ${res.status} ${body.error ?? ""}`;
          break;
        }
        case "outage":
          mock.setOutage(step.on);
          say(`OpenAI outage ${step.on ? "starts (75 s)" : "ends"}`);
          break;
      }
      if (problem) problems.push(`${Math.round(step.at / 1000)} s ${step.do}: ${problem}`);
    } catch (err) {
      problems.push(`${Math.round(step.at / 1000)} s ${step.do}: ${(err as Error).message}`);
    }
  }

  // --- wind down: let the session go to sleep, close the extra streams, then the final count -----------
  say("evening over; letting the porch go quiet…");
  await sleep((plan.settings.idleCloseSeconds + 25) * 1000);
  running = false;
  await sampler;
  for (const client of clients) client.close(false);
  clients.clear();
  await sleep(4000);
  const final = await sample();
  samples.push(final);
  writeFileSync(join(OUT, "samples.csv"), toCsv(samples));
  await Promise.race([Promise.all(background), sleep(5000)]);

  // --- results ------------------------------------------------------------------------------------
  const warmupMs = Math.max(3 * 60_000, plan.wallMs * 0.15);
  const checks: Check[] = leakChecks(samples, { warmupMs });
  const check = (name: string, pass: boolean | null, value: string, limit: string) => checks.push({ name, pass, value, limit });
  check("log streams left open after clients went away", final.sseLogs === 1, String(final.sseLogs), "1 (the dashboard)");
  check("remote streams left open", final.ssePhones === 0 && final.sseDashboards === 1, `${final.ssePhones} phones, ${final.sseDashboards} dashboards`, "0 phones, 1 dashboard");
  check("unexpected page reloads", loads - loadsAtStart === 0, String(loads - loadsAtStart), "0");
  check("uncaught page errors", pageErrors.length === 0, String(pageErrors.length), "0");
  const unanswered = sent.filter((c) => !acks.has(c.id));
  check("phone commands the dashboard never ran", unanswered.length === 0, `${unanswered.length} of ${sent.length}`, "0");

  const quiet = quietWindows(plan.steps);
  const greeted = greetings(plan.steps, appends, quiet);
  const arrivalsJudged = Object.values(greeted.byKind).reduce((a, k) => a + k.greeted + k.silent + k.none, 0);
  const newJudged = greeted.byKind.new.greeted + greeted.byKind.new.silent + greeted.byKind.new.none + greeted.byKind["swap-in"].greeted + greeted.byKind["swap-in"].silent + greeted.byKind["swap-in"].none;
  check("new groups not greeted within 20 s", greeted.missed.length <= Math.ceil(newJudged * 0.03), `${greeted.missed.length} of ${newJudged}`, "≤ 3%");

  check("voice session still open once the porch went quiet", final.sessionsOpen === 0, String(final.sessionsOpen), "0");
  const awake = awakeWindows(plan.steps, plan.settings.idleCloseSeconds);
  const emptyPorch = sessions.map((span) => ({ span, ms: outside(span, merge([...awake, ...quiet])) })).filter((x) => x.ms > 0);
  const emptyMs = emptyPorch.reduce((a, x) => a + x.ms, 0);
  check("voice session open on an empty porch", emptyMs < 60_000, `${Math.round(emptyMs / 1000)} s in ${emptyPorch.length} sessions`, "< 60 s");

  const billedMin = (final.sessionMinutes ?? 0) as number;
  const disk = dirStats(logDir);
  const wallH = final.t / 3_600_000;
  const summary = {
    when: new Date().toISOString(),
    options: { hours: HOURS, seed: SEED, sampleSeconds: SAMPLE_MS / 1000 },
    plan: { groups: plan.groups, visits: plan.visits, flickers: plan.flickers, wallMinutes: Math.round(final.t / 60_000), settings: plan.settings, gapSpeed: plan.gapSpeed, staySpeed: plan.staySpeed },
    voice: {
      sessions: final.sessionsStarted,
      billedMinutesThisRun: Math.round(billedMin * 10) / 10,
      projectedOnTheNight: plan.projected,
      projectedCostUsd: Math.round(plan.projected.billedMinutes * 0.05 * 100) / 100,
      emptyPorchSeconds: Math.round(emptyMs / 1000),
      worstEmptyPorch: emptyPorch.sort((a, b) => b.ms - a.ms).slice(0, 5).map((x) => ({ fromS: Math.round(x.span[0] / 1000), toS: Math.round(x.span[1] / 1000), emptyS: Math.round(x.ms / 1000) })),
    },
    greetings: { ...greeted, judged: arrivalsJudged },
    remote: { sent: sent.length, ran: sent.length - unanswered.length, failed: [...acks.values()].filter((a) => !a.ok).map((a) => a.message) },
    streams: { reconnects: sseReconnects, logEventsReceived: logEvents },
    mock: mock.stats,
    disk: { bytes: disk.bytes, files: disk.files, snapshots: disk.snapshots, mbPerWallHour: Math.round((disk.bytes / MB / wallH) * 10) / 10, mbPerEvening: Math.round((disk.bytes / MB / HOURS) * 4 * 10) / 10 },
    server: { alertLines: serverLines.alerts, errorLines: serverLines.errors, peakRssMb: Math.round(maxOf(samples, "serverRss") / MB) },
    page: { errors: pageErrors.slice(0, 20), reloads: loads - loadsAtStart, peakHeapMb: Math.round((maxOf(samples, "browserHeapUsed") / MB) * 10) / 10 },
    driverProblems: problems,
    checks,
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify({ steps: plan.steps, appends, sessions, sent }, null, 2));

  console.log("\n🎃 Soak test summary");
  console.log(`  Evening: ${HOURS} h with ${plan.groups} groups (${plan.visits.new} new, ${plan.visits["swap-in"]} swap-ins, ${plan.visits["return-soon"] + plan.visits["return-later"]} returns), ${plan.flickers} passers-by, in ${(final.t / 60_000).toFixed(0)} min of wall time`);
  console.log(`  Voice: ${final.sessionsStarted} sessions, ${billedMin.toFixed(1)} billed min this run; on the real night (IDLE_CLOSE_SECONDS=180) ≈ ${plan.projected.sessions} sessions, ${plan.projected.billedMinutes} min, $${summary.voice.projectedCostUsd}`);
  console.log(`  Greetings: new ${fmtKind(greeted.byKind.new)}, swap-ins ${fmtKind(greeted.byKind["swap-in"])}, back soon ${fmtKind(greeted.byKind["return-soon"])}, back later ${fmtKind(greeted.byKind["return-later"])}; ${greeted.skipped} skipped (kill switch / outage)`);
  console.log(`  Vision calls: ${mock.stats.calls.responses ?? 0} (SAME ${mock.stats.verdicts.SAME}, NEW ${mock.stats.verdicts.NEW}, CHANGED ${mock.stats.verdicts.CHANGED}, plain ${mock.stats.verdicts.none}); injected failures ${mock.stats.injectedFailures}, outage failures ${mock.stats.outageFailures}`);
  console.log(`  Remote: ${sent.length - unanswered.length}/${sent.length} commands ran · streams reconnected ${sseReconnects} times`);
  console.log(`  Disk: ${(disk.bytes / MB).toFixed(1)} MB in ${disk.files} files (${disk.snapshots} snapshots), ≈ ${summary.disk.mbPerEvening} MB per 4-hour evening`);
  console.log(`  Server: peak RSS ${summary.server.peakRssMb} MB, ${serverLines.alerts} alert lines, ${serverLines.errors} error lines · Page: peak heap ${summary.page.peakHeapMb} MB`);
  if (problems.length) console.log(`  Driver problems (${problems.length}): ${problems.slice(0, 5).join("; ")}`);
  console.log(formatChecks(checks));
  console.log(`\n  Samples: ${join(OUT, "samples.csv")}\n  Summary: ${join(OUT, "summary.json")}\n`);

  browser.close();
  nodeCdp.close();
  cleanup();
  await mock.close();
  process.exitCode = checks.some((c) => c.pass === false) ? 1 : 0;
}

function fmtKind(k: { greeted: number; silent: number; none: number }): string {
  return `${k.greeted} greeted/${k.silent} silent/${k.none} none`;
}

main().catch((err) => {
  console.error(`[soak] failed: ${(err as Error).stack ?? err}`);
  cleanup();
  process.exit(2);
});
