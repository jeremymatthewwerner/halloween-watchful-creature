import { plural, snapshotPolicy } from "../shared/snapshots.ts";
import type { ClientConfig, DeleteSnapshotsRequest, DeleteSnapshotsResult } from "../shared/types.ts";

/**
 * The privacy line under the log links: whether greeting photos are saved and for how long, and
 * "Delete all snapshots now" (with a confirm, since it can't be undone). Hidden when disk logging is off.
 */
export function setupSnapshotPanel(root: HTMLElement, policy: ClientConfig["snapshots"], log: (text: string) => void): void {
  root.hidden = !policy;
  if (!policy) return;
  const text = root.querySelector<HTMLSpanElement>("#snapshot-policy")!;
  const button = root.querySelector<HTMLButtonElement>("#delete-snapshots")!;
  const line = snapshotPolicy(policy.enabled, policy.retentionDays);
  text.textContent = `📷 ${line.charAt(0).toUpperCase()}${line.slice(1)}`;
  text.title = "SNAPSHOTS and SNAPSHOT_RETENTION_DAYS in .env";
  button.addEventListener("click", async () => {
    const ok = window.confirm(
      "Delete every snapshot photo from every day's log, today's included? This can't be undone.\n\nThe captions, log.txt and the rest of the log are kept.",
    );
    if (!ok) return;
    button.disabled = true;
    try {
      const body = JSON.stringify({ confirm: true } satisfies DeleteSnapshotsRequest);
      const res = await fetch("/api/snapshots/delete-all", { method: "POST", headers: { "content-type": "application/json" }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { files, days } = (await res.json()) as DeleteSnapshotsResult;
      log(files ? `Deleted ${plural(files, "snapshot")} from ${plural(days.length, "day")}` : "No snapshots to delete");
    } catch (err) {
      log(`Couldn't delete the snapshots (${(err as Error).message})`);
    } finally {
      button.disabled = false;
    }
  });
}
