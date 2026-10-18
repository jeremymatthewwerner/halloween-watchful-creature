import { describe, expect, it } from "vitest";
import { RESUME_WITHIN_MS, Watchdog, loadReloads, loadResume, resumeAudio, saveReloads, saveResume, type WatchdogAction } from "../web/watchdog.ts";

const T0 = 1_700_000_000_000;

/** Runs the watchdog like the dashboard does: a camera sample every 200 ms, a check every 2 s. */
function harness(opts: ConstructorParameters<typeof Watchdog>[2] = {}, reloads: number[] = []) {
  let now = T0;
  const dog = new Watchdog(T0, reloads, opts);
  let videoTime = 0;
  let framesFlowing = true;
  const actions: WatchdogAction[] = [];
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += 200;
      if (framesFlowing) videoTime += 0.2;
      dog.cameraTime(videoTime, now);
      if ((now - T0) % 2000 === 0) actions.push(...dog.check(now));
    }
  };
  dog.cameraStarted(now);
  return {
    dog,
    actions,
    run,
    now: () => now,
    stopFrames: () => (framesFlowing = false),
    startFrames: () => (framesFlowing = true),
    types: () => actions.map((a) => (a.type === "alert" || a.type === "resolve" ? `${a.type}:${a.kind}` : a.type)),
  };
}

describe("Watchdog: camera", () => {
  it("leaves a healthy camera alone", () => {
    const h = harness();
    h.run(10 * 60_000);
    expect(h.actions).toEqual([]);
  });

  it("restarts a stalled camera, and clears the alert when frames come back", () => {
    const h = harness();
    h.run(70_000);
    h.stopFrames();
    h.run(14_000);
    expect(h.actions).toEqual([]);
    h.run(2_000);
    expect(h.types()).toEqual(["alert:camera-lost", "restartCamera"]);
    expect(h.dog.cameraStalled).toBe(true);
    h.startFrames();
    h.run(2_000);
    expect(h.types()).toEqual(["alert:camera-lost", "restartCamera", "resolve:camera-lost"]);
    h.run(5 * 60_000);
    expect(h.actions).toHaveLength(3);
  });

  it("reloads when restarting didn't bring frames back", () => {
    const h = harness();
    h.run(70_000);
    h.stopFrames();
    h.run(16_000);
    h.run(19_000);
    expect(h.types()).not.toContain("reload");
    h.run(2_000);
    expect(h.actions.at(-1)).toEqual({ type: "reload", reason: "the camera stopped sending frames" });
    // Nothing more once it decided to reload.
    h.run(60_000);
    expect(h.types().filter((t) => t === "reload")).toHaveLength(1);
    expect(h.dog.reloadHistory).toHaveLength(1);
  });

  it("doesn't count a hidden tab's paused video as the camera dying", () => {
    const h = harness();
    h.run(70_000);
    h.dog.setVisible(false, h.now());
    h.stopFrames();
    h.run(5 * 60_000);
    expect(h.actions).toEqual([]);
    h.dog.setVisible(true, h.now());
    h.startFrames();
    h.run(60_000);
    expect(h.actions).toEqual([]);
  });

  it("does nothing before the camera was started", () => {
    let now = T0;
    const dog = new Watchdog(T0);
    for (let i = 0; i < 100; i++) {
      now += 2000;
      dog.cameraTime(0, now);
      expect(dog.check(now)).toEqual([]);
    }
  });
});

describe("Watchdog: person detector", () => {
  it("tolerates a few errors but reloads after many in a row", () => {
    const h = harness();
    h.run(70_000);
    for (let i = 0; i < 24; i++) h.dog.detectorError("WebGL context lost");
    h.dog.detectorOk();
    for (let i = 0; i < 24; i++) h.dog.detectorError("WebGL context lost");
    h.run(2_000);
    expect(h.actions).toEqual([]);
    h.dog.detectorError("WebGL context lost");
    h.run(2_000);
    expect(h.types()).toEqual(["alert:detector-failed", "reload"]);
  });

  it("waits for a minute of uptime before reloading for a load failure", () => {
    const h = harness();
    h.dog.detectorLoadFailed("network error");
    h.run(2_000);
    expect(h.types()).toEqual(["alert:detector-failed"]);
    h.run(55_000);
    expect(h.types()).toEqual(["alert:detector-failed"]);
    h.run(4_000);
    expect(h.types()).toEqual(["alert:detector-failed", "reload"]);
  });
});

describe("Watchdog: voice session", () => {
  const failConnect = (dog: Watchdog) => {
    dog.voiceStatus("connecting");
    dog.voiceStatus("closed");
  };

  it("reloads after 5 failed starts in a row; a good session resets the count", () => {
    const h = harness();
    h.run(70_000);
    for (let i = 0; i < 4; i++) failConnect(h.dog);
    h.dog.voiceStatus("connecting");
    h.dog.voiceStatus("open");
    h.dog.voiceStatus("closing");
    h.dog.voiceStatus("closed"); // a normal close isn't a failure
    for (let i = 0; i < 4; i++) failConnect(h.dog);
    h.run(2_000);
    expect(h.actions).toEqual([]);
    failConnect(h.dog);
    h.run(2_000);
    expect(h.types()).toEqual(["alert:voice-errors", "reload"]);
  });

  it("only alerts (no reload) when the page isn't known to wake by itself", () => {
    const h = harness({ reloadForVoice: false });
    h.run(70_000);
    for (let i = 0; i < 8; i++) failConnect(h.dog);
    h.run(10_000);
    expect(h.types()).toEqual(["alert:voice-errors"]);
    h.dog.voiceStatus("connecting");
    h.dog.voiceStatus("open");
    h.run(2_000);
    expect(h.types()).toEqual(["alert:voice-errors", "resolve:voice-errors"]);
  });

  it("alerts when session errors pile up within 5 minutes", () => {
    const h = harness();
    h.run(70_000);
    for (let i = 0; i < 4; i++) {
      h.dog.voiceError(h.now());
      h.run(2 * 60_000); // spread out: never 5 within 5 min
    }
    expect(h.actions).toEqual([]);
    for (let i = 0; i < 5; i++) h.dog.voiceError(h.now());
    h.run(2_000);
    expect(h.types()).toEqual(["alert:voice-errors"]);
  });
});

describe("Watchdog: reload budget", () => {
  it("stops reloading after 3 reloads in an hour and says so once", () => {
    const h = harness({}, [T0 - 50 * 60_000, T0 - 30 * 60_000, T0 - 5 * 60_000]);
    h.run(70_000);
    h.dog.detectorLoadFailed("boom");
    h.run(10_000);
    const reloadAlerts = h.actions.filter((a) => a.type === "alert" && a.kind === "watchdog-reload");
    expect(h.types()).not.toContain("reload");
    expect(reloadAlerts).toHaveLength(1);
    expect(reloadAlerts[0]).toMatchObject({ detail: expect.stringMatching(/already 3 times/) });
    // Once the oldest reload is over an hour ago, it may reload again.
    h.run(10 * 60_000);
    expect(h.types()).toContain("reload");
  });
});

describe("resume after a reload", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  };

  it("resumes a page that was awake moments ago, keeping the kill switch", () => {
    const store = memory();
    expect(loadResume(store, T0)).toBeNull();
    saveResume(store, { awake: true, autopilot: false, at: T0, reloadReason: "camera" });
    expect(loadResume(store, T0 + 5000)).toEqual({ awake: true, autopilot: false, at: T0, reloadReason: "camera" });
    expect(loadResume(store, T0 + RESUME_WITHIN_MS + 1)).toBeNull();
  });

  it("survives junk and missing storage", () => {
    const store = memory();
    store.setItem("creature.resume", "{not json");
    expect(loadResume(store, T0)).toBeNull();
    expect(loadResume(null, T0)).toBeNull();
    store.setItem("creature.watchdogReloads", '[1, "x", 3]');
    expect(loadReloads(store)).toEqual([1, 3]);
    saveReloads(store, Array.from({ length: 20 }, (_, i) => i));
    expect(loadReloads(store)).toHaveLength(10);
  });

  it("resumeAudio gives up when the browser keeps sound blocked", async () => {
    expect(await resumeAudio({ state: "running", resume: async () => undefined }, 10)).toBe(true);
    const blocked = { state: "suspended", resume: () => new Promise<void>(() => undefined) };
    expect(await resumeAudio(blocked, 10)).toBe(false);
    const allowed = { state: "suspended", resume: async () => void (allowed.state = "running") };
    expect(await resumeAudio(allowed, 10)).toBe(true);
  });
});
