import type { BodyState, CharacterInfo, EyeFlourish, Rgb } from "../shared/types.ts";
import type { GreetingKind } from "./engines/types.ts";

/**
 * Eye flourishes for the dashboard preview: the same timings and shapes as flourishFrame() in
 * firmware/creature_body/creature_body.ino, so the preview shows what the pumpkin's eyes do.
 */

/** How long each flourish lasts (ms); keep in sync with FLOURISH_MS in the firmware. */
export const FLOURISH_MS: Record<EyeFlourish, number> = { sparkle: 1200, gasp: 900, slowblink: 1400 };

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
}

type EyeStyle = CharacterInfo["eyeStyle"];

const NONE: FlourishFrame = { lid: 1, wide: 0, sparkle: 0 };

const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const blinkLid = (t: number, start: number, end: number) => (t < start || t >= end ? 1 : Math.abs((2 * (t - start)) / (end - start) - 1));

/** What `effect` does to the eyes `t` ms after it started (nothing once it's over). */
export function flourishFrame(effect: EyeFlourish, t: number): FlourishFrame {
  if (t < 0 || t >= FLOURISH_MS[effect]) return NONE;
  switch (effect) {
    case "gasp":
      return { lid: blinkLid(t, 0, 150) * blinkLid(t, 220, 370), wide: t >= 370 ? 1 - ease((t - 370) / 530) : 0, sparkle: 0 };
    case "slowblink":
      return { lid: t < 550 ? 1 - ease(t / 550) : t < 850 ? 0 : ease((t - 850) / 550), wide: 0, sparkle: 0 };
    case "sparkle":
      return { lid: 1, wide: 0, sparkle: t < 900 ? 1 : 1 - (t - 900) / 300 };
  }
}

/** Pixels on one NeoPixel Jewel 7: pixel 0 in the center, 1-6 around the ring. */
export const JEWEL_PIXELS = 7;

/** The firmware picks a twinkle pixel from 0 to 3 x (both jewels' pixels): one about every third frame. */
export const TWINKLE_SLOTS = JEWEL_PIXELS * 2 * 3;

/**
 * One preview jewel's 7 pixel colors, the same per pixel as renderEyes() in the firmware: the state's
 * color at `brightness`, with the flourish on top. In a sparkle, a rainbow spins around the ring (the
 * two eyes half a turn apart), the center flashes white first, and pixel `twinkle` (if 0-6) is white.
 * Colors are on the full 0-255 scale; the firmware also caps them at MAX_BRIGHTNESS to save current.
 */
export function jewelLook(color: Rgb, brightness: number, active: ActiveFlourish | null, now: number, eye: number, twinkle = -1): Rgb[] {
  const t = active ? now - active.at : 0;
  const f = active ? flourishFrame(active.effect, t) : NONE;
  const base = scale(color, (brightness + (1 - brightness) * f.wide) * f.lid);
  return Array.from({ length: JEWEL_PIXELS }, (_, p) => {
    if (f.sparkle <= 0) return base;
    // ColorHSV(p * 65536 / 6 + t * 66 + eye * 32768) in the firmware, in degrees.
    const spark = p === twinkle || (p === 0 && t < 200) ? ([255, 255, 255] as Rgb) : hue(p * 60 + (t * 66 * 360) / 65536 + eye * 180);
    return base.map((c, i) => c + (spark[i]! - c) * f.sparkle) as Rgb;
  });
}

/**
 * Eye brightness 0..1 for a state before any flourish, as stateBrightness() in the firmware,
 * including its candle flicker: a drift toward a random target every ~16 ms frame.
 */
export class EyeBrightness {
  private flicker = 0.8;
  private lastStepAt = -Infinity;

  constructor(private readonly random: () => number = Math.random) {}

  at(state: BodyState, level: number, style: EyeStyle, now: number): number {
    switch (state) {
      case "speaking":
        return 0.35 + 0.65 * level;
      case "thinking":
        return 0.45 + 0.35 * Math.sin(now / 250);
      case "sleeping":
        return 0.25;
      default:
        if (style === "flicker") {
          if (now - this.lastStepAt >= 16) {
            this.lastStepAt = now;
            this.flicker += (0.55 + 0.45 * this.random() - this.flicker) * 0.15;
          }
          return this.flicker;
        }
        if (style === "blink" && now % 4000 < 150) return 0.05;
        return 0.8;
    }
  }
}

function scale([r, g, b]: Rgb, k: number): Rgb {
  return [r * k, g * k, b * k];
}

/** Fully saturated color at `degrees` around the color wheel. */
function hue(degrees: number): Rgb {
  const h = (((degrees % 360) + 360) % 360) / 60;
  const x = 255 * (1 - Math.abs((h % 2) - 1));
  const sector: Rgb[] = [
    [255, x, 0],
    [x, 255, 0],
    [0, 255, x],
    [0, x, 255],
    [x, 0, 255],
    [255, 0, x],
  ];
  return sector[Math.floor(h) % 6]!;
}
