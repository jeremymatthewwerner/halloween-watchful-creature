/**
 * One-time generator for the bundled recorded clips: `npx tsx scripts/make-lure-clips.ts [character] [--force] [--kind lure|greeting]`.
 *
 * Turns each line in server/clips.ts into a short MP3 with OpenAI text-to-speech and writes them,
 * plus a manifest.json, to web/public/<kind>/<character>/: lure call-outs for people walking by
 * (web/public/lure/) and greetings for when the live voice is down (web/public/greeting/). The
 * clips are committed, so the app never needs this script (or a key) to play them. Clips whose
 * text hasn't changed are kept, so re-running only pays for new or edited lines. A full run costs
 * about a cent or two. They're read in a neutral voice (cedar); the server makes and caches a set in
 * the operator's chosen voice on top of these (POST /api/clips).
 */
import "dotenv/config";
import { resolve } from "node:path";
import { CLIP_KINDS, type ClipKind } from "../shared/types.ts";
import { BUNDLED_VOICE, CLIP_LINES, clipInstructions, makeClipSet, openaiSpeaker } from "../server/clips.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const kindArg = args.includes("--kind") ? args[args.indexOf("--kind") + 1] : undefined;
  const id = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--kind") ?? "pumpkin";
  const character = CLIP_LINES[id];
  if (!character) throw new Error(`No clip lines for "${id}". Known: ${Object.keys(CLIP_LINES).join(", ")}`);
  if (kindArg && !(CLIP_KINDS as readonly string[]).includes(kindArg)) throw new Error(`--kind must be one of ${CLIP_KINDS.join(", ")}`);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY isn't set (add it to .env)");
  const speak = openaiSpeaker({ apiKey, apiBase: process.env.OPENAI_API_BASE?.trim() || undefined });

  for (const kind of (kindArg ? [kindArg] : CLIP_KINDS) as ClipKind[]) {
    const dir = resolve(import.meta.dirname, "..", "web", "public", kind, id);
    const { manifest, made, characters } = await makeClipSet({
      dir,
      voice: BUNDLED_VOICE,
      instructions: clipInstructions(character, kind, null),
      lines: character.lines[kind],
      speak,
      force,
      log: console.log,
    });
    console.log(`✅ ${manifest.clips.length} ${kind} clips in ${dir} (${made} generated, ${characters} characters of text)\n`);
  }
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
