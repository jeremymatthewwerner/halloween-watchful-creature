import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../server/config.ts";
import { createLiveSession, describeFrame } from "../server/openai.ts";

/** A fake OpenAI API that records requests. */
let server: Server;
const requests: { url: string; body: Record<string, unknown> }[] = [];
let rejectReasoning = true;

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
      res.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "A witch." }] }], usage: { input_tokens: 90, output_tokens: 5 } }));
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

    // Remembered: the next call goes straight through without reasoning.
    await describeFrame(config, { image: "data:image/jpeg;base64,AAA", reason: "background" });
    expect(requests.filter((r) => r.url === "/v1/responses")).toHaveLength(3);
  });
});
