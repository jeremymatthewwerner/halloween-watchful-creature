/**
 * The spookiness dial: how spooky the creature is tonight, from 0 (gentle) to 3 (scary, for teens).
 * Sent as a standing instruction, alongside the quick modes. Kept DOM-free so it can be tested.
 *
 * 1 (playful) is the creature's normal, spooky-cute self, so it adds no instruction at all.
 * Toddler mode holds the dial at 0: tiny kids get gentle whatever the dial says.
 */
import { eveningOf, type ModeId, type Store } from "./modes.ts";

export type SpookyLevel = 0 | 1 | 2 | 3;
/** What the operator picked: a level, or "auto" to follow the time of night. */
export type SpookyChoice = SpookyLevel | "auto";

export interface SpookyInfo {
  level: SpookyLevel;
  /** Button text. */
  label: string;
  /** One word for logs and hints. */
  name: string;
  /** What the creature is told at this level ("" for the normal, playful level). Simple words. */
  rule: string;
}

export const SPOOKY_LEVELS: readonly SpookyInfo[] = [
  {
    level: 0,
    label: "🌼 Gentle",
    name: "gentle",
    rule:
      "Spookiness tonight: gentle. Keep everything sunny, sweet and cheerful. Nothing scary at all: " +
      "no spooky voices, creepy sounds or scary jokes.",
  },
  { level: 1, label: "🎃 Playful", name: "playful", rule: "" },
  {
    level: 2,
    label: "👻 Spooky",
    name: "spooky",
    rule:
      "Spookiness tonight: spooky. Now and then, not every line, use a slow, eerie voice for a moment, a creaky laugh " +
      "or a ghostly \"ooooo\", and tell spooky jokes. Then turn friendly again. If a little kid looks unsure, stop and be cheerful.",
  },
  {
    level: 3,
    label: "🦇 Scary (teens)",
    name: "scary",
    rule:
      "Spookiness tonight: scary, for teens. Be creepier and more dramatic: a low, eerie voice, long pauses, spooky " +
      "sounds, a whispered ghost-story line. Still never gory, cruel or mean; no jump-scares. If a young child " +
      "walks up, or anyone seems scared or says so, switch to gentle and cheerful right away.",
  },
];

export const DEFAULT_SPOOKINESS: SpookyChoice = 1;

/** The "auto" schedule: gentle until 7 pm, playful from 7, spooky from 8 pm until morning. Never auto-scary. */
export const AUTO_HINT = "gentle until 7 pm, playful 7 to 8, spooky after 8";

export function autoLevel(now: Date): SpookyLevel {
  const hour = now.getHours();
  if (hour >= 20 || hour < 6) return 2;
  return hour >= 19 ? 1 : 0;
}

export const isSpookyChoice = (value: unknown): value is SpookyChoice =>
  value === "auto" || value === 0 || value === 1 || value === 2 || value === 3;

export const spookyInfo = (level: SpookyLevel): SpookyInfo => SPOOKY_LEVELS[level]!;

/** The level the creature actually uses now: Toddler mode means gentle, "auto" follows the clock. */
export function resolveSpookiness(choice: SpookyChoice, active: readonly ModeId[], now = new Date()): SpookyLevel {
  if (active.includes("toddler")) return 0;
  return choice === "auto" ? autoLevel(now) : choice;
}

/** The tone rules for this level, to go with the quick modes' standing instructions. */
export function spookyRules(level: SpookyLevel): string[] {
  const { rule } = spookyInfo(level);
  return rule ? [rule] : [];
}

export const SPOOKY_KEY = "creature.spookiness";

/** The dial as set earlier this evening (the default from an earlier evening, or if storage is unavailable). */
export function loadSpookiness(store: Store | null, now = new Date()): SpookyChoice {
  try {
    const saved = JSON.parse(store?.getItem(SPOOKY_KEY) ?? "null") as { evening?: unknown; choice?: unknown } | null;
    return saved && saved.evening === eveningOf(now) && isSpookyChoice(saved.choice) ? saved.choice : DEFAULT_SPOOKINESS;
  } catch {
    return DEFAULT_SPOOKINESS;
  }
}

export function saveSpookiness(store: Store | null, choice: SpookyChoice, now = new Date()): void {
  try {
    store?.setItem(SPOOKY_KEY, JSON.stringify({ evening: eveningOf(now), choice }));
  } catch {
    /* private mode: the dial just won't be remembered */
  }
}
