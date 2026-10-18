/**
 * Privacy settings for the greeting snapshots (photos of visitors, mostly kids): whether they're
 * saved at all (SNAPSHOTS) and how long they're kept (SNAPSHOT_RETENTION_DAYS). Pure logic, shared
 * by the server, the gallery and the dashboard; the deleting itself is in server/snapshots.ts.
 */

/**
 * A week: long enough for the family to enjoy the gallery the week after Halloween (and to survive
 * a late night and a lazy morning), short enough that photos of other people's kids don't linger.
 */
export const DEFAULT_RETENTION_DAYS = 7;

/** SNAPSHOT_RETENTION_DAYS: whole days to keep photos; empty for the default; 0 or "off" keeps them forever. */
export function parseRetentionDays(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) return DEFAULT_RETENTION_DAYS;
  if (value === "off") return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(`SNAPSHOT_RETENTION_DAYS must be a whole number of days, or 0 (or off) to keep photos forever; got "${raw}"`);
  }
  return Number(value);
}

/**
 * SNAPSHOTS: "on" (the default) or "off". The older LOG_SNAPSHOTS=false still turns them off too:
 * either one saying off wins, so upgrading never starts saving photos someone had turned off.
 */
export function parseSnapshotsSwitch(raw: string | undefined, legacy: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value && !["on", "off", "true", "false"].includes(value)) throw new Error(`SNAPSHOTS must be on or off; got "${raw}"`);
  return value !== "off" && value !== "false" && legacy?.trim().toLowerCase() !== "false";
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Whole calendar days from a day folder's name (like 2026-10-31) to `now`'s local date: 0 today,
 * 1 yesterday. Null when the name isn't a real date, so a folder like 2026-13-45 is never touched.
 */
export function dayAge(day: string, now: Date): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const then = new Date(Date.UTC(y, mo, d));
  if (then.getUTCFullYear() !== y || then.getUTCMonth() !== mo || then.getUTCDate() !== d) return null;
  // Both sides as UTC midnights, so daylight-saving changes don't shift the count.
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - then.getTime()) / DAY_MS);
}

/**
 * Whether a day's photos are past the retention: older than `retentionDays` whole days. With 7,
 * Halloween's photos are kept through Nov 7 and removed on Nov 8. Never with 0 (keep forever).
 */
export function isExpired(day: string, retentionDays: number, now: Date): boolean {
  if (retentionDays <= 0) return false;
  const age = dayAge(day, now);
  return age !== null && age > retentionDays;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line for the dashboard and the server log, e.g. "snapshots on, kept 7 days". */
export function snapshotPolicy(enabled: boolean, retentionDays: number): string {
  if (!enabled) return "snapshots off";
  return retentionDays > 0 ? `snapshots on, kept ${plural(retentionDays, "day")}` : "snapshots on, kept until you delete them";
}
