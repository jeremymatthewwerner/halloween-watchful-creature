/**
 * The soak test's numbers: samples over time, growth slopes, pass/fail checks and the CSV.
 * Pure, so it's unit tested.
 */

/** One sample: ms since the start, plus named numbers (NaN when a source couldn't be read). */
export type Sample = { t: number } & Record<string, number>;

/** Least-squares slope of `key` over time, in units per hour. NaN with fewer than 3 usable points. */
export function slopePerHour(samples: readonly Sample[], key: string): number {
  const pts = samples.filter((s) => Number.isFinite(s[key]));
  if (pts.length < 3) return NaN;
  const n = pts.length;
  const mt = pts.reduce((a, s) => a + s.t, 0) / n;
  const mv = pts.reduce((a, s) => a + s[key]!, 0) / n;
  let num = 0;
  let den = 0;
  for (const s of pts) {
    num += (s.t - mt) * (s[key]! - mv);
    den += (s.t - mt) ** 2;
  }
  return den === 0 ? 0 : (num / den) * 3_600_000;
}

export const maxOf = (samples: readonly Sample[], key: string): number =>
  samples.reduce((m, s) => (Number.isFinite(s[key]) ? Math.max(m, s[key]!) : m), -Infinity);

export const minOf = (samples: readonly Sample[], key: string): number =>
  samples.reduce((m, s) => (Number.isFinite(s[key]) ? Math.min(m, s[key]!) : m), Infinity);

export interface Check {
  name: string;
  /** null: not enough data to judge (a short run). */
  pass: boolean | null;
  value: string;
  limit: string;
}

/** Growth-rate limits, per wall-clock hour after warm-up. */
export const SLOPE_LIMITS: readonly { key: string; label: string; perHour: number; unit: "MB" | "count" }[] = [
  { key: "serverHeapUsed", label: "server heap (after GC)", perHour: 3, unit: "MB" },
  { key: "serverRss", label: "server RSS", perHour: 40, unit: "MB" },
  { key: "browserHeapUsed", label: "browser JS heap (after GC)", perHour: 5, unit: "MB" },
  { key: "domNodes", label: "browser DOM nodes (incl. detached)", perHour: 1000, unit: "count" },
  { key: "jsListeners", label: "browser event listeners", perHour: 200, unit: "count" },
  { key: "audioHandlers", label: "browser Web Audio nodes", perHour: 60, unit: "count" },
];

const MB = 1024 * 1024;
const fmt = (v: number, unit: "MB" | "count") => (unit === "MB" ? `${(v / MB).toFixed(2)} MB` : `${Math.round(v)}`);

export interface EvaluateOptions {
  /** Samples before this (ms since start) are warm-up: buffers filling, caches, JIT. */
  warmupMs: number;
  /** Slopes need at least this much time after warm-up to mean anything. */
  minSlopeSpanMs?: number;
}

/** Leak checks from the samples. Stalls and greetings are checked by the caller (they need the timeline). */
export function leakChecks(samples: readonly Sample[], opts: EvaluateOptions): Check[] {
  const steady = samples.filter((s) => s.t >= opts.warmupMs);
  const span = steady.length ? steady.at(-1)!.t - steady[0]!.t : 0;
  const enough = span >= (opts.minSlopeSpanMs ?? 15 * 60_000);
  const checks: Check[] = [];
  for (const limit of SLOPE_LIMITS) {
    const slope = slopePerHour(steady, limit.key);
    const perHour = limit.unit === "MB" ? limit.perHour * MB : limit.perHour;
    checks.push({
      name: `${limit.label} growth`,
      pass: !enough || !Number.isFinite(slope) ? null : slope <= perHour,
      value: Number.isFinite(slope) ? `${fmt(slope, limit.unit)}/h` : "n/a",
      limit: `≤ ${fmt(perHour, limit.unit)}/h`,
    });
  }

  const bounded = (name: string, key: string, max: number, unit = "") => {
    const v = maxOf(samples, key);
    checks.push({ name, pass: Number.isFinite(v) ? v <= max : null, value: Number.isFinite(v) ? `max ${v}${unit}` : "n/a", limit: `≤ ${max}${unit}` });
  };
  // Timers that pile up: intervals should stay flat once everything is running.
  const firstIntervals = steady.find((s) => Number.isFinite(s.pageIntervals))?.pageIntervals;
  if (firstIntervals !== undefined) bounded("browser intervals (flat after warm-up)", "pageIntervals", firstIntervals + 2);
  bounded("browser pending timeouts", "pageTimeouts", 150);
  const firstServerTimers = steady.find((s) => Number.isFinite(s.serverTimeouts))?.serverTimeouts;
  if (firstServerTimers !== undefined) bounded("server timers (flat after warm-up)", "serverTimeouts", firstServerTimers + 12);
  bounded("browser open EventSources", "pageEventSources", 2);
  bounded("browser open WebSockets", "pageWebSockets", 1);
  bounded("voice sessions open at once", "sessionsOpen", 1);
  bounded("server /api/health latency", "healthMs", 1000, " ms");
  bounded("dashboard heartbeat age", "heartbeatAgeS", 10, " s");
  bounded("browser main-thread stall", "maxLagMs", 2000, " ms");
  bounded("browser stuck fetches (>10 s)", "slowFetches", 0);
  bounded("oversized context appends (>2000 chars)", "oversizeAppends", 0);
  return checks;
}

/** Samples as CSV, one column per key seen in any sample (t first). */
export function toCsv(samples: readonly Sample[]): string {
  const keys = ["t", ...new Set(samples.flatMap((s) => Object.keys(s).filter((k) => k !== "t")))];
  const cell = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "" : String(Math.round(v * 1000) / 1000));
  return [keys.join(","), ...samples.map((s) => keys.map((k) => cell(s[k])).join(","))].join("\n") + "\n";
}

/** "✅ name: value (limit)" lines; ⏭️ for checks without enough data. */
export function formatChecks(checks: readonly Check[]): string {
  return checks.map((c) => `  ${c.pass === null ? "⏭️ " : c.pass ? "✅" : "❌"} ${c.name}: ${c.value} (limit ${c.limit})`).join("\n");
}
