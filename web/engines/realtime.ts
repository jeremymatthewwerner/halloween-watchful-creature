import { UNSURE_RETURN, WebRtcEngine } from "./base.ts";
import type { Engine, GreetReason } from "./types.ts";

type ServerEvent = { type: string; [key: string]: unknown };

const GREETING: Record<GreetReason, string> = {
  arrived: "[CAMERA] New visitors just walked up to you. Greet them now and compliment their costumes.",
  grew: "[CAMERA] More visitors just joined the group. Welcome the newcomers and compliment their costumes.",
  manual: "[CAMERA] Greet whoever is there and compliment their costumes.",
  returned:
    '[CAMERA] Someone just walked up after the porch was empty for a bit. Unless their costumes are clearly identical to the visitors you just greeted, treat them as NEW visitors: greet them and compliment their costumes. Only if clearly identical, give a quick "welcome back".',
};

/** Greeting without a camera frame: ask instead of guessing (a return may be the same people). */
function blindGreeting(reason: GreetReason): string {
  if (reason === "returned") {
    return UNSURE_RETURN;
  }
  return `${GREETING[reason]} (Your eyes aren't working; ask what they're dressed as.)`;
}

interface OutputItem {
  type: string;
  name?: string;
  call_id?: string;
}

/**
 * gpt-realtime engine (gpt-realtime-2.x). Takes camera frames directly as input_image
 * items, and exposes a "look" tool so the model can ask for a fresh frame.
 */
export class RealtimeEngine extends WebRtcEngine implements Engine {
  readonly kind = "realtime" as const;
  private onCreated: (() => void) | null = null;
  private responding = false;
  private queue: (() => void)[] = [];

  protected waitUntilReady(): Promise<void> {
    return new Promise((resolve) => (this.onCreated = resolve));
  }

  protected onServerEvent(event: ServerEvent): void {
    switch (event.type) {
      case "session.created":
        this.responding = false;
        this.queue = [];
        this.onCreated?.();
        this.onCreated = null;
        break;
      case "input_audio_buffer.speech_started":
        this.heardAt = performance.now();
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.heardAt = performance.now();
        this.emit({ type: "transcript", who: "visitor", delta: String(event.delta ?? "") });
        break;
      case "response.output_audio_transcript.delta":
        this.emit({ type: "transcript", who: "creature", delta: String(event.delta ?? "") });
        break;
      case "response.created":
        this.responding = true;
        break;
      case "response.done": {
        this.responding = false;
        const response = event.response as { output?: OutputItem[]; usage?: { total_tokens?: number } } | undefined;
        if (response?.usage?.total_tokens) this.emit({ type: "usage", tokens: response.usage.total_tokens });
        const look = response?.output?.find((o) => o.type === "function_call" && o.name === "look");
        if (look?.call_id) this.answerLook(look.call_id);
        else this.drain();
        break;
      }
      case "error": {
        const error = event.error as { message?: string; code?: string } | undefined;
        this.emit({ type: "error", message: `${error?.code ?? "error"}: ${error?.message ?? "unknown"}` });
        break;
      }
    }
  }

  async greet(image: string | null, reason: GreetReason): Promise<void> {
    this.whenIdle(() => {
      const content: Record<string, string>[] = [];
      if (image) content.push({ type: "input_image", image_url: image });
      content.push({ type: "input_text", text: image ? GREETING[reason] : blindGreeting(reason) });
      this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
      this.createResponse();
    });
  }

  /** The model sees frames itself; a recheck just gives it the current view. */
  async recheck(image: string): Promise<void> {
    await this.observe(image);
  }

  async observe(image: string): Promise<void> {
    this.whenIdle(() => {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: image },
            { type: "input_text", text: "[CAMERA] Current view. No need to respond to this." },
          ],
        },
      });
    });
  }

  say(text: string): void {
    this.whenIdle(() => {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `Say the following to the visitors now, in your character's voice and style: "${text}"` }],
        },
      });
      this.createResponse();
    });
  }

  isThinking(): boolean {
    return this.responding;
  }

  private answerLook(callId: string): void {
    this.emit({ type: "note", text: "taking a fresh look (tool call)" });
    const image = this.deps.capture();
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: Boolean(image) }) },
    });
    if (image) {
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_image", image_url: image }, { type: "input_text", text: "[CAMERA] Fresh look." }] },
      });
    }
    this.createResponse();
  }

  private createResponse(): void {
    this.responding = true;
    this.send({ type: "response.create" });
  }

  /** Conversation items added mid-response can be ignored, so wait for a gap. */
  private whenIdle(action: () => void): void {
    if (this.status !== "open") return;
    if (this.responding) this.queue.push(action);
    else action();
  }

  private drain(): void {
    while (!this.responding && this.queue.length) this.queue.shift()!();
  }
}
