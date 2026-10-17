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
  sameGroup: boolean | undefined = undefined;
  visionError: Error | null = null;
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
  protected async look(_image: string, reason: string, opts?: unknown): Promise<{ text: string; sameGroup?: boolean }> {
    this.looks.push({ reason, opts });
    if (this.visionError) throw this.visionError;
    return { text: this.vision, sameGroup: this.sameGroup };
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
    expect(e.looks).toEqual([{ reason: "arrived", opts: { previous: undefined } }]);
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append", delegation_id: null });
    expect(String(e.sent[0]!.content)).toContain("green dinosaur");
    expect(String(e.sent[0]!.content)).toMatch(/^\[CAMERA\]/);
  });

  it("compares a returning group with the last one and greets them as new when different", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    e.vision = "One visitor in a skeleton mask and a striped shirt.";
    e.sameGroup = false;
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 30_000 });
    expect(e.looks[1]).toEqual({ reason: "returned", opts: { previous: "One visitor in a green dinosaur costume with a sparkly tail." } });
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append" });
    expect(String(e.sent[0]!.content)).toContain("New visitors just walked up");
    expect(String(e.sent[0]!.content)).toContain("skeleton mask");
  });

  it("stays quiet for the same group back soon, and welcomes them back after a longer gap", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    e.sameGroup = true;
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 20_000 });
    expect(e.sent.map((s) => s.type)).toEqual(["session.thinking.append"]);
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 60_000 });
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append" });
    expect(String(e.sent[0]!.content)).toContain("welcome back");
  });

  it("treats a returning group as new when there's no previous group to compare", async () => {
    const e = new TestLive();
    e.sameGroup = true; // ignored without a previous description
    await e.greet("img", "returned", { awayMs: 60_000 });
    expect(e.looks[0]).toEqual({ reason: "returned", opts: { previous: undefined } });
    expect(String(e.sent[0]!.content)).toContain("New visitors just walked up");
  });

  it("hedges instead of assuming strangers when the return check fails, and compares with them next time", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    e.visionError = new Error("Failed to fetch");
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 20_000 });
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append" });
    expect(String(e.sent[0]!.content)).toContain("can't tell whether they're the visitors you were just talking to");
    expect(String(e.sent[0]!.content)).not.toContain("New visitors");
    expect(e.events).toContainEqual({ type: "note", text: expect.stringContaining("couldn't check whether these are the same visitors") });
    e.visionError = null;
    await e.greet("img", "returned", { awayMs: 20_000 });
    expect(e.looks.at(-1)).toEqual({ reason: "returned", opts: { previous: "One visitor in a green dinosaur costume with a sparkly tail." } });
  });

  it("hedges on a return with no camera frame", async () => {
    let frame: string | null = "img";
    const e = new TestLive(deps(() => frame));
    await e.greet("img", "arrived");
    frame = null;
    e.sent = [];
    await e.greet(null, "returned", { awayMs: 20_000 });
    expect(e.looks).toHaveLength(1);
    expect(String(e.sent[0]!.content)).toContain("ask whether they're back or new");
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

  it("hedges a return it can't see instead of assuming strangers", async () => {
    const e = new TestRealtime();
    await e.greet(null, "returned");
    const item = e.sent[0]!.item as { content: { type: string; text?: string }[] };
    expect(item.content.map((c) => c.type)).toEqual(["input_text"]);
    expect(item.content[0]!.text).toContain("ask whether they're back or new");
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
