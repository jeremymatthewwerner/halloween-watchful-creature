import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveEngine } from "../web/engines/live.ts";
import { RealtimeEngine } from "../web/engines/realtime.ts";
import type { EngineDeps, EngineEvent } from "../web/engines/types.ts";

type Sent = Record<string, unknown>;

const deps = (capture: () => string | null = () => "data:image/jpeg;base64,AAA"): EngineDeps => ({
  mic: { getAudioTracks: () => [] } as unknown as MediaStream,
  character: "pumpkin",
  capture,
  recentTranscript: () => "Visitor: what am I?",
  lastVoiceAt: () => -Infinity,
});

/** Live engine with the network replaced by in-memory fakes. */
class TestLive extends LiveEngine {
  sent: Sent[] = [];
  events: EngineEvent[] = [];
  looks: { reason: string; opts: unknown }[] = [];
  vision = "One visitor in a green dinosaur costume with a sparkly tail.";
  constructor(d = deps()) {
    super(d);
    this.status = "open";
    this.nudgeMs = 5000;
    this.on((e) => this.events.push(e));
  }
  protected send(event: Sent): boolean {
    this.sent.push(event);
    return true;
  }
  protected async describe(_image: string, reason: string, opts?: unknown): Promise<string> {
    this.looks.push({ reason, opts });
    return this.vision;
  }
  server(event: { type: string; [key: string]: unknown }) {
    this.onServerEvent(event);
  }
}

class TestRealtime extends RealtimeEngine {
  sent: Sent[] = [];
  constructor(d = deps()) {
    super(d);
    this.status = "open";
  }
  protected send(event: Sent): boolean {
    this.sent.push(event);
    return true;
  }
  server(event: { type: string; [key: string]: unknown }) {
    this.onServerEvent(event);
  }
}

describe("LiveEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("greets by appending spoken commentary with what the vision model saw", async () => {
    const e = new TestLive();
    await e.greet("data:image/jpeg;base64,AAA", "arrived");
    expect(e.looks).toEqual([{ reason: "arrived", opts: undefined }]);
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append", delegation_id: null });
    expect(String(e.sent[0]!.content)).toContain("green dinosaur");
    expect(String(e.sent[0]!.content)).toMatch(/^\[CAMERA\]/);
  });

  it("asks the visitor what they are when there's no camera frame", async () => {
    const e = new TestLive();
    await e.greet(null, "manual");
    expect(e.looks).toEqual([]);
    expect(String(e.sent[0]!.content)).toContain("ask what they're dressed as");
  });

  it("nudges once if the greeting doesn't start speaking", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(5100);
    expect(e.sent.map((s) => s.type)).toEqual(["session.commentary.append", "session.instructions.append"]);
  });

  it("doesn't nudge when the voice was audible even without a transcript", async () => {
    let voiceAt = -Infinity;
    const e = new TestLive({ ...deps(), lastVoiceAt: () => voiceAt });
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(1000);
    voiceAt = performance.now();
    vi.advanceTimersByTime(5000);
    expect(e.sent).toHaveLength(1);
  });

  it("doesn't nudge when the creature started talking", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(1000);
    e.server({ type: "session.output_transcript.delta", delta: "Ooh la la!" });
    vi.advanceTimersByTime(5000);
    expect(e.sent).toHaveLength(1);
  });

  it("answers a client delegation with a fresh look on the same delegation id", async () => {
    const e = new TestLive();
    e.server({ type: "session.delegation.created", delegation: { id: "item_42", type: "delegation", target: "client" } });
    await vi.runAllTimersAsync();
    expect(e.looks).toEqual([{ reason: "delegation", opts: { withTranscript: true } }]);
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append", delegation_id: "item_42" });
  });

  it("sends background views as silent thinking, and skips unchanged ones", async () => {
    const e = new TestLive();
    await e.observe("img");
    await e.observe("img");
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toMatchObject({ type: "session.thinking.append", delegation_id: null });
    expect(e.looks[0]).toEqual({ reason: "background", opts: { quiet: true } });
  });

  it("mutes and unmutes the session mic", () => {
    const e = new TestLive();
    e.setMicEnabled(false);
    e.setMicEnabled(true);
    expect(e.sent.map((s) => s.type)).toEqual(["session.input_audio.mute", "session.input_audio.unmute"]);
  });

  it("reports transcripts, usage and errors", () => {
    const e = new TestLive();
    vi.advanceTimersByTime(10); // fake clock starts at 0
    e.server({ type: "session.input_transcript.delta", delta: "hi" });
    e.server({ type: "session.usage.updated", usage: { seconds: 42 } });
    e.server({ type: "error", error: { code: "x", message: "boom" } });
    expect(e.events).toEqual([
      { type: "transcript", who: "visitor", delta: "hi" },
      { type: "usage", voiceSeconds: 42 },
      { type: "error", message: "x: boom" },
    ]);
    expect(e.lastHeardAt()).toBeGreaterThan(0);
  });

  it("operator lines become spoken instructions", () => {
    const e = new TestLive();
    e.say("One piece each!");
    expect(e.sent[0]).toMatchObject({ type: "session.instructions.append", delegation_id: null });
    expect(String(e.sent[0]!.content)).toContain("One piece each!");
  });
});

describe("RealtimeEngine", () => {
  it("greets with the image and asks for a response", async () => {
    const e = new TestRealtime();
    await e.greet("img", "arrived");
    expect(e.sent.map((s) => s.type)).toEqual(["conversation.item.create", "response.create"]);
    const item = e.sent[0]!.item as { content: { type: string }[] };
    expect(item.content.map((c) => c.type)).toEqual(["input_image", "input_text"]);
  });

  it("queues a greeting until the current response finishes", async () => {
    const e = new TestRealtime();
    e.server({ type: "response.created" });
    await e.greet("img", "grew");
    expect(e.sent).toEqual([]);
    e.server({ type: "response.done", response: { output: [] } });
    expect(e.sent.map((s) => s.type)).toEqual(["conversation.item.create", "response.create"]);
  });

  it("answers the look tool with a function output, a fresh image and a response", () => {
    const e = new TestRealtime();
    e.server({ type: "response.created" });
    e.server({ type: "response.done", response: { output: [{ type: "function_call", name: "look", call_id: "call_1" }] } });
    expect(e.sent[0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1" } });
    expect(e.sent.map((s) => s.type)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  });

  it("adds background views without triggering a response", async () => {
    const e = new TestRealtime();
    await e.observe("img");
    expect(e.sent.map((s) => s.type)).toEqual(["conversation.item.create"]);
  });
});
