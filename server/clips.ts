/**
 * Recorded clips, read by OpenAI text-to-speech: lure call-outs for people walking by, and greetings
 * for when the live voice can't start. Used two ways:
 *  - scripts/make-lure-clips.ts makes the bundled sets (web/public/<kind>/<character>/, committed),
 *    so the prop has clips even with no key, no network and no cache;
 *  - the server makes a set per session voice on demand (POST /api/clips), cached on disk
 *    (CLIP_CACHE_DIR, gitignored), so the clips sound like the voice the operator picked.
 * Clips whose text, voice and instructions haven't changed are kept, so re-running only pays for
 * new or edited lines. A full set (about 30 short lines) costs a cent or two.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLIP_KINDS, type ClipKind, type ClipManifest, type EngineKind, type VoiceClipsResult } from "../shared/types.ts";
import { describeRendition, renditionKey, ttsVoiceFor, type TtsRendition } from "../shared/voices.ts";

export const TTS_MODEL = "gpt-4o-mini-tts";

/** The voice the bundled sets are read in (the pumpkin is feminine; the server matches the session voice). */
export const BUNDLED_VOICE = "marin";

interface CharacterClips {
  /** How to perform each kind (gpt-4o-mini-tts follows these); the accent line is added after. */
  perform: Record<ClipKind, string>;
  lines: Record<ClipKind, string[]>;
}

const JACQUELINE =
  "You are Jacqueline O'Lantern, a big, bouncy, friendly talking pumpkin, like a favorite children's TV host. ";

// Kid-friendly, short, plain words; no French, no chef talk (see prompts/characters/). The greetings
// can't see the costume, so they praise it without naming it, and work for one visitor or a group.
export const CLIP_LINES: Record<string, CharacterClips> = {
  pumpkin: {
    perform: {
      lure:
        JACQUELINE +
        "Call out playfully to a kid across the yard: warm, excited, a little sneaky on 'psst', smiling the whole time. Never scary.",
      greeting:
        JACQUELINE +
        "Greet trick-or-treaters who just walked up to the porch: delighted, warm and bursting with excitement, smiling the whole time. Never scary.",
    },
    lines: {
      lure: [
        "Psst! Over here! Come get your costume reviewed!",
        "Ooh, is that a costume I see? Come closer!",
        "Hey there! Yes, you! The talking pumpkin wants to see your costume!",
        "Trick or treaters! Come show me your costume!",
        "Wowza! I spy a costume! Come on over!",
        "Over here! It's me, the pumpkin! Come say hi!",
        "Psst! I'm a pumpkin costume judge, and I'd love to see yours!",
        "Great gourds, is that a costume? Come closer so I can see!",
        "Hello out there! Bring that costume over here!",
        "Yoo-hoo! Spooky friends! Come visit the pumpkin!",
        "Don't be shy! I'm a friendly pumpkin! Come on up!",
        "Jumping jack-o'-lanterns! I think I see a costume! Come here!",
        "Ahem! The costume judge is open! Come on up to the porch!",
        "Hey, you with the awesome costume! Come closer!",
      ],
      greeting: [
        "Happy Halloween! Ooh, what a great costume!",
        "Well, hello there! Wow, look at you! Happy Halloween!",
        "Trick or treat! Ooh, I love that costume!",
        "Great gourds! What an amazing costume! Happy Halloween!",
        "Hello, hello! The pumpkin judge says: gold medal costume!",
        "Wowza! That costume gets three thumbs up, and I don't even have thumbs!",
        "Happy Halloween! You look fantastic tonight!",
        "Ooh! A costume this good deserves a big round of applause!",
        "Jumping jack-o'-lanterns! What a spectacular costume!",
        "Hi there! I'm Jacqueline the pumpkin, and I love your costume!",
        "Look who's here! Happy Halloween! What a super cool costume!",
        "Hooray, trick-or-treaters! Happy Halloween!",
        "Oh my gourd! That is one terrific costume!",
        "Happy Halloween! Thanks for visiting the pumpkin! Enjoy your treats!",
        "Ten out of ten! That costume is a real treat! Happy Halloween!",
        "Whoa, fancy! I can tell you worked hard on that costume! Happy Halloween!",
      ],
    },
  },
};

/** The TTS instructions for a kind of clip, read by a rendition (with its accent, if any). */
export function clipInstructions(character: CharacterClips, kind: ClipKind, accent: string | null): string {
  const voice = accent ? `Speak English with a light, friendly ${accent} accent.` : "Plain American English, no accent.";
  return `${character.perform[kind]} ${voice}`;
}

/** Reads one line aloud; returns MP3 bytes. */
export type Speak = (voice: string, instructions: string, text: string) => Promise<Buffer>;

/** OpenAI's /audio/speech, with a timeout so a hung request doesn't hold the set up forever. */
export function openaiSpeaker(opts: { apiKey: string; apiBase?: string; timeoutMs?: number }): Speak {
  const base = (opts.apiBase ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return async (voice, instructions, text) => {
    const res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice, input: text, instructions, response_format: "mp3" }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

export interface MakeClipSetOptions {
  dir: string;
  voice: string;
  instructions: string;
  lines: readonly string[];
  speak: Speak;
  /** Redo every clip, even unchanged ones. */
  force?: boolean;
  /** How many TTS requests at once. */
  concurrency?: number;
  log?: (text: string) => void;
}

/**
 * Writes `lines` as 01.mp3, 02.mp3… plus manifest.json into `dir`, keeping clips that are already
 * there with the same text, voice and instructions. Throws if any line fails (the ones that worked
 * are kept, so a retry only redoes the rest).
 */
export async function makeClipSet(opts: MakeClipSetOptions): Promise<{ manifest: ClipManifest; made: number; characters: number }> {
  mkdirSync(opts.dir, { recursive: true });
  const manifestPath = join(opts.dir, "manifest.json");
  const old = readManifest(manifestPath);
  // Older manifests didn't record instructions: same voice and text counts as unchanged.
  const sameVoice = old?.model === TTS_MODEL && old.voice === opts.voice && (old.instructions === undefined || old.instructions === opts.instructions);
  const clips = opts.lines.map((text, i) => ({ file: `${String(i + 1).padStart(2, "0")}.mp3`, text }));
  const todo = clips.filter(
    (clip) => opts.force || !sameVoice || !old?.clips.some((c) => c.file === clip.file && c.text === clip.text) || !existsSync(join(opts.dir, clip.file)),
  );
  const done = new Set(clips.filter((c) => !todo.includes(c)).map((c) => c.file));
  const errors: string[] = [];
  let made = 0;
  let characters = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let clip = queue.shift(); clip; clip = queue.shift()) {
      try {
        opts.log?.(`🎙️  ${clip.file}: ${clip.text}`);
        writeFileSync(join(opts.dir, clip.file), await opts.speak(opts.voice, opts.instructions, clip.text));
        done.add(clip.file);
        made++;
        characters += clip.text.length;
      } catch (err) {
        errors.push(`${clip.file}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, todo.length)) }, worker));
  // The manifest only lists clips that exist in this voice, so a half-made set is never mistaken for a full one.
  const manifest: ClipManifest = { model: TTS_MODEL, voice: opts.voice, instructions: opts.instructions, clips: clips.filter((c) => done.has(c.file)) };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (errors.length) throw new Error(`${errors.length} of ${clips.length} clips failed (${errors[0]})`);
  return { manifest, made, characters };
}

function readManifest(path: string): ClipManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ClipManifest;
  } catch {
    return null;
  }
}

export const CLIP_FILE = /^\d{2}\.mp3$/;
const SAFE = /^[a-z0-9-]{1,64}$/;

export interface VoiceClipsOptions {
  /** Where the per-voice sets go (gitignored). */
  dir: string;
  engine: EngineKind;
  /** Null without an API key: cached sets are still served, nothing new is made. */
  speak: Speak | null;
  log?: (text: string) => void;
}

/**
 * The per-voice clip sets the server makes on demand: <dir>/<character>/<rendition>/<kind>/.
 * One generation per set at a time; a second request for the same set waits for the first.
 */
export class VoiceClips {
  private readonly busy = new Map<string, Promise<VoiceClipsResult>>();

  constructor(private readonly opts: VoiceClipsOptions) {}

  /**
   * The character's clips in `voice` (made now if they aren't cached). Throws with a plain reason
   * when that isn't possible; the dashboard then keeps the bundled clips.
   */
  ensure(character: string, voice: string): Promise<VoiceClipsResult> {
    const lines = CLIP_LINES[character];
    if (!lines || !SAFE.test(character)) return Promise.reject(new Error(`no clip lines for "${character}"`));
    const rendition = ttsVoiceFor(this.opts.engine, voice);
    if (!rendition) return Promise.reject(new Error(`no text-to-speech voice is close to "${voice}"`));
    const key = `${character}/${renditionKey(rendition)}`;
    let job = this.busy.get(key);
    if (!job) {
      job = this.make(character, voice, rendition, lines).finally(() => this.busy.delete(key));
      this.busy.set(key, job);
    }
    return job;
  }

  /** One cached MP3, or null. */
  async file(character: string, rendition: string, kind: string, file: string) {
    if (!SAFE.test(character) || !SAFE.test(rendition) || !(CLIP_KINDS as readonly string[]).includes(kind) || !CLIP_FILE.test(file)) return null;
    return readFile(join(resolve(this.opts.dir), character, rendition, kind, file)).catch(() => null);
  }

  private async make(character: string, voice: string, rendition: TtsRendition, lines: CharacterClips): Promise<VoiceClipsResult> {
    const key = renditionKey(rendition);
    const result: VoiceClipsResult = { voice, rendition: describeRendition(rendition), exact: rendition.exact, sets: {}, generated: 0 };
    for (const kind of CLIP_KINDS) {
      const want = lines.lines[kind];
      if (!want.length) continue;
      const dir = join(this.opts.dir, character, key, kind);
      const instructions = clipInstructions(lines, kind, rendition.accent);
      const cached = readManifest(join(dir, "manifest.json"));
      const complete =
        cached?.model === TTS_MODEL &&
        cached.voice === rendition.voice &&
        cached.instructions === instructions &&
        want.every((text, i) => cached.clips[i]?.text === text && existsSync(join(dir, cached.clips[i]!.file)));
      let manifest = complete ? cached : null;
      if (!manifest) {
        if (!this.opts.speak) throw new Error("OPENAI_API_KEY isn't set, and these clips aren't cached yet");
        this.opts.log?.(`[clips] making ${character}'s ${kind} clips in ${result.rendition} (for ${voice})`);
        const made = await makeClipSet({ dir, voice: rendition.voice, instructions, lines: want, speak: this.opts.speak });
        manifest = made.manifest;
        result.generated += made.made;
      }
      result.sets[kind] = { base: `/api/clips/${character}/${key}/${kind}/`, clips: manifest.clips };
    }
    if (result.generated) this.opts.log?.(`[clips] ${result.generated} clips made for ${voice} (${result.rendition}), cached in ${join(this.opts.dir, character, key)}`);
    return result;
  }
}
