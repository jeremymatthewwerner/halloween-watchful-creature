import { describe, expect, it, vi } from "vitest";
import { Director, type RecordedGreetings } from "../web/director.ts";
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
  greet = vi.fn(async (image: string | null, reason: string, opts?: { awayMs?: number; count?: number; grows?: number; ready?: Promise<boolean> }) => {
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
    { idleCloseMs: 60_000, backgroundMs: 10_000, recheckCooldownMs: 10_000, sightingGraceMs: 15_000, micGraceMs: 20_000 },
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

  it("tells the engine the group's size and how often it grew this visit, for big-group mode", async () => {
    const { engine, director } = setup();
    const sizes = () => engine.greet.mock.calls.map(([, reason, opts]) => `${reason}:${opts?.count}:${opts?.grows}`);
    await director.onVisitorEvent({ type: "arrived", count: 2 });
    await director.onVisitorEvent({ type: "grew", count: 3, from: 2 });
    await director.onVisitorEvent({ type: "grew", count: 5, from: 3 });
    await director.greetNow();
    expect(sizes()).toEqual(["arrived:2:0", "grew:3:1", "grew:5:2", "manual:5:2"]);
    // A new visit starts counting again.
    await director.onVisitorEvent({ type: "left" });
    await director.onVisitorEvent({ type: "returned", count: 4, awayMs: 120_000 });
    expect(sizes().at(-1)).toBe("returned:4:0");
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

  it("mutes a while after visitors leave, and sleeps the session after the idle timeout", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    // Still listening for a grace period: the camera loses people just out of frame.
    expect(engine.mic).toBe(true);
    advance(19_000);
    await director.tick();
    expect(engine.mic).toBe(true);
    advance(1_000);
    await director.tick();
    expect(engine.mic).toBe(false);
    advance(39_000);
    await director.tick();
    expect(engine.close).not.toHaveBeenCalled();
    advance(2_000);
    await director.tick();
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(engine.status).toBe("closed");
  });

  it("keeps the mic on if visitors come back within the grace period", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    advance(10_000);
    await director.tick();
    await director.onVisitorEvent({ type: "returned", count: 1, awayMs: 10_000 });
    for (let i = 0; i < 40; i++) {
      advance(1_000);
      await director.tick();
      expect(engine.mic).toBe(true); // the pending mute was cancelled
    }
  });

  it("the kill switch mutes at once, even during the grace period", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    await director.sleep();
    expect(engine.mic).toBe(false);
    director.wake();
    advance(30_000);
    await director.tick();
    expect(engine.mic).toBe(false); // nobody's here, so waking doesn't unmute
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

  it("doesn't owe a greeting to visitors who left before the session came back", async () => {
    const { engine, director, advance } = setup();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    engine.failConnect = false;
    advance(16_000);
    engine.calls = [];
    await director.onVisitorEvent({ type: "returned", count: 1, awayMs: 20_000 });
    await director.tick();
    expect(engine.calls).toEqual(["connect", "greet:returned:frame:20000"]);
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

  it("greet now on an empty porch still sleeps the session after the idle timeout", async () => {
    // Found by the soak test: nothing scheduled the close, so the session stayed open (billed) until visitors came and went.
    const { engine, director, advance } = setup();
    await director.greetNow();
    expect(engine.status).toBe("open");
    advance(30_000);
    await director.tick();
    expect(engine.close).not.toHaveBeenCalled();
    advance(31_000);
    await director.tick();
    expect(engine.close).toHaveBeenCalledTimes(1);
  });

  it("make it say wakes the voice session first, then says the line, and sleeps it again on an empty porch", async () => {
    const { engine, director, advance } = setup();
    expect(await director.say("Hi Margaret!")).toBe(true);
    expect(engine.connect).toHaveBeenCalledTimes(1);
    expect(engine.say).toHaveBeenCalledWith("Hi Margaret!");
    expect(engine.mic).toBe(true);
    advance(61_000);
    await director.tick();
    expect(engine.close).toHaveBeenCalledTimes(1);
    // Already open: just says it.
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    engine.connect.mockClear();
    expect(await director.say("One piece each!")).toBe(true);
    expect(engine.connect).not.toHaveBeenCalled();
    expect(engine.say).toHaveBeenLastCalledWith("One piece each!");
  });

  it("greet now while visitors are there leaves the session open", async () => {
    const { engine, director, advance } = setup();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.greetNow();
    advance(120_000);
    await director.tick();
    expect(engine.close).not.toHaveBeenCalled();
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

class FakeRecorded implements RecordedGreetings {
  played: number[] = [];
  isPlaying = false;
  constructor(public n = 16) {}
  count() {
    return this.n;
  }
  play(index: number) {
    this.played.push(index);
    this.isPlaying = true;
    return `clip ${index}`;
  }
  playing() {
    return this.isPlaying;
  }
  stop = vi.fn(() => {
    this.isPlaying = false;
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setupOffline(clips = 16) {
  let now = 0;
  const engine = new FakeEngine();
  const recorded = new FakeRecorded(clips);
  const logs: string[] = [];
  const offline: [boolean, string][] = [];
  // The connect timeout fires only when a test says so.
  let pending: (() => void)[] = [];
  const director = new Director(
    {
      engine,
      capture: () => "frame",
      isSpeaking: () => false,
      now: () => now,
      log: (m) => logs.push(m),
      recorded,
      onOffline: (on, detail) => offline.push([on, detail]),
      wait: () => new Promise<void>((resolve) => pending.push(resolve)),
    },
    { idleCloseMs: 60_000, backgroundMs: 10_000, recheckCooldownMs: 10_000, sightingGraceMs: 15_000, micGraceMs: 20_000, offline: { clipCooldownMs: 20_000 } },
  );
  const timeout = () => {
    const fire = pending;
    pending = [];
    for (const resolve of fire) resolve();
  };
  return { engine, recorded, director, logs, offline, timeout, advance: (ms: number) => (now += ms) };
}

describe("Director offline mode", () => {
  it("plays a recorded greeting when the voice session can't start, and reports going offline once", async () => {
    const { engine, recorded, director, logs, offline, advance } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 2 });
    expect(recorded.played).toHaveLength(1);
    expect(engine.calls).toEqual(["connect"]); // no live greeting
    expect(director.offline).toBe(true);
    expect(offline).toEqual([[true, "no key"]]);
    expect(logs.some((l) => l.includes("Offline mode: recorded greetings"))).toBe(true);
    expect(logs).toContain('Recorded greeting (offline): "clip ' + recorded.played[0] + '"');
    advance(6000);
    await director.tick(); // a retry fails too: still one report
    expect(engine.connect).toHaveBeenCalledTimes(2);
    expect(offline).toHaveLength(1);
  });

  it("once offline, greets with a recording right away (no vision look), at most once per cooldown, never the same twice running", async () => {
    const { engine, recorded, director, advance } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    advance(10_000);
    await director.onVisitorEvent({ type: "returned", count: 1, awayMs: 10_000 });
    expect(recorded.played).toHaveLength(1); // too soon after the last one
    await director.onVisitorEvent({ type: "left" });
    recorded.isPlaying = false;
    for (let i = 0; i < 6; i++) {
      advance(25_000);
      await director.onVisitorEvent({ type: "arrived", count: 1 });
      await director.onVisitorEvent({ type: "left" });
      recorded.isPlaying = false;
    }
    expect(recorded.played).toHaveLength(7);
    for (let i = 1; i < recorded.played.length; i++) expect(recorded.played[i]).not.toBe(recorded.played[i - 1]);
    // Only the first arrival (not yet known to be offline) asked the engine to greet, and so to look.
    expect(engine.greet).toHaveBeenCalledTimes(1);
  });

  it("plays a recording when the live voice is slow to connect, then greets live once it's open and the clip is done", async () => {
    const { engine, recorded, director, logs, offline, timeout } = setupOffline();
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
    await flush();
    timeout();
    await arriving;
    expect(recorded.played).toHaveLength(1);
    expect(logs.some((l) => l.includes("slow to connect"))).toBe(true);
    expect(engine.calls).toEqual([]);
    finishConnect();
    await flush();
    await director.tick();
    expect(engine.calls).toEqual([]); // the clip is still playing
    recorded.isPlaying = false;
    await director.tick();
    expect(engine.calls).toEqual(["greet:arrived:frame"]);
    expect(offline).toEqual([]); // it was only slow, never offline
  });

  it("keeps retrying with backoff while the porch is empty, and switches back as soon as it works", async () => {
    const { engine, director, offline, logs, advance } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 }); // t=0: fails, next try at 5 s
    await director.onVisitorEvent({ type: "left" });
    advance(1000);
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(1);
    advance(5000); // 6 s
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(2); // fails: next at 16 s
    advance(5000);
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(2);
    advance(6000); // 17 s
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(3); // fails: next at 37 s
    engine.failConnect = false;
    advance(19_000);
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(3);
    advance(1000); // 37 s
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(4);
    expect(director.offline).toBe(false);
    expect(offline).toEqual([
      [true, "no key"],
      [false, "live voice back after 37 s offline"],
    ]);
    // Nobody's there, so the working session isn't kept open (billed).
    expect(engine.calls.at(-1)).toBe("close");
    expect(logs).toContain("Back online: live voice back after 37 s offline");
  });

  it("gives a visitor greeted by a recording the live greeting once the voice is back", async () => {
    const { engine, recorded, director, offline, advance } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    engine.failConnect = false;
    recorded.isPlaying = false;
    advance(6000);
    await director.tick();
    expect(engine.calls).toEqual(["connect", "connect", "greet:arrived:frame"]);
    expect(offline.map(([on]) => on)).toEqual([true, false]);
    advance(1000);
    await director.tick(); // and only once
    expect(engine.greet).toHaveBeenCalledTimes(2);
  });

  it("a session that drops mid-visit and won't come back gets one recorded line (not one per retry), then catches up silently", async () => {
    const { engine, recorded, director, advance } = setupOffline();
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    expect(engine.calls).toEqual(["connect", "greet:arrived:frame"]);
    engine.status = "closed";
    engine.failConnect = true;
    await director.tick();
    expect(recorded.played).toHaveLength(1);
    advance(30_000);
    await director.tick();
    expect(engine.connect).toHaveBeenCalledTimes(3);
    expect(recorded.played).toHaveLength(1);
    engine.failConnect = false;
    recorded.isPlaying = false;
    advance(30_000);
    await director.tick();
    expect(engine.calls.slice(-2)).toEqual(["connect", "observe:frame"]);
    expect(engine.greet).toHaveBeenCalledTimes(1); // they were greeted live before the drop
  });

  it("forgets the owed greeting when the visitors leave", async () => {
    const { engine, recorded, director, advance } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    engine.failConnect = false;
    recorded.isPlaying = false;
    advance(6000);
    await director.tick(); // the background retry works; nobody to greet
    expect(engine.calls).toEqual(["connect", "connect", "close"]);
  });

  it("the kill switch stops a recorded greeting", async () => {
    const { engine, recorded, director } = setupOffline();
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.sleep();
    expect(recorded.stop).toHaveBeenCalled();
    expect(recorded.isPlaying).toBe(false);
  });

  it("stays quiet without recorded greetings, and says so once", async () => {
    const { engine, director, logs, advance } = setupOffline(0);
    engine.failConnect = true;
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    await director.onVisitorEvent({ type: "left" });
    advance(30_000);
    await director.onVisitorEvent({ type: "arrived", count: 1 });
    expect(logs.filter((l) => l.startsWith("No recorded greetings"))).toHaveLength(1);
  });
});
