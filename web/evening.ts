/**
 * What the creature has said and seen tonight, kept across voice sessions and page reloads.
 *
 * Every GPT-Live session starts with no memory, and the session sleeps after a few minutes of empty
 * porch, so on its own the creature reuses its favourite lines all night. This store keeps:
 *  - its last ~20 spoken lines, handed to each new session as background ("don't reuse these"),
 *  - how many visitor groups it has greeted, and a rough tally of costumes seen, offered with each
 *    greeting so it can riff ("visitor group number 50!", "fourth dinosaur tonight!").
 * Character-neutral. Saved in localStorage for the evening and reset the next day.
 */

/** The bits of `Storage` we use (localStorage in the browser, a fake in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EveningState {
  /** Which evening this is (see `eveningOf`). */
  evening: string;
  /** The creature's recent spoken lines, oldest first. */
  said: string[];
  /** Visitor groups greeted tonight. */
  groups: number;
  /** Costume kind → number of greeted groups that had one. */
  costumes: Record<string, number>;
}

export const STORAGE_KEY = "creature.evening";
/** Spoken lines remembered. */
export const MAX_LINES = 20;
/** Each remembered line is shortened to about this many characters (keeping its start and end). */
export const MAX_LINE_CHARS = 120;
/** GPT-Live takes ≤ 500 tokens per context append: keep the memory well under that. */
export const MAX_MEMORY_CHARS = 1800;
/** Offer a milestone every this many groups. */
export const MILESTONE_EVERY = 25;

/**
 * Costume kinds counted from the vision model's descriptions. Deliberately conservative: costumes,
 * not body or age words. Words that are often props rather than costumes (a pumpkin candy bucket,
 * a hat) are left out. The voice model reads the descriptions itself for anything not listed.
 */
const COSTUME_KINDS: [string, RegExp][] = [
  ["superhero", /\bsuper ?heroe?s?\b|spider-?man|batman|superman|wonder woman|captain america|iron man|\bhulk\b/],
  ["witch", /\bwitch(es)?\b/],
  ["wizard", /\bwizards?\b/],
  ["ghost", /\bghosts?\b/],
  ["vampire", /\bvampires?\b|\bdracula\b/],
  ["skeleton", /\bskeletons?\b/],
  ["zombie", /\bzombies?\b/],
  ["mummy", /\bmumm(y|ies)\b/],
  ["werewolf", /\bwerewol(f|ves)\b/],
  ["dinosaur", /\bdinosaurs?\b|\bdinos?\b|t-?rex\b/],
  ["dragon", /\bdragons?\b/],
  ["unicorn", /\bunicorns?\b/],
  ["princess", /\bprincess(es)?\b/],
  ["fairy", /\bfair(y|ies)\b/],
  ["pirate", /\bpirates?\b/],
  ["ninja", /\bninjas?\b/],
  ["knight", /\bknights?\b/],
  ["astronaut", /\bastronauts?\b/],
  ["robot", /\brobots?\b/],
  ["alien", /\baliens?\b/],
  ["devil", /\bdevils?\b/],
  ["angel", /\bangels?\b/],
  ["clown", /\bclowns?\b/],
  ["cowboy", /\bcow(boy|girl)s?\b/],
  ["mermaid", /\bmermaids?\b/],
  ["shark", /\bsharks?\b/],
  ["bee", /\bbumble ?bees?\b|\bbees?\b/],
  ["butterfly", /\bbutterfl(y|ies)\b/],
  ["black cat", /\bblack cats?\b|\bcat ears\b/],
  ["firefighter", /\bfire ?(fighter|man|woman)s?\b/],
];

/** The costume kinds a vision description mentions. */
export function costumeKinds(description: string): string[] {
  const text = description.toLowerCase();
  return COSTUME_KINDS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

/**
 * The evening a moment belongs to: the local date, with the day running noon to noon,
 * so a party that goes past midnight is still one evening.
 */
export function eveningOf(now: Date): string {
  const d = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** localStorage, or null where it's unavailable (private mode, tests). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Shortens a line, keeping its start (the opening) and end (the verdict). */
function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= MAX_LINE_CHARS) return line;
  const half = Math.floor((MAX_LINE_CHARS - 3) / 2);
  return `${line.slice(0, half).trimEnd()} … ${line.slice(-half).trimStart()}`;
}

export class EveningMemory {
  private state: EveningState;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = this.load();
  }

  /** Tonight's state (a fresh one if the evening changed since it was saved). */
  get current(): Readonly<EveningState> {
    return this.fresh();
  }

  /** Remember one finished line the creature said. */
  recordLine(text: string): void {
    const line = shorten(text);
    if (line.length < 4) return;
    const state = this.fresh();
    state.said = state.said.filter((l) => l !== line);
    state.said.push(line);
    if (state.said.length > MAX_LINES) state.said.splice(0, state.said.length - MAX_LINES);
    this.save();
  }

  /**
   * Count a newly greeted group and the costumes in its description. `previous` (for a group that
   * grew) is the description from before, so costumes already counted aren't counted again.
   * Returns the group's number tonight.
   */
  recordGroup(description: string | null, previous = ""): number {
    const state = this.fresh();
    state.groups++;
    if (description) {
      const before = new Set(costumeKinds(previous));
      for (const kind of costumeKinds(description)) {
        if (!before.has(kind)) state.costumes[kind] = (state.costumes[kind] ?? 0) + 1;
      }
    }
    this.save();
    return state.groups;
  }

  /**
   * Optional fun facts for a greeting, right after `recordGroup` (null before any group).
   * Offered, not scripted: the creature can riff on a streak or a milestone, or ignore it.
   */
  tonightContext(description: string | null): string | null {
    const { groups, costumes } = this.fresh();
    if (!groups) return null;
    const facts = [`these visitors are group number ${groups} you've greeted tonight`];
    const repeats = (description ? costumeKinds(description) : [])
      .filter((kind) => (costumes[kind] ?? 0) >= 2)
      .map((kind) => `${ordinal(costumes[kind]!)} ${kind} tonight`);
    if (repeats.length) facts.push(`their costumes include the ${repeats.join(" and the ")}`);
    const top = topCostumes(costumes, 5);
    if (top) facts.push(`costumes so far tonight (groups): ${top}`);
    const milestone =
      groups % MILESTONE_EVERY === 0 ? ` Group ${groups} is a milestone: you could celebrate it ("visitor number ${groups}!").` : "";
    return (
      ` [TONIGHT] Optional fun facts, only if they fit naturally (don't recite numbers every time): ${facts.join("; ")}.` +
      `${milestone} You could riff on a costume streak or a "best one so far", but never compare visitors unkindly.`
    );
  }

  /** Background for a new voice session: what it already said tonight, so it says new things. */
  memoryContext(): string | null {
    const { said, groups, costumes } = this.fresh();
    if (!said.length && !groups) return null;
    const parts = ["[MEMORY] Background only, don't respond to this or mention it."];
    if (groups) {
      const top = topCostumes(costumes, 8);
      parts.push(`Tonight so far you've greeted ${groups} visitor group${groups === 1 ? "" : "s"}${top ? `; costumes seen: ${top}` : ""}.`);
    }
    if (said.length) {
      parts.push("Things you've already said tonight: don't reuse these lines, jokes or verdicts, find fresh ones:");
      const fixed = parts.join(" ").length;
      const lines = [...said];
      while (lines.length && fixed + lines.reduce((n, l) => n + l.length + 4, 0) > MAX_MEMORY_CHARS) lines.shift();
      parts.push(...lines.map((l) => `\n- "${l}"`));
    }
    return parts.join(" ").replace(/ \n/g, "\n");
  }

  private fresh(): EveningState {
    const evening = eveningOf(this.now());
    if (this.state.evening !== evening) this.state = empty(evening);
    return this.state;
  }

  private load(): EveningState {
    const evening = eveningOf(this.now());
    try {
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "null") as Partial<EveningState> | null;
      if (saved?.evening === evening) {
        return {
          evening,
          said: Array.isArray(saved.said) ? saved.said.filter((l) => typeof l === "string").slice(-MAX_LINES) : [],
          groups: Number(saved.groups) || 0,
          costumes: saved.costumes && typeof saved.costumes === "object" ? { ...saved.costumes } : {},
        };
      }
    } catch {
      /* unreadable: start the evening fresh */
    }
    return empty(evening);
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* full or private mode: the memory just won't survive a reload */
    }
  }
}

function empty(evening: string): EveningState {
  return { evening, said: [], groups: 0, costumes: {} };
}

function topCostumes(costumes: Record<string, number>, n: number): string {
  return Object.entries(costumes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

function ordinal(n: number): string {
  const words = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  if (n < words.length) return words[n]!;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
