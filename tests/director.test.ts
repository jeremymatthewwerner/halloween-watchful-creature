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
  greet = vi.fn(async (image: string | null, reason: string, opts?: { awayMs?: number; ready?: Promise<boolean> }) => {
    // Like the real engines: only greet once the session is open.
    if (opts?.ready && !(await opts.ready)) return;
    this.calls.push(`greet:${reason}:${image}${opts?.awayMs ? `:${opts.awayMs}` : ""}`);
  });
  observe = vi.fn(async (image: string) => {
    this.calls.push(`observe:${image}`);
  });
  recheck = vi.fn(async (image: string) => {
    this.calls.push(`recheck:${image}`);
  });
  say = vi.fn();
  setStanding = vi.fn();
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
  const logs: string[] = [];
  const director = new Director(
    { engine, capture: () => "frame", isSpeaking: () => speaking, now: () => now, log: (m) => logs.push(m) },
    { idleCloseMs: 60_000, backgroundMs: 10_000, recheckCooldownMs: 10_000, sightingGraceMs: 15_000 },
  );
  return {
    engine,
    director,
    logs,
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

  it("hands a returning group to the engine to decide same vs new, with how long they were away", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    engine.calls = [];
    await director.onVisitorEvent({ type: "returned", count: 1, awayMs: 10_000 });
    expect(engine.calls).toEqual(["greet:returned:frame:10000"]);
    expect(engine.mic).toBe(true);
    expect(director.visitorsPresent).toBe(true);
  });

  it("wakes the session on a sighting, and sleeps it again soon if nobody arrives", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "sighted" });
    expect(engine.calls).toEqual(["connect"]);
    expect(engine.mic).toBe(false);
    advance(14_000);
    await director.tick();
    expect(engine.status).toBe("open");
    advance(2_000);
    await director.tick();
    expect(engine.calls).toEqual(["connect", "close"]);
  });

  it("an arrival after a sighting uses the session it woke, and isn't closed by the sighting timer", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "sighted" });
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    advance(20_000);
    await director.tick();
    expect(engine.calls.filter((c) => c === "connect" || c === "close")).toEqual(["connect"]);
    // Sightings while the session is open (or someone's present) do nothing.
    await director.onVisitorEvent({ type: "sighted" });
    expect(engine.connect).toHaveBeenCalledTimes(1);
  });

  it("starts the greeting (and its look) while the session is still connecting", async () => {
    const { engine, director } = setup();
    let finishConnect = () => {};
    engine.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = () => {
            engine.status = "open";
            resolve();
          };
        }),
    );
    const arriving = director.onVisitorEvent({ type: "arrived", count: 1 });
    await Promise.resolve();
    expect(engine.greet).toHaveBeenCalledTimes(1);
    expect(engine.calls).toEqual([]); // waiting for the session before speaking
    finishConnect();
    await arriving;
    expect(engine.calls).toEqual(["greet:arrived:frame"]);
  });

  it("rechecks for someone new after a presence gap, at most once per cooldown, logging every gap", async () => {
    const { engine, director, advance, logs } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    engine.calls = [];
    await director.onVisitorEvent({ type: "gap", count: 1, awayMs: 3200 });
    advance(4000);
    await director.onVisitorEvent({ type: "gap", count: 1, awayMs: 2500 });
    advance(7000);
    await director.onVisitorEvent({ type: "gap", count: 1, awayMs: 2100 });
    expect(engine.calls).toEqual(["recheck:frame", "recheck:frame"]);
    expect(logs.filter((l) => l.startsWith("Nobody in view"))).toEqual([
      "Nobody in view for 3s, then someone again: checking for someone new",
      "Nobody in view for 3s, then someone again (checked recently)",
      "Nobody in view for 2s, then someone again: checking for someone new",
    ]);
  });

  it("reconnects before greeting a returning group if the session went to sleep", async () => {
    const { engine, director } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    await engine.close();
    engine.calls = [];
    await director.onVisitorEvent({ type: "returned", count: 1, awayMs: 45_000 });
    expect(engine.calls).toEqual(["connect", "greet:returned:frame:45000"]);
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
