/**
 * One-time generator for lure-mode call-outs: `npx tsx scripts/make-lure-clips.ts [character] [--force]`.
 *
 * Turns each line below into a short MP3 with OpenAI text-to-speech and writes them, plus a
 * manifest.json, to web/public/lure/<character>/. The clips are committed, so the app never
 * needs this script (or a key) to play them. Clips whose text hasn't changed are kept, so
 * re-running only pays for new or edited lines. A full run costs about a cent or two.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MODEL = "gpt-4o-mini-tts";

interface CharacterLines {
  voice: string;
  /** How to perform the lines (gpt-4o-mini-tts follows these). */
  instructions: string;
  lines: string[];
}

// Kid-friendly, short, plain words; no French, no chef talk (see prompts/characters/).
const CHARACTERS: Record<string, CharacterLines> = {
  pumpkin: {
    // The same voice the pumpkin uses on the Realtime engine; GPT-Live's voices aren't offered for TTS.
    voice: "cedar",
    instructions:
      "You are Jacques O'Lantern, a big, bouncy, friendly talking pumpkin, like a favorite children's TV host. " +
      "Call out playfully to a kid across the yard: warm, excited, a little sneaky on 'psst', smiling the whole time. " +
      "Plain American English, no accent. Never scary.",
    lines: [
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
  },
};

interface Manifest {
  model: string;
  voice: string;
  clips: { file: string; text: string }[];
}

async function speak(apiKey: string, c: CharacterLines, text: string): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, voice: c.voice, input: text, instructions: c.instructions, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`TTS failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const id = args.find((a) => !a.startsWith("--")) ?? "pumpkin";
  const character = CHARACTERS[id];
  if (!character) throw new Error(`No lure lines for "${id}". Known: ${Object.keys(CHARACTERS).join(", ")}`);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY isn't set (add it to .env)");

  const dir = resolve(import.meta.dirname, "..", "web", "public", "lure", id);
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const old: Manifest | null = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest) : null;
  const sameVoice = old?.voice === character.voice && old.model === MODEL;

  const clips: Manifest["clips"] = [];
  let made = 0;
  let characters = 0;
  for (const [i, text] of character.lines.entries()) {
    const file = `${String(i + 1).padStart(2, "0")}.mp3`;
    const unchanged = sameVoice && old?.clips.some((c) => c.file === file && c.text === text) && existsSync(join(dir, file));
    if (!unchanged || force) {
      console.log(`🎙️  ${file}: ${text}`);
      writeFileSync(join(dir, file), await speak(apiKey, character, text));
      made++;
      characters += text.length;
    }
    clips.push({ file, text });
  }
  const manifest: Manifest = { model: MODEL, voice: character.voice, clips };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n✅ ${clips.length} clips in ${dir} (${made} generated, ${characters} characters of text)`);
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
