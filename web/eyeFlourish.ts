import type { BodyState, CharacterInfo, EyeFlourish, Rgb } from "../shared/types.ts";
import type { GreetingKind } from "./engines/types.ts";

/**
 * Eye flourishes for the dashboard preview: the same timings and shapes as flourishFrame() in
 * firmware/creature_body/creature_body.ino, so the preview shows what the pumpkin's eyes do.
 */

const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/** A blink: a dark lid comes down over each eye, stays shut a moment and goes back up. */
export const LID_DOWN_MS = 145;
export const LID_SHUT_MS = 65;
export const BLINK_MS = 375;
/** The lid's color, on the same 0-255 scale as the eye colors. */
export const LID_COLOR: Rgb = [0, 0, 0];
/** Which ring pixel (1-6) is at the top of each jewel as it's mounted: the lid comes down from it. */
export const EYE_TOP_PIXEL = 1;
/** Where the lid's edge sits when open: just above the top pixel (pixels sit from -1, bottom, to 1, top). */
export const LID_OPEN = 1.3;

/** Where the lid's edge is `t` ms into a blink: coming down, shut, then going up for the rest. */
export function lidEdge(t: number): number {
  if (t < 0 || t >= BLINK_MS) return LID_OPEN;
  if (t < LID_DOWN_MS) return LID_OPEN - 2 * LID_OPEN * ease(t / LID_DOWN_MS);
  const up = LID_DOWN_MS + LID_SHUT_MS;
  if (t < up) return -LID_OPEN;
  return -LID_OPEN + 2 * LID_OPEN * ease((t - up) / (BLINK_MS - up));
}

/** How much of pixel `p` (0 = center, 1-6 = ring) the lid covers with its edge at `edge`: 0..1, soft-edged. */
export function lidCover(edge: number, p: number): number {
  const y = p === 0 ? 0 : Math.cos((2 * Math.PI * (p - EYE_TOP_PIXEL)) / 6);
  return Math.min(1, Math.max(0, (y - edge) / 0.6 + 0.5));
}

/** How long each flourish lasts (ms); keep in sync with FLOURISH_MS in the firmware. */
export const FLOURISH_MS: Record<EyeFlourish, number> = { sparkle: 1200, gasp: 900, slowblink: BLINK_MS };

/** Which flourish greets which kind of greeting. */
export const GREETING_FLOURISH: Record<GreetingKind, EyeFlourish> = {
  visitors: "sparkle",
  costume: "sparkle",
  "welcome-back": "gasp",
};

export interface ActiveFlourish {
  effect: EyeFlourish;
  /** When it started (performance.now() ms). */
  at: number;
}

export interface FlourishFrame {
  /** Brightness multiplier: 0 = shut, 1 = normal. */
  lid: number;
  /** 0..1: how far brightness is pushed toward full (wide-eyed). */
  wide: number;
  /** 0..1: how much of the rainbow sparkle shows over the normal color. */
  sparkle: number;
  /** Where a blinking lid's edge is (see lidEdge): LID_OPEN when there's none. */
  edge: number;
}

type EyeStyle = CharacterInfo["eyeStyle"];

const NONE: FlourishFrame = { lid: 1, wide: 0, sparkle: 0, edge: LID_OPEN };

const blinkLid = (t: number, start: number, end: number) => (t < start || t >= end ? 1 : Math.abs((2 * (t - start)) / (end - start) - 1));

/** What `effect` does to the eyes `t` ms after it started (nothing once it's over). */
export function flourishFrame(effect: EyeFlourish, t: number): FlourishFrame {
  if (t < 0 || t >= FLOURISH_MS[effect]) return NONE;
  switch (effect) {
    case "gasp":
      return { ...NONE, lid: blinkLid(t, 0, 150) * blinkLid(t, 220, 370), wide: t >= 370 ? 1 - ease((t - 370) / 530) : 0 };
    case "slowblink": // a blink like the idle ones: the lid comes down from the top and goes back up
      return { ...NONE, edge: lidEdge(t) };
    case "sparkle":
      return { ...NONE, sparkle: t < 900 ? 1 : 1 - (t - 900) / 300 };
  }
}

/** Pixels on one NeoPixel Jewel 7: pixel 0 in the center, 1-6 around the ring. */
export const JEWEL_PIXELS = 7;

/** The firmware picks a twinkle pixel from 0 to 3 x (both jewels' pixels): one about every third frame. */
export const TWINKLE_SLOTS = JEWEL_PIXELS * 2 * 3;

/** Each LED's own brightness (0..1) and hue shift (degrees from the state's color) for a frame. */
export interface PixelMotion {
  b: number;
  hue: number;
}

/** How far through a cycle of `periodMs` the clock is, 0..1 (as phase() in the firmware). */
const phase = (now: number, periodMs: number) => (now % periodMs) / periodMs;
/** Wraps `x` into [0, m). */
const wrap = (x: number, m: number) => ((x % m) + m) % m;

/**
 * How one LED moves in a state, the same as pixelMotion() in the firmware. `p` is the pixel (0 =
 * center, 1-6 = ring); the two eyes turn in mirror image. `flicker` is that LED's own candle flicker.
 *  - speaking: brightness follows the voice, from dim between words to full on loud ones, with a
 *    ripple of brightness and warmer hue going round, spinning faster the louder the voice (`spin`:
 *    how far round it is, in turns). LivelyEyes adds blinks and whirls on top.
 *  - thinking: a comet spins round the ring, its tail fading and drifting in hue
 *  - listening: a soft bright spot circles slowly round a steady center
 *  - sleeping: a faint ember drifting round
 *  - idle: every LED flickers on its own (flicker), a slow hue swirl (glow), or a blink
 */
export function pixelMotion(
  state: BodyState,
  style: EyeStyle,
  level: number,
  now: number,
  eye: number,
  p: number,
  flicker = 0.8,
  spin = 0,
): PixelMotion {
  const ring = p - 1;
  const dir = eye === 0 ? 1 : -1;
  const wave = (periodMs: number) => Math.cos(2 * Math.PI * (ring / 6 - dir * phase(now, periodMs)));
  switch (state) {
    case "speaking": {
      const base = 0.1 + 0.9 * level;
      if (p === 0) return { b: base, hue: 0 };
      const w = Math.cos(2 * Math.PI * (ring / 6 - dir * spin));
      return { b: base * (0.65 + 0.35 * w), hue: -12 * (1 + w) }; // toward warmer, never greener
    }
    case "thinking": {
      if (p === 0) return { b: 0.25 + 0.1 * Math.sin(now / 250), hue: 0 };
      // How far (in pixels) this LED is behind the comet's head, which goes round every 900 ms.
      const behind = wrap(6 * phase(now, 900) - dir * ring, 6);
      const k = 1 - behind / 6;
      return { b: 0.06 + 0.94 * k * k * k, hue: -12 * behind };
    }
    case "listening": {
      if (p === 0) return { b: 0.9, hue: 0 };
      const w = wave(2400);
      return { b: 0.8 + 0.2 * w, hue: 12 * w };
    }
    case "sleeping":
      return { b: p === 0 ? 0.2 : 0.225 + 0.075 * wave(6000), hue: 0 };
    case "idle":
      if (style === "flicker") return { b: flicker, hue: 0 };
      if (style === "blink" && now % 4000 < 150) return { b: 0.05, hue: 0 };
      return { b: 0.8, hue: p === 0 ? 0 : 15 * wave(4000) };
  }
}

/** How fast the speaking ripple goes round (turns a second): a lazy drift when quiet, quick when loud. */
export const speakSpinRate = (level: number) => 0.4 + 2.6 * level;

/** A whirl: the speaking ripple spins about 1.5 extra turns in this long. */
export const WHIRL_MS = 600;
/** The voice jumping to this loud starts a whirl... */
export const WHIRL_PEAK = 0.7;
/** ...at most this often... */
export const WHIRL_COOLDOWN_MS = 5000;
/** ...and a long answer gets one at least this often anyway. */
export const WHIRL_AT_LEAST_EVERY_MS = 9000;

/** The whirl's extra spin (turns a second) `t` ms after it started: up to 4, easing in and out. */
export const whirlRate = (t: number) => (t >= 0 && t < WHIRL_MS ? 4 * Math.sin((Math.PI * t) / WHIRL_MS) : 0);

/**
 * What keeps the eyes lively, the same as livelyStep() in the firmware. Speaking, idle and sleeping
 * eyes blink (the first 1.5-4 s after the eyes settle into one of them): every 3-6 s while speaking,
 * every 4-8 s otherwise. Listening and thinking have motion enough. Speaking also whirls when the
 * voice jumps loud.
 */
export class LivelyEyes {
  private blinks = false;
  private speaking = false;
  private lastLevel = 0;
  private blinkAt = -Infinity;
  private nextBlinkAt = Infinity;
  private whirlAt = -Infinity;
  private whirlBy = Infinity;

  constructor(private readonly random: () => number = Math.random) {}

  /**
   * Moves on to `now`: where the lid's edge is (see lidEdge) and the whirl's extra spin (turns a second).
   */
  step(now: number, state: BodyState, level: number): { lid: number; whirl: number } {
    const speaking = state === "speaking";
    const blinks = speaking || state === "idle" || state === "sleeping";
    if (blinks && !this.blinks) this.nextBlinkAt = now + 1500 + 2500 * this.random();
    if (speaking && !this.speaking) this.whirlBy = now + WHIRL_AT_LEAST_EVERY_MS;
    this.blinks = blinks;
    this.speaking = speaking;
    const rising = level >= WHIRL_PEAK && this.lastLevel < WHIRL_PEAK;
    this.lastLevel = level;
    if (blinks && now >= this.nextBlinkAt) {
      this.blinkAt = now;
      this.nextBlinkAt = now + (speaking ? 3000 + 3000 * this.random() : 4000 + 4000 * this.random());
    }
    if (speaking && ((rising && now - this.whirlAt >= WHIRL_COOLDOWN_MS) || now >= this.whirlBy)) {
      this.whirlAt = now;
      this.whirlBy = now + WHIRL_AT_LEAST_EVERY_MS;
    }
    return {
      lid: blinks ? lidEdge(now - this.blinkAt) : LID_OPEN,
      whirl: speaking ? whirlRate(now - this.whirlAt) : 0,
    };
  }
}

/**
 * Both preview jewels' pixel colors, frame by frame, the same as renderEyes() in the firmware: each
 * LED's motion for the state, with the flourish and then a blinking lid on top. In a sparkle, a rainbow spins around the
 * ring (the two eyes half a turn apart), the centers flash white first, and pixel `twinkle` (0-13,
 * counting both jewels; anything else for none) is white. Colors are on the full 0-255 scale; the
 * firmware also caps them at MAX_BRIGHTNESS to save current.
 */
export class JewelAnimator {
  /** Each LED's own candle flicker (both jewels), drifting toward a random target every ~16 ms. */
  private readonly flicker = new Array<number>(JEWEL_PIXELS * 2).fill(0.8);
  private lastStepAt = -Infinity;
  /** How far round the speaking ripple is (turns), and when it was last moved. */
  private spin = 0;
  private lastFrameAt: number | null = null;
  private readonly lively: LivelyEyes;

  constructor(private readonly random: () => number = Math.random) {
    this.lively = new LivelyEyes(random);
  }

  frame(color: Rgb, state: BodyState, level: number, style: EyeStyle, now: number, active: ActiveFlourish | null = null, twinkle = -1): Rgb[][] {
    if (now - this.lastStepAt >= 16) {
      this.lastStepAt = now;
      for (let i = 0; i < this.flicker.length; i++) this.flicker[i]! += (0.55 + 0.45 * this.random() - this.flicker[i]!) * 0.15;
    }
    const dt = this.lastFrameAt === null ? 0 : Math.min(Math.max(now - this.lastFrameAt, 0), 100);
    this.lastFrameAt = now;
    const lively = this.lively.step(now, state, level);
    this.spin = wrap(this.spin + (dt / 1000) * (speakSpinRate(level) + lively.whirl), 1);
    const t = active ? now - active.at : 0;
    const f = active ? flourishFrame(active.effect, t) : NONE;
    return [0, 1].map((eye) =>
      Array.from({ length: JEWEL_PIXELS }, (_, p) => {
        const i = eye * JEWEL_PIXELS + p;
        const m = pixelMotion(state, style, level, now, eye, p, this.flicker[i], this.spin);
        let rgb = scale(shiftHue(color, m.hue), (m.b + (1 - m.b) * f.wide) * f.lid);
        if (f.sparkle > 0) {
          // ColorHSV(p * 65536 / 6 + t * 66 + eye * 32768) in the firmware, in degrees.
          const spark = i === twinkle || (p === 0 && t < 200) ? ([255, 255, 255] as Rgb) : hue(p * 60 + (t * 66 * 360) / 65536 + eye * 180);
          rgb = mix(rgb, spark, f.sparkle);
        }
        return mix(rgb, LID_COLOR, lidCover(Math.min(lively.lid, f.edge), p));
      }),
    );
  }
}

/** `color` turned `degrees` round the color wheel, keeping its saturation and brightness. */
export function shiftHue(color: Rgb, degrees: number): Rgb {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (!degrees || d <= 0) return color;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return hsv(wrap(h + degrees / 60, 6), d, max);
}

/** The color at `h` (0..6, a sixth of the wheel each) with chroma `c` and value `v`. */
function hsv(h: number, c: number, v: number): Rgb {
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  const sector: Rgb[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = sector[Math.floor(h) % 6]!;
  return [r + m, g + m, b + m];
}

/** `a` moved `k` (0..1) of the way to `b`. */
function mix(a: Rgb, b: Rgb, k: number): Rgb {
  return k <= 0 ? a : (a.map((c, n) => c + (b[n]! - c) * k) as Rgb);
}

function scale([r, g, b]: Rgb, k: number): Rgb {
  return [r * k, g * k, b * k];
}

/** Fully saturated color at `degrees` around the color wheel. */
function hue(degrees: number): Rgb {
  return hsv(wrap(degrees, 360) / 60, 255, 255);
}
