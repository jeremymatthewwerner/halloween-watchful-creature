import { describe, expect, it, vi } from "vitest";
import { Director } from "../web/director.ts";
import type { Engine, EngineStatus } from "../web/engines/types.ts";

class FakeEngine implements Engine {
  readonly kind = "live" as const;
  status: EngineStatus = "closed";
  remoteStream = null;
  mic = false;
  thinking = false;
  failConnect = false;
  calls: string[] = [];
  connect = vi.fn(async () => {
    this.calls.push("connect");
    if (this.failConnect) throw new Error("no key");
    this.status = "open";
  });
  close = vi.fn(async () => {
    this.calls.push("close");
    this.status = "closed";
  });
  greet = vi.fn(async (image: string | null, reason: string) => {
    this.calls.push(`greet:${reason}:${image}`);
  });
  observe = vi.fn(async (image: string) => {
    this.calls.push(`observe:${image}`);
  });
  say = vi.fn();
  setMicEnabled(enabled: boolean) {
    this.mic = enabled;
  }
  isThinking() {
    return this.thinking;
  }
  lastHeardAt() {
    return 0;
  }
  on() {
    return () => {};
  }
}

function setup() {
  let now = 0;
  let speaking = false;
  const engine = new FakeEngine();
  const director = new Director(
    { engine, capture: () => "frame", isSpeaking: () => speaking, now: () => now, log: () => {} },
    { idleCloseMs: 60_000, backgroundMs: 10_000 },
  );
  return {
    engine,
    director,
    advance: (ms: number) => (now += ms),
    setSpeaking: (v: boolean) => (speaking = v),
  };
}

describe("Director", () => {
  it("starts with the mic gated off", () => {
    const { engine } = setup();
    expect(engine.mic).toBe(false);
  });

  it("connects, unmutes and greets when visitors arrive", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 2 });
    expect(engine.calls).toEqual(["connect", "greet:arrived:frame"]);
    expect(engine.mic).toBe(true);
  });

  it("greets a growing group only when the session is open", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "grew", count: 3, from: 1 });
    expect(engine.calls).toEqual([]);
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "grew", count: 3, from: 1 });
    expect(engine.calls.at(-1)).toBe("greet:grew:frame");
  });

  it("sends background frames while visitors stay, but not while speaking", async () => {
    const { engine, director, advance, setSpeaking } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    advance(5_000);
    await director.tick();
    expect(engine.observe).not.toHaveBeenCalled();
    advance(6_000);
    setSpeaking(true);
    await director.tick();
    expect(engine.observe).not.toHaveBeenCalled();
    setSpeaking(false);
    await director.tick();
    expect(engine.observe).toHaveBeenCalledTimes(1);
  });

  it("mutes when visitors leave and sleeps the session after the idle timeout", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    expect(engine.mic).toBe(false);
    advance(59_000);
    await director.tick();
    expect(engine.close).not.toHaveBeenCalled();
    advance(2_000);
    await director.tick();
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(engine.status).toBe("closed");
  });

  it("does not sleep if visitors come back before the timeout", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    advance(30_000);
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    advance(60_000);
    await director.tick();
    expect(engine.close).not.toHaveBeenCalled();
  });

  it("reconnects (without re-greeting) if the session drops mid-visit", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    engine.status = "closed";
    engine.calls = [];
    await director.tick();
    expect(engine.calls).toEqual(["connect", "observe:frame"]);
  });

  it("backs off after a failed connection instead of retrying every tick", async () => {
    const { engine, director, advance } = setup();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.tick();
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(1);
    advance(16_000);
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(2);
  });

  it("kill switch closes the session and ignores visitors until woken", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.sleep();
    expect(engine.status).toBe("closed");
    expect(engine.mic).toBe(false);
    await director.onVisitorEvent({ type: "left" });
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(1);
    director.wake();
    expect(engine.mic).toBe(true);
  });

  it("greet now connects even during the failure backoff", async () => {
    const { engine, director } = setup();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    engine.failConnect = false;
    await director.greetNow();
    expect(engine.calls.at(-1)).toBe("greet:manual:frame");
  });
});
