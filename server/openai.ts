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
- For each person: what their costume is (your best guess at the character or thing), its main colors, and its standout detail.
- The standout detail is the single most delightful, specific thing about that costume, the one a kid would be proudest of, in a few plain words: "glow-in-the-dark bones", "a tail made of tinsel", "a light-up wand", "a cape with silver stars". Pick something you can really see (a prop, hat, cape, mask, wings, glitter, lights, makeup that is part of the costume), not just "a nice costume". Write it as "standout: <detail>".
- Anything they are holding up to show the decoration.

Rules:
- Describe costumes, outfits and props only. Never describe bodies, faces, skin, hair (unless it's a costume wig), height, weight, age, gender, race or disability. Refer to people as "one visitor", "another visitor", "the visitor on the left".
- If someone isn't in a costume, say "no costume visible" for them.
- If the image is too dark or blurry to tell, say so plainly.
- Plain facts only, no jokes, no character voice. Under 80 words.`;

const REASON_PROMPTS: Record<LookReason, string> = {
  arrived: "Visitors just walked up. Describe their costumes, with each one's standout detail.",
  grew: "More visitors just joined the group. Describe everyone's costumes with each one's standout detail, noting who seems new if you can tell.",
  returned: "Someone just walked up to the decoration. Describe who is there and their costumes, with each one's standout detail.",
  background: "Briefly describe who is in front of the decoration right now, with each costume's standout detail.",
  recheck: "Someone just came back into view after a short gap. Describe who is there and their costumes, with each one's standout detail.",
  delegation:
    "The character asked for a fresh look during a conversation. Using the recent conversation below, describe what the visitors are asking about (usually their costume or something they're holding up) and its standout detail, plus anything else useful.",
  manual: "Describe the visitors' costumes, with each one's standout detail.",
};

/** Looks that compare who's there with the last greeted group (when one is given). */
const COMPARING_REASONS = new Set<LookReason>(["returned", "background", "recheck"]);

let reasoningUnsupported = false;

/** Describes a camera frame with a vision-capable Responses model. */
export async function describeFrame(config: Config, req: VisionRequest): Promise<VisionResult> {
  let prompt = REASON_PROMPTS[req.reason];
  const comparing = COMPARING_REASONS.has(req.reason) && Boolean(req.previous);
  const previousImage = comparing && req.previousImage?.startsWith("data:image/") ? req.previousImage : undefined;
  if (comparing) {
    const photos = previousImage
      ? "The first image is a photo from when they were greeted; the second image is the view right now. Compare the people in the two photos. "
      : "Compare them with who is in this image. ";
    const verdict =
      req.reason === "returned"
        ? `Begin your reply with exactly "SAME:" only if these are clearly the same people ` +
          `(the same costumes, masks, hats and props). If anything about the costumes differs, or you are unsure, begin with "NEW:". `
        : `Begin your reply with exactly one of: "NEW:" if someone here now is clearly a different person from everyone who was ` +
          `greeted; "CHANGED:" if they're the same people but a costume piece clearly changed (a hat, mask, cape, wig or prop put ` +
          `on, taken off or swapped); otherwise "SAME:", including when you are unsure, people just moved or turned, or fewer ` +
          `people are visible. `;
    prompt =
      `The visitors greeted a little while ago were described as: "${req.previous!.slice(0, 600)}"\n\n` +
      photos +
      verdict +
      `Then describe who is there now and their costumes, with each one's standout detail.`;
  }
  if (req.transcript) prompt += `\n\nRecent conversation (oldest first, transcripts may have mistakes):\n${req.transcript.slice(-2000)}`;
  const body: Record<string, unknown> = {
    model: config.visionModel,
    instructions: VISION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...(previousImage ? [{ type: "input_image", image_url: previousImage, detail: "low" }] : []),
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
  let text = extractOutputText(data) || "Too dark or blurry to make out any costumes.";
  let sameGroup: boolean | undefined;
  let verdict: VisionResult["verdict"];
  if (comparing) {
    const match = /^\s*(SAME|NEW|CHANGED)\s*:\s*/i.exec(text);
    if (match) {
      verdict = match[1]!.toUpperCase() as NonNullable<VisionResult["verdict"]>;
      // A return compares costumes, so a changed costume there is someone new to greet.
      if (verdict === "CHANGED" && req.reason === "returned") verdict = "NEW";
      text = text.slice(match[0].length);
    }
    // No verdict: a return leans NEW (don't ignore a possible new visitor); a recheck leans SAME.
    sameGroup = verdict ? verdict !== "NEW" : req.reason === "returned" ? false : undefined;
  }
  return {
    text,
    sameGroup,
    verdict,
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
