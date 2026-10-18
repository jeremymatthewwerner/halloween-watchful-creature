import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { WebSocketServer } from "ws";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BodyMessage, ClientConfig, ConversationLogRequest, ServerLogEntry, VisionRequest } from "../shared/types.ts";
import { BodyController, NullSink, SerialSink } from "./body/driver.ts";
import { buildInstructions, listCharacterIds, loadCharacter, publicInfo } from "./characters.ts";
import { config } from "./config.ts";
import { buildGallery } from "./gallery.ts";
import { LOG_DAY, LogBuffer, SessionLog, captureConsole, logEventId } from "./logs.ts";
import { OpenAIError, createLiveSession, createRealtimeCall, describeFrame, voiceFor } from "./openai.ts";
import { listenHost } from "./auth.ts";
import { Remote } from "./remote.ts";

// Everything this process prints also goes to the dashboard's server log, and (unless
// LOG_DIR=none) to today's log on disk along with the conversation and greeting snapshots.
const logs = new LogBuffer();
captureConsole(logs);
const sessionLog = config.logDir === "none" ? null : new SessionLog(config.logDir, "Watchful Creature log");
if (sessionLog) {
  sessionLog.start(`engine ${config.engine}, character ${config.character}`);
  logs.subscribe((entry) => sessionLog.server(entry));
}

const app = new Hono();

// Only the dashboard itself may call the API (origin check), so other web pages open in the same
// browser can't start (billed) sessions against this local server. Other devices (the phone remote)
// need REMOTE_PIN and a signed-in session. Also health alerts. See server/auth.ts and server/remote.ts.
const remote = new Remote({
  ...config,
  arduinoEnabled: config.bodySerialPort !== "none",
  bodyStatus: () => body.status,
  todayLogUrl: () => (sessionLog ? `/api/session-logs/${sessionLog.currentDay}/log.html` : null),
});
remote.install(app);

function characterFrom(id: unknown) {
  const wanted = typeof id === "string" && id ? id : config.character;
  return loadCharacter(listCharacterIds().includes(wanted) ? wanted : config.character);
}

app.onError((err, c) => {
  if (err instanceof OpenAIError) {
    console.error(`[openai] ${err.message}: ${err.body.slice(0, 500)}`);
    return c.json({ error: err.message, detail: err.body.slice(0, 500) }, err.status === 503 ? 503 : 502);
  }
  console.error(err);
  return c.json({ error: (err as Error).message }, 500);
});

app.get("/api/config", (c) => {
  const character = characterFrom(c.req.query("character"));
  const body: ClientConfig = {
    engine: config.engine,
    character: publicInfo(character),
    characters: listCharacterIds().map((id) => ({ id, name: loadCharacter(id).name })),
    idleCloseSeconds: config.idleCloseSeconds,
    backgroundFrameSeconds: config.backgroundFrameSeconds,
    liveCostPerMinute: config.liveCostPerMinute,
    maxVoiceMinutesPerDay: config.maxVoiceMinutesPerDay,
    hasApiKey: Boolean(config.apiKey),
    sessionLogUrl: sessionLog ? `/api/session-logs/${sessionLog.currentDay}/log.html` : null,
  };
  return c.json(body);
});

app.get("/api/health", (c) => c.json({ ok: true, engine: config.engine, body: body.status, hasApiKey: Boolean(config.apiKey) }));

/** Exchanges the browser's WebRTC offer for an answer from GPT-Live or gpt-realtime. */
app.post("/api/session", async (c) => {
  const req = await c.req.json<{ sdp?: string; character?: string }>();
  if (typeof req.sdp !== "string" || !req.sdp.trim()) return c.json({ error: "An SDP offer is required" }, 400);
  const character = characterFrom(req.character);
  const instructions = buildInstructions(character, config.engine);
  const voice = voiceFor(config, character);
  if (config.engine === "live") {
    const { sdp, sessionId } = await createLiveSession(config, { sdp: req.sdp, instructions, voice });
    console.log(`[live] session ${sessionId} started as ${character.name} (${voice})`);
    return c.json({ engine: "live", sdp, sessionId }, 201);
  }
  const { sdp } = await createRealtimeCall(config, { sdp: req.sdp, instructions, voice });
  console.log(`[realtime] session started as ${character.name} (${voice})`);
  return c.json({ engine: "realtime", sdp }, 201);
});

/** Streams server log lines (Server-Sent Events): the backlog first, then new lines as they happen. */
app.get("/api/logs", (c) =>
  streamSSE(c, async (stream) => {
    let sending = Promise.resolve();
    const send = (entry: ServerLogEntry) => {
      sending = sending.then(() => stream.writeSSE({ id: logEventId(entry), data: JSON.stringify(entry) })).catch(() => undefined);
    };
    for (const entry of logs.since(c.req.header("last-event-id"))) send(entry);
    const unsubscribe = logs.subscribe(send);
    // Heartbeats let the dashboard notice a dead stream (a dev proxy can hold one open after a restart).
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined), 5_000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsubscribe();
  }),
);

/** Finished Conversation-panel lines (visitor and creature speech, system notes) for the on-disk log. */
app.post("/api/conversation", async (c) => {
  const { lines } = await c.req.json<ConversationLogRequest>();
  if (!Array.isArray(lines)) return c.json({ error: "lines must be an array" }, 400);
  for (const line of lines.slice(0, 100)) {
    if (!["visitor", "creature", "system"].includes(line?.who) || typeof line.text !== "string" || !Number.isFinite(line.at)) continue;
    sessionLog?.conversation(line.who, line.text.slice(0, 4000), line.at);
  }
  return c.body(null, 204);
});

/** Past days' logs, newest first. */
app.get("/api/session-logs", async (c) => {
  const days = sessionLog ? (await readdir(config.logDir).catch(() => [])).filter((d) => LOG_DAY.test(d)).sort().reverse() : [];
  const items = days.map((d) => `<li><a href="/api/session-logs/${d}/log.html">${d}</a> · <a href="/api/session-logs/${d}/log.txt">text</a> · <a href="/api/session-logs/${d}/gallery.html">🖼️ costume gallery</a></li>`);
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Creature logs</title><style>body{background:#120a1c;color:#f3eaff;font:15px system-ui;padding:16px}a{color:#ff7a1a}</style>` +
      `<h1>🎃 Creature logs</h1><ul>${items.join("") || "<li>No logs yet.</li>"}</ul>`,
  );
});

/** A day's costume gallery: each greeting snapshot with its caption and the creature's best line. Built on request. */
app.get("/api/session-logs/:day/gallery.html", async (c) => {
  const { day } = c.req.param();
  if (!sessionLog || !LOG_DAY.test(day)) return c.notFound();
  const logText = await readFile(join(config.logDir, day, "log.txt"), "utf8").catch(() => null);
  if (logText === null) return c.notFound();
  const snapshots = config.logSnapshots
    ? new Set((await readdir(join(config.logDir, day, "snapshots")).catch(() => [])).map((f) => `snapshots/${f}`))
    : null;
  return c.html(buildGallery({ day, logText, snapshots }), 200, { "cache-control": "no-store" });
});

const LOG_FILES: Record<string, string> = { html: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** One file from a day's log folder: log.html, log.txt or a snapshot. */
app.get("/api/session-logs/:day/:file{(?:log\\.(?:html|txt)|snapshots/[\\w-]+\\.(?:jpg|png|webp))}", async (c) => {
  const { day, file } = c.req.param();
  if (!sessionLog || !LOG_DAY.test(day)) return c.notFound();
  const data = await readFile(join(config.logDir, day, file)).catch(() => null);
  if (!data) return c.notFound();
  return c.body(data, 200, { "content-type": LOG_FILES[file.split(".").pop()!]!, "cache-control": "no-store" });
});

/** Looks that start a greeting: their camera frame is worth keeping in the log. */
const GREETING_LOOKS = new Set(["arrived", "grew", "returned", "manual"]);

/** Describes a camera frame for GPT-Live (which can't take images directly). */
app.post("/api/vision", async (c) => {
  const req = await c.req.json<VisionRequest>();
  if (typeof req.image !== "string" || !req.image.startsWith("data:image/")) {
    return c.json({ error: "image must be a data:image/... URL" }, 400);
  }
  if (req.image.length > 2_000_000) return c.json({ error: "image too large" }, 413);
  if (req.previousImage !== undefined && (typeof req.previousImage !== "string" || !req.previousImage.startsWith("data:image/") || req.previousImage.length > 2_000_000)) {
    return c.json({ error: "previousImage must be a data:image/... URL under 2 MB" }, 400);
  }
  const started = Date.now();
  const result = await describeFrame(config, req);
  const verdict = result.verdict ?? (result.sameGroup === false ? "NEW" : undefined);
  console.log(`[vision] ${req.reason}${verdict ? ` (${verdict})` : ""} in ${Date.now() - started} ms: ${result.text}`);
  // Greetings, and checks that found someone new or a costume change, are worth a snapshot.
  if (sessionLog && config.logSnapshots && (GREETING_LOOKS.has(req.reason) || verdict === "NEW" || verdict === "CHANGED")) {
    try {
      sessionLog.snapshot(req.image, req.reason, result.text, verdict);
    } catch (err) {
      console.warn(`[log] couldn't save snapshot: ${(err as Error).message}`);
    }
  }
  return c.json(result);
});

if (config.production) {
  app.use("/*", serveStatic({ root: "./dist" }));
}

// --- body controller (Arduino) ---
const body = new BodyController(new NullSink(), config.bodyModes);
if (config.bodySerialPort !== "none") {
  const sink = new SerialSink(config.bodySerialPort, () => body.replay());
  body.setSink(sink);
  void sink.start();
}
body.startHeartbeat();

const listen = listenHost({ HOST: process.env.HOST, pinSet: Boolean(config.remotePin) });
if (listen.warning) console.warn(listen.warning);
const server = serve({ fetch: app.fetch, port: config.port, hostname: listen.host }, (info) => {
  console.log(`Creature server on http://localhost:${info.port} (engine: ${config.engine}, character: ${config.character})`);
  if (config.remotePin) console.log(`Phone remote on: open http://<this computer's address>:${info.port}/remote on your phone`);
  remote.start();
  if (!config.apiKey) console.warn("OPENAI_API_KEY is not set: copy .env.example to .env and add your key.");
  if (!config.production) console.log("Open the dashboard at http://localhost:5173");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws/body" || !remote.checkUpgrade(req).allow) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on("message", (data) => {
      try {
        body.handle(JSON.parse(String(data)) as BodyMessage);
      } catch (err) {
        console.warn(`[body] bad message: ${(err as Error).message}`);
      }
    });
  });
});
