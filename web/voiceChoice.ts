/** The dashboard's voice pick: remembered per engine, and what the voice picker shows. No DOM here. */
import type { ClientConfig, EngineKind } from "../shared/types.ts";
import { describeSource, isKnownVoice, resolveVoice, type VoiceChoice } from "../shared/voices.ts";
import type { StorageLike } from "./evening.ts";

export const voiceKey = (engine: EngineKind) => `creature.voice.${engine}`;

/** The saved pick for this engine, or null if there's none (or it isn't a voice this engine knows). */
export function loadPickedVoice(storage: StorageLike | null, engine: EngineKind): string | null {
  try {
    const id = storage?.getItem(voiceKey(engine)) ?? null;
    return isKnownVoice(engine, id) ? id : null;
  } catch {
    return null;
  }
}

/** Saves a pick; null goes back to the default (VOICE in .env, else the character's). */
export function savePickedVoice(storage: StorageLike | null, engine: EngineKind, id: string | null): void {
  try {
    storage?.setItem(voiceKey(engine), id && isKnownVoice(engine, id) ? id : "");
  } catch {
    /* private mode: the pick just won't persist */
  }
}

/** The first part of a character's name ("Jacques O'Lantern, Pumpkin Critic" → "Jacques O'Lantern"). */
export function shortName(name: string): string {
  return name.split(",")[0]!.trim() || name;
}

export interface VoiceStatus {
  /** What the next voice session will use, and why. */
  effective: VoiceChoice;
  /** "ripple, VOICE in .env" */
  summary: string;
  /** What "use default" falls back to. */
  fallback: VoiceChoice;
  /** The voice of the session running now (null if none). */
  sessionVoice: string | null;
  /** A session is running with a different voice than the one in effect: offer a restart. */
  restartNeeded: boolean;
  /** When the choice applies, in plain words. */
  applies: string;
  /** VOICE in .env names a voice that isn't in this engine's list. */
  envUnknown: boolean;
}

export function voiceStatus(cfg: Pick<ClientConfig, "engine" | "voice" | "character">, picked: string | null, sessionVoice: string | null): VoiceStatus {
  const effective = resolveVoice(cfg.engine, { picked, env: cfg.voice.env, character: cfg.voice.character });
  const fallback = resolveVoice(cfg.engine, { env: cfg.voice.env, character: cfg.voice.character });
  const name = shortName(cfg.character.name);
  const restartNeeded = sessionVoice !== null && sessionVoice !== effective.voice;
  const applies = restartNeeded
    ? `Talking with ${sessionVoice} right now; ${effective.voice} starts with the next voice session.`
    : sessionVoice
      ? `This voice session is using ${sessionVoice}. A new pick starts with the next voice session.`
      : "A new pick starts with the next voice session.";
  return {
    effective,
    summary: `${effective.voice}, ${describeSource(effective.source, name)}`,
    fallback,
    sessionVoice,
    restartNeeded,
    applies,
    envUnknown: Boolean(cfg.voice.env) && !isKnownVoice(cfg.engine, cfg.voice.env),
  };
}

/** Labels shown next to a voice in the list. */
export function voiceTags(cfg: Pick<ClientConfig, "voice" | "character">, status: VoiceStatus, id: string): string[] {
  const tags: string[] = [];
  if (status.effective.voice === id) tags.push("current");
  if (status.restartNeeded && status.sessionVoice === id) tags.push("this session");
  if (cfg.voice.env === id) tags.push("VOICE in .env");
  if (cfg.voice.character === id) tags.push(`${shortName(cfg.character.name)}'s default`);
  return tags;
}
