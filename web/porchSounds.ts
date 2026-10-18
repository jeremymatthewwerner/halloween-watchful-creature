/**
 * Local porch sounds: synthesized spooky ambience and pre-recorded clips (lure call-outs, and the
 * greetings offline mode plays when the live voice is down). Everything plays from the browser
 * through the selected speaker; nothing here touches the (billed) voice session.
 * `AmbienceScheduler` (web/ambience.ts) decides when ambience and call-outs play; the Director
 * decides when a recorded greeting does.
 */
import type { ClipKind, ClipManifest, VoiceClipsResult } from "../shared/types.ts";
import { AmbienceScheduler, type AmbienceAction, type AmbientSound } from "./ambience.ts";
import type { RecordedGreetings } from "./director.ts";
import type { PersonBox } from "./visitors.ts";

/** Ambience stays in the background; call-outs are a bit louder but still below the creature's voice. */
const AMBIENCE_VOLUME = 0.18;
const CLIP_VOLUME: Record<ClipKind, number> = { lure: 0.55, greeting: 0.8 };
const FADE_S = 0.05;

type Kind = "ambience" | ClipKind;

interface Playing {
  kind: Kind;
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  endsAt: number;
}

interface Clip {
  buffer: AudioBuffer;
  text: string;
}

/** Plays sounds into one output that follows the dashboard's speaker choice (setSinkId). */
export class PorchSoundPlayer {
  /**
   * Recorded clips also feed this, before their volume, so a VoiceMeter can drive the eyes from it
   * the way it follows the live voice. Ambience doesn't: it isn't the creature talking.
   */
  readonly voiceTap: GainNode;
  private readonly out: GainNode;
  private readonly element = document.createElement("audio") as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  private current: Playing | null = null;
  private noise: AudioBuffer | null = null;
  readonly clips: Record<ClipKind, Clip[]> = { lure: [], greeting: [] };

  constructor(private readonly ctx: AudioContext) {
    // Route through an <audio> element so setSinkId can send it to the USB sound card, like the voice.
    const dest = ctx.createMediaStreamDestination();
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.voiceTap = ctx.createGain();
    this.element.srcObject = dest.stream;
    this.element.autoplay = true;
    void this.element.play().catch(() => undefined);
  }

  async setSink(deviceId: string): Promise<void> {
    await this.element.setSinkId?.(deviceId);
  }

  get playing(): Kind | null {
    if (this.current && this.ctx.currentTime >= this.current.endsAt) this.current = null;
    return this.current?.kind ?? null;
  }

  /**
   * Loads a clip set from `base` (its manifest.json, unless the clip list is given); returns how
   * many loaded. Keeps the current set if nothing loads, so a broken set never silences the clips.
   */
  async loadClips(kind: ClipKind, base: string, list?: ClipManifest["clips"]): Promise<number> {
    let clips = list;
    if (!clips) {
      const res = await fetch(`${base}manifest.json`);
      if (!res.ok) return 0;
      clips = ((await res.json()) as ClipManifest).clips;
    }
    const loaded = await Promise.all(
      clips.map(async (c) => {
        try {
          const res = await fetch(base + c.file);
          if (!res.ok) return null;
          return { buffer: await this.ctx.decodeAudioData(await res.arrayBuffer()), text: c.text };
        } catch {
          return null;
        }
      }),
    );
    const ok = loaded.filter((c) => c !== null);
    if (ok.length) this.clips[kind] = ok;
    return ok.length;
  }

  playClip(kind: ClipKind, index: number): string | undefined {
    const clip = this.clips[kind][index];
    if (!clip) return undefined;
    void this.element.play().catch(() => undefined);
    const voice = this.begin(kind, CLIP_VOLUME[kind]);
    const src = this.ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.connect(voice.gain);
    src.connect(this.voiceTap);
    src.start();
    voice.sources.push(src);
    voice.endsAt = this.ctx.currentTime + clip.buffer.duration;
    return clip.text;
  }

  playAmbience(sound: AmbientSound): void {
    void this.element.play().catch(() => undefined);
    const voice = this.begin("ambience", AMBIENCE_VOLUME);
    const t = this.ctx.currentTime + 0.02;
    this.noise ??= makeNoise(this.ctx);
    const duration = synthesize(this.ctx, voice.gain, sound, t, (s) => voice.sources.push(s), this.noise);
    voice.endsAt = t + duration;
  }

  /** Stops whatever is playing with a very short fade (no click). */
  stop(): void {
    const voice = this.current;
    this.current = null;
    if (!voice) return;
    const t = this.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
    voice.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
    for (const s of voice.sources) {
      try {
        s.stop(t + FADE_S + 0.01);
      } catch {
        /* already stopped */
      }
    }
    setTimeout(() => voice.gain.disconnect(), (FADE_S + 0.1) * 1000);
  }

  private begin(kind: Playing["kind"], volume: number): Playing {
    this.stop();
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    gain.connect(this.out);
    this.current = { kind, gain, sources: [], endsAt: Infinity };
    return this.current;
  }
}

// --- synthesized sounds -------------------------------------------------------------------------

interface SynthKit {
  ctx: BaseAudioContext;
  out: AudioNode;
  /** A few seconds of white noise. */
  noise: AudioBuffer;
  /** Registers a source so stop() can silence it. */
  track(source: AudioScheduledSourceNode): void;
}

/** Each synth schedules its sound at time `t` and returns its length in seconds. */
type Synth = (kit: SynthKit, t: number) => number;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function makeNoise(ctx: BaseAudioContext, seconds = 4): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function osc(kit: SynthKit, type: OscillatorType, freq: number, t: number, end: number): OscillatorNode {
  const o = kit.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(end);
  kit.track(o);
  return o;
}

function noiseSource(kit: SynthKit, t: number, end: number): AudioBufferSourceNode {
  const n = kit.ctx.createBufferSource();
  n.buffer = kit.noise;
  n.loop = true;
  n.start(t, Math.random() * kit.noise.duration);
  n.stop(end);
  kit.track(n);
  return n;
}

function withQ(f: BiquadFilterNode, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** A gain envelope: ramps to each [time offset, level] point in turn, starting silent at t. */
function envelope(kit: SynthKit, t: number, points: [number, number][]): GainNode {
  const g = kit.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  for (const [dt, level] of points) g.gain.linearRampToValueAtTime(level, t + dt);
  return g;
}

/** Creaky door: a slow stick-slip buzz through the resonances of a wooden door. */
const creak: Synth = (kit, t) => {
  const len = rand(1.4, 2.4);
  const buzz = osc(kit, "sawtooth", rand(18, 26), t, t + len);
  // The hinge speeds up and slows down as the door swings.
  buzz.frequency.linearRampToValueAtTime(rand(45, 70), t + len * 0.4);
  buzz.frequency.linearRampToValueAtTime(rand(25, 40), t + len * 0.8);
  buzz.frequency.linearRampToValueAtTime(rand(15, 22), t + len);
  const env = envelope(kit, t, [[0.15, 0.9], [len * 0.7, 0.7], [len, 0]]);
  for (const [freq, q] of [[rand(500, 700), 12], [rand(1100, 1500), 14], [rand(2300, 2800), 10]] as const) {
    buzz.connect(withQ(kit.ctx.createBiquadFilter(), "bandpass", freq, q)).connect(env);
  }
  env.connect(kit.out);
  return len;
};

/** Owl: "hoo, hoo-hoooo". */
const owl: Synth = (kit, t) => {
  const pitch = rand(330, 420);
  const notes: [number, number][] = [[0, 0.35], [0.7, 0.22], [1.0, 0.7]];
  for (const [start, len] of notes) {
    const s = t + start;
    const o = osc(kit, "sine", pitch * 1.06, s, s + len + 0.05);
    o.frequency.exponentialRampToValueAtTime(pitch * 0.94, s + len);
    const vibrato = osc(kit, "sine", 6, s, s + len + 0.05);
    const depth = kit.ctx.createGain();
    depth.gain.value = pitch * 0.012;
    vibrato.connect(depth).connect(o.frequency);
    const env = envelope(kit, s, [[0.06, 0.8], [len * 0.7, 0.6], [len, 0]]);
    o.connect(withQ(kit.ctx.createBiquadFilter(), "lowpass", 900, 0.7)).connect(env).connect(kit.out);
  }
  return 1.8;
};

/** Distant thunder: low, rolling noise with a few swells. */
const thunder: Synth = (kit, t) => {
  const len = rand(4, 6);
  const n = noiseSource(kit, t, t + len);
  // Real thunder is mostly sub-bass, which a small porch speaker can't play: keep some low-mids.
  const low = withQ(kit.ctx.createBiquadFilter(), "lowpass", rand(300, 450), 0.8);
  low.frequency.linearRampToValueAtTime(120, t + len);
  const points: [number, number][] = [[0.4, 0.8]];
  for (let at = 0.9; at < len - 1; at += rand(0.5, 1.1)) points.push([at, rand(0.3, 1)]);
  points.push([len, 0]);
  const env = envelope(kit, t, points);
  n.connect(low).connect(env).connect(kit.out);
  return len;
};

/** Wind: noise through a slowly sweeping, whistly band-pass filter. */
const wind: Synth = (kit, t) => {
  const len = rand(5, 8);
  const n = noiseSource(kit, t, t + len);
  const band = withQ(kit.ctx.createBiquadFilter(), "bandpass", rand(300, 500), rand(4, 8));
  for (let at = 1; at < len; at += rand(0.8, 1.6)) band.frequency.linearRampToValueAtTime(rand(250, 1000), t + at);
  const env = envelope(kit, t, [[len * 0.35, 0.9], [len * 0.65, 0.6], [len, 0]]);
  n.connect(band).connect(env).connect(kit.out);
  return len;
};

/** Witch cackle: a quick run of "ha"s sliding down in pitch. */
const cackle: Synth = (kit, t) => {
  const count = Math.floor(rand(6, 10));
  const start = rand(700, 900);
  let at = 0;
  for (let i = 0; i < count; i++) {
    const s = t + at;
    const len = rand(0.07, 0.11);
    const f = start * (1 - (0.35 * i) / count);
    const o = osc(kit, "sawtooth", f * 1.1, s, s + len + 0.03);
    o.frequency.linearRampToValueAtTime(f * 0.85, s + len);
    const env = envelope(kit, s, [[0.012, 0.6], [len, 0]]);
    // Two vowel-ish formants make it sound like "ha" rather than a buzzer.
    const mix = kit.ctx.createGain();
    o.connect(withQ(kit.ctx.createBiquadFilter(), "bandpass", 800, 5)).connect(mix);
    o.connect(withQ(kit.ctx.createBiquadFilter(), "bandpass", 1300, 6)).connect(mix);
    mix.connect(env).connect(kit.out);
    at += len + rand(0.05, 0.08);
  }
  return at + 0.1;
};

/** A faraway wolf howl: a slow glide up and down with vibrato. */
const howl: Synth = (kit, t) => {
  const len = rand(2.2, 3.2);
  const base = rand(260, 340);
  const o = osc(kit, "triangle", base, t, t + len);
  o.frequency.exponentialRampToValueAtTime(base * 1.9, t + len * 0.35);
  o.frequency.linearRampToValueAtTime(base * 1.7, t + len * 0.75);
  o.frequency.exponentialRampToValueAtTime(base * 1.1, t + len);
  const vibrato = osc(kit, "sine", 5, t, t + len);
  const depth = kit.ctx.createGain();
  depth.gain.value = base * 0.02;
  vibrato.connect(depth).connect(o.frequency);
  const env = envelope(kit, t, [[0.4, 0.7], [len * 0.8, 0.6], [len, 0]]);
  o.connect(withQ(kit.ctx.createBiquadFilter(), "lowpass", 1200, 0.7)).connect(env).connect(kit.out);
  return len;
};

/** A distant church bell: one or two strikes of a few inharmonic partials. */
const bell: Synth = (kit, t) => {
  const strikes = Math.random() < 0.5 ? 1 : 2;
  const pitch = rand(180, 240);
  const ring = 3.5;
  for (let i = 0; i < strikes; i++) {
    const s = t + i * 2.2;
    for (const [ratio, level] of [[1, 0.5], [2.0, 0.3], [2.4, 0.2], [3.0, 0.15], [4.2, 0.1]] as const) {
      const o = osc(kit, "sine", pitch * ratio, s, s + ring);
      const g = kit.ctx.createGain();
      g.gain.setValueAtTime(0.0001, s);
      g.gain.linearRampToValueAtTime(level, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + ring / ratio ** 0.5);
      o.connect(g).connect(kit.out);
    }
  }
  return (strikes - 1) * 2.2 + ring;
};

const SYNTHS: Record<AmbientSound, Synth> = { creak, owl, thunder, wind, cackle, howl, bell };

/** Evens out loudness: pure tones (owl, howl) carry far more than filtered noise (wind, creak). */
const LEVELS: Record<AmbientSound, number> = { creak: 4, owl: 0.5, thunder: 2.5, wind: 4, cackle: 2, howl: 0.5, bell: 1.5 };

/**
 * Schedules one ambient sound into `out` at time `t`; returns its length in seconds.
 * Exported so the sounds can also be rendered offline (OfflineAudioContext) to check them.
 */
export function synthesize(
  ctx: BaseAudioContext,
  out: AudioNode,
  sound: AmbientSound,
  t: number,
  track: (source: AudioScheduledSourceNode) => void = () => undefined,
  noise: AudioBuffer = makeNoise(ctx),
): number {
  const level = ctx.createGain();
  level.gain.value = LEVELS[sound];
  level.connect(out);
  return SYNTHS[sound]({ ctx, out: level, noise, track }, t);
}

// --- wiring ---------------------------------------------------------------------------------------

export interface PorchSoundDeps {
  audioCtx: AudioContext;
  character: string;
  /** The speaker the dashboard picked. */
  sinkId?: string;
  /** Read every tick: whether anyone's close, whether the creature is talking, and the kill switch. */
  status(): { porchEmpty: boolean; talking: boolean; autopilot: boolean };
  prefs: { get(key: string): string | null; set(key: string, value: string): void };
  log(message: string): void;
  /** An ambient sound just started (for a subtle eye effect; it isn't the creature talking). */
  onAmbience?(sound: AmbientSound): void;
}

export interface PorchSounds {
  /** Feed each frame's detections; people smaller than minArea are "far away". */
  see(people: readonly PersonBox[], minArea: number): void;
  setSink(deviceId: string): void;
  /** Recorded clips (lure and greetings) play through this too, for the eyes' VoiceMeter. */
  readonly voiceTap: AudioNode;
  /** A recorded clip (not ambience) is playing. */
  clipPlaying(): boolean;
  /** The recorded greetings, for the Director's offline mode. */
  readonly greetings: RecordedGreetings;
  /**
   * Switches the clips to the session voice: the dashboard's pick (null: the server's default).
   * The server makes and caches that set if needed; on any failure the current clips stay.
   */
  useVoice(picked: string | null): Promise<void>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Starts ambience and lure mode, wiring the Settings toggles (#ambience-toggle, #lure-toggle, #lure-cooldown). */
export function startPorchSounds(deps: PorchSoundDeps): PorchSounds {
  const player = new PorchSoundPlayer(deps.audioCtx);
  if (deps.sinkId) void player.setSink(deps.sinkId).catch(() => undefined);

  const ambienceToggle = $<HTMLInputElement>("ambience-toggle");
  const lureToggle = $<HTMLInputElement>("lure-toggle");
  const cooldownInput = $<HTMLInputElement>("lure-cooldown");
  const settings = {
    ambience: deps.prefs.get("ambience") !== "off",
    lure: deps.prefs.get("lure") !== "off",
    cooldownS: Number(deps.prefs.get("lureCooldown") ?? 45) || 45,
  };
  const scheduler = new AmbienceScheduler({ lureCooldownMs: settings.cooldownS * 1000 });

  if (ambienceToggle) {
    ambienceToggle.checked = settings.ambience;
    ambienceToggle.addEventListener("change", () => {
      settings.ambience = ambienceToggle.checked;
      deps.prefs.set("ambience", settings.ambience ? "on" : "off");
    });
  }
  if (lureToggle) {
    lureToggle.checked = settings.lure;
    lureToggle.addEventListener("change", () => {
      settings.lure = lureToggle.checked;
      deps.prefs.set("lure", settings.lure ? "on" : "off");
    });
  }
  if (cooldownInput) {
    cooldownInput.value = String(settings.cooldownS);
    cooldownInput.addEventListener("change", () => {
      const seconds = Math.min(600, Math.max(15, Number(cooldownInput.value) || 45));
      cooldownInput.value = String(seconds);
      deps.prefs.set("lureCooldown", String(seconds));
      scheduler.setLureCooldown(seconds * 1000);
    });
  }

  // The bundled clips first (web/public/<kind>/<character>/, always there, even offline); useVoice()
  // swaps in the set in the session voice when the server has or can make one.
  const character = encodeURIComponent(deps.character);
  const loadBundled = (quiet: boolean) =>
    Promise.all([
      player.loadClips("lure", `/lure/${character}/`).then((n) => {
        if (!n && !quiet) deps.log("Lure mode: this character has no call-out clips (see scripts/make-lure-clips.ts)");
      }),
      player.loadClips("greeting", `/greeting/${character}/`).then((n) => {
        if (!n && !quiet) deps.log("Offline mode: this character has no recorded greetings, so it stays quiet when the live voice is down");
      }),
    ]).catch((err) => deps.log(`Recorded clips failed to load: ${(err as Error).message}`));
  const bundled = loadBundled(false);
  /** The clips loaded now are a per-voice set (not the bundled ones). */
  let matched = false;

  let farPeople = 0;
  setInterval(() => {
    const now = performance.now();
    const playing = player.playing;
    const status = deps.status();
    const actions: AmbienceAction[] = scheduler.update(
      {
        ...status,
        // A recorded greeting is the creature talking: no ambience or call-outs over it, and it isn't the scheduler's to stop.
        talking: status.talking || playing === "greeting",
        farPeople,
        ambience: settings.ambience,
        lure: settings.lure,
        lureClips: player.clips.lure.length,
        playing: playing === "greeting" ? null : playing,
      },
      now,
    );
    for (const action of actions) {
      if (action.type === "stop") player.stop();
      else if (action.type === "ambience") {
        console.log(`[creature] ambience: ${action.sound}`);
        player.playAmbience(action.sound);
        deps.onAmbience?.(action.sound);
      } else {
        const text = player.playClip("lure", action.clip);
        if (text) deps.log(`Lure call-out (recorded, no voice session): "${text}"`);
      }
    }
  }, 200);

  let voiceRequest = 0;
  return {
    see(people, minArea) {
      farPeople = people.filter((p) => p.area < minArea).length;
    },
    setSink(deviceId) {
      void player.setSink(deviceId).catch((err) => deps.log(`Porch sounds speaker selection failed: ${(err as Error).message}`));
    },
    voiceTap: player.voiceTap,
    clipPlaying: () => {
      const playing = player.playing;
      return playing === "lure" || playing === "greeting";
    },
    greetings: {
      count: () => player.clips.greeting.length,
      play: (index) => player.playClip("greeting", index),
      playing: () => player.playing === "greeting",
      stop: () => {
        if (player.playing === "greeting") player.stop();
      },
    },
    async useVoice(picked) {
      const mine = ++voiceRequest;
      await bundled;
      try {
        const res = await fetch("/api/clips", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ character: deps.character, voice: picked }),
        });
        const body = (await res.json().catch(() => ({}))) as Partial<VoiceClipsResult> & { error?: string };
        if (!res.ok || !body.sets) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (mine !== voiceRequest) return; // the pick changed meanwhile
        const counts: string[] = [];
        for (const [kind, set] of Object.entries(body.sets) as [ClipKind, NonNullable<VoiceClipsResult["sets"][ClipKind]>][]) {
          const n = await player.loadClips(kind, set.base, set.clips);
          if (mine !== voiceRequest) return;
          counts.push(`${n} ${kind === "lure" ? "call-outs" : "greetings"}`);
        }
        matched = true;
        const made = body.generated ? `, ${body.generated} just made` : "";
        deps.log(`Recorded clips now match the ${body.voice} voice (read by ${body.rendition}${made}): ${counts.join(", ")}`);
      } catch (err) {
        if (mine !== voiceRequest) return;
        // Don't leave clips in a voice that was picked before: go back to the bundled ones.
        if (matched) await loadBundled(true);
        matched = false;
        deps.log(`Recorded clips use the bundled voice: ${(err as Error).message}`);
      }
    },
  };
}
