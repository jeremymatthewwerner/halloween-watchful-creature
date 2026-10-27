/**
 * The voices each engine can use, shared by the server (the allowlist for /api/session) and the
 * dashboard's voice picker. The facts come from OpenAI's docs, checked on 2026-10-18; the docs
 * don't describe tone, so neither do we. "Our notes" are from trying voices on the porch.
 */
import type { EngineKind } from "./types.ts";

export interface VoiceInfo {
  /** The API name sent as audio.output.voice. */
  id: string;
  /** From OpenAI's docs (GPT-Live's voice table). */
  language?: string;
  region?: string;
  presentation?: "feminine" | "masculine";
  source?: "generated" | "natural";
  /** Anything else OpenAI's docs say about this voice. */
  docsNote?: string;
  /** Our own notes from testing (2026-10-17/18). */
  ourNotes?: string;
}

export interface VoiceCatalog {
  engine: EngineKind;
  /** The docs page the facts come from. */
  docsUrl: string;
  docsSection: string;
  /** When we last checked the docs. */
  checked: string;
  voices: readonly VoiceInfo[];
}

const live = (
  id: string,
  language: string,
  region: string | undefined,
  presentation: VoiceInfo["presentation"],
  source: VoiceInfo["source"],
  ourNotes?: string,
): VoiceInfo => ({ id, language, region, presentation, source, ourNotes });

export const LIVE_VOICES: VoiceCatalog = {
  engine: "live",
  docsUrl: "https://developers.openai.com/api/docs/guides/live-conversations",
  docsSection: "Choose a voice",
  checked: "2026-10-18",
  voices: [
    { id: "marin", docsNote: "GPT-Live's default voice. The docs' voice table doesn't describe it." },
    live("quartz", "English", "Australian", "feminine", "generated"),
    live("ripple", "English", "Australian", "masculine", "natural", '"Fine, probably." The one in use as of Oct 18.'),
    live("vesper", "English", "British", "masculine", "natural", "Tried."),
    live("willow", "English", "Irish", "feminine", "natural"),
    live("stone", "English", "Irish", "masculine", "natural", "Sounds Irish."),
    live("gleam", "English", "North American", "feminine", "natural", "Tried."),
    live("meridian", "English", "North American", "masculine", "natural", "Tried: felt flat."),
    live("beacon", "English", "Filipino", "masculine", "generated"),
    live("delta", "English", "Southern U.S.", "feminine", "generated"),
    live("cinder", "English", "Southern U.S.", "masculine", "generated", '"That voice was bad."'),
    live("bossa", "Portuguese", "Brazilian", "feminine", "natural"),
    live("tempo", "Portuguese", "Brazilian", "masculine", "natural"),
    live("nuri", "German", undefined, "feminine", "natural"),
    live("juni", "German", undefined, "feminine", "natural"),
    live("flitz", "German", undefined, "masculine", "natural"),
    live("brise", "French", undefined, "feminine", "natural"),
    live(
      "sillage",
      "French",
      undefined,
      "masculine",
      "natural",
      "Native French: the only one that gave a real French accent (the pumpkin no longer speaks French).",
    ),
    live("nira", "Hindi", undefined, "feminine", "natural"),
    live("harema", "Japanese", undefined, "feminine", "natural"),
    live("shida", "Japanese", undefined, "masculine", "natural"),
    live("noeul", "Korean", undefined, "feminine", "natural"),
  ],
};

const RECOMMENDED = "OpenAI recommends marin or cedar for best quality.";

export const REALTIME_VOICES: VoiceCatalog = {
  engine: "realtime",
  docsUrl: "https://developers.openai.com/api/docs/guides/realtime-conversations",
  docsSection: "Voice options",
  checked: "2026-10-18",
  voices: [
    { id: "marin", docsNote: RECOMMENDED },
    { id: "cedar", docsNote: RECOMMENDED },
    ...["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].map((id) => ({ id })),
  ],
};

export function voiceCatalog(engine: EngineKind): VoiceCatalog {
  return engine === "live" ? LIVE_VOICES : REALTIME_VOICES;
}

/** Whether `id` is a voice this engine can use: the allowlist for voices picked on the dashboard. */
export function isKnownVoice(engine: EngineKind, id: unknown): id is string {
  return typeof id === "string" && voiceCatalog(engine).voices.some((v) => v.id === id);
}

export function findVoice(engine: EngineKind, id: string): VoiceInfo | undefined {
  return voiceCatalog(engine).voices.find((v) => v.id === id);
}

/** What OpenAI's docs say about a voice, in one line (empty if they say nothing). */
export function docsBlurb(voice: VoiceInfo): string {
  const facts: string[] = [];
  if (voice.language) facts.push(voice.region ? `${voice.language} (${voice.region} influence)` : voice.language);
  if (voice.presentation) facts.push(voice.presentation);
  if (voice.source) facts.push(`${voice.source} source`);
  return [facts.join(", "), voice.docsNote].filter(Boolean).join(". ");
}

/**
 * English voices first (they suit our characters), then voices the docs give no language for,
 * then the other languages, keeping the docs' order within each group.
 */
export function groupVoices(catalog: VoiceCatalog): { english: VoiceInfo[]; undescribed: VoiceInfo[]; other: VoiceInfo[] } {
  const english = catalog.voices.filter((v) => v.language === "English");
  const undescribed = catalog.voices.filter((v) => !v.language);
  const other = catalog.voices.filter((v) => v.language && v.language !== "English");
  return { english, undescribed, other };
}

/** Where the voice in effect comes from: picked on the dashboard, VOICE in .env, or the character file. */
export type VoiceSource = "dashboard" | "env" | "character";

export interface VoiceChoice {
  voice: string;
  source: VoiceSource;
}

/**
 * Picks the voice for a session. Precedence: the dashboard's pick (only if it's a known voice for
 * this engine) > VOICE in .env > the character's default.
 */
export function resolveVoice(
  engine: EngineKind,
  opts: { picked?: unknown; env?: string | null; character: string },
): VoiceChoice {
  if (isKnownVoice(engine, opts.picked)) return { voice: opts.picked, source: "dashboard" };
  const env = opts.env?.trim();
  if (env) return { voice: env, source: "env" };
  return { voice: opts.character, source: "character" };
}

export function describeSource(source: VoiceSource, characterName: string): string {
  switch (source) {
    case "dashboard":
      return "picked here on the dashboard";
    case "env":
      return "VOICE in .env";
    case "character":
      return `${characterName}'s default`;
  }
}

// --- text-to-speech (the recorded lure and offline clips) -------------------------------------------

/**
 * The voices gpt-4o-mini-tts takes, from OpenAI's text-to-speech guide (checked 2026-10-18). The
 * docs recommend marin or cedar for best quality and don't describe the voices. Of GPT-Live's
 * voices only marin is here; every gpt-realtime voice is.
 */
export const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];
export const TTS_DOCS_URL = "https://developers.openai.com/api/docs/guides/text-to-speech";

export interface TtsRendition {
  /** The TTS voice that reads the clips. */
  voice: TtsVoice;
  /** An accent asked for in the TTS instructions ("Australian"), or null for plain American English. */
  accent: string | null;
  /** True when the session voice is itself a TTS voice. */
  exact: boolean;
}

export const isTtsVoice = (id: unknown): id is TtsVoice => typeof id === "string" && (TTS_VOICES as readonly string[]).includes(id);

/**
 * The closest TTS reading of a session voice, for the recorded clips. A voice TTS also has is used
 * as is. A GPT-Live-only voice gets one of OpenAI's two recommended TTS voices by presentation
 * (masculine: cedar, feminine: marin; the TTS docs don't describe voices, so that pairing is by ear)
 * plus its accent in the TTS instructions, which gpt-4o-mini-tts follows: the region for English
 * voices ("North American" is the plain default, so no accent), the language for the others.
 * Null when we know nothing about the voice (a VOICE in .env that isn't on the list, say).
 */
export function ttsVoiceFor(engine: EngineKind, id: string): TtsRendition | null {
  if (isTtsVoice(id)) return { voice: id, accent: null, exact: true };
  const info = findVoice(engine, id);
  if (!info?.presentation) return null;
  const accent = info.language === "English" ? (info.region && info.region !== "North American" ? info.region : null) : (info.language ?? null);
  return { voice: info.presentation === "feminine" ? "marin" : "cedar", accent, exact: false };
}

/** A folder-safe name for a rendition: "cedar", "cedar-australian", "marin-southern-u-s". */
export function renditionKey(r: Pick<TtsRendition, "voice" | "accent">): string {
  const accent = r.accent
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return accent ? `${r.voice}-${accent}` : r.voice;
}

/** "cedar", or "cedar with a light Australian accent". */
export function describeRendition(r: Pick<TtsRendition, "voice" | "accent">): string {
  return r.accent ? `${r.voice} with a light ${r.accent} accent` : r.voice;
}
