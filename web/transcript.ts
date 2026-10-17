export type Speaker = "visitor" | "creature" | "system";

export interface TranscriptLine {
  who: Speaker;
  text: string;
  at: number;
}

/** Groups streaming transcript fragments into lines per speaker. */
export class Transcript {
  readonly lines: TranscriptLine[] = [];
  private lastBySpeaker = new Map<Speaker, TranscriptLine>();

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
    const line = { who, text: who === "system" ? fragment : fragment.trimStart(), at: now };
    this.lines.push(line);
    this.lastBySpeaker.set(who, line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    return line;
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
