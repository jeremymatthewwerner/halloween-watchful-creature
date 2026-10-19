/**
 * Reads the soak run's timeline against what the page did: were visitors greeted, and was the
 * (billed) voice session ever left open on an empty porch? Pure, so it's unit tested.
 * All times are wall ms since the start of the run.
 */
import { REAL, type Step, type VisitKind } from "./scenario.ts";

export type Span = [from: number, to: number];

/** A context append the page sent to the voice session. */
export interface Append {
  t: number;
  type: string;
}

/**
 * When a voice session may be open: from each arrival (or flicker, or Greet now) until the porch
 * has been empty long enough to close it (LEAVE_MS + IDLE_CLOSE_SECONDS), plus `slackMs` for
 * vision, a speaking creature and the close handshake.
 */
export function awakeWindows(steps: readonly Step[], idleCloseSeconds: number, slackMs = 20_000): Span[] {
  const tail = REAL.leaveMs + idleCloseSeconds * 1000 + slackMs;
  const spans: Span[] = [];
  let arrivedAt: number | null = null;
  for (const s of steps) {
    if (s.do === "arrive" && arrivedAt === null) arrivedAt = s.at;
    if (s.do === "leave" && arrivedAt !== null) {
      spans.push([arrivedAt, s.at + tail]);
      arrivedAt = null;
    }
    if (s.do === "flicker") spans.push([s.at, s.at + REAL.sightingGraceMs + slackMs]);
    // Greet now wakes the session even on an empty porch; it should still go back to sleep.
    if (s.do === "remote" && s.command.type === "greet") spans.push([s.at, s.at + tail]);
  }
  if (arrivedAt !== null) spans.push([arrivedAt, Infinity]);
  return merge(spans);
}

/** Overlapping spans joined, in order. */
export function merge(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

/** How much of `span` lies outside all of `windows` (merged). */
export function outside(span: Span, windows: readonly Span[]): number {
  let covered = 0;
  for (const [from, to] of windows) covered += Math.max(0, Math.min(span[1], to) - Math.max(span[0], from));
  return Math.max(0, span[1] - span[0] - covered);
}

export interface GreetingReport {
  /** Per kind of arrival: greeted (spoken), silent (background update only), none (nothing sent). */
  byKind: Record<VisitKind, { greeted: number; silent: number; none: number }>;
  /** New groups (new arrivals and swap-ins) that weren't greeted in time. */
  missed: { at: number; kind: VisitKind; got: "silent" | "none" }[];
  /** Arrivals not judged: kill switch on, or OpenAI down. */
  skipped: number;
}

const SPOKEN = new Set(["session.commentary.append", "session.instructions.append"]);

/**
 * For each arrival, what the page sent to the voice session within `withinMs`. New groups must be
 * greeted; the same group back soon may get silence (that's by design), so returns are only counted.
 */
export function greetings(steps: readonly Step[], appends: readonly Append[], quiet: readonly Span[], withinMs = 20_000): GreetingReport {
  const byKind = { new: z(), "return-soon": z(), "return-later": z(), "swap-in": z() };
  const missed: GreetingReport["missed"] = [];
  let skipped = 0;
  const sorted = [...appends].sort((a, b) => a.t - b.t);
  for (const s of steps) {
    if (s.do !== "arrive") continue;
    if (quiet.some(([from, to]) => s.at >= from && s.at <= to)) {
      skipped++;
      continue;
    }
    const answer = sorted.filter((a) => a.t >= s.at && a.t <= s.at + withinMs);
    const got = answer.some((a) => SPOKEN.has(a.type)) ? "greeted" : answer.length ? "silent" : "none";
    byKind[s.kind][got]++;
    if (got !== "greeted" && (s.kind === "new" || s.kind === "swap-in")) missed.push({ at: s.at, kind: s.kind, got });
  }
  return { byKind, missed, skipped };
}

function z() {
  return { greeted: 0, silent: 0, none: 0 };
}
