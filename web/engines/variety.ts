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

export class Variety {
  private readonly last = new Map<readonly string[], number>();

  constructor(private readonly random: () => number = Math.random) {}

  /** For a full greeting: an opening and a way to finish. */
  greeting(): string {
    return ` For variety this time: ${this.pick(OPENINGS)} ${this.pick(VERDICTS)} Use your own words.`;
  }

  /** For a quick hello, before the costumes are known. */
  opening(): string {
    return ` For variety this time: ${this.pick(OPENINGS)}`;
  }

  /** For the compliments after a quick hello. */
  verdict(): string {
    return ` For variety this time: ${this.pick(VERDICTS)}`;
  }

  /** A random entry, never the same one twice in a row. */
  private pick(list: readonly string[]): string {
    let i = Math.floor(this.random() * list.length) % list.length;
    if (i === this.last.get(list)) i = (i + 1) % list.length;
    this.last.set(list, i);
    return list[i]!;
  }
}
