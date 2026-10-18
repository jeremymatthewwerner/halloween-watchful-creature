import { describe, expect, it } from "vitest";
import {
  LIVE_VOICES,
  REALTIME_VOICES,
  TTS_VOICES,
  describeRendition,
  docsBlurb,
  findVoice,
  groupVoices,
  isKnownVoice,
  isTtsVoice,
  renditionKey,
  resolveVoice,
  ttsVoiceFor,
} from "../shared/voices.ts";
import type { StorageLike } from "../web/evening.ts";
import { loadPickedVoice, savePickedVoice, shortName, voiceKey, voiceStatus, voiceTags } from "../web/voiceChoice.ts";

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const cfg = (env: string | null, character = "meridian") => ({
  engine: "live" as const,
  voice: { env, character },
  character: { id: "pumpkin", name: "Jacques O'Lantern, Pumpkin Critic", voice: character, eyes: {} as never, eyeStyle: "flicker" as const },
});

describe("voice catalog", () => {
  it("lists GPT-Live's 21 documented voices plus the default, marin", () => {
    expect(LIVE_VOICES.voices).toHaveLength(22);
    expect(LIVE_VOICES.voices[0]!.id).toBe("marin");
    expect(new Set(LIVE_VOICES.voices.map((v) => v.id)).size).toBe(22);
    expect(findVoice("live", "ripple")).toMatchObject({ language: "English", region: "Australian", presentation: "masculine", source: "natural" });
    expect(findVoice("live", "cinder")).toMatchObject({ language: "English", region: "Southern U.S.", presentation: "masculine", source: "generated" });
    expect(findVoice("live", "sillage")).toMatchObject({ language: "French", region: undefined, presentation: "masculine", source: "natural" });
    expect(findVoice("live", "noeul")).toMatchObject({ language: "Korean", presentation: "feminine" });
  });

  it("describes voices only with the docs' facts", () => {
    expect(docsBlurb(findVoice("live", "vesper")!)).toBe("English (British influence), masculine, natural source");
    expect(docsBlurb(findVoice("live", "nuri")!)).toBe("German, feminine, natural source");
    expect(docsBlurb(findVoice("live", "marin")!)).toMatch(/default/);
    expect(docsBlurb(findVoice("realtime", "cedar")!)).toMatch(/recommends marin or cedar/);
    expect(docsBlurb(findVoice("realtime", "alloy")!)).toBe("");
  });

  it("keeps our testing notes separate from the docs", () => {
    expect(findVoice("live", "meridian")!.ourNotes).toMatch(/flat/);
    expect(findVoice("live", "cinder")!.ourNotes).toMatch(/bad/);
    expect(findVoice("live", "sillage")!.ourNotes).toMatch(/French accent/);
    expect(findVoice("live", "quartz")!.ourNotes).toBeUndefined();
  });

  it("groups English voices first", () => {
    const { english, undescribed, other } = groupVoices(LIVE_VOICES);
    expect(undescribed.map((v) => v.id)).toEqual(["marin"]);
    expect(english.map((v) => v.id)).toEqual(["quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "beacon", "delta", "cinder"]);
    expect(other.every((v) => v.language !== "English")).toBe(true);
    expect(other).toHaveLength(11);
    expect(groupVoices(REALTIME_VOICES)).toMatchObject({ english: [], other: [] });
    expect(groupVoices(REALTIME_VOICES).undescribed).toHaveLength(10);
  });

  it("allowlists voices per engine", () => {
    expect(isKnownVoice("live", "ripple")).toBe(true);
    expect(isKnownVoice("live", "cedar")).toBe(false);
    expect(isKnownVoice("realtime", "cedar")).toBe(true);
    expect(isKnownVoice("realtime", "ripple")).toBe(false);
    for (const bad of ["", "Ripple", "ripple ", "../x", "constructor", null, undefined, 42, { id: "ripple" }]) {
      expect(isKnownVoice("live", bad)).toBe(false);
    }
  });
});

describe("voice precedence", () => {
  it("dashboard pick > VOICE in .env > character default", () => {
    expect(resolveVoice("live", { picked: "gleam", env: "ripple", character: "meridian" })).toEqual({ voice: "gleam", source: "dashboard" });
    expect(resolveVoice("live", { picked: null, env: "ripple", character: "meridian" })).toEqual({ voice: "ripple", source: "env" });
    expect(resolveVoice("live", { picked: null, env: "", character: "meridian" })).toEqual({ voice: "meridian", source: "character" });
    expect(resolveVoice("live", { env: "  ", character: "meridian" })).toEqual({ voice: "meridian", source: "character" });
  });

  it("ignores a pick that isn't a known voice for this engine", () => {
    expect(resolveVoice("live", { picked: "evil-voice", env: "ripple", character: "meridian" })).toEqual({ voice: "ripple", source: "env" });
    expect(resolveVoice("realtime", { picked: "ripple", character: "cedar" })).toEqual({ voice: "cedar", source: "character" });
  });
});

describe("dashboard voice pick", () => {
  it("is remembered per engine, and only for known voices", () => {
    const storage = new FakeStorage();
    expect(loadPickedVoice(storage, "live")).toBeNull();
    savePickedVoice(storage, "live", "gleam");
    expect(storage.getItem(voiceKey("live"))).toBe("gleam");
    expect(loadPickedVoice(storage, "live")).toBe("gleam");
    expect(loadPickedVoice(storage, "realtime")).toBeNull();
    savePickedVoice(storage, "live", null);
    expect(loadPickedVoice(storage, "live")).toBeNull();
    storage.setItem(voiceKey("live"), "not-a-voice");
    expect(loadPickedVoice(storage, "live")).toBeNull();
    savePickedVoice(storage, "live", "not-a-voice");
    expect(storage.getItem(voiceKey("live"))).toBe("");
    expect(loadPickedVoice(null, "live")).toBeNull();
  });

  it("shows the source in effect and the default to fall back to", () => {
    const withEnv = voiceStatus(cfg("ripple"), null, null);
    expect(withEnv.effective).toEqual({ voice: "ripple", source: "env" });
    expect(withEnv.summary).toBe("ripple, VOICE in .env");
    expect(withEnv.restartNeeded).toBe(false);

    const picked = voiceStatus(cfg("ripple"), "gleam", null);
    expect(picked.summary).toBe("gleam, picked here on the dashboard");
    expect(picked.fallback).toEqual({ voice: "ripple", source: "env" });

    const noEnv = voiceStatus(cfg(null), null, null);
    expect(noEnv.summary).toBe("meridian, Jacques O'Lantern's default");
    expect(voiceStatus(cfg("custom-voice"), null, null).envUnknown).toBe(true);
  });

  it("offers a restart only while a session runs with another voice", () => {
    const running = voiceStatus(cfg("ripple"), "gleam", "ripple");
    expect(running.restartNeeded).toBe(true);
    expect(running.applies).toMatch(/Talking with ripple right now; gleam starts with the next voice session/);
    expect(voiceStatus(cfg("ripple"), "gleam", "gleam").restartNeeded).toBe(false);
    expect(voiceStatus(cfg("ripple"), "gleam", null).applies).toMatch(/next voice session/);
  });

  it("tags the current voice and the defaults", () => {
    const c = cfg("ripple");
    const status = voiceStatus(c, "gleam", "ripple");
    expect(voiceTags(c, status, "gleam")).toEqual(["current"]);
    expect(voiceTags(c, status, "ripple")).toEqual(["this session", "VOICE in .env"]);
    expect(voiceTags(c, status, "meridian")).toEqual(["Jacques O'Lantern's default"]);
    expect(shortName("Edgar the Raven, Rhyming Critic")).toBe("Edgar the Raven");
  });
});

describe("text-to-speech voices for the recorded clips", () => {
  it("lists gpt-4o-mini-tts's 13 voices; of GPT-Live's only marin is one, and all of gpt-realtime's are", () => {
    expect(TTS_VOICES).toHaveLength(13);
    expect(LIVE_VOICES.voices.filter((v) => isTtsVoice(v.id)).map((v) => v.id)).toEqual(["marin"]);
    for (const v of REALTIME_VOICES.voices) expect(ttsVoiceFor("realtime", v.id)).toEqual({ voice: v.id, accent: null, exact: true });
  });

  it("maps GPT-Live-only voices to cedar or marin by presentation, with the accent asked for", () => {
    expect(ttsVoiceFor("live", "marin")).toEqual({ voice: "marin", accent: null, exact: true });
    expect(ttsVoiceFor("live", "ripple")).toEqual({ voice: "cedar", accent: "Australian", exact: false });
    expect(ttsVoiceFor("live", "quartz")).toEqual({ voice: "marin", accent: "Australian", exact: false });
    expect(ttsVoiceFor("live", "vesper")).toEqual({ voice: "cedar", accent: "British", exact: false });
    expect(ttsVoiceFor("live", "willow")).toEqual({ voice: "marin", accent: "Irish", exact: false });
    expect(ttsVoiceFor("live", "cinder")).toEqual({ voice: "cedar", accent: "Southern U.S.", exact: false });
    // North American is the TTS voices' own way of speaking: no accent to ask for.
    expect(ttsVoiceFor("live", "meridian")).toEqual({ voice: "cedar", accent: null, exact: false });
    expect(ttsVoiceFor("live", "gleam")).toEqual({ voice: "marin", accent: null, exact: false });
    // The other languages' voices carry their accent in English, so the clips do too.
    expect(ttsVoiceFor("live", "sillage")).toEqual({ voice: "cedar", accent: "French", exact: false });
    expect(ttsVoiceFor("live", "nuri")).toEqual({ voice: "marin", accent: "German", exact: false });
    // Every GPT-Live voice has a rendition.
    for (const v of LIVE_VOICES.voices) expect(ttsVoiceFor("live", v.id)).not.toBeNull();
  });

  it("has no rendition for a voice it knows nothing about, and makes folder-safe keys", () => {
    expect(ttsVoiceFor("live", "custom-voice")).toBeNull();
    expect(ttsVoiceFor("realtime", "ripple")).toBeNull();
    // A TTS voice set as VOICE on GPT-Live is still read by itself.
    expect(ttsVoiceFor("live", "cedar")).toEqual({ voice: "cedar", accent: null, exact: true });
    expect(renditionKey({ voice: "cedar", accent: null })).toBe("cedar");
    expect(renditionKey({ voice: "cedar", accent: "Australian" })).toBe("cedar-australian");
    expect(renditionKey({ voice: "marin", accent: "Southern U.S." })).toBe("marin-southern-u-s");
    expect(describeRendition({ voice: "cedar", accent: "British" })).toBe("cedar with a light British accent");
  });
});
