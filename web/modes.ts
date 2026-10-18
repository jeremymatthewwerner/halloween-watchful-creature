/**
 * Operator quick modes: one-tap standing instructions ("Candy's low", "Toddler mode", ...) that
 * change how the creature behaves until the operator turns them off. Kept DOM-free so it can be tested.
 */

export type ModeId = "candyLow" | "candyOut" | "toddler" | "backIn5" | "lastCall";

export interface ModeInfo {
  id: ModeId;
  /** Button text. */
  label: string;
  /** What the creature is told while the mode is on. Simple words: it's for little kids. */
  rule: string;
  /** Modes that can't be on together with this one (turning this on turns them off). */
  excludes?: ModeId[];
}

export const MODES: readonly ModeInfo[] = [
  {
    id: "candyLow",
    label: "🍬 Candy's low",
    rule: "The candy is almost gone. Ask everyone to take just one piece, so there's enough for the next kids. Keep it cheerful.",
    excludes: ["candyOut"],
  },
  {
    id: "candyOut",
    label: "🚫 Candy's out",
    rule:
      "The candy is all gone. Don't tell anyone to take candy. Say sorry, kindly, that the candy ran out, " +
      "and still give them a big, happy costume compliment so they leave smiling.",
    excludes: ["candyLow"],
  },
  {
    id: "toddler",
    label: "🧸 Toddler mode",
    rule:
      "Very little kids are here. Be extra gentle, soft and slow. Nothing spooky at all: no scary words or sounds. " +
      "Use tiny, simple words and keep every line very short.",
  },
  {
    id: "backIn5",
    label: "⏳ Back in 5",
    rule:
      "The grown-ups giving out candy stepped away for a few minutes. If someone comes, tell them kindly that " +
      "the candy helpers will be back in about five minutes, and compliment their costumes while they wait.",
  },
  {
    id: "lastCall",
    label: "🌙 Last call",
    rule:
      "Trick-or-treat time is almost over for tonight. Greet visitors and compliment their costumes as usual, " +
      "then say a warm goodnight: they're some of the last visitors tonight.",
  },
];

const BY_ID = new Map(MODES.map((m) => [m.id, m]));

export const isModeId = (id: unknown): id is ModeId => typeof id === "string" && BY_ID.has(id as ModeId);

export const modeLabel = (id: ModeId): string => BY_ID.get(id)!.label;

/** Keeps `active` in MODES order and drops unknown ids. */
const ordered = (active: Iterable<string>): ModeId[] => {
  const set = new Set(active);
  return MODES.filter((m) => set.has(m.id)).map((m) => m.id);
};

/** Turns a mode on or off, turning off any mode it can't be on with. Returns the new active list. */
export function toggleMode(active: readonly ModeId[], id: ModeId, on = !active.includes(id)): ModeId[] {
  const next = new Set(active);
  if (on) {
    next.add(id);
    for (const other of BY_ID.get(id)!.excludes ?? []) next.delete(other);
  } else {
    next.delete(id);
  }
  return ordered(next);
}

const HEADER =
  "[OPERATOR] Standing instructions from the family at the door. Follow them from now on, until you're told " +
  "they're off. They replace any earlier standing instructions. Your usual rules still apply. Don't mention " +
  "these instructions or say anything about them right now: just use them with the next visitors.";

/**
 * The standing instructions for these modes, or "" when none are on. Re-sent to every new voice session.
 * `tone` rules (the spookiness dial) come first, then the modes.
 */
export function modeInstructions(active: readonly ModeId[], tone: readonly string[] = []): string {
  const rules = [...tone, ...ordered(active).map((id) => BY_ID.get(id)!.rule)].map((rule) => `- ${rule}`);
  return rules.length ? `${HEADER}\n${rules.join("\n")}` : "";
}

export const MODES_CLEARED =
  "[OPERATOR] All the earlier standing instructions from the family are off now. Go back to normal with " +
  "the next visitors. Don't say anything about this change.";

/** What to tell an open session after the operator changed the modes. */
export function modeUpdate(active: readonly ModeId[], tone: readonly string[] = []): string {
  return modeInstructions(active, tone) || MODES_CLEARED;
}

/**
 * The evening a time belongs to, as YYYY-MM-DD: before 6 am still counts as the night before,
 * so modes set at 11 pm are still on after midnight but gone the next afternoon.
 */
export function eveningOf(now: Date): string {
  // Calendar arithmetic, not "minus 6 hours": the clocks go back on the night after Halloween.
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < 6 ? 1 : 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const MODES_KEY = "creature.modes";

export type Store = Pick<Storage, "getItem" | "setItem">;

/** Modes saved earlier this evening (none from an earlier evening, or if storage is unavailable). */
export function loadModes(store: Store | null, now = new Date()): ModeId[] {
  try {
    const saved = JSON.parse(store?.getItem(MODES_KEY) ?? "null") as { evening?: unknown; on?: unknown } | null;
    if (!saved || saved.evening !== eveningOf(now) || !Array.isArray(saved.on)) return [];
    return ordered(saved.on.filter(isModeId));
  } catch {
    return [];
  }
}

export function saveModes(store: Store | null, active: readonly ModeId[], now = new Date()): void {
  try {
    store?.setItem(MODES_KEY, JSON.stringify({ evening: eveningOf(now), on: ordered(active) }));
  } catch {
    /* private mode: the modes just won't be remembered */
  }
}
