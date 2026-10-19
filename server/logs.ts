import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import type { ServerLogEntry } from "../shared/types.ts";

type Level = ServerLogEntry["level"];

/** Keeps the most recent server log lines and tells subscribers about new ones. */
export class LogBuffer {
  readonly boot: string;
  private entries: ServerLogEntry[] = [];
  private seq = 0;
  private readonly listeners = new Set<(entry: ServerLogEntry) => void>();

  constructor(
    private readonly capacity = 500,
    boot = Date.now().toString(36),
  ) {
    this.boot = boot;
  }

  push(level: Level, text: string, at = Date.now()): ServerLogEntry {
    const entry: ServerLogEntry = { boot: this.boot, seq: ++this.seq, at, level, text };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a broken subscriber must not break logging */
      }
    }
    return entry;
  }

  /**
   * Buffered lines a (re)connecting client hasn't seen. `lastEventId` is the SSE id it saw last;
   * from an earlier boot (the server restarted) it has seen none of this boot's lines.
   */
  since(lastEventId?: string | null): ServerLogEntry[] {
    const [boot, seq] = (lastEventId ?? "").split(":");
    if (boot !== this.boot) return [...this.entries];
    return this.entries.filter((e) => e.seq > Number(seq));
  }

  subscribe(listener: (entry: ServerLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The SSE event id for an entry, as parsed back by `LogBuffer.since`. */
export const logEventId = (entry: ServerLogEntry): string => `${entry.boot}:${entry.seq}`;

const LEVELS: Record<"log" | "info" | "warn" | "error", Level> = { log: "info", info: "info", warn: "warn", error: "error" };

/**
 * Mirrors console.log/info/warn/error into `buffer`; output still reaches the terminal.
 * Returns a function that restores the original console methods.
 */
export function captureConsole(buffer: LogBuffer, target: Console = console): () => void {
  const originals = new Map<keyof typeof LEVELS, (...args: unknown[]) => void>();
  let inside = false;
  for (const method of Object.keys(LEVELS) as (keyof typeof LEVELS)[]) {
    const original = target[method].bind(target);
    originals.set(method, target[method]);
    target[method] = (...args: unknown[]) => {
      original(...args);
      // A subscriber that logs must not loop back into the buffer.
      if (inside) return;
      inside = true;
      try {
        buffer.push(LEVELS[method], format(...args));
      } finally {
        inside = false;
      }
    };
  }
  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}

export type ConversationSpeaker = "visitor" | "creature" | "system";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Conversation lines from rehearsal mode start with this in the log (the gallery skips them). */
export const REHEARSAL_MARK = "[REHEARSAL] ";

/** Looks that start a greeting: their camera frame is worth keeping in the log. */
const GREETING_LOOKS = new Set(["arrived", "grew", "returned", "manual"]);

/**
 * Whether a vision look's frame is worth a snapshot: greetings, and checks that found someone new
 * or a costume change. Never in rehearsal: those frames are sample images (uploads stay in the
 * browser's memory, log snapshots are already saved), and they'd fill the costume gallery.
 */
export function wantsSnapshot(reason: string, verdict: string | undefined, rehearsal = false): boolean {
  if (rehearsal) return false;
  return GREETING_LOOKS.has(reason) || verdict === "NEW" || verdict === "CHANGED";
}

/** A day's log folder is named like 2026-10-31. */
export const LOG_DAY = /^\d{4}-\d\d-\d\d$/;

/** A file in a day's snapshots/ folder, as `snapshot()` names it: 18-05-09-arrived.jpg. */
export const SNAPSHOT_FILE = /^\d\d-\d\d-\d\d-[\w-]*\.(?:jpg|png|webp)$/;

/** A snapshot's picture in log.html, as `snapshot()` writes it; group 1 is its path (snapshots/…). */
export const SNAPSHOT_IMAGE_HTML = /<a href="(snapshots\/[\w-]+\.(?:jpg|png|webp))" target="_blank"><img src="\1"[^>]*><\/a>/g;

/**
 * Stands in for a snapshot's picture in log.html: photos turned off, or removed later. Styled
 * inline, so log.html files written before it existed show it right too.
 */
export const photoPlaceholder = (text: string) =>
  `<span class="nophoto" style="display:inline-block;flex:none;width:240px;max-width:45vw;padding:24px 8px;box-sizing:border-box;border:1px dashed #3a2858;border-radius:6px;color:#a99bc0;text-align:center">📷 ${escapeHtml(text)}</span>`;

const HTML_HEAD = (day: string, title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${day}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 16px; background: #120a1c; color: #f3eaff; font: 14px/1.45 system-ui, -apple-system, sans-serif; }
h1 { font-size: 18px; margin: 0 0 12px; }
.row { display: flex; gap: 10px; padding: 3px 8px; border-radius: 6px; margin: 2px 0; overflow-wrap: anywhere; }
.row time { color: #a99bc0; font: 12px ui-monospace, monospace; flex: none; padding-top: 2px; }
.server { color: #a99bc0; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
.server.warn { color: #ff7a1a; } .server.error { color: #ff4d6a; }
.system { color: #a99bc0; }
.visitor { background: #1b2a1f; } .visitor .text::before { content: "🧒 "; }
.creature { background: #2e1d10; } .creature .text::before { content: "🎃 "; }
.restart { color: #b26bff; border-top: 1px solid #3a2858; margin-top: 10px; padding-top: 8px; }
.snapshot { background: #1e1330; border: 1px solid #3a2858; align-items: flex-start; padding: 8px; }
.snapshot img { width: 240px; max-width: 45vw; border-radius: 6px; display: block; }
.snapshot .verdict { color: #ff7a1a; font-weight: 600; }
.rehearsal { opacity: .6; border-left: 3px dashed #b26bff; }
</style></head><body>
<h1>🎃 ${escapeHtml(title)} · ${day}</h1>
`;

/**
 * The permanent, per-day log in <dir>/<YYYY-MM-DD>/: log.txt (plain text), log.html (readable,
 * with costume snapshots inline) and snapshots/. Server restarts append to the same day.
 */
export class SessionLog {
  private day = "";
  private folder = "";

  constructor(
    private readonly dir: string,
    private readonly title: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The current day's folder name, e.g. "2026-10-31". */
  get currentDay(): string {
    return dayOf(this.now());
  }

  /** Marks a (re)start of the server in today's log. */
  start(detail: string): void {
    const at = this.now();
    this.write(at, `===== server started: ${detail}`, `<div class="row restart"><time>${timeOf(at)}</time><span>Server started: ${escapeHtml(detail)}</span></div>`);
  }

  server(entry: Pick<ServerLogEntry, "at" | "level" | "text">): void {
    const at = new Date(entry.at);
    const tag = entry.level === "info" ? "server" : entry.level;
    this.write(
      at,
      `${tag.padEnd(8)} ${entry.text}`,
      `<div class="row server ${entry.level}"><time>${timeOf(at)}</time><span>${escapeHtml(entry.text)}</span></div>`,
    );
  }

  /** `rehearsal`: said during rehearsal mode (pretend visitors), so marked and kept out of the gallery. */
  conversation(who: ConversationSpeaker, text: string, atMs: number, rehearsal = false): void {
    const at = new Date(atMs);
    const tag = who === "system" ? "note" : who;
    const mark = rehearsal ? REHEARSAL_MARK : "";
    this.write(
      at,
      `${tag.padEnd(8)} ${mark}${text}`,
      `<div class="row ${who}${rehearsal ? " rehearsal" : ""}"><time>${timeOf(at)}</time><span class="text">${escapeHtml(mark + text)}</span></div>`,
    );
  }

  /**
   * Saves a camera frame (a data:image/... URL) to snapshots/ and logs it with its caption.
   * Returns the snapshot's path relative to the day's folder.
   */
  snapshot(dataUrl: string, label: string, caption: string, verdict?: string): string | null {
    const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    const at = this.now();
    this.ensureFolder(at);
    const ext = match[1] === "jpeg" ? "jpg" : match[1]!;
    const name = `snapshots/${timeOf(at).replaceAll(":", "-")}-${label.replace(/[^\w-]/g, "")}.${ext}`;
    writeFileSync(join(this.folder, name), Buffer.from(match[2]!, "base64"));
    const verdictText = verdict ? `[${verdict}] ` : "";
    this.write(
      at,
      `snapshot ${name}  ${label} ${verdictText}${caption}`,
      `<div class="row snapshot"><time>${timeOf(at)}</time><a href="${name}" target="_blank"><img src="${name}" alt="${escapeHtml(label)} snapshot" loading="lazy"></a>` +
        `<span><strong>${escapeHtml(label)}</strong> ${verdict ? `<span class="verdict">${escapeHtml(verdict)}</span> ` : ""}${escapeHtml(caption)}</span></div>`,
    );
    return name;
  }

  /**
   * Logs what the camera saw at a greeting without saving the frame (SNAPSHOTS=off), so the
   * captions stay in the log and the gallery can still show them in words.
   */
  look(label: string, caption: string, verdict?: string): void {
    const at = this.now();
    const verdictText = verdict ? `[${verdict}] ` : "";
    this.write(
      at,
      `look     ${label.replace(/[^\w-]/g, "") || "look"} ${verdictText}${caption}`,
      `<div class="row snapshot"><time>${timeOf(at)}</time>${photoPlaceholder("snapshots off")}` +
        `<span><strong>${escapeHtml(label)}</strong> ${verdict ? `<span class="verdict">${escapeHtml(verdict)}</span> ` : ""}${escapeHtml(caption)}</span></div>`,
    );
  }

  private ensureFolder(at: Date): void {
    const day = dayOf(at);
    if (day === this.day) return;
    this.day = day;
    this.folder = join(this.dir, day);
    mkdirSync(join(this.folder, "snapshots"), { recursive: true });
    const html = join(this.folder, "log.html");
    if (!existsSync(html)) writeFileSync(html, HTML_HEAD(day, this.title));
  }

  private write(at: Date, text: string, html: string): void {
    this.ensureFolder(at);
    // Continuation lines (stack traces) stay indented under their timestamp.
    appendFileSync(join(this.folder, "log.txt"), `${timeOf(at)} ${text.replaceAll("\n", "\n         ")}\n`);
    appendFileSync(join(this.folder, "log.html"), `${html}\n`);
  }
}
