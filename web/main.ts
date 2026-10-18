import type { BodyState, ClientConfig, ConversationLogRequest } from "../shared/types.ts";
import { BodyLink } from "./bodyLink.ts";
import { describeError, resolveDevice, type DeviceInfo, type SavedDevice } from "./devices.ts";
import { Director } from "./director.ts";
import { EveningMemory, browserStorage } from "./evening.ts";
import { eyeLook, GREETING_FLOURISH, type ActiveFlourish } from "./eyeFlourish.ts";
import { followServerLog } from "./serverLog.ts";
import { ModePanel } from "./modePanel.ts";
import { Rehearsal } from "./rehearsal.ts";
import { RehearsalPanel } from "./rehearsalPanel.ts";
import { LiveEngine } from "./engines/live.ts";
import { RealtimeEngine } from "./engines/realtime.ts";
import type { Engine, EngineDeps } from "./engines/types.ts";
import { Transcript, type Speaker } from "./transcript.ts";
import { Camera, PersonDetector, type DetectedPerson } from "./vision.ts";
import { VisitorTracker } from "./visitors.ts";
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
  rehearsal: $<HTMLDivElement>("rehearsal"),
  voice: $<HTMLAudioElement>("voice"),
};

const transcript = new Transcript();
/** What the creature said and saw earlier tonight, so each new voice session says fresh things. */
const evening = new EveningMemory(browserStorage());
const lineElements = new Map<object, HTMLLIElement>();

function show(who: Speaker, text: string): void {
  const line = transcript.add(who, text, performance.now());
  let li = lineElements.get(line);
  if (!li) {
    li = document.createElement("li");
    li.className = who;
    lineElements.set(line, li);
    ui.transcript.append(li);
    while (ui.transcript.children.length > 200) ui.transcript.firstElementChild?.remove();
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
  const rehearsalPanel = new RehearsalPanel(ui.rehearsal, ui.video.parentElement!, rehearsal, log);
  void rehearsalPanel.loadDays();
  void rehearsalPanel.loadGenerated();
  ui.start.addEventListener("click", () => void wake(cfg, body, minArea, modes), { once: true });
  // Kiosk mode (Pi): start without a click; needs Chromium's --autoplay-policy=no-user-gesture-required.
  if (new URLSearchParams(location.search).has("autowake")) ui.start.click();
}

async function wake(cfg: ClientConfig, body: BodyLink, minArea: number, modes: ModePanel): Promise<void> {
  ui.start.disabled = true;
  ui.startHint.textContent = "Waking up…";

  const audioCtx = new AudioContext();
  await audioCtx.resume();

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
    await camera.start().catch((err2) => log(`Camera failed: ${describeError(err2)}`));
  }

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
    rehearsal: () => rehearsal.active,
  };
  const engine: Engine = cfg.engine === "live" ? new LiveEngine(deps) : new RealtimeEngine(deps);
  modes.attach(engine);
  const meter = new VoiceMeter(audioCtx);
  const director = new Director(
    { engine, capture, isSpeaking: () => meter.speaking(performance.now()), now: () => performance.now(), log },
    { idleCloseMs: cfg.idleCloseSeconds * 1000, backgroundMs: cfg.backgroundFrameSeconds * 1000, recheckCooldownMs: 10_000, sightingGraceMs: 15_000 },
  );

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
        ui.statusPill.textContent = e.status === "open" ? "awake" : e.status === "closed" ? "asleep" : e.status;
        ui.statusPill.className = `pill ${e.status === "open" ? "on" : e.status === "closed" ? "" : "busy"}`;
        if (e.status === "closed") {
          pastVoiceSeconds += sessionVoiceSeconds;
          sessionVoiceSeconds = 0;
          renderCost();
        }
        log(`Voice session ${e.status}${e.detail ? ` (${e.detail})` : ""}`);
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
  PersonDetector.create()
    .then((d) => {
      detector = d;
      log("Person detector ready");
    })
    .catch((err) => log(`Person detector failed to load: ${(err as Error).message}. Use "Greet now".`));
  setInterval(() => {
    const now = performance.now();
    // While rehearsing, pretend visitors replace the real detections (the detector isn't run).
    const people = rehearsal.detections(() => (detector && camera.ready ? detector.detect(ui.video, now) : null));
    if (!people) return;
    drawOverlay(people, Number(ui.minArea.value));
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
      if (attached) void ui.voice.play().catch(() => log("Click anywhere to allow audio playback"));
      meter.attach(attached);
    }
    const level = meter.sample(t);
    const state: BodyState =
      engine.status !== "open"
        ? "sleeping"
        : meter.speaking(t)
          ? "speaking"
          : engine.isThinking()
            ? "thinking"
            : t - engine.lastHeardAt() < 1500
              ? "listening"
              : "idle";
    body.setState(state, t);
    body.setLevel(state === "speaking" ? level : 0, t);
    renderEyes(cfg, state, level, t, body.activeFlourish(t));
    ui.statePill.textContent = state;
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
  ui.sleep.addEventListener("click", () => {
    if (director.autopilot) {
      void director.sleep();
      ui.sleep.textContent = "▶️ Wake (autopilot on)";
      log("Kill switch: asleep until you press Wake");
    } else {
      director.wake();
      if (awakeToday >= cfg.maxVoiceMinutesPerDay * 60) capOverridden = true;
      ui.sleep.textContent = "🛑 Sleep (kill switch)";
      log("Autopilot on");
    }
  });
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
  });

  log(cfg.hasApiKey ? "Awake and watching. Walk up to the camera to test!" : "Watching, but the server has no OPENAI_API_KEY");
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

/** On-screen preview of what the Arduino eyes are doing. */
function renderEyes(cfg: ClientConfig, state: BodyState, level: number, t: number, flourish: ActiveFlourish | null = null): void {
  let brightness: number;
  switch (state) {
    case "speaking":
      brightness = 0.35 + 0.65 * level;
      break;
    case "thinking":
      brightness = 0.45 + 0.35 * Math.sin(t / 250);
      break;
    case "sleeping":
      brightness = 0.25;
      break;
    default:
      brightness =
        cfg.character.eyeStyle === "flicker"
          ? 0.7 + 0.15 * Math.sin(t / 90) * Math.sin(t / 37)
          : cfg.character.eyeStyle === "blink" && t % 4000 < 150
            ? 0.05
            : 0.8;
  }
  [ui.eyeLeft, ui.eyeRight].forEach((eye, i) => {
    const look = eyeLook(cfg.character.eyes[state], brightness, flourish, t, i);
    const color = `rgb(${look.rgb.map(Math.round).join(", ")})`;
    eye.style.backgroundColor = color;
    eye.style.boxShadow = `0 0 ${Math.round(10 + 30 * look.brightness)}px ${color}`;
  });
}

main().catch((err) => log(`Startup failed: ${(err as Error).message}`));
