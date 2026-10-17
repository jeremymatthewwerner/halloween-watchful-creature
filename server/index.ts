import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import type { BodyMessage, ClientConfig, VisionRequest } from "../shared/types.ts";
import { BodyController, NullSink, SerialSink } from "./body/driver.ts";
import { buildInstructions, listCharacterIds, loadCharacter, publicInfo } from "./characters.ts";
import { config } from "./config.ts";
import { OpenAIError, createLiveSession, createRealtimeCall, describeFrame, voiceFor } from "./openai.ts";

const app = new Hono();

// Only the dashboard itself may call the API, so other web pages open in the
// same browser can't start (billed) sessions against this local server.
const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedOrigin.test(origin)) return c.json({ error: "forbidden origin" }, 403);
  await next();
});

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
    hasApiKey: Boolean(config.apiKey),
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

/** Describes a camera frame for GPT-Live (which can't take images directly). */
app.post("/api/vision", async (c) => {
  const req = await c.req.json<VisionRequest>();
  if (typeof req.image !== "string" || !req.image.startsWith("data:image/")) {
    return c.json({ error: "image must be a data:image/... URL" }, 400);
  }
  if (req.image.length > 2_000_000) return c.json({ error: "image too large" }, 413);
  const started = Date.now();
  const result = await describeFrame(config, req);
  console.log(`[vision] ${req.reason} in ${Date.now() - started} ms: ${result.text}`);
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

const server = serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
  console.log(`Creature server on http://localhost:${info.port} (engine: ${config.engine}, character: ${config.character})`);
  if (!config.apiKey) console.warn("OPENAI_API_KEY is not set: copy .env.example to .env and add your key.");
  if (!config.production) console.log("Open the dashboard at http://localhost:5173");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws/body") {
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
