export type Speaker = "visitor" | "creature" | "system";

export interface TranscriptLine {
  who: Speaker;
  text: string;
  /** When the line started, and when its latest fragment arrived. */
  start: number;
  at: number;
}

/**
 * The on-screen element of each of the newest `max` lines, so streaming fragments update the right
 * one. Adding past `max` forgets the oldest and hands back its element to remove from the page:
 * keeping every line ever shown would hold all of them (and their detached elements) all night.
 */
export class LineElements<E> {
  private readonly map = new Map<TranscriptLine, E>();

  constructor(private readonly max = 200) {}

  get(line: TranscriptLine): E | undefined {
    return this.map.get(line);
  }

  /** Remembers `element` for `line`; returns the elements of lines that no longer fit. */
  add(line: TranscriptLine, element: E): E[] {
    this.map.set(line, element);
    const evicted: E[] = [];
    for (const [old, el] of this.map) {
      if (this.map.size <= this.max) break;
      this.map.delete(old);
      evicted.push(el);
    }
    return evicted;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Groups streaming transcript fragments into lines per speaker. */
export class Transcript {
  readonly lines: TranscriptLine[] = [];
  private lastBySpeaker = new Map<Speaker, TranscriptLine>();
  private unfinished: TranscriptLine[] = [];

  constructor(
    private readonly gapMs = 2500,
    private readonly maxLines = 200,
  ) {}

  /** Appends a fragment exactly as received; returns the line it landed in. */
  add(who: Speaker, fragment: string, now: number): TranscriptLine {
    const last = this.lastBySpeaker.get(who);
    if (who !== "system" && last && now - last.at < this.gapMs) {
      last.text += fragment;
      last.at = now;
      return last;
    }
    const line = { who, text: who === "system" ? fragment : fragment.trimStart(), start: now, at: now };
    this.lines.push(line);
    this.unfinished.push(line);
    this.lastBySpeaker.set(who, line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    return line;
  }

  /**
   * Lines that are complete, oldest first, each returned once: system notes at once, speech once
   * its speaker has paused for the grouping gap. `all` also takes lines still being spoken.
   */
  takeFinished(now: number, all = false): TranscriptLine[] {
    const done = this.unfinished.filter((l) => all || l.who === "system" || now - l.at >= this.gapMs);
    this.unfinished = this.unfinished.filter((l) => !done.includes(l));
    return done;
  }

  /** Recent conversation as plain text for the vision backend. */
  recent(maxChars = 1500): string {
    const out: string[] = [];
    let size = 0;
    for (let i = this.lines.length - 1; i >= 0 && size < maxChars; i--) {
      const line = this.lines[i]!;
      if (line.who === "system") continue;
      const text = `${line.who === "visitor" ? "Visitor" : "Creature"}: ${line.text.trim()}`;
      out.unshift(text);
      size += text.length;
    }
    return out.join("\n");
  }
}
