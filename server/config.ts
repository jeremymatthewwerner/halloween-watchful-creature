import "dotenv/config";
import type { BodyMode, EngineKind } from "../shared/types.ts";

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
  /** Save the camera frame of each greeting in the day's log. */
  logSnapshots: str("LOG_SNAPSHOTS", "true") !== "false",
  port: num("PORT", 8787),
  production: process.env.NODE_ENV === "production",
};

export type Config = typeof config;
