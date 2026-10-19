import "dotenv/config";
import { parseRetentionDays, parseSnapshotsSwitch } from "../shared/snapshots.ts";
import type { BodyMode, EngineKind } from "../shared/types.ts";
import { parseRecapAt } from "./recap.ts";

function str(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const engine = str("ENGINE", "live");
if (engine !== "live" && engine !== "realtime") {
  throw new Error(`ENGINE must be "live" or "realtime", got "${engine}"`);
}

const bodyModes = str("BODY_MODES", "eyes")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
for (const mode of bodyModes) {
  if (mode !== "eyes" && mode !== "jaw" && mode !== "relay") {
    throw new Error(`BODY_MODES entries must be eyes, jaw or relay; got "${mode}"`);
  }
}

const remotePin = process.env.REMOTE_PIN?.trim() ?? "";
if (remotePin && remotePin.length < 6) {
  throw new Error("REMOTE_PIN must be at least 6 characters (or leave it empty to keep the phone remote off)");
}

function recapSleepMinutes(value: string | undefined): number | null {
  const v = value?.trim() ?? "";
  if (v === "off" || v === "0") return null;
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : 15;
}

export const config = {
  apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  apiBase: str("OPENAI_API_BASE", "https://api.openai.com/v1"),
  engine: engine as EngineKind,
  character: str("CHARACTER", "pumpkin"),
  liveModel: str("LIVE_MODEL", "gpt-live-1"),
  realtimeModel: str("REALTIME_MODEL", "gpt-realtime-2.1"),
  realtimeTranscribeModel: str("REALTIME_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
  visionModel: str("VISION_MODEL", "gpt-6-luna"),
  visionReasoningEffort: process.env.VISION_REASONING_EFFORT?.trim() ?? "low",
  voiceOverride: process.env.VOICE?.trim() ?? "",
  bodySerialPort: str("BODY_SERIAL_PORT", "auto"),
  bodyModes: bodyModes as BodyMode[],
  idleCloseSeconds: num("IDLE_CLOSE_SECONDS", 180),
  backgroundFrameSeconds: num("BACKGROUND_FRAME_SECONDS", 30),
  liveCostPerMinute: num("LIVE_COST_PER_MINUTE", 0.05),
  maxVoiceMinutesPerDay: num("MAX_VOICE_MINUTES_PER_DAY", 240),
  /** Where the per-day logs go (log.txt, log.html, snapshots/); "none" turns disk logging off. */
  logDir: str("LOG_DIR", "logs"),
  /** Save the camera frame of each greeting in the day's log (SNAPSHOTS=off, or the older LOG_SNAPSHOTS=false, saves none). */
  snapshots: parseSnapshotsSwitch(process.env.SNAPSHOTS, process.env.LOG_SNAPSHOTS),
  /** Delete snapshots older than this many days (checked at start and daily); 0 keeps them forever. */
  snapshotRetentionDays: parseRetentionDays(process.env.SNAPSHOT_RETENTION_DAYS),
  /** Rehearsal mode's "Generate visitors": image model, quality and size (landscape, like the webcam). */
  rehearsalImageModel: str("REHEARSAL_IMAGE_MODEL", "gpt-image-2.5-flare"),
  rehearsalImageQuality: str("REHEARSAL_IMAGE_QUALITY", "low"),
  rehearsalImageSize: str("REHEARSAL_IMAGE_SIZE", "1536x1024"),
  /** Estimated US dollars per generated image, shown before generating (the real cost is logged after). */
  rehearsalImageCostUsd: num("REHEARSAL_IMAGE_COST_USD", 0.01),
  /** Where generated rehearsal visitors are cached (gitignored); "none" turns generating off. */
  rehearsalCacheDir: str("REHEARSAL_CACHE_DIR", "rehearsal-cache"),
  /** Where lure and offline-greeting clips in the session voice are cached (gitignored); "none" uses only the bundled ones. */
  clipCacheDir: str("CLIP_CACHE_DIR", "clip-cache"),
  port: num("PORT", 8787),
  /** Turns on the phone remote: the server listens on the LAN and asks other devices for this PIN. */
  remotePin,
  /** ntfy.sh topic for push alerts to the owner's phone; empty: no pushes. */
  ntfyTopic: process.env.NTFY_TOPIC?.trim() ?? "",
  ntfyServer: str("NTFY_SERVER", "https://ntfy.sh"),
  /** Access token for a protected topic or a self-hosted ntfy server (optional). */
  ntfyToken: process.env.NTFY_TOKEN?.trim() ?? "",
  /** Night recap push: at this local time (minutes after midnight), or null for no clock trigger. */
  recapAt: parseRecapAt(process.env.RECAP_AT),
  /** ...and when the kill switch has been on this many minutes (null: "off" or 0). */
  recapSleepMinutes: recapSleepMinutes(process.env.RECAP_SLEEP_MINUTES),
  /** How the phone reaches this server (e.g. http://192.168.1.5:8787), for the recap link; else guessed. */
  remoteUrl: process.env.REMOTE_URL?.trim() ?? "",
  production: process.env.NODE_ENV === "production",
};

export type Config = typeof config;
