import { BODY_STATES, type BodyMode, type BodyState, type CharacterInfo, type EyePalette } from "../../shared/types.ts";

/**
 * Line protocol spoken to firmware/creature_body (115200 baud, "\n"-terminated):
 *   M eyes,jaw,relay   enable body modes (any subset; "M none" disables all)
 *   P <state> r g b    eye color for a state (0-255 each)
 *   Y <style>          idle eye style: flicker | glow | blink
 *   S <state>          current state: sleeping | idle | listening | thinking | speaking
 *   L <0-255>          current voice loudness (drives eye brightness and jaw)
 * Any line also counts as a heartbeat; the firmware fails safe after 2 s of silence.
 */

export function encodeModes(modes: readonly BodyMode[]): string {
  return `M ${modes.length ? modes.join(",") : "none"}`;
}

export function encodePalette(eyes: EyePalette): string[] {
  return BODY_STATES.map((s) => {
    const [r, g, b] = eyes[s];
    return `P ${s} ${clampByte(r)} ${clampByte(g)} ${clampByte(b)}`;
  });
}

export function encodeEyeStyle(style: CharacterInfo["eyeStyle"]): string {
  return `Y ${style}`;
}

export function encodeState(state: BodyState): string {
  if (!BODY_STATES.includes(state)) throw new Error(`Unknown body state "${state}"`);
  return `S ${state}`;
}

/** Level is 0..1 from the browser; the firmware gets 0..255. */
export function encodeLevel(level: number): string {
  return `L ${clampByte(Math.round(level * 255))}`;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}
