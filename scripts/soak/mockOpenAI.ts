/**
 * A local stand-in for the OpenAI endpoints the app calls, with plausible canned answers, so the
 * soak test (and anyone poking at the server) runs at no API cost. Point the server at it with
 * OPENAI_API_BASE=<url>/v1. It never forwards anything anywhere.
 *
 *  - POST /v1/live/sessions        GPT-Live session: an id and a fake SDP answer
 *  - POST /v1/realtime/calls       gpt-realtime: a fake SDP answer (text)
 *  - POST /v1/responses            vision: a costume description, with a SAME/NEW/CHANGED verdict
 *                                  when the prompt asks to compare (rotating, image-aware)
 *  - POST /v1/images/generations   rehearsal's generated visitors: a JPEG (b64_json) plus usage
 *  - POST /v1/audio/speech         text-to-speech (only scripts/make-lure-clips.ts uses it): fake MP3 bytes
 *
 * Failures can be injected (a rate per call, or a full outage) to exercise retries and alerts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A valid 1×1 JPEG, used until real-looking images are supplied with setImages(). */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

const COSTUMES = [
  ["a green dinosaur costume with a spiky felt tail", "standout: soft felt teeth on the hood"],
  ["a witch with a tall purple pointy hat and a black cape", "standout: a little broom with orange ribbons"],
  ["a puffy white astronaut suit with mission patches", "standout: a helmet tucked under one arm"],
  ["a white bedsheet ghost", "standout: two round eye holes and a pumpkin bucket"],
  ["an invented superhero with a red cape and blue mask", "standout: a lightning-bolt emblem"],
  ["a sparkly pink princess gown with a tiara", "standout: a glowing star wand"],
  ["a pirate with a tricorn hat and striped shirt", "standout: a foam sword"],
  ["a black skeleton onesie", "standout: glow-in-the-dark bones"],
  ["a fuzzy bumblebee costume", "standout: tiny wiggly antennae"],
  ["a homemade cardboard robot", "standout: bottle-cap buttons"],
  ["a starry blue wizard robe", "standout: a cotton-wool beard"],
  ["a black cat with an ear headband", "standout: drawn-on whiskers"],
] as const;

export type Verdict = "SAME" | "NEW" | "CHANGED";

export interface MockStats {
  calls: Record<string, number>;
  verdicts: Record<Verdict | "none", number>;
  injectedFailures: number;
  /** Requests answered during an outage (all failed). */
  outageFailures: number;
  unknownPaths: number;
  /** Calls without a Bearer token (the server should always send one). */
  unauthorized: number;
}

export interface MockOptions {
  port?: number;
  /** Chance (0..1) that a call fails with a 500, per endpoint kind. */
  failRate?: Partial<Record<"live" | "realtime" | "responses" | "images" | "speech", number>>;
  /** Added latency, ms, uniform in [min, max]. */
  latencyMs?: { min: number; max: number };
  /** Seeded randomness, so a run can be repeated. */
  random?: () => number;
}

export interface MockOpenAI {
  /** e.g. http://127.0.0.1:54321/v1, for OPENAI_API_BASE. */
  readonly url: string;
  readonly stats: MockStats;
  /** JPEGs (any group size) to hand out for image generation; keyed by group size when known. */
  setImages(images: Map<number, Buffer[]>): void;
  /** While on, every call fails with a 503 (an OpenAI outage). */
  setOutage(on: boolean): void;
  close(): Promise<void>;
}

/** A small, fast, seedable PRNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cheap string hash (FNV-1a), to give the same image the same description. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  // Sampling keeps long data URLs cheap; JPEGs of different pictures differ all over.
  const step = Math.max(1, Math.floor(text.length / 4096));
  for (let i = 0; i < text.length; i += step) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** What the vision model would say about an image (deterministic per image). */
export function describe(image: string): string {
  const h = hash(image);
  const people = 1 + (h % 3);
  const parts: string[] = [`${people === 1 ? "One visitor" : `${people} visitors`} close to the decoration.`];
  for (let i = 0; i < people; i++) {
    const [costume, standout] = COSTUMES[(h >>> (4 + i * 4)) % COSTUMES.length]!;
    parts.push(`${i === 0 ? "One visitor" : i === 1 ? "Another visitor" : "A third visitor"}: ${costume}; ${standout}.`);
  }
  return parts.join(" ");
}

interface ResponsesBody {
  model?: string;
  input?: { content?: { type: string; text?: string; image_url?: string }[] }[];
}

/**
 * The verdict for a comparing look. Same picture as the greeting photo: SAME, except now and then
 * CHANGED (a hat came off). A different picture: alternately NEW and CHANGED. A "returned" check
 * (which only knows SAME or NEW) never gets CHANGED.
 */
export function pickVerdict(prompt: string, images: string[], turn: number): Verdict | null {
  if (!/Begin your reply with exactly/.test(prompt)) return null;
  const returnCheck = /"SAME:" only if/.test(prompt);
  const same = images.length >= 2 && images[0] === images[1];
  if (returnCheck) return same || (images.length < 2 && turn % 2 === 0) ? "SAME" : "NEW";
  if (same) return turn % 7 === 6 ? "CHANGED" : "SAME";
  if (images.length < 2) return (["SAME", "NEW", "SAME", "CHANGED"] as const)[turn % 4]!;
  return turn % 2 === 0 ? "NEW" : "CHANGED";
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const error = (res: ServerResponse, status: number, message: string, type = "server_error") =>
  json(res, status, { error: { message, type, code: type } });

export async function startMockOpenAI(opts: MockOptions = {}): Promise<MockOpenAI> {
  const random = opts.random ?? Math.random;
  const latency = opts.latencyMs ?? { min: 150, max: 900 };
  const stats: MockStats = {
    calls: {},
    verdicts: { SAME: 0, NEW: 0, CHANGED: 0, none: 0 },
    injectedFailures: 0,
    outageFailures: 0,
    unknownPaths: 0,
    unauthorized: 0,
  };
  let images = new Map<number, Buffer[]>();
  let outage = false;
  let turn = 0;
  let sessionSeq = 0;
  let imageSeq = 0;

  const fails = (kind: keyof NonNullable<MockOptions["failRate"]>) => random() < (opts.failRate?.[kind] ?? 0);
  const wait = () => new Promise((r) => setTimeout(r, latency.min + random() * (latency.max - latency.min)));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    const body = await readBody(req);
    const kind = (
      { "/v1/live/sessions": "live", "/v1/realtime/calls": "realtime", "/v1/responses": "responses", "/v1/images/generations": "images", "/v1/audio/speech": "speech" } as const
    )[path];
    if (req.method !== "POST" || !kind) {
      stats.unknownPaths++;
      return error(res, 404, `mock OpenAI: no ${req.method} ${path}`, "not_found");
    }
    stats.calls[kind] = (stats.calls[kind] ?? 0) + 1;
    if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) {
      stats.unauthorized++;
      return error(res, 401, "mock OpenAI: missing bearer token", "invalid_api_key");
    }
    await wait();
    if (outage) {
      stats.outageFailures++;
      return error(res, 503, "mock OpenAI: simulated outage", "service_unavailable");
    }
    if (fails(kind)) {
      stats.injectedFailures++;
      return error(res, 500, "mock OpenAI: injected failure");
    }

    switch (kind) {
      case "live": {
        const req = JSON.parse(body.toString("utf8") || "{}") as { session?: { model?: string }; transport?: { sdp?: string } };
        if (!req.session?.model || !req.transport?.sdp) return error(res, 400, "session.model and transport.sdp are required", "invalid_request_error");
        const id = `sess_soak_${++sessionSeq}`;
        return json(res, 201, { session: { id, model: req.session.model }, transport: { type: "webrtc", sdp: fakeAnswer(id) } });
      }
      case "realtime": {
        const text = fakeAnswer(`rt_soak_${++sessionSeq}`);
        res.writeHead(201, { "content-type": "application/sdp", "content-length": Buffer.byteLength(text) });
        return void res.end(text);
      }
      case "responses": {
        const req = JSON.parse(body.toString("utf8") || "{}") as ResponsesBody;
        const content = req.input?.[0]?.content ?? [];
        const prompt = content.filter((c) => c.type === "input_text").map((c) => c.text ?? "").join("\n");
        const shots = content.filter((c) => c.type === "input_image").map((c) => c.image_url ?? "");
        if (!shots.length) return error(res, 400, "an input_image is required", "invalid_request_error");
        const verdict = pickVerdict(prompt, shots, turn++);
        stats.verdicts[verdict ?? "none"]++;
        const text = `${verdict ? `${verdict}: ` : ""}${describe(shots.at(-1)!)}`;
        return json(res, 200, {
          id: `resp_soak_${turn}`,
          object: "response",
          model: req.model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
          usage: { input_tokens: 420 + shots.length * 85, output_tokens: 70 + Math.floor(random() * 40) },
        });
      }
      case "images": {
        const req = JSON.parse(body.toString("utf8") || "{}") as { prompt?: string };
        const size = Number(/Exactly (\d+) (?:person|people)/.exec(req.prompt ?? "")?.[1] ?? 1);
        const pool = images.get(size) ?? [...images.values()].flat();
        const jpeg = pool.length ? pool[imageSeq++ % pool.length]! : TINY_JPEG;
        return json(res, 200, {
          created: Math.floor(Date.now() / 1000),
          data: [{ b64_json: jpeg.toString("base64") }],
          usage: { input_tokens: 300, output_tokens: 270, input_tokens_details: { text_tokens: 300 } },
        });
      }
      case "speech": {
        // Not a playable MP3: nothing at runtime plays TTS, only the one-off clip script.
        const fake = Buffer.from("ID3soak-fake-mp3");
        res.writeHead(200, { "content-type": "audio/mpeg", "content-length": fake.length });
        return void res.end(fake);
      }
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) error(res, 500, `mock OpenAI crashed: ${err.message}`);
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    stats,
    setImages: (next) => (images = next),
    setOutage: (on) => (outage = on),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function fakeAnswer(id: string): string {
  return ["v=0", `o=- ${id} 2 IN IP4 127.0.0.1`, "s=soak-test fake answer", "t=0 0", "a=group:BUNDLE 0 1", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:0", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=mid:1", ""].join("\r\n");
}
