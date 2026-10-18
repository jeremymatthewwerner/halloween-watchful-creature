/** Types shared by the server and the browser client. */

export type EngineKind = "live" | "realtime";

/** What the creature is doing; drives the eyes, jaw and relay. */
export type BodyState = "sleeping" | "idle" | "listening" | "thinking" | "speaking";

export const BODY_STATES: readonly BodyState[] = ["sleeping", "idle", "listening", "thinking", "speaking"];

export type BodyMode = "eyes" | "jaw" | "relay";

/**
 * One-shot eye animations played over the current state, then back to normal:
 * a rainbow burst for a greeting, a quick double-blink gasp, a slow thoughtful blink.
 */
export type EyeFlourish = "sparkle" | "gasp" | "slowblink";

export const EYE_FLOURISHES: readonly EyeFlourish[] = ["sparkle", "gasp", "slowblink"];

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
  /** Whether greeting photos are saved (SNAPSHOTS) and kept how many days (0: until deleted); null when disk logging is off. */
  snapshots: { enabled: boolean; retentionDays: number } | null;
  /** The voice fallbacks under the dashboard's pick: VOICE in .env (null if unset), then the character's default. */
  voice: { env: string | null; character: string };
}

/** Messages from the browser to the server over /ws/body. */
export type BodyMessage =
  | { type: "state"; state: BodyState }
  | { type: "level"; level: number }
  | { type: "flourish"; effect: EyeFlourish }
  | { type: "palette"; eyes: EyePalette; eyeStyle: CharacterInfo["eyeStyle"] };

/** Why the client is asking the vision backend to look. */
export type LookReason = "arrived" | "grew" | "returned" | "background" | "recheck" | "delegation" | "manual";

export interface VisionRequest {
  image: string; // data URL
  reason: LookReason;
  /** Recent conversation transcript, oldest first. */
  transcript?: string;
  /** For "returned", "background" and "recheck": how the last greeted visitors were described, to decide same vs new. */
  previous?: string;
  /** The frame those visitors were greeted from (data URL), so the comparison can use both photos. */
  previousImage?: string;
  /** From rehearsal mode (a sample image, not the real camera): logged as such, and no snapshot is saved. */
  rehearsal?: boolean;
}

export interface VisionResult {
  text: string;
  /** With `previous`: false only for new visitors; missing if the vision model gave no verdict. */
  sameGroup?: boolean;
  /**
   * With `previous`: the vision model's verdict. CHANGED (only from "background" and "recheck") means the
   * same people with a clearly different costume piece, such as a new hat or mask.
   */
  verdict?: "SAME" | "NEW" | "CHANGED";
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
  lines: {
    who: "visitor" | "creature" | "system";
    text: string;
    /** Epoch milliseconds. */
    at: number;
    /** Said during rehearsal mode: marked as such in the log and left out of the costume gallery. */
    rehearsal?: boolean;
  }[];
}

/** POST /api/snapshots/delete-all needs this body, so a stray request can't wipe the photos. */
export interface DeleteSnapshotsRequest {
  confirm: true;
}

/** What "Delete all snapshots now" removed. */
export interface DeleteSnapshotsResult {
  /** Day folders that had photos, oldest first. */
  days: string[];
  files: number;
}

/** Rehearsal mode: a made-up group of trick-or-treaters for one generated image. */
export interface VisitorScenario {
  /** How many people are in the picture (1–4): the rehearsal's simulated detection count. */
  groupSize: number;
  /** One costume id per person (see COSTUMES in server/rehearsalGen.ts). */
  costumes: string[];
  lighting: "bright" | "dim" | "backlit" | "lantern";
  style: "animated" | "storybook" | "clay";
}

/** A generated rehearsal visitor image cached on disk, with the scenario it was drawn from. */
export interface GeneratedVisitor extends VisitorScenario {
  id: string;
  /** ISO time it was generated. */
  createdAt: string;
  /** Human-readable costume names, one per person. */
  costumeLabels: string[];
  model: string;
  quality: string;
  size: string;
  /** What it cost in US dollars: from the API's reported token usage, or the estimate if it reported none. */
  costUsd: number;
  costEstimated: boolean;
}

export interface GeneratedVisitorList {
  items: GeneratedVisitor[];
  /** Estimated cost of generating one more image, and how it'd be made. */
  estimate: { perImageUsd: number; model: string; quality: string; size: string };
  hasApiKey: boolean;
  /** Most images one generate request may ask for. */
  maxPerRequest: number;
}

export interface GenerateVisitorsRequest {
  /** How many images (1 to maxPerRequest); default 1. */
  count?: number;
  /** Fix the group size (1–4) instead of picking one at random. */
  groupSize?: number;
  /** Fix the costumes (known costume ids); their number sets the group size. */
  costumes?: string[];
  lighting?: VisitorScenario["lighting"];
}

export interface GenerateVisitorsResult {
  items: GeneratedVisitor[];
  /** Images that failed (e.g. the API refused a prompt); the rest are still returned. */
  errors: string[];
}
