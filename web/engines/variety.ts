import type { SpookyLevel } from "../spookiness.ts";

/**
 * Random style twists added to greeting requests. Left alone, the voice model settles into the same
 * opening and verdict (and every new session starts with no memory of the last), so each greeting
 * asks for a different opening and a different way to finish. Character-neutral: works for every persona.
 */
export const OPENINGS = [
  "Open with a big dramatic gasp.",
  "Open by asking them a fun question about their costume.",
  "Open by announcing their costume like a grand introduction.",
  "Open with a compliment about one tiny detail.",
  "Open with a fun sound effect.",
  "Open in a secret-sounding whisper, then burst with excitement.",
  "Open by pretending to be so dazzled you're speechless for a second.",
  "Open by guessing what their costume can do.",
] as const;

export const VERDICTS = [
  "Finish with a verdict you invent on the spot, nothing you've said before.",
  "Skip the verdict and finish with a playful question for them instead.",
  "Finish by giving them an award with a made-up name.",
  "Finish with a verdict that counts something Halloween-y.",
  "Finish by telling them which shelf of your Hall of Fame this costume goes on.",
  "Finish with a tiny made-up cheer or rhyme.",
] as const;

/**
 * Extra twists for the spookiness dial (0 gentle ... 3 scary for teens), mixed in with the ones above.
 * Playful (1) is the creature's normal and adds none.
 */
export const SPOOKY_OPENINGS: Record<SpookyLevel, readonly string[]> = {
  0: ["Open with a big, sunny hello, like they're the best thing you've seen all day."],
  1: [],
  2: [
    'Open with a slow, spooky "ooooo", then a friendly laugh.',
    "Open with a creaky, eerie voice for one line, then switch back to your fun self.",
  ],
  3: [
    "Open with a long, eerie pause, like the start of a ghost story.",
    "Open in a low, creepy whisper, as if the wind just told you about their costume.",
    "Open with a creaky, eerie voice for one line, then switch back to your fun self.",
  ],
};

export const SPOOKY_VERDICTS: Record<SpookyLevel, readonly string[]> = {
  0: ["Finish with a sweet, happy cheer for them."],
  1: [],
  2: ["Finish with a spooky-silly verdict that counts ghosts, bats or cobwebs.", "Finish with a quick spooky joke."],
  3: [
    "Finish with one spine-tingly ghost-story line, then a big friendly laugh.",
    "Finish with a spooky-silly verdict that counts ghosts, bats or cobwebs.",
  ],
};

/**
 * For big groups (web/bigGroup.ts): openings for the whole group rather than one costume, and finishes that
 * are one fun group moment, not a verdict per costume. The dial's spooky openings mix in as usual.
 */
export const GROUP_OPENINGS = [
  "Open with a big gasp at how many of you there are.",
  "Open by announcing the group like a parade marching in.",
  "Open by pretending to count everyone and happily losing track.",
  "Open with a fun sound effect.",
  "Open by welcoming them like a whole team arriving.",
] as const;

export const GROUP_FINISHES = [
  'Finish by getting everybody to shout "trick or treat!" together.',
  "Finish with one quick Halloween joke for the whole group.",
  'Finish with a quick countdown for everyone: "three, two, one, candy time!"',
  "Finish with a tiny made-up cheer for the whole group.",
] as const;

export const SPOOKY_GROUP_FINISHES: Record<SpookyLevel, readonly string[]> = {
  0: ["Finish with a sweet, happy cheer for the whole group."],
  1: [],
  2: ["Finish with one quick spooky joke for the whole group."],
  3: ['Finish by getting everybody to shout "trick or treat!" in their spookiest voices.'],
};

export class Variety {
  /** The twist each kind last gave, so the next one is different. */
  private readonly last = new Map<string, string>();

  constructor(
    private readonly random: () => number = Math.random,
    /** The spookiness dial right now (1, playful, when not given). */
    private readonly spookiness: () => SpookyLevel = () => 1,
  ) {}

  /** For a full greeting: an opening and a way to finish. */
  greeting(): string {
    return ` For variety this time: ${this.opener()} ${this.finisher()} Use your own words.`;
  }

  /** For a quick hello, before the costumes are known. */
  opening(): string {
    return ` For variety this time: ${this.opener()}`;
  }

  /** For the compliments after a quick hello. */
  verdict(): string {
    return ` For variety this time: ${this.finisher()}`;
  }

  /** For a big group's greeting: a group opening and a group moment to finish. */
  groupGreeting(): string {
    return ` For variety this time: ${this.groupOpener()} ${this.groupFinisher()} Use your own words.`;
  }

  /** For a big group's quick hello. */
  groupOpening(): string {
    return ` For variety this time: ${this.groupOpener()}`;
  }

  /** For a big group's shout-outs after a quick hello. */
  groupFinish(): string {
    return ` For variety this time: ${this.groupFinisher()}`;
  }

  private groupOpener(): string {
    return this.pick("group-opening", [...GROUP_OPENINGS, ...SPOOKY_OPENINGS[this.spookiness()]]);
  }

  private groupFinisher(): string {
    return this.pick("group-finish", [...GROUP_FINISHES, ...SPOOKY_GROUP_FINISHES[this.spookiness()]]);
  }

  private opener(): string {
    return this.pick("opening", [...OPENINGS, ...SPOOKY_OPENINGS[this.spookiness()]]);
  }

  private finisher(): string {
    return this.pick("verdict", [...VERDICTS, ...SPOOKY_VERDICTS[this.spookiness()]]);
  }

  /** A random entry, never the same one twice in a row. */
  private pick(kind: string, list: readonly string[]): string {
    let i = Math.floor(this.random() * list.length) % list.length;
    if (list[i] === this.last.get(kind)) i = (i + 1) % list.length;
    this.last.set(kind, list[i]!);
    return list[i]!;
  }
}
