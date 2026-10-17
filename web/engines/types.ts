/** A voice engine connects the creature to an OpenAI speech-to-speech model. */

export type EngineStatus = "closed" | "connecting" | "open" | "closing";

export type GreetReason = "arrived" | "grew" | "returned" | "manual";

export type EngineEvent =
  | { type: "status"; status: EngineStatus; detail?: string }
  | { type: "transcript"; who: "visitor" | "creature"; delta: string }
  | { type: "note"; text: string }
  | { type: "usage"; voiceSeconds?: number; tokens?: number }
  | { type: "error"; message: string };

export interface Engine {
  readonly kind: "live" | "realtime";
  readonly status: EngineStatus;
  /** Remote voice audio (for playback and the loudness meter). */
  readonly remoteStream: MediaStream | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Make the creature greet whoever is in this frame. */
  greet(image: string | null, reason: GreetReason): Promise<void>;
  /** Silently update what the creature can see. */
  observe(image: string): Promise<void>;
  /** Operator puppeteering: have the creature say this line, in character. */
  say(text: string): void;
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
}
