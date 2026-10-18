/** Types for the phone remote, the dashboard heartbeat and health alerts (shared by server, dashboard and tests). */
import type { BodyState } from "./types.ts";

/** Health problems worth telling the owner about. */
export type AlertKind =
  | "camera-lost"
  | "detector-failed"
  | "arduino-disconnected"
  | "vision-errors"
  | "voice-errors"
  | "cost-cap"
  | "watchdog-reload"
  | "needs-wake"
  | "dashboard-offline";

/** The kinds the dashboard itself may report (the server watches the others). */
export const DASHBOARD_ALERT_KINDS: readonly AlertKind[] = ["camera-lost", "detector-failed", "voice-errors", "cost-cap", "watchdog-reload", "needs-wake"];

export interface Alert {
  id: number;
  kind: AlertKind;
  level: "warn" | "error";
  /** Short, fixed text for the kind ("Camera stopped"). */
  title: string;
  /** What happened, for the dashboard and remote only (never pushed). */
  detail: string;
  /** Epoch ms of the first and the latest occurrence. */
  firstAt: number;
  at: number;
  count: number;
  /** Epoch ms when it cleared up by itself (or null while still a problem). */
  resolvedAt: number | null;
}

/** What the dashboard reports about itself every couple of seconds (doubles as its heartbeat). */
export interface DashboardStatus {
  character: string;
  /** "Wake the creature" is done: camera, mic and voice are set up. */
  woken: boolean;
  /** Waiting for someone to click the dashboard (the browser blocks sound until then). */
  needsTap: boolean;
  /** False while the kill switch is on. */
  autopilot: boolean;
  voice: "closed" | "connecting" | "open" | "closing";
  body: BodyState;
  present: boolean;
  visitors: number;
  camera: "off" | "ok" | "stalled";
  detector: "off" | "loading" | "ok" | "failed";
  awakeMinutesToday: number;
  /** Estimated voice cost today in USD (GPT-Live), or null when it can't be estimated. */
  costToday: number | null;
  capReached: boolean;
  modes: { id: string; label: string; on: boolean }[];
  /** The result of the latest remote command, so the phone can show it. */
  lastCommand: { id: string; ok: boolean; message: string } | null;
}

/** A button press on the phone, relayed to the dashboard. */
export type RemoteCommand = { id: string } & (
  | { type: "sleep" }
  | { type: "wake" }
  | { type: "greet" }
  | { type: "say"; text: string }
  | { type: "mode"; mode: string; on: boolean }
);

/** Everything the phone shows, pushed over /api/remote/stream. */
export interface RemoteSnapshot {
  dashboard: DashboardStatus | null;
  /** The dashboard checked in recently. */
  dashboardOnline: boolean;
  /** Seconds since the dashboard last checked in (null: never since the server started). */
  dashboardSeenAgo: number | null;
  arduino: { enabled: boolean; connected: boolean; status: string };
  alerts: Alert[];
  /** `recap`: the latest night's recap (absent on older servers). */
  links: { todayLog: string | null; gallery: string | null; allLogs: string; recap?: string | null };
}

export const SAY_MAX_CHARS = 300;
