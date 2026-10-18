/** A voice engine connects the creature to an OpenAI speech-to-speech model. */
import type { EveningMemory } from "../evening.ts";
import type { SpookyLevel } from "../spookiness.ts";

export type EngineStatus = "closed" | "connecting" | "open" | "closing";

export type GreetReason = "arrived" | "grew" | "returned" | "manual";

/**
 * What kind of greeting the creature was just asked to say: hello to new visitors, a remark on a
 * costume change, or a welcome back to the same visitors. Drives the eyes' flourish.
 */
export type GreetingKind = "visitors" | "costume" | "welcome-back";

export type EngineEvent =
  | { type: "status"; status: EngineStatus; detail?: string }
  /** The creature was just asked to greet someone (fires once, at the greeting's first line). */
  | { type: "greeting"; kind: GreetingKind }
  | { type: "transcript"; who: "visitor" | "creature"; delta: string }
  | { type: "note"; text: string }
  | { type: "usage"; voiceSeconds?: number; tokens?: number }
  | { type: "error"; message: string };

export interface GreetOptions {
  /** For "returned": how long they were away. */
  awayMs?: number;
  /**
   * The session connecting (resolves true once open). The engine can start looking meanwhile,
   * but only speaks once it resolves true; false means it couldn't connect, so skip the greeting.
   */
  ready?: Promise<boolean>;
}

export interface Engine {
  readonly kind: "live" | "realtime";
  readonly status: EngineStatus;
  /** Remote voice audio (for playback and the loudness meter). */
  readonly remoteStream: MediaStream | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Make the creature greet whoever is in this frame. */
  greet(image: string | null, reason: GreetReason, opts?: GreetOptions): Promise<void>;
  /** Silently update what the creature can see. */
  observe(image: string): Promise<void>;
  /** Someone reappeared after a short gap: check whether they're someone new, and greet them if so. */
  recheck(image: string): Promise<void>;
  /** Operator puppeteering: have the creature say this line, in character. */
  say(text: string): void;
  /**
   * Operator modes: standing instructions kept until changed. `standing` ("" for none) is re-sent
   * to every new voice session; `change`, if given, is sent now to an open session.
   */
  setStanding(standing: string, change?: string): void;
  setMicEnabled(enabled: boolean): void;
  /** True while waiting on vision or a model response. */
  isThinking(): boolean;
  /** Last time the visitor's speech was heard (ms timestamp). */
  lastHeardAt(): number;
  on(listener: (event: EngineEvent) => void): () => void;
}

export interface EngineDeps {
  mic: MediaStream;
  character: string;
  /** Grab the current camera frame as a JPEG data URL (null if no camera). */
  capture(): string | null;
  /** Recent conversation for vision context. */
  recentTranscript(): string;
  /** When the creature's voice was last audible (performance.now() ms). */
  lastVoiceAt(): number;
  /** What it said and saw earlier tonight, kept across sessions (optional). */
  evening?: EveningMemory;
  /** The operator's spookiness dial right now, 0 (gentle) to 3 (scary, for teens). Flavors greetings. */
  spookiness?(): SpookyLevel;
  /** The voice picked on the dashboard, read as each session starts (null: the server's default). */
  voice?: () => string | null;
  /** True while rehearsal mode feeds sample images instead of the camera (optional). */
  rehearsal?(): boolean;
}
