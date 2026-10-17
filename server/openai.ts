import type { Config } from "./config.ts";
import type { Character } from "./characters.ts";
import type { LookReason, VisionRequest, VisionResult } from "../shared/types.ts";

export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

async function post(config: Config, path: string, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  if (!config.apiKey) throw new OpenAIError("OPENAI_API_KEY is not set on the server", 503, "");
  const res = await fetch(`${config.apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, ...headers },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new OpenAIError(`OpenAI ${path} failed with ${res.status}`, res.status, text);
  }
  return res;
}

/**
 * Starts a GPT-Live session for a browser WebRTC offer and returns the SDP answer.
 * Uses client delegation: when GPT-Live wants help (e.g. a fresh look), the browser
 * runs the vision backend and returns the result with session.commentary.append.
 */
export async function createLiveSession(
  config: Config,
  opts: { sdp: string; instructions: string; voice: string },
): Promise<{ sessionId: string; sdp: string }> {
  const res = await post(
    config,
    "/live/sessions",
    JSON.stringify({
      session: {
        model: config.liveModel,
        instructions: opts.instructions,
        audio: { output: { voice: opts.voice } },
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: opts.sdp },
    }),
    { "Content-Type": "application/json" },
  );
  const data = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
  if (!data.transport?.sdp) throw new OpenAIError("Live session response had no SDP answer", 502, JSON.stringify(data));
  return { sessionId: data.session?.id ?? "", sdp: data.transport.sdp };
}

export const LOOK_TOOL = {
  type: "function",
  name: "look",
  description:
    "Take a fresh look through your eyes at whoever is in front of you. Use when someone asks you to look at them or their costume, or shows you something.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

/** Starts a gpt-realtime session (unified interface) and returns the SDP answer. */
export async function createRealtimeCall(
  config: Config,
  opts: { sdp: string; instructions: string; voice: string },
): Promise<{ sdp: string }> {
  const session = {
    type: "realtime",
    model: config.realtimeModel,
    instructions: opts.instructions,
    audio: {
      input: {
        noise_reduction: { type: "far_field" },
        transcription: { model: config.realtimeTranscribeModel },
        turn_detection: { type: "semantic_vad", eagerness: "medium" },
      },
      output: { voice: opts.voice },
    },
    tools: [LOOK_TOOL],
    tool_choice: "auto",
  };
  const form = new FormData();
  form.set("sdp", opts.sdp);
  form.set("session", JSON.stringify(session));
  const res = await post(config, "/realtime/calls", form);
  return { sdp: await res.text() };
}

const VISION_INSTRUCTIONS = `You are the eyes of a friendly talking Halloween decoration on a front porch. You look at one camera frame and report what you see to the character, who will speak to the visitors.

Report:
- How many people are close to the decoration (ignore distant passers-by).
- For each person: what their costume is (your best guess at the character or thing), its main colors, and one or two fun specific details (props, hats, capes, masks, wings, glitter, makeup that is part of the costume).
- Anything they are holding up to show the decoration.

Rules:
- Describe costumes, outfits and props only. Never describe bodies, faces, skin, hair (unless it's a costume wig), height, weight, age, gender, race or disability. Refer to people as "one visitor", "another visitor", "the visitor on the left".
- If someone isn't in a costume, say "no costume visible" for them.
- If the image is too dark or blurry to tell, say so plainly.
- Plain facts only, no jokes, no character voice. Under 70 words.`;

const REASON_PROMPTS: Record<LookReason, string> = {
  arrived: "Visitors just walked up. Describe their costumes.",
  grew: "More visitors just joined the group. Describe everyone's costumes, noting who seems new if you can tell.",
  background: "Briefly describe who is in front of the decoration right now.",
  delegation:
    "The character asked for a fresh look during a conversation. Using the recent conversation below, describe what the visitors are asking about (usually their costume or something they're holding up), plus anything else useful.",
  manual: "Describe the visitors' costumes.",
};

let reasoningUnsupported = false;

/** Describes a camera frame with a vision-capable Responses model. */
export async function describeFrame(config: Config, req: VisionRequest): Promise<VisionResult> {
  let prompt = REASON_PROMPTS[req.reason];
  if (req.transcript) prompt += `\n\nRecent conversation (oldest first, transcripts may have mistakes):\n${req.transcript.slice(-2000)}`;
  const body: Record<string, unknown> = {
    model: config.visionModel,
    instructions: VISION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: req.image, detail: "low" },
        ],
      },
    ],
    max_output_tokens: 400,
    store: false,
  };
  if (config.visionReasoningEffort && !reasoningUnsupported) body.reasoning = { effort: config.visionReasoningEffort };
  let res: Response;
  try {
    res = await post(config, "/responses", JSON.stringify(body), { "Content-Type": "application/json" });
  } catch (err) {
    // Non-reasoning vision models reject the reasoning setting; drop it and remember.
    if (!(err instanceof OpenAIError) || err.status !== 400 || !body.reasoning || !/reasoning/i.test(err.body)) throw err;
    console.warn(`[vision] ${config.visionModel} doesn't accept reasoning settings; retrying without`);
    reasoningUnsupported = true;
    delete body.reasoning;
    res = await post(config, "/responses", JSON.stringify(body), { "Content-Type": "application/json" });
  }
  const data = (await res.json()) as ResponsesResult;
  return {
    text: extractOutputText(data) || "Too dark or blurry to make out any costumes.",
    usage: data.usage ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } : undefined,
  };
}

interface ResponsesResult {
  output_text?: string;
  output?: { type: string; content?: { type: string; text?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function extractOutputText(data: ResponsesResult): string {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text.trim();
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && c.text) parts.push(c.text);
  }
  return parts.join("\n").trim();
}

export function voiceFor(config: Config, character: Character): string {
  if (config.voiceOverride) return config.voiceOverride;
  return config.engine === "live" ? character.voice : character.realtimeVoice;
}
