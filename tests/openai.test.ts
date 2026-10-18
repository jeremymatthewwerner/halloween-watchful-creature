import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../server/config.ts";
import { loadCharacter } from "../server/characters.ts";
import { createLiveSession, describeFrame, sessionVoice, voiceFor } from "../server/openai.ts";

/** A fake OpenAI API that records requests. */
let server: Server;
const requests: { url: string; body: Record<string, unknown> }[] = [];
let rejectReasoning = true;
let visionReply = "A witch.";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return JSON.parse(data || "{}");
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ url: req.url ?? "", body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/live/sessions") {
      res.statusCode = 201;
      res.end(JSON.stringify({ session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }));
    } else if (req.url === "/v1/responses") {
      if (rejectReasoning && body.reasoning) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning'", param: "reasoning" } }));
        return;
      }
      res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: visionReply }] }], usage: { input_tokens: 90, output_tokens: 5 } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  Object.assign(config, { apiKey: "sk-test", apiBase: `http://127.0.0.1:${port}/v1`, visionReasoningEffort: "low" });
});

afterAll(() => server.close());

describe("OpenAI calls", () => {
  it("creates a GPT-Live WebRTC session with client delegation", async () => {
    const result = await createLiveSession(config, { sdp: "v=0 offer", instructions: "Be a pumpkin.", voice: "meridian" });
    expect(result).toEqual({ sessionId: "live_123", sdp: "v=0 answer" });
    const req = requests.find((r) => r.url === "/v1/live/sessions")!;
    expect(req.body).toEqual({
      session: {
        model: config.liveModel,
        instructions: "Be a pumpkin.",
        audio: { output: { voice: "meridian" } },
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: "v=0 offer" },
    });
  });

  it("describes a frame, retrying without reasoning if the model rejects it", async () => {
    const result = await describeFrame(config, { image: "data:image/jpeg;base64,AAA", reason: "arrived", transcript: "Visitor: hi" });
    expect(result).toEqual({ text: "A witch.", usage: { inputTokens: 90, outputTokens: 5 } });
    const calls = requests.filter((r) => r.url === "/v1/responses");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.reasoning).toEqual({ effort: "low" });
    expect(calls[1]!.body.reasoning).toBeUndefined();
    const content = (calls[1]!.body.input as { content: { type: string; text?: string }[] }[])[0]!.content;
    expect(content[1]).toMatchObject({ type: "input_image", detail: "low" });
    expect(content[0]!.text).toContain("Visitor: hi");
    // Each costume's single standout detail, so compliments can be specific.
    expect(content[0]!.text).toContain("standout detail");
    const instructions = calls[1]!.body.instructions as string;
    expect(instructions).toContain('"standout: <detail>"');
    expect(instructions).toContain("glow-in-the-dark bones");
    expect(instructions).toContain("Never describe bodies, faces");
    expect(instructions).toContain("Under 80 words");

    // Remembered: the next call goes straight through without reasoning.
    await describeFrame(config, { image: "data:image/jpeg;base64,AAA", reason: "background" });
    expect(requests.filter((r) => r.url === "/v1/responses")).toHaveLength(3);
  });

  it("compares a returning group with the previous one and parses the SAME/NEW verdict", async () => {
    const image = "data:image/jpeg;base64,AAA";
    visionReply = "NEW: One visitor in a skeleton mask.";
    const fresh = await describeFrame(config, { image, reason: "returned", previous: "A dinosaur." });
    expect(fresh).toMatchObject({ text: "One visitor in a skeleton mask.", sameGroup: false });
    const prompt = (requests.at(-1)!.body.input as { content: { text?: string }[] }[])[0]!.content[0]!.text!;
    expect(prompt).toContain('"A dinosaur."');
    expect(prompt).toContain("If anything about the costumes differs, or you are unsure");
    expect(prompt).toContain("Then describe who is there now and their costumes, with each one's standout detail.");

    visionReply = "SAME: The dinosaur is back.";
    expect(await describeFrame(config, { image, reason: "returned", previous: "A dinosaur." })).toMatchObject({ sameGroup: true, text: "The dinosaur is back." });

    // No verdict prefix: treat as new rather than ignoring a possible new visitor.
    visionReply = "A ghost.";
    expect(await describeFrame(config, { image, reason: "returned", previous: "A dinosaur." })).toMatchObject({ sameGroup: false });
    visionReply = "A witch.";
  });

  it("rechecks a present group against the greeting photo, leaning SAME", async () => {
    const image = "data:image/jpeg;base64,BBB";
    const previousImage = "data:image/jpeg;base64,AAA";
    visionReply = "NEW: One visitor in a plain blue T-shirt.";
    const result = await describeFrame(config, { image, reason: "recheck", previous: "One visitor in a top hat.", previousImage });
    expect(result).toMatchObject({ sameGroup: false, text: "One visitor in a plain blue T-shirt." });
    const content = (requests.at(-1)!.body.input as { content: { type: string; text?: string; image_url?: string }[] }[])[0]!.content;
    expect(content.map((c) => c.image_url ?? c.type)).toEqual(["input_text", previousImage, image]);
    expect(content[0]!.text).toContain("people just moved or turned");
    expect(content[0]!.text).toContain("The first image is a photo from when they were greeted");

    // Same person, new hat.
    visionReply = "CHANGED: One visitor in a tan brimmed hat.";
    expect(await describeFrame(config, { image, reason: "recheck", previous: "One visitor in a top hat.", previousImage })).toMatchObject({
      verdict: "CHANGED",
      sameGroup: true,
      text: "One visitor in a tan brimmed hat.",
    });
    expect((requests.at(-1)!.body.input as { content: { text?: string }[] }[])[0]!.content[0]!.text).toContain('"CHANGED:"');
    // On a return, a changed costume means new visitors to greet.
    visionReply = "CHANGED: One visitor in a tan brimmed hat.";
    expect(await describeFrame(config, { image, reason: "returned", previous: "One visitor in a top hat." })).toMatchObject({ verdict: "NEW", sameGroup: false });

    // No verdict on a background look: not treated as new.
    visionReply = "One visitor in a top hat.";
    expect((await describeFrame(config, { image, reason: "background", previous: "One visitor in a top hat." })).sameGroup).toBeUndefined();
    // Without a greeted group there's nothing to compare.
    visionReply = "NEW: whoever.";
    const plain = await describeFrame(config, { image, reason: "background" });
    expect(plain).toMatchObject({ text: "NEW: whoever.", sameGroup: undefined });
    visionReply = "A witch.";
  });
});

describe("session voice", () => {
  const pumpkin = loadCharacter("pumpkin");
  const live = { ...config, engine: "live" as const, voiceOverride: "" };
  const realtime = { ...config, engine: "realtime" as const, voiceOverride: "" };

  it("uses the dashboard pick, else VOICE in .env, else the character's voice for the engine", () => {
    expect(sessionVoice(live, pumpkin, "gleam")).toEqual({ voice: "gleam", source: "dashboard", rejected: false });
    expect(sessionVoice({ ...live, voiceOverride: "ripple" }, pumpkin, "gleam")).toMatchObject({ voice: "gleam", source: "dashboard" });
    expect(sessionVoice({ ...live, voiceOverride: "ripple" }, pumpkin)).toEqual({ voice: "ripple", source: "env", rejected: false });
    expect(sessionVoice(live, pumpkin)).toEqual({ voice: pumpkin.voice, source: "character", rejected: false });
    expect(sessionVoice(realtime, pumpkin)).toEqual({ voice: pumpkin.realtimeVoice, source: "character", rejected: false });
    // Without a pick, voiceFor keeps its old meaning (VOICE in .env, else the character's).
    expect(voiceFor({ ...live, voiceOverride: "ripple" }, pumpkin)).toBe("ripple");
    expect(voiceFor(live, pumpkin)).toBe(pumpkin.voice);
  });

  it("never passes a voice that isn't on the engine's allowlist", () => {
    for (const bad of ["evil", "MERIDIAN", "gleam; drop", 7, { voice: "gleam" }, ["gleam"], true]) {
      const choice = sessionVoice({ ...live, voiceOverride: "ripple" }, pumpkin, bad);
      expect(choice).toEqual({ voice: "ripple", source: "env", rejected: true });
    }
    // A GPT-Live voice isn't valid for gpt-realtime, and vice versa.
    expect(sessionVoice(realtime, pumpkin, "ripple")).toEqual({ voice: pumpkin.realtimeVoice, source: "character", rejected: true });
    expect(sessionVoice(live, pumpkin, "cedar")).toMatchObject({ voice: pumpkin.voice, rejected: true });
    expect(sessionVoice(realtime, pumpkin, "cedar")).toMatchObject({ voice: "cedar", source: "dashboard", rejected: false });
    // No pick at all isn't a rejection.
    for (const none of [undefined, null, ""]) expect(sessionVoice(live, pumpkin, none).rejected).toBe(false);
  });

  it("sends the chosen voice to GPT-Live", async () => {
    // The fake API's key and URL are set in beforeAll, after `live` was copied.
    const { voice } = sessionVoice(live, pumpkin, "stone");
    await createLiveSession({ ...config, engine: "live" }, { sdp: "v=0 offer", instructions: "Be a pumpkin.", voice });
    const req = requests.filter((r) => r.url === "/v1/live/sessions").at(-1)!;
    expect((req.body.session as { audio: unknown }).audio).toEqual({ output: { voice: "stone" } });
  });
});
