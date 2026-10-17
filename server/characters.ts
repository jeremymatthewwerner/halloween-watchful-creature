import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BODY_STATES, type CharacterInfo, type EngineKind, type EyePalette, type Rgb } from "../shared/types.ts";

const PROMPTS_DIR = resolve(import.meta.dirname, "..", "prompts");
const CHARACTERS_DIR = join(PROMPTS_DIR, "characters");

export interface Character extends CharacterInfo {
  realtimeVoice: string;
  /** Character-specific prompt (markdown body of the character file). */
  persona: string;
}

/** Parses the flat `key: value` frontmatter used by character files. */
export function parseCharacterFile(id: string, source: string): Character {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Character "${id}" is missing its --- frontmatter block`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  const need = (key: string): string => {
    const value = fields[key];
    if (!value) throw new Error(`Character "${id}" is missing "${key}"`);
    return value;
  };
  const eyes = Object.fromEntries(BODY_STATES.map((s) => [s, parseHex(id, need(`eyes_${s}`))])) as EyePalette;
  const eyeStyle = fields.eye_style ?? "glow";
  if (eyeStyle !== "flicker" && eyeStyle !== "glow" && eyeStyle !== "blink") {
    throw new Error(`Character "${id}" has unknown eye_style "${eyeStyle}"`);
  }
  return {
    id,
    name: need("name"),
    voice: need("voice"),
    realtimeVoice: fields.realtime_voice ?? "marin",
    eyes,
    eyeStyle,
    persona: match[2]!.trim(),
  };
}

function parseHex(id: string, hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Character "${id}" has invalid color "${hex}"`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

export function listCharacterIds(): string[] {
  return readdirSync(CHARACTERS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function loadCharacter(id: string): Character {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`Invalid character id "${id}"`);
  return parseCharacterFile(id, readFileSync(join(CHARACTERS_DIR, `${id}.md`), "utf8"));
}

export function publicInfo(c: Character): CharacterInfo {
  return { id: c.id, name: c.name, voice: c.voice, eyes: c.eyes, eyeStyle: c.eyeStyle };
}

const SENSES: Record<EngineKind, string> = {
  live: `# How your senses work

- You can't see continuously. Your eyes send you short notes that start with "[CAMERA]". They describe what's in front of you right now. Treat them as your own eyesight: talk as if you're looking ("Ooh, I see a..."). Never mention notes or cameras.
- When a [CAMERA] note says visitors just walked up, greet them immediately and compliment the costumes it describes.
- If someone asks you to look at them, asks what you think of their costume, or holds something up, and you have no fresh [CAMERA] note about it, ask your backend for a fresh look. Say something playful while you wait, like "Hold still, let me get a good look!"
- Camera notes can be wrong, especially in the dark. If a visitor corrects you, believe them happily ("Of course! A ninja turtle, how did I miss it?").
- If nobody is there, stay quiet.`,
  realtime: `# How your senses work

- You see through images from your camera. When an image arrives with a note that visitors just walked up, greet them immediately and compliment the costumes you see.
- If someone asks you to look at them, asks about their costume, or holds something up, call the "look" tool to get a fresh image.
- Talk as if you're looking with your own eyes. Never mention images, cameras or tools.
- If a visitor corrects you about their costume, believe them happily.
- If nobody is there, stay quiet.`,
};

/** Full voice-model instructions for a character and engine. */
export function buildInstructions(c: Character, engine: EngineKind): string {
  const base = readFileSync(join(PROMPTS_DIR, "base.md"), "utf8").trim();
  return [base, c.persona, SENSES[engine]].join("\n\n");
}
