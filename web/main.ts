import type { DashboardStatus, RemoteCommand } from "../shared/remote.ts";
import type { BodyState, ClientConfig, ConversationLogRequest } from "../shared/types.ts";
import { BodyLink } from "./bodyLink.ts";
import { describeError, resolveDevice, type DeviceInfo, type SavedDevice } from "./devices.ts";
import { Director } from "./director.ts";
import { EveningMemory, browserStorage } from "./evening.ts";
import { GREETING_FLOURISH, JEWEL_PIXELS, JewelAnimator, TWINKLE_SLOTS, type ActiveFlourish } from "./eyeFlourish.ts";
import { startPorchSounds } from "./porchSounds.ts";
import { followServerLog } from "./serverLog.ts";
import { ModePanel } from "./modePanel.ts";
import { Rehearsal } from "./rehearsal.ts";
import { RehearsalPanel } from "./rehearsalPanel.ts";
import { isModeId, modeLabel } from "./modes.ts";
import { RemoteLink, renderAlerts } from "./remoteLink.ts";
import { setupSnapshotPanel } from "./snapshotPanel.ts";
import { Watchdog, loadReloads, loadResume, resumeAudio, saveReloads, saveResume } from "./watchdog.ts";
import { LiveEngine } from "./engines/live.ts";
import { RealtimeEngine } from "./engines/realtime.ts";
import type { Engine, EngineDeps } from "./engines/types.ts";
import { LineElements, Transcript, type Speaker } from "./transcript.ts";
import { Camera, PersonDetector, type DetectedPerson } from "./vision.ts";
import { VisitorTracker } from "./visitors.ts";
import { VoicePanel } from "./voicePanel.ts";
import { VoiceMeter } from "./voiceLevel.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`creature.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`creature.${key}`, value);
    } catch {
      /* private mode: settings just won't persist */
    }
  },
};

const ui = {
  characterName: $<HTMLSpanElement>("character-name"),
  enginePill: $<HTMLSpanElement>("engine-pill"),
  statusPill: $<HTMLSpanElement>("status-pill"),
  statePill: $<HTMLSpanElement>("state-pill"),
  costPill: $<HTMLSpanElement>("cost-pill"),
  video: $<HTMLVideoElement>("video"),
  overlay: $<HTMLCanvasElement>("overlay"),
  presence: $<HTMLDivElement>("presence"),
  eyeLeft: $<HTMLDivElement>("eye-left"),
  eyeRight: $<HTMLDivElement>("eye-right"),
  startCard: $<HTMLDivElement>("start-card"),
  startHint: $<HTMLParagraphElement>("start-hint"),
  start: $<HTMLButtonElement>("start"),
  keyWarning: $<HTMLParagraphElement>("key-warning"),
  greet: $<HTMLButtonElement>("greet"),
  sleep: $<HTMLButtonElement>("sleep"),
  sayForm: $<HTMLFormElement>("say-form"),
  sayInput: $<HTMLInputElement>("say-input"),
  sayButton: $<HTMLButtonElement>("say-button"),
  characterSelect: $<HTMLSelectElement>("character-select"),
  cameraSelect: $<HTMLSelectElement>("camera-select"),
  micSelect: $<HTMLSelectElement>("mic-select"),
  speakerSelect: $<HTMLSelectElement>("speaker-select"),
  minArea: $<HTMLInputElement>("min-area"),
  minAreaValue: $<HTMLSpanElement>("min-area-value"),
  transcript: $<HTMLOListElement>("transcript"),
  serverLog: $<HTMLOListElement>("server-log"),
  serverLogStatus: $<HTMLSpanElement>("server-log-status"),
  sessionLogLink: $<HTMLAnchorElement>("session-log-link"),
  galleryLink: $<HTMLAnchorElement>("gallery-link"),
  recapLink: $<HTMLAnchorElement>("recap-link"),
  rehearsal: $<HTMLDivElement>("rehearsal"),
  alerts: $<HTMLElement>("alerts"),
  alertList: $<HTMLOListElement>("alert-list"),
  voice: $<HTMLAudioElement>("voice"),
};

const transcript = new Transcript();
/** What the creature said and saw earlier tonight, so each new voice session says fresh things. */
const evening = new EveningMemory(browserStorage());
/** The Conversation panel shows the newest 200 lines. */
const lineElements = new LineElements<HTMLLIElement>(200);

function show(who: Speaker, text: string): void {
  const line = transcript.add(who, text, performance.now());
  let li = lineElements.get(line);
  if (!li) {
    li = document.createElement("li");
    li.className = who;
    for (const old of lineElements.add(line, li)) old.remove();
    ui.transcript.append(li);
  }
  li.textContent = line.text;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

/** Sends finished Conversation lines (speech and notes) to the server's on-disk log. */
function saveConversation(all = false): void {
  const now = performance.now();
  const lines: ConversationLogRequest["lines"] = transcript
    .takeFinished(now, all)
    .map((line) => {
      const at = Date.now() - (now - line.start);
      return { who: line.who, text: line.text.trim(), at, ...(rehearsal.wasActiveAt(at) && { rehearsal: true }) };
    });
  if (!lines.length) return;
  for (const line of lines) if (line.who === "creature" && !line.rehearsal) evening.recordLine(line.text);
  const body = JSON.stringify({ lines } satisfies ConversationLogRequest);
  void fetch("/api/conversation", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
}
setInterval(saveConversation, 1000);
addEventListener("pagehide", () => saveConversation(true));

const log = (text: string) => {
  console.log(`[creature] ${text}`);
  show("system", text);
};

/** Rehearsal mode: sample images and pretend visitors instead of the real camera (see rehearsal.ts). */
const rehearsal = new Rehearsal({ log });
/** Rehearsal greetings mustn't count toward tonight's real visitors, so they get a throwaway memory. */
const rehearsalEvening = new EveningMemory(null);

// --- phone remote + watchdog (web/remoteLink.ts, web/watchdog.ts) ---
const store = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
/** Set when this load should wake by itself: it was awake moments ago (a reload, or the watchdog). */
const resume = loadResume(store, Date.now());
// Failing voice sessions only reload the page if it's known to wake again without a click.
const watchdog = new Watchdog(Date.now(), loadReloads(store), { reloadForVoice: prefs.get("autoWakeOk") === "1" });

/** What the remote and the watchdog act on once the creature is awake. */
interface Awake {
  director: Director;
  engine: Engine;
  tracker: VisitorTracker;
  setAutopilot(on: boolean, why: string): void;
  awakeSeconds(): number;
  capReached(): boolean;
}
let awake: Awake | null = null;
let awakeStarting: Promise<boolean> | null = null;
let startWake: ((gesture: boolean) => Promise<boolean>) | null = null;
let modePanel: ModePanel | null = null;
let clientConfig: ClientConfig | null = null;
let needsTap = false;
let detectorState: DashboardStatus["detector"] = "off";
let bodyState: BodyState = "sleeping";

/** Wakes once (later calls share the attempt); false if the browser blocked sound or it failed. */
function tryWake(gesture: boolean): Promise<boolean> {
  if (awake) return Promise.resolve(true);
  if (!startWake) return Promise.resolve(false);
  awakeStarting ??= startWake(gesture)
    .catch((err: Error) => {
      log(`Wake failed: ${err.message}`);
      ui.start.disabled = false;
      ui.startHint.textContent = "Waking failed (see Conversation). Click to try again.";
      return false;
    })
    .finally(() => (awakeStarting = null));
  return awakeStarting;
}

function dashboardStatus(): Omit<DashboardStatus, "lastCommand"> {
  const cfg = clientConfig;
  const today = new Date().toISOString().slice(0, 10);
  const seconds = awake?.awakeSeconds() ?? Number(prefs.get(`awake.${today}`) ?? 0);
  return {
    character: cfg?.character.name ?? "",
    woken: awake !== null,
    needsTap,
    autopilot: awake?.director.autopilot ?? true,
    voice: awake?.engine.status ?? "closed",
    body: bodyState,
    present: awake?.director.visitorsPresent ?? false,
    visitors: awake?.tracker.count ?? 0,
    camera: !awake ? "off" : watchdog.cameraStalled ? "stalled" : "ok",
    detector: detectorState,
    awakeMinutesToday: Math.round(seconds / 60),
    costToday: cfg?.engine === "live" ? (seconds / 60) * cfg.liveCostPerMinute : null,
    capReached: awake?.capReached() ?? false,
    modes: modePanel?.list() ?? [],
  };
}

/** A button press on the phone remote. Returns what to show on the phone; throws to show an error. */
async function runCommand(cmd: RemoteCommand): Promise<string> {
  switch (cmd.type) {
    case "wake":
      if (awake) {
        if (awake.director.autopilot) return "Already awake";
        awake.setAutopilot(true, "from the phone remote");
        return "Awake: autopilot on";
      }
      if (await tryWake(false)) return "Woke up";
      throw new Error(
        needsTap
          ? "Still blocked: the browser won't play sound until someone clicks the dashboard once. Starting Chrome with --autoplay-policy=no-user-gesture-required avoids this."
          : "Couldn't wake (see the dashboard's Conversation panel)",
      );
    case "sleep":
      if (!awake) return "Not woken yet: nothing to stop";
      awake.setAutopilot(false, "from the phone remote");
      return "Asleep until you press Wake";
    case "greet":
      if (!awake) throw new Error("Not woken yet: press Wake first");
      log("(phone remote) Greet now");
      void awake.director.greetNow();
      return "Greeting whoever is there";
    case "say":
      if (awake?.engine.status !== "open") throw new Error("Not awake yet: press Greet now first");
      awake.engine.say(cmd.text);
      log(`(operator, phone) ${cmd.text}`);
      return "Saying it";
    case "mode":
      if (!isModeId(cmd.mode) || !modePanel) throw new Error("Unknown mode");
      modePanel.set(cmd.mode, cmd.on);
      return `${modeLabel(cmd.mode)} ${cmd.on ? "on" : "off"}`;
  }
}

const remote = new RemoteLink({ status: dashboardStatus, run: runCommand }, (alerts) => renderAlerts(ui.alerts, ui.alertList, alerts));

/** The watchdog decided a reload is the way out: remember to wake again, tell the owner, reload. */
let reloadPending = false;
async function watchdogReload(reason: string): Promise<void> {
  reloadPending = true;
  log(`Watchdog: ${reason}; reloading the page to recover`);
  saveReloads(store, watchdog.reloadHistory);
  saveResume(store, { awake: true, autopilot: awake?.director.autopilot ?? true, at: Date.now(), reloadReason: reason });
  await Promise.race([remote.alert("watchdog-reload", reason), new Promise((resolve) => setTimeout(resolve, 1500))]);
  location.reload();
}

/**
 * The server may still be starting (a kiosk at boot) or restarting (tsx watch): keep trying
 * instead of giving up, so the page never needs a manual reload.
 */
async function loadConfig(character: string): Promise<ClientConfig> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`/api/config?character=${encodeURIComponent(character)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cfg = (await res.json()) as ClientConfig;
      if (attempt > 1) log("Server is up");
      return cfg;
    } catch (err) {
      if (attempt === 1) log(`Waiting for the server (${(err as Error).message}); retrying…`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * attempt)));
    }
  }
}

async function main(): Promise<void> {
  followServerLog(ui.serverLog, ui.serverLogStatus);
  const savedCharacter = prefs.get("character") ?? "";
  const cfg = await loadConfig(savedCharacter);
  ui.characterName.textContent = cfg.character.name;
  document.title = cfg.character.name;
  ui.enginePill.textContent = cfg.engine === "live" ? "GPT-Live" : "gpt-realtime";
  ui.keyWarning.hidden = cfg.hasApiKey;
  ui.sessionLogLink.hidden = !cfg.sessionLogUrl;
  if (cfg.sessionLogUrl) ui.sessionLogLink.href = cfg.sessionLogUrl;
  ui.galleryLink.hidden = !cfg.sessionLogUrl;
  if (cfg.sessionLogUrl) ui.galleryLink.href = cfg.sessionLogUrl.replace(/log\.html$/, "gallery.html");
  setupSnapshotPanel($("snapshot-privacy"), cfg.snapshots, log);
  ui.recapLink.hidden = !cfg.sessionLogUrl;
  for (const c of cfg.characters) ui.characterSelect.add(new Option(c.name, c.id, false, c.id === cfg.character.id));
  ui.characterSelect.addEventListener("change", () => {
    prefs.set("character", ui.characterSelect.value);
    location.reload();
  });

  const minArea = Number(prefs.get("minArea") ?? 0.03);
  ui.minArea.value = String(minArea);
  ui.minAreaValue.textContent = `${Math.round(minArea * 100)}% of frame`;

  const body = new BodyLink();
  body.sendPalette(cfg.character);
  body.connect();
  renderEyes(cfg, "sleeping", 0, 0);

  const modes = new ModePanel($("modes"), log);
  const voices = new VoicePanel($("voice-picker"), cfg, log);
  const rehearsalPanel = new RehearsalPanel(ui.rehearsal, ui.video.parentElement!, rehearsal, log);
  void rehearsalPanel.loadDays();
  void rehearsalPanel.loadGenerated();
  clientConfig = cfg;
  modePanel = modes;
  startWake = (gesture) => wake(cfg, body, minArea, modes, voices, gesture);
  remote.start();
  ui.start.addEventListener("click", () => void tryWake(true));
  // Kiosk mode (Pi), or a reload of a page that was awake (the watchdog's, say): wake without a click.
  // Sound then needs Chrome's --autoplay-policy=no-user-gesture-required (or the browser's leave).
  if (resume?.reloadReason) log(`The watchdog reloaded the page (${resume.reloadReason}): waking again`);
  if (new URLSearchParams(location.search).has("autowake") || resume) void tryWake(false);
}

async function wake(
  cfg: ClientConfig,
  body: BodyLink,
  minArea: number,
  modes: ModePanel,
  voices: VoicePanel,
  gesture: boolean,
): Promise<boolean> {
  ui.start.disabled = true;
  ui.startHint.textContent = "Waking up…";

  const audioCtx = new AudioContext();
  if (!(await resumeAudio(audioCtx, gesture ? 10_000 : 1500))) {
    void audioCtx.close();
    needsTap = true;
    ui.start.disabled = false;
    ui.startHint.textContent =
      "Click to wake: the browser blocks sound until someone clicks this page. (For unattended use, start Chrome with --autoplay-policy=no-user-gesture-required.)";
    log("Sound is blocked until someone clicks the page: click Wake the creature");
    void remote.alert("needs-wake", resume?.reloadReason ? `after the watchdog reloaded the page (${resume.reloadReason})` : "waiting for a click on the dashboard");
    void remote.beat();
    return false;
  }
  if (!gesture) prefs.set("autoWakeOk", "1");
  if (needsTap) void remote.resolve("needs-wake");
  needsTap = false;

  // Saved devices are found by id, else by name (ids can change when gear is re-plugged), else the default.
  // Device names are only visible once the mic is allowed, so open it first, then switch if needed.
  const savedMic = saved("mic");
  let mic = await openMic(savedMic.id ?? undefined);
  const devices = await navigator.mediaDevices.enumerateDevices();
  const micDevice = pickDevice(devices, "audioinput", "mic", "microphone");
  if (micDevice && micDevice.deviceId !== mic.getAudioTracks()[0]?.getSettings().deviceId) {
    mic.getTracks().forEach((t) => t.stop());
    mic = await openMic(micDevice.deviceId);
  }

  const camera = new Camera(ui.video);
  const cameraDevice = pickDevice(devices, "videoinput", "camera", "camera");
  try {
    await camera.start(cameraDevice?.deviceId);
  } catch (err) {
    log(`Camera failed (${describeError(err)}); trying the default camera`);
    await camera.start().catch((err2) => {
      log(`Camera failed: ${describeError(err2)}`);
      void remote.alert("camera-lost", `couldn't start the camera: ${describeError(err2)}`);
    });
  }
  watchdog.cameraStarted(Date.now());

  const speakerDevice = pickDevice(devices, "audiooutput", "speaker", "speaker");
  if (speakerDevice) await setSpeaker(speakerDevice.deviceId);
  await fillDeviceSelects(camera);

  // While rehearsing, frames come from the chosen sample image instead of the camera.
  const capture = () => rehearsal.capture(() => camera.capture());
  const deps: EngineDeps = {
    mic,
    character: cfg.character.id,
    capture,
    recentTranscript: () => transcript.recent(),
    lastVoiceAt: () => meter.lastLoudTime,
    get evening() {
      return rehearsal.active ? rehearsalEvening : evening;
    },
    spookiness: () => modes.spookiness,
    voice: voices.requestVoice,
    rehearsal: () => rehearsal.active,
  };
  const engine: Engine = cfg.engine === "live" ? new LiveEngine(deps) : new RealtimeEngine(deps);
  modes.attach(engine);
  const meter = new VoiceMeter(audioCtx);
  // Spooky ambience, lure call-outs and offline greetings: local audio only, never the voice session.
  const porchSounds = startPorchSounds({
    audioCtx,
    character: cfg.character.id,
    sinkId: speakerDevice?.deviceId,
    status: () => ({
      porchEmpty: tracker.state === "empty",
      talking: meter.speaking(performance.now()) || engine.isThinking(),
      autopilot: director.autopilot,
    }),
    prefs,
    log,
    // Ambience only stirs the eyes (a blink), it doesn't pulse them like a voice.
    onAmbience: () => {
      if (!body.activeFlourish(performance.now())) body.flourish("slowblink");
    },
  });
  // The recorded clips drive the eyes the way the live voice does.
  const clipMeter = new VoiceMeter(audioCtx);
  clipMeter.attachNode(porchSounds.voiceTap);
  // Clips in the voice picked here (made and cached by the server), else the bundled ones.
  void porchSounds.useVoice(voices.pickedVoice);
  voices.onPick((picked) => void porchSounds.useVoice(picked));

  const renderStatusPill = (status: Engine["status"]) => {
    const offline = director.offline && status !== "open";
    ui.statusPill.textContent = offline ? "offline: recorded greetings" : status === "open" ? "awake" : status === "closed" ? "asleep" : status;
    ui.statusPill.className = `pill ${offline ? "bad" : status === "open" ? "on" : status === "closed" ? "" : "busy"}`;
  };
  const director = new Director(
    {
      engine,
      capture,
      isSpeaking: () => meter.speaking(performance.now()) || clipMeter.speaking(performance.now()),
      now: () => performance.now(),
      log,
      recorded: {
        ...porchSounds.greetings,
        play: (index) => {
          const text = porchSounds.greetings.play(index);
          if (text) body.flourish(GREETING_FLOURISH.visitors);
          return text;
        },
      },
      onOffline: (offline, detail) => {
        // The server logs both (and pushes the alert, at most once per 15 min).
        if (offline) void remote.alert("voice-offline", detail);
        else void remote.resolve("voice-offline", detail);
        renderStatusPill(engine.status);
      },
    },
    { idleCloseMs: cfg.idleCloseSeconds * 1000, backgroundMs: cfg.backgroundFrameSeconds * 1000, recheckCooldownMs: 10_000, sightingGraceMs: 15_000 },
  );
  voices.attach(engine, () => director.visitorsPresent);

  // --- usage / cost ---
  let pastVoiceSeconds = 0;
  let sessionVoiceSeconds = 0;
  let tokens = 0;
  const renderCost = () => {
    const seconds = pastVoiceSeconds + sessionVoiceSeconds;
    ui.costPill.textContent =
      cfg.engine === "live"
        ? `$${((seconds / 60) * cfg.liveCostPerMinute).toFixed(2)} voice · ${Math.round(seconds / 60)} min · ${(tokens / 1000).toFixed(1)}k vision tok`
        : `${(tokens / 1000).toFixed(1)}k tokens`;
  };

  engine.on((e) => {
    switch (e.type) {
      case "status":
        renderStatusPill(e.status);
        if (e.status === "closed") {
          pastVoiceSeconds += sessionVoiceSeconds;
          sessionVoiceSeconds = 0;
          renderCost();
        }
        log(`Voice session ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
        watchdog.voiceStatus(e.status);
        break;
      case "transcript":
        show(e.who, e.delta);
        break;
      case "greeting":
        body.flourish(GREETING_FLOURISH[e.kind]);
        break;
      case "note":
        log(e.text);
        break;
      case "usage":
        if (e.voiceSeconds !== undefined) sessionVoiceSeconds = e.voiceSeconds;
        if (e.tokens) tokens += e.tokens;
        renderCost();
        break;
      case "error":
        log(`⚠️ ${e.message}`);
        // Vision failures are counted by the server (it sees every look); these are the voice session's.
        if (!e.message.startsWith("vision:")) watchdog.voiceError(Date.now());
        break;
    }
  });

  // --- vision loop (~5 fps) ---
  const tracker = new VisitorTracker({ minArea });
  ui.minArea.addEventListener("input", () => {
    const value = Number(ui.minArea.value);
    prefs.set("minArea", String(value));
    ui.minAreaValue.textContent = `${Math.round(value * 100)}% of frame`;
    tracker.setMinArea(value);
  });
  let detector: PersonDetector | null = null;
  detectorState = "loading";
  PersonDetector.create()
    .then((d) => {
      detector = d;
      detectorState = "ok";
      log("Person detector ready");
    })
    .catch((err) => {
      detectorState = "failed";
      log(`Person detector failed to load: ${(err as Error).message}. Use "Greet now".`);
      watchdog.detectorLoadFailed((err as Error).message);
    });
  setInterval(() => {
    watchdog.cameraTime(ui.video.currentTime, Date.now());
    const now = performance.now();
    // While rehearsing, pretend visitors replace the real detections (the detector isn't run).
    const people = rehearsal.detections(() => {
      if (!detector || !camera.ready) return null;
      try {
        const found = detector.detect(ui.video, now);
        watchdog.detectorOk();
        return found;
      } catch (err) {
        watchdog.detectorError((err as Error).message);
        return null;
      }
    });
    if (!people) return;
    drawOverlay(people, Number(ui.minArea.value));
    porchSounds.see(people, Number(ui.minArea.value));
    for (const event of tracker.update(people, now)) void director.onVisitorEvent(event);
    const best = people.reduce((m, p) => Math.max(m, p.score), 0);
    ui.presence.textContent = `${tracker.state}${tracker.count ? ` · ${tracker.count} visitor${tracker.count > 1 ? "s" : ""}` : ""} · ${people.length} detected${people.length ? ` (best ${Math.round(best * 100)}%)` : ""}`;
  }, 200);

  // --- director heartbeat + daily awake-time cap ---
  const today = new Date().toISOString().slice(0, 10);
  let awakeToday = Number(prefs.get(`awake.${today}`) ?? 0);
  let capOverridden = false; // pressing Wake after the cap means "keep going today
  setInterval(() => {
    if (engine.status === "open") {
      awakeToday++;
      if (awakeToday % 10 === 0) prefs.set(`awake.${today}`, String(awakeToday));
      if (awakeToday >= cfg.maxVoiceMinutesPerDay * 60 && director.autopilot && !capOverridden) {
        log(`Daily limit of ${cfg.maxVoiceMinutesPerDay} awake minutes reached: going to sleep (raise MAX_VOICE_MINUTES_PER_DAY to change)`);
        void director.sleep();
        ui.sleep.textContent = "▶️ Wake (autopilot on)";
        void remote.alert("cost-cap", `${cfg.maxVoiceMinutesPerDay} awake minutes today`);
      }
    }
    void director.tick();
  }, 1000);

  // --- body + voice meter loop ---
  let attached: MediaStream | null = null;
  const frame = (t: number) => {
    if (engine.remoteStream !== attached) {
      attached = engine.remoteStream;
      ui.voice.srcObject = attached;
      if (attached) {
        void ui.voice.play().catch(() => {
          log("Click anywhere to allow audio playback");
          void remote.alert("needs-wake", "the browser blocked the creature's voice");
        });
      }
      meter.attach(attached);
    }
    const voiceLevel = meter.sample(t);
    const clipLevel = clipMeter.sample(t);
    const live = engine.status === "open";
    // A recorded clip (call-out or offline greeting) speaks too: the eyes and jaw follow it like the live voice.
    const liveSpeaking = live && meter.speaking(t);
    const clipSpeaking = !liveSpeaking && porchSounds.clipPlaying() && clipMeter.speaking(t);
    const level = liveSpeaking ? voiceLevel : clipLevel;
    const state: BodyState =
      liveSpeaking || clipSpeaking
        ? "speaking"
        : !live
          ? "sleeping"
          : engine.isThinking()
            ? "thinking"
            : t - engine.lastHeardAt() < 1500
              ? "listening"
              : "idle";
    body.setState(state, t);
    body.setLevel(state === "speaking" ? level : 0, t);
    renderEyes(cfg, state, level, t, body.activeFlourish(t));
    ui.statePill.textContent = state;
    bodyState = state;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // --- controls ---
  const setControls = (enabled: boolean) => {
    for (const el of [ui.greet, ui.sleep, ui.sayInput, ui.sayButton]) el.disabled = !enabled;
  };
  setControls(true);
  ui.startCard.hidden = true;
  ui.greet.addEventListener("click", () => void director.greetNow());
  const setAutopilot = (on: boolean, why = "") => {
    if (!on) {
      void director.sleep();
      ui.sleep.textContent = "▶️ Wake (autopilot on)";
      log(`Kill switch: asleep until you press Wake${why ? ` (${why})` : ""}`);
    } else {
      director.wake();
      if (awakeToday >= cfg.maxVoiceMinutesPerDay * 60) capOverridden = true;
      ui.sleep.textContent = "🛑 Sleep (kill switch)";
      log(`Autopilot on${why ? ` (${why})` : ""}`);
    }
    void remote.beat();
  };
  ui.sleep.addEventListener("click", () => setAutopilot(!director.autopilot));
  ui.sayForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ui.sayInput.value.trim();
    if (!text) return;
    if (engine.status !== "open") {
      log("Not awake yet: press Greet now first");
      return;
    }
    engine.say(text);
    log(`(operator) ${text}`);
    ui.sayInput.value = "";
  });
  ui.cameraSelect.addEventListener("change", async () => {
    rememberChoice("camera", ui.cameraSelect);
    await camera.start(ui.cameraSelect.value).catch((err) => log(`Camera failed: ${describeError(err)}`));
  });
  ui.micSelect.addEventListener("change", () => {
    rememberChoice("mic", ui.micSelect);
    location.reload();
  });
  ui.speakerSelect.addEventListener("change", () => {
    rememberChoice("speaker", ui.speakerSelect);
    void setSpeaker(ui.speakerSelect.value);
    porchSounds.setSink(ui.speakerSelect.value);
  });

  log(cfg.hasApiKey ? "Awake and watching. Walk up to the camera to test!" : "Watching, but the server has no OPENAI_API_KEY");

  // --- phone remote + watchdog ---
  awake = {
    director,
    engine,
    tracker,
    setAutopilot,
    awakeSeconds: () => awakeToday,
    capReached: () => awakeToday >= cfg.maxVoiceMinutesPerDay * 60 && !capOverridden,
  };
  // The kill switch was on before the reload: keep it on.
  if (resume && !resume.autopilot) setAutopilot(false, "it was on before the page reloaded");
  setInterval(() => {
    if (reloadPending) return; // keep the reason saved for the next load
    const now = Date.now();
    watchdog.setVisible(!document.hidden, now);
    for (const action of watchdog.check(now)) {
      switch (action.type) {
        case "restartCamera":
          log("Watchdog: no camera frames; restarting the camera");
          void camera
            .start(prefs.get("camera") ?? undefined)
            .catch(() => camera.start())
            .catch((err) => log(`Camera restart failed: ${describeError(err)}`));
          break;
        case "alert":
          // Offline mode has its own alert (one push): failed starts while offline are expected.
          if (action.kind === "voice-errors" && director.offline) break;
          void remote.alert(action.kind, action.detail);
          break;
        case "resolve":
          void remote.resolve(action.kind);
          break;
        case "reload":
          void watchdogReload(action.reason);
          return;
      }
    }
    saveResume(store, { awake: true, autopilot: director.autopilot, at: now });
  }, 2000);
  void remote.beat();
  return true;
}

type DeviceSlot = "camera" | "mic" | "speaker";

function saved(slot: DeviceSlot): SavedDevice {
  return { id: prefs.get(slot), label: prefs.get(`${slot}Label`) };
}

/** Saves the operator's pick from a device dropdown, with its name for when its id changes. */
function rememberChoice(slot: DeviceSlot, select: HTMLSelectElement): void {
  prefs.set(slot, select.value);
  prefs.set(`${slot}Label`, select.selectedOptions[0]?.text ?? "");
}

/** The saved device for this slot, refreshing its saved id; logs when falling back to the default. */
function pickDevice(devices: readonly DeviceInfo[], kind: MediaDeviceKind, slot: DeviceSlot, noun: string): DeviceInfo | undefined {
  const want = saved(slot);
  const device = resolveDevice(devices, kind, want);
  if (device) {
    prefs.set(slot, device.deviceId);
    if (device.label) prefs.set(`${slot}Label`, device.label);
  } else if (want.id || want.label) {
    log(`Saved ${noun} ${want.label ? `"${want.label}" ` : ""}isn't connected: using the default`);
  }
  return device;
}

function openMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { ideal: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function setSpeaker(deviceId: string): Promise<void> {
  const audio = ui.voice as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  try {
    await audio.setSinkId?.(deviceId);
  } catch (err) {
    log(`Speaker selection failed: ${(err as Error).message}`);
  }
}

async function fillDeviceSelects(camera: Camera): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select: HTMLSelectElement, kind: MediaDeviceKind, current: string | undefined) => {
    select.replaceChildren();
    for (const d of devices.filter((x) => x.kind === kind)) {
      select.add(new Option(d.label || `${kind} ${select.length + 1}`, d.deviceId, false, d.deviceId === current));
    }
  };
  const videoTrack = (camera.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  fill(ui.cameraSelect, "videoinput", videoTrack?.getSettings().deviceId);
  fill(ui.micSelect, "audioinput", prefs.get("mic") ?? undefined);
  fill(ui.speakerSelect, "audiooutput", prefs.get("speaker") ?? undefined);
}

function drawOverlay(people: DetectedPerson[], minArea: number): void {
  const canvas = ui.overlay;
  const { clientWidth: w, clientHeight: h } = canvas;
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  // Map normalized video coords into the letterboxed (object-fit: contain) video area.
  const vw = ui.video.videoWidth || 16;
  const vh = ui.video.videoHeight || 9;
  const scale = Math.min(w / vw, h / vh);
  const ox = (w - vw * scale) / 2;
  const oy = (h - vh * scale) / 2;
  ctx.lineWidth = 3;
  ctx.font = "14px system-ui";
  for (const p of people) {
    const close = p.area >= minArea;
    ctx.strokeStyle = close ? "#7dff8a" : "#a99bc0";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.strokeRect(ox + p.x * vw * scale, oy + p.y * vh * scale, p.w * vw * scale, p.h * vh * scale);
    ctx.fillText(close ? "visitor" : "too far", ox + p.x * vw * scale + 4, oy + p.y * vh * scale + 16);
  }
}

/**
 * The eye preview's pixels: one NeoPixel Jewel 7 per eye, laid out like the board (pixel 0 in
 * the center, 1-6 around it), so the preview shows what each LED does.
 */
const jewels = [ui.eyeLeft, ui.eyeRight].map((board) =>
  Array.from({ length: JEWEL_PIXELS }, (_, p) => {
    const pixel = document.createElement("div");
    pixel.className = "pixel";
    if (p > 0) {
      const angle = ((p - 1) * Math.PI) / 3;
      pixel.style.left = `${50 + 34 * Math.sin(angle)}%`;
      pixel.style.top = `${50 - 34 * Math.cos(angle)}%`;
    }
    board.append(pixel);
    return pixel;
  }),
);
const jewelAnimator = new JewelAnimator();

/** On-screen preview of what the Arduino eyes are doing, pixel by pixel. */
function renderEyes(cfg: ClientConfig, state: BodyState, level: number, t: number, flourish: ActiveFlourish | null = null): void {
  // As the firmware: one random twinkle slot per frame across both jewels; most frames have none.
  const twinkle = Math.floor(Math.random() * TWINKLE_SLOTS);
  const frame = jewelAnimator.frame(cfg.character.eyes[state], state, level, cfg.character.eyeStyle, t, flourish, twinkle);
  jewels.forEach((pixels, eye) => {
    pixels.forEach((pixel, p) => {
      const rgb = frame[eye]![p]!;
      const color = `rgb(${rgb.map(Math.round).join(", ")})`;
      const glow = Math.max(...rgb) / 255;
      pixel.style.backgroundColor = color;
      pixel.style.boxShadow = `0 0 ${Math.round(2 + 12 * glow)}px ${Math.round(1 + 3 * glow)}px ${color}`;
    });
  });
}

main().catch((err) => log(`Startup failed: ${(err as Error).message}`));
