import type { Alert, AlertKind, DashboardStatus, RemoteCommand } from "../shared/remote.ts";

/** What the phone remote can do to the dashboard; each returns the message shown on the phone. */
export interface DashboardControls {
  status(): Omit<DashboardStatus, "lastCommand" | "hidden">;
  run(command: RemoteCommand): Promise<string>;
}

const HEARTBEAT_MS = 2000;

/**
 * The dashboard's side of the phone remote: checks in with the server every couple of seconds
 * (its status, which is also the heartbeat the server watches), runs button presses from the phone,
 * reports health alerts, and shows the server's alert list.
 */
export class RemoteLink {
  private lastCommand: DashboardStatus["lastCommand"] = null;
  private commands: EventSource | null = null;
  private lastHeard = Date.now();
  private beating = false;

  constructor(
    private readonly controls: DashboardControls,
    private readonly onAlerts: (alerts: Alert[]) => void,
  ) {}

  start(): void {
    this.listen();
    setInterval(() => void this.beat(), HEARTBEAT_MS);
    // Say so right away when the tab goes to the background (the server then expects slower
    // check-ins) and when it comes back.
    document.addEventListener("visibilitychange", () => void this.beat());
    // Reopen a command stream that went quiet (the server pings every 10 s).
    setInterval(() => {
      if (Date.now() - this.lastHeard > 25_000) this.listen();
    }, 5000);
    void this.beat();
  }

  /** Raises a health alert on the server (it dedupes and decides whether to push it). */
  alert(kind: AlertKind, detail = ""): Promise<void> {
    return this.post("/api/remote/alert", { kind, detail });
  }

  /** The problem cleared up; `detail` goes in the server log. */
  resolve(kind: AlertKind, detail = ""): Promise<void> {
    return this.post("/api/remote/alert", { kind, resolve: true, detail });
  }

  /** Sends the status now (after something changed). */
  async beat(): Promise<void> {
    if (this.beating) return;
    this.beating = true;
    try {
      const status: DashboardStatus = { ...this.controls.status(), hidden: document.hidden, lastCommand: this.lastCommand };
      const res = await fetch("/api/remote/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(status) });
      if (res.ok) this.onAlerts(((await res.json()) as { alerts: Alert[] }).alerts);
    } catch {
      /* server restarting: the next beat will do */
    } finally {
      this.beating = false;
    }
  }

  private listen(): void {
    this.commands?.close();
    this.lastHeard = Date.now();
    const source = new EventSource("/api/remote/commands");
    this.commands = source;
    source.onopen = () => (this.lastHeard = Date.now());
    source.addEventListener("ping", () => (this.lastHeard = Date.now()));
    source.addEventListener("command", (e) => {
      this.lastHeard = Date.now();
      const command = JSON.parse((e as MessageEvent<string>).data) as RemoteCommand;
      void this.controls
        .run(command)
        .then(
          (message) => ({ id: command.id, ok: true, message }),
          (err: Error) => ({ id: command.id, ok: false, message: err.message }),
        )
        .then((result) => {
          this.lastCommand = result;
          void this.beat();
        });
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
  }
}

/** The dashboard's Alerts panel: open problems first; hidden when there's nothing to show. */
export function renderAlerts(section: HTMLElement, list: HTMLOListElement, alerts: readonly Alert[]): void {
  const shown = [...alerts.filter((a) => a.resolvedAt === null), ...alerts.filter((a) => a.resolvedAt !== null)].slice(0, 8);
  section.hidden = shown.length === 0;
  list.replaceChildren(
    ...shown.map((a) => {
      const li = document.createElement("li");
      li.className = a.resolvedAt === null ? a.level : "resolved";
      const time = document.createElement("time");
      time.textContent = new Date(a.at).toLocaleTimeString();
      li.append(time, ` ${a.resolvedAt === null ? "" : "✅ "}${a.title}${a.count > 1 ? ` ×${a.count}` : ""}${a.detail ? `: ${a.detail}` : ""}`);
      return li;
    }),
  );
}
