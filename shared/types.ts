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
}

export interface VisionResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}
