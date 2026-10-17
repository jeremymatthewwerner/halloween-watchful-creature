/** Types shared by the server and the browser client. */

export type EngineKind = "live" | "realtime";

/** What the creature is doing; drives the eyes, jaw and relay. */
export type BodyState = "sleeping" | "idle" | "listening" | "thinking" | "speaking";

export const BODY_STATES: readonly BodyState[] = ["sleeping", "idle", "listening", "thinking", "speaking"];

export type BodyMode = "eyes" | "jaw" | "relay";

export type Rgb = [number, number, number];

export type EyePalette = Record<BodyState, Rgb>;

/** Public character info the browser needs (the prompt itself stays on the server). */
export interface CharacterInfo {
  id: string;
  name: string;
  voice: string;
  eyes: EyePalette;
  /** Idle eye animation style. */
  eyeStyle: "flicker" | "glow" | "blink";
}

export interface ClientConfig {
  engine: EngineKind;
  character: CharacterInfo;
  characters: { id: string; name: string }[];
  idleCloseSeconds: number;
  backgroundFrameSeconds: number;
  liveCostPerMinute: number;
  /** Safety cap: the creature goes to sleep after this many awake minutes in a day. */
  maxVoiceMinutesPerDay: number;
  hasApiKey: boolean;
  /** Today's on-disk log (log.html), or null when disk logging is off. */
  sessionLogUrl: string | null;
}

/** Messages from the browser to the server over /ws/body. */
export type BodyMessage =
  | { type: "state"; state: BodyState }
  | { type: "level"; level: number }
  | { type: "palette"; eyes: EyePalette; eyeStyle: CharacterInfo["eyeStyle"] };

/** Why the client is asking the vision backend to look. */
export type LookReason = "arrived" | "grew" | "returned" | "background" | "delegation" | "manual";

export interface VisionRequest {
  image: string; // data URL
  reason: LookReason;
  /** Recent conversation transcript, oldest first. */
  transcript?: string;
  /** For "returned": how the previous visitors were described, to decide same vs new. */
  previous?: string;
}

export interface VisionResult {
  text: string;
  /** For "returned" with `previous`: true only if clearly the same visitors. */
  sameGroup?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/** One line of server console output, streamed to the dashboard's server log. */
export interface ServerLogEntry {
  /** Identifies the server process, so the dashboard can tell when it restarted. */
  boot: string;
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  level: "info" | "warn" | "error";
  text: string;
}

/** Finished Conversation-panel lines the dashboard sends for the on-disk log. */
export interface ConversationLogRequest {
  lines: { who: "visitor" | "creature" | "system"; text: string; /** Epoch milliseconds. */ at: number }[];
}
