import type { EyeFlourish, Rgb } from "../shared/types.ts";
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

/**
 * One preview eye's color and brightness: the state's look (`color` at `brightness`) with the
 * flourish on top. `eye` is 0 or 1; the two eyes' rainbows run half a turn apart, as on the jewels.
 */
export function eyeLook(color: Rgb, brightness: number, active: ActiveFlourish | null, now: number, eye: number): { rgb: Rgb; brightness: number } {
  if (!active) return { rgb: scale(color, brightness), brightness };
  const t = now - active.at;
  const f = flourishFrame(active.effect, t);
  const b = (brightness + (1 - brightness) * f.wide) * f.lid;
  let rgb = scale(color, b);
  if (f.sparkle > 0) {
    const spark = t < 200 ? ([255, 255, 255] as Rgb) : hue((t / 1000) * 360 + eye * 180);
    rgb = rgb.map((c, i) => c + (spark[i]! - c) * f.sparkle) as Rgb;
  }
  return { rgb, brightness: b + (1 - b) * f.sparkle };
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
