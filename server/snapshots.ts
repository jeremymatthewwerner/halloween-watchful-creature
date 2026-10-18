import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isExpired, plural } from "../shared/snapshots.ts";
import type { DeleteSnapshotsResult } from "../shared/types.ts";
import { LOG_DAY, SNAPSHOT_FILE, SNAPSHOT_IMAGE_HTML, photoPlaceholder } from "./logs.ts";

/**
 * Deleting greeting snapshots (photos of visitors, mostly kids): old ones on a schedule
 * (SNAPSHOT_RETENTION_DAYS), or all of them from the dashboard's button. log.txt is kept, and
 * log.html gets a small placeholder where each removed photo was.
 */

/** Day folders that had photos removed (oldest first), and how many photos. */
export type SweepResult = DeleteSnapshotsResult;

const DAY_MS = 24 * 60 * 60_000;

/** Whether `path` is strictly inside `root` (both absolute and already resolved). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** lstat, so a symlink is never mistaken for what it points to. */
function kind(path: string): "file" | "dir" | "other" | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/**
 * Deletes the snapshot images in the day folders of `dir` that `pick` chooses, and swaps their
 * pictures in log.html for `placeholder`. Deliberately narrow: only real folders (not symlinks)
 * named like a day, only their own snapshots/ folder, and only regular files named like a
 * snapshot. Symlinks are never followed or removed, and nothing outside `dir` is touched.
 */
function sweep(dir: string, pick: (day: string) => boolean, placeholder: string): SweepResult {
  const result: SweepResult = { days: [], files: 0 };
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return result; // no logs yet
  }
  if (kind(root) !== "dir") return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !LOG_DAY.test(entry.name) || !pick(entry.name)) continue;
    const folder = join(root, entry.name);
    const removed = removeFiles(root, join(folder, "snapshots"));
    markRemoved(folder, placeholder);
    if (removed) {
      result.days.push(entry.name);
      result.files += removed;
    }
  }
  result.days.sort();
  return result;
}

function removeFiles(root: string, snapshots: string): number {
  if (kind(snapshots) !== "dir" || !inside(root, snapshots)) return 0;
  let removed = 0;
  for (const entry of readdirSync(snapshots, { withFileTypes: true })) {
    if (!entry.isFile() || !SNAPSHOT_FILE.test(entry.name)) continue;
    const file = join(snapshots, entry.name);
    if (dirname(file) !== snapshots || !inside(root, file)) continue;
    unlinkSync(file);
    removed++;
  }
  return removed;
}

/** Replaces the pictures of snapshots that no longer exist in a day's log.html (written only if something changed). */
function markRemoved(folder: string, placeholder: string): void {
  const html = join(folder, "log.html");
  if (kind(html) !== "file") return;
  const text = readFileSync(html, "utf8");
  const next = text.replace(SNAPSHOT_IMAGE_HTML, (whole, name: string) => (existsSync(join(folder, name)) ? whole : photoPlaceholder(placeholder)));
  // Sync on purpose: SessionLog appends to today's log.html synchronously too, so they can't interleave.
  if (next !== text) writeFileSync(html, next);
}

/** Removes the photos of days older than `retentionDays` (see `isExpired`); nothing with 0 (keep forever). */
export function pruneSnapshots(dir: string, retentionDays: number, now = new Date()): SweepResult {
  if (retentionDays <= 0) return { days: [], files: 0 };
  return sweep(dir, (day) => isExpired(day, retentionDays, now), `photo removed after ${plural(retentionDays, "day")}`);
}

/** The dashboard's "Delete all snapshots now": every photo of every day, today's included. */
export function deleteAllSnapshots(dir: string): SweepResult {
  return sweep(dir, () => true, "photo deleted");
}

/**
 * Prunes old photos now (server start) and then once a day. Returns a function that stops it.
 * Problems are logged, never thrown: a stuck file mustn't take the creature down.
 */
export function startRetention(dir: string, retentionDays: number, log: Pick<Console, "log" | "warn"> = console, everyMs = DAY_MS): () => void {
  if (retentionDays <= 0) return () => {};
  const run = () => {
    try {
      const { files, days } = pruneSnapshots(dir, retentionDays);
      if (files) log.log(`[privacy] removed ${plural(files, "snapshot")} older than ${plural(retentionDays, "day")} (${days.join(", ")})`);
    } catch (err) {
      log.warn(`[privacy] couldn't remove old snapshots: ${(err as Error).message}`);
    }
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
