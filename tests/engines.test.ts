import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveEngine } from "../web/engines/live.ts";
import { RealtimeEngine } from "../web/engines/realtime.ts";
import type { EngineDeps, EngineEvent } from "../web/engines/types.ts";
import { EveningMemory } from "../web/evening.ts";

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
  verdict: "SAME" | "NEW" | "CHANGED" | undefined = undefined;
  visionError: Error | null = null;
  /** When set, looks wait for this before answering (a slow vision call). */
  lookGate: Promise<void> | null = null;
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
  protected async look(_image: string, reason: string, opts?: unknown): Promise<{ text: string; sameGroup?: boolean; verdict?: "SAME" | "NEW" | "CHANGED" }> {
    this.looks.push({ reason, opts });
    if (this.lookGate) await this.lookGate;
    if (this.visionError) throw this.visionError;
    return { text: this.vision, sameGroup: this.sameGroup, verdict: this.verdict };
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
    expect(String(e.sent[0]!.content)).toContain("praise each costume's standout detail");
  });

  it("compares a returning group with the last one and greets them as new when different", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    e.vision = "One visitor in a skeleton mask and a striped shirt.";
    e.sameGroup = false;
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 30_000 });
    expect(e.looks[1]).toEqual({
      reason: "returned",
      opts: { previous: "One visitor in a green dinosaur costume with a sparkly tail.", previousImage: "img" },
    });
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

  it("adds a style twist to every greeting so the creature doesn't repeat itself", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    await e.greet("img", "manual");
    const [first, second] = e.sent.map((s) => String(s.content));
    expect(first).toContain("For variety this time:");
    expect(second).toContain("For variety this time:");
    expect(first!.slice(first!.indexOf("For variety"))).not.toBe(second!.slice(second!.indexOf("For variety")));
  });

  it("says a quick hello while vision is slow, then compliments the costumes", async () => {
    const e = new TestLive();
    let finishLook = () => {};
    e.lookGate = new Promise<void>((resolve) => (finishLook = resolve));
    const greeting = e.greet("img", "arrived");
    await vi.advanceTimersByTimeAsync(300);
    expect(e.sent.map((s) => String(s.content))).toEqual([expect.stringContaining("give them a quick, warm hello")]);
    finishLook();
    await greeting;
    expect(e.sent).toHaveLength(2);
    expect(String(e.sent[1]!.content)).toContain("Your eyes have focused. What you see: One visitor in a green dinosaur costume");
    expect(String(e.sent[1]!.content)).toContain("Now compliment their costumes.");
    expect(String(e.sent[1]!.content)).toContain("praise each costume's standout detail");
  });

  it("looks while the session connects, and stays silent if it can't connect", async () => {
    const e = new TestLive();
    e.status = "connecting";
    let connected = (_ok: boolean) => {};
    const ready = new Promise<boolean>((resolve) => (connected = resolve));
    const greeting = e.greet("img", "arrived", { ready });
    await Promise.resolve();
    expect(e.looks).toHaveLength(1); // already looking
    connected(false);
    await greeting;
    expect(e.sent).toEqual([]);
  });

  it("doesn't compare a return with a group from before the session (re)connected", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    e.status = "connecting";
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 20_000, ready: Promise.resolve(true) });
    expect(e.looks.at(-1)).toEqual({ reason: "returned", opts: { previous: undefined, previousImage: undefined } });
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
    expect(e.looks.at(-1)).toMatchObject({ reason: "returned", opts: { previous: "One visitor in a green dinosaur costume with a sparkly tail." } });
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

  it("nudges with newcomer wording when only the tail of an earlier reply is heard", async () => {
    const e = new TestLive();
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(6000);
    e.sent = [];
    // Mid-sentence when the group grows: the rest of that sentence isn't the greeting.
    e.server({ type: "session.output_transcript.delta", delta: "Hmm! I " });
    await e.greet("img", "grew");
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(200);
      e.server({ type: "session.output_transcript.delta", delta: "can't " });
    }
    vi.advanceTimersByTime(5000);
    expect(e.sent.map((s) => s.type)).toEqual(["session.commentary.append", "session.instructions.append"]);
    expect(String(e.sent[1]!.content)).toContain("Welcome the newcomers now");
  });

  it("counts a new utterance after a pause as the greeting starting", async () => {
    const e = new TestLive();
    e.server({ type: "session.output_transcript.delta", delta: "Hmm! I " });
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(1500);
    e.server({ type: "session.output_transcript.delta", delta: "Bonsoir!" });
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

  it("greets someone new spotted by a background look, comparing with the greeting photo", async () => {
    const e = new TestLive();
    await e.greet("greeting-frame", "arrived");
    e.sent = [];
    e.vision = "One visitor in a plain blue T-shirt.";
    e.sameGroup = false;
    await e.observe("now-frame");
    expect(e.looks.at(-1)).toEqual({
      reason: "background",
      opts: { quiet: true, previous: "One visitor in a green dinosaur costume with a sparkly tail.", previousImage: "greeting-frame" },
    });
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append" });
    expect(String(e.sent[0]!.content)).toContain("Someone new is in front of you");
    expect(e.events).toContainEqual({ type: "note", text: "someone new is here (vision saw: One visitor in a plain blue T-shirt.)" });

    // The tracker's "grew" for the same newcomer shortly after isn't a second greeting.
    e.sent = [];
    await e.greet("img", "grew");
    expect(e.sent.map((s) => s.type)).toEqual(["session.thinking.append"]);
    // And the next check compares with the newcomer's photo.
    e.sameGroup = true;
    await e.recheck("later-frame");
    expect(e.looks.at(-1)).toMatchObject({ reason: "recheck", opts: { previousImage: "img" } });
  });

  it("caps remarks on changes from background looks at one per 30 s, and compares with the new look", async () => {
    const e = new TestLive();
    await e.greet("greeting-frame", "arrived");
    vi.advanceTimersByTime(6000); // past the greeting's nudge
    e.sent = [];
    e.sameGroup = true;
    e.verdict = "CHANGED";
    e.vision = "One visitor in a blue shirt and a tan brimmed hat.";
    await e.recheck("hat-frame");
    expect(e.sent).toHaveLength(1);
    expect(e.sent[0]).toMatchObject({ type: "session.commentary.append" });
    expect(String(e.sent[0]!.content)).toContain("just changed their look");
    expect(String(e.sent[0]!.content)).toContain("tan brimmed hat");
    expect(e.events).toContainEqual({ type: "note", text: "costume change (vision saw: One visitor in a blue shirt and a tan brimmed hat.)" });

    // Another change soon after: noted, but not remarked on.
    e.sent = [];
    e.vision = "One visitor in a blue shirt, hat off.";
    vi.advanceTimersByTime(15_000);
    await e.observe("hat-off-frame");
    expect(e.looks.at(-1)).toMatchObject({ opts: { previous: "One visitor in a blue shirt and a tan brimmed hat.", previousImage: "hat-frame" } });
    expect(e.sent.map((s) => s.type)).toEqual(["session.thinking.append"]);

    // 30 s after the last remark, a change gets one again.
    e.sent = [];
    e.vision = "One visitor in a blue shirt and a witch hat.";
    vi.advanceTimersByTime(16_000);
    await e.observe("witch-frame");
    expect(e.sent.map((s) => s.type)).toEqual(["session.commentary.append"]);
  });

  it("always remarks on a costume change found after a gap, whatever the background cap", async () => {
    const e = new TestLive();
    await e.greet("greeting-frame", "arrived");
    vi.advanceTimersByTime(6000);
    e.sameGroup = true;
    e.verdict = "CHANGED";
    e.vision = "One visitor in a black top hat.";
    await e.recheck("top-hat-frame");
    e.sent = [];
    vi.advanceTimersByTime(20_000);
    e.vision = "One visitor holding a pumpkin up in front of their face.";
    await e.recheck("pumpkin-frame");
    expect(e.sent.map((s) => s.type)).toEqual(["session.commentary.append"]);
    expect(String(e.sent[0]!.content)).toContain("pumpkin up in front of their face");
  });

  it("keeps quiet when a check finds the same visitors, or has no greeted group to compare", async () => {
    const e = new TestLive();
    e.sameGroup = false; // no greeted group yet: nothing to compare, never a greeting
    await e.observe("frame");
    expect(e.looks[0]).toEqual({ reason: "background", opts: { quiet: true, previous: undefined, previousImage: undefined } });
    expect(e.sent.map((s) => s.type)).toEqual(["session.thinking.append"]);
    await e.greet("img", "arrived");
    e.sent = [];
    e.sameGroup = true;
    e.vision = "One visitor in a dinosaur costume, facing away.";
    await e.recheck("frame");
    expect(e.sent.map((s) => s.type)).toEqual(["session.thinking.append"]);
    expect(e.events).toContainEqual({ type: "note", text: "no one new (vision saw: One visitor in a dinosaur costume, facing away.)" });
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

describe("LiveEngine: tonight's memory and running gags", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const withEvening = (evening = new EveningMemory(null, () => new Date("2026-10-31T19:00:00"))) => ({
    evening,
    engine: new TestLive({ ...deps(), evening }),
  });
  const contents = (e: TestLive) => e.sent.map((s) => String(s.content));

  it("tells a new session, in the background, what it already said tonight", () => {
    const { evening, engine: e } = withEvening();
    evening.recordLine("Boo! What a spooky cape!");
    evening.recordGroup("A vampire in a cape.");
    e.server({ type: "session.started" });
    expect(e.sent.map((s) => s.type)).toEqual(["session.input_audio.mute", "session.thinking.append"]);
    const memory = contents(e)[1]!;
    expect(memory).toMatch(/^\[MEMORY\]/);
    expect(memory).toContain(`- "Boo! What a spooky cape!"`);
    expect(memory).toContain("greeted 1 visitor group; costumes seen: vampire 1");
    expect(e.events).toContainEqual({ type: "note", text: "reminded the new session of tonight (1 lines said, 1 groups greeted)" });
  });

  it("sends no memory on the first session of the evening, or without a store", () => {
    const { engine: e } = withEvening();
    e.server({ type: "session.started" });
    const plain = new TestLive();
    plain.server({ type: "session.started" });
    expect(e.sent.map((s) => s.type)).toEqual(["session.input_audio.mute"]);
    expect(plain.sent.map((s) => s.type)).toEqual(["session.input_audio.mute"]);
  });

  it("counts each new group and offers tonight's tally with its greeting", async () => {
    const { evening, engine: e } = withEvening();
    await e.greet("img", "arrived");
    expect(contents(e)[0]).toContain("[TONIGHT] Optional fun facts");
    expect(contents(e)[0]).toContain("group number 1 you've greeted tonight");
    e.vision = "Two visitors: a witch and a green dinosaur.";
    e.sameGroup = false;
    e.sent = [];
    await e.greet("img", "returned", { awayMs: 30_000 });
    expect(contents(e)[0]).toContain("group number 2 you've greeted tonight");
    expect(contents(e)[0]).toContain("the second dinosaur tonight");
    expect(evening.current.costumes).toEqual({ dinosaur: 2, witch: 1 });
  });

  it("doesn't count the same group coming back, a manual greeting, or newcomers already greeted", async () => {
    const { evening, engine: e } = withEvening();
    await e.greet("img", "arrived");
    e.sameGroup = true;
    await e.greet("img", "returned", { awayMs: 60_000 });
    e.sent = [];
    await e.greet("img", "manual");
    expect(contents(e)[0]).not.toContain("[TONIGHT]");
    expect(evening.current.groups).toBe(1);

    // A newcomer spotted by a background look counts once; the tracker's "grew" for them doesn't again.
    e.sameGroup = false;
    e.vision = "A dinosaur and a ghost.";
    e.sent = [];
    await e.observe("frame");
    expect(contents(e)[0]).toContain("group number 2 you've greeted tonight");
    await e.greet("img", "grew");
    expect(evening.current.groups).toBe(2);
    expect(evening.current.costumes).toEqual({ dinosaur: 1, ghost: 1 });
  });

  it("counts a grown group's new costumes only", async () => {
    const { evening, engine: e } = withEvening();
    await e.greet("img", "arrived");
    vi.advanceTimersByTime(30_000);
    e.vision = "A green dinosaur and a pirate.";
    e.sent = [];
    await e.greet("img", "grew");
    expect(contents(e)[0]).toContain("group number 2 you've greeted tonight");
    expect(evening.current.costumes).toEqual({ dinosaur: 1, pirate: 1 });
  });

  it("counts a group greeted without a clear look, but no costumes", async () => {
    const { evening, engine: e } = withEvening();
    e.visionError = new Error("Failed to fetch");
    await e.greet("img", "arrived");
    expect(evening.current).toMatchObject({ groups: 1, costumes: {} });
    expect(contents(e)[0]).toContain("group number 1 you've greeted tonight");
  });

  it("offers milestones after a quick hello too", async () => {
    const { evening, engine: e } = withEvening();
    for (let i = 0; i < 24; i++) evening.recordGroup("A witch.");
    let finishLook = () => {};
    e.lookGate = new Promise<void>((resolve) => (finishLook = resolve));
    const greeting = e.greet("img", "arrived");
    await vi.advanceTimersByTimeAsync(300);
    expect(contents(e)[0]).not.toContain("[TONIGHT]"); // the quick hello comes before the count
    finishLook();
    await greeting;
    expect(contents(e)[1]).toContain("Your eyes have focused");
    expect(contents(e)[1]).toContain('Group 25 is a milestone: you could celebrate it ("visitor number 25!")');
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
