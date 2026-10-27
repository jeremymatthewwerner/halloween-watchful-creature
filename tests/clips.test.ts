import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_VOICE, CLIP_LINES, TTS_MODEL, VoiceClips, clipInstructions, makeClipSet, type Speak } from "../server/clips.ts";
import type { ClipManifest } from "../shared/types.ts";

/** Pretend TTS: "MP3s" that say which voice read what. No real API calls. */
function fakeSpeak(fail?: (text: string) => boolean) {
  return vi.fn<Speak>(async (voice, _instructions, text) => {
    if (fail?.(text)) throw new Error("TTS failed (HTTP 500)");
    return Buffer.from(`${voice}:${text}`);
  });
}

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "creature-clips-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const manifestOf = (d: string) => JSON.parse(readFileSync(join(d, "manifest.json"), "utf8")) as ClipManifest;

describe("clip lines", () => {
  it("has short, varied, kid-friendly lure and greeting lines for Jacqueline", () => {
    const { lure, greeting } = CLIP_LINES.pumpkin!.lines;
    expect(lure.length).toBeGreaterThanOrEqual(10);
    expect(greeting.length).toBeGreaterThanOrEqual(10);
    for (const lines of [lure, greeting]) {
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) {
        expect(line.length).toBeLessThan(90);
        // No French and no chef talk for Jacqueline (prompts/characters/pumpkin.md).
        expect(line).not.toMatch(/bonjour|magnifique|chef|kiss/i);
      }
    }
    // Greetings can't see the costume, so they never name one.
    for (const line of greeting) expect(line).not.toMatch(/dinosaur|witch|princess|pirate|ghost|superhero/i);
  });

  it("asks for the rendition's accent in the TTS instructions", () => {
    const pumpkin = CLIP_LINES.pumpkin!;
    expect(clipInstructions(pumpkin, "greeting", null)).toMatch(/Plain American English, no accent\.$/);
    expect(clipInstructions(pumpkin, "lure", "Australian")).toMatch(/Speak English with a light, friendly Australian accent\.$/);
    expect(clipInstructions(pumpkin, "lure", null)).not.toBe(clipInstructions(pumpkin, "greeting", null));
  });

  it("the bundled sets on disk match the lines (re-run scripts/make-lure-clips.ts after editing them)", () => {
    for (const kind of ["lure", "greeting"] as const) {
      const bundled = resolve(import.meta.dirname, "..", "web", "public", kind, "pumpkin");
      const manifest = manifestOf(bundled);
      expect(manifest).toMatchObject({ model: TTS_MODEL, voice: BUNDLED_VOICE });
      expect(manifest.clips.map((c) => c.text)).toEqual(CLIP_LINES.pumpkin!.lines[kind]);
      for (const clip of manifest.clips) expect(existsSync(join(bundled, clip.file))).toBe(true);
    }
  });
});

describe("makeClipSet", () => {
  it("writes numbered MP3s and a manifest, and only redoes new or edited lines", async () => {
    const speak = fakeSpeak();
    const opts = { dir, voice: "cedar", instructions: "be bouncy", lines: ["Hello!", "Happy Halloween!"], speak };
    const first = await makeClipSet(opts);
    expect(first.made).toBe(2);
    expect(readFileSync(join(dir, "02.mp3"), "utf8")).toBe("cedar:Happy Halloween!");
    expect(manifestOf(dir)).toEqual({
      model: TTS_MODEL,
      voice: "cedar",
      instructions: "be bouncy",
      clips: [
        { file: "01.mp3", text: "Hello!" },
        { file: "02.mp3", text: "Happy Halloween!" },
      ],
    });
    expect((await makeClipSet(opts)).made).toBe(0);
    expect((await makeClipSet({ ...opts, lines: ["Hello!", "Great costume!"] })).made).toBe(1);
    expect((await makeClipSet({ ...opts, lines: ["Hello!", "Great costume!"], instructions: "be sneaky" })).made).toBe(2);
    expect((await makeClipSet({ ...opts, lines: ["Hello!", "Great costume!"], instructions: "be sneaky", force: true })).made).toBe(2);
    expect(speak).toHaveBeenCalledTimes(7);
  });

  it("keeps the clips that worked when some fail, lists only those, and retries just the rest", async () => {
    const lines = ["One!", "Two!", "Three!"];
    await expect(makeClipSet({ dir, voice: "marin", instructions: "x", lines, speak: fakeSpeak((t) => t === "Two!") })).rejects.toThrow(/1 of 3 clips failed/);
    expect(manifestOf(dir).clips.map((c) => c.text)).toEqual(["One!", "Three!"]);
    const retry = fakeSpeak();
    expect((await makeClipSet({ dir, voice: "marin", instructions: "x", lines, speak: retry })).made).toBe(1);
    expect(retry).toHaveBeenCalledWith("marin", "x", "Two!");
  });
});

describe("VoiceClips (per-voice sets made on demand, cached on disk)", () => {
  it("makes a set in the closest TTS reading of the voice, then serves it from the cache", async () => {
    const speak = fakeSpeak();
    const clips = new VoiceClips({ dir, engine: "live", speak });
    const result = await clips.ensure("pumpkin", "ripple");
    const { lure, greeting } = CLIP_LINES.pumpkin!.lines;
    expect(result).toMatchObject({ voice: "ripple", rendition: "cedar with a light Australian accent", exact: false, generated: lure.length + greeting.length });
    expect(result.sets.greeting!.base).toBe("/api/clips/pumpkin/cedar-australian/greeting/");
    expect(result.sets.lure!.clips).toHaveLength(lure.length);
    expect(speak.mock.calls.every(([voice, instructions]) => voice === "cedar" && instructions.includes("Australian accent"))).toBe(true);
    expect(String(await clips.file("pumpkin", "cedar-australian", "greeting", "01.mp3"))).toBe(`cedar:${greeting[0]}`);

    // Cached: no more TTS, even without a key.
    const offline = new VoiceClips({ dir, engine: "live", speak: null });
    expect((await offline.ensure("pumpkin", "ripple")).generated).toBe(0);
    expect(speak).toHaveBeenCalledTimes(lure.length + greeting.length);
    // Voices with the same reading share a set.
    expect((await clips.ensure("pumpkin", "stone")).sets.lure!.base).toBe("/api/clips/pumpkin/cedar-irish/lure/");
    expect((await clips.ensure("pumpkin", "marin")).exact).toBe(true);
  });

  it("makes each set once when asked twice at the same time", async () => {
    const speak = fakeSpeak();
    const clips = new VoiceClips({ dir, engine: "live", speak });
    const [a, b] = await Promise.all([clips.ensure("pumpkin", "gleam"), clips.ensure("pumpkin", "gleam")]);
    expect(a).toBe(b);
    const { lure, greeting } = CLIP_LINES.pumpkin!.lines;
    expect(speak).toHaveBeenCalledTimes(lure.length + greeting.length);
  });

  it("refuses what it can't do, so the dashboard keeps the bundled clips", async () => {
    const clips = new VoiceClips({ dir, engine: "live", speak: fakeSpeak() });
    await expect(clips.ensure("raven", "ripple")).rejects.toThrow(/no clip lines/);
    await expect(clips.ensure("pumpkin", "custom-voice")).rejects.toThrow(/no text-to-speech voice/);
    await expect(new VoiceClips({ dir, engine: "live", speak: null }).ensure("pumpkin", "vesper")).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(new VoiceClips({ dir, engine: "live", speak: fakeSpeak(() => true) }).ensure("pumpkin", "vesper")).rejects.toThrow(/clips failed/);
  });

  it("serves only clip files from the cache folder", async () => {
    const clips = new VoiceClips({ dir, engine: "live", speak: fakeSpeak() });
    await clips.ensure("pumpkin", "gleam");
    expect(await clips.file("pumpkin", "marin", "lure", "01.mp3")).not.toBeNull();
    expect(await clips.file("pumpkin", "marin", "lure", "manifest.json")).toBeNull();
    expect(await clips.file("..", "marin", "lure", "01.mp3")).toBeNull();
    expect(await clips.file("pumpkin", "../../etc", "lure", "01.mp3")).toBeNull();
    expect(await clips.file("pumpkin", "marin", "secrets", "01.mp3")).toBeNull();
    expect(await clips.file("pumpkin", "cedar", "lure", "01.mp3")).toBeNull(); // never made
  });
});
