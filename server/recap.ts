import { existsSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { DashboardStatus } from "../shared/remote.ts";
import type { Notifier } from "./alerts.ts";
import { galleryItems, parseLogText, scoreLine, type GalleryItem, type LogLine } from "./gallery.ts";
import { LOG_DAY, REHEARSAL_MARK } from "./logs.ts";

/**
 * The morning-after recap of one night, computed from the day's log.txt (as written by SessionLog)
 * on request: visitor groups and roughly how many people, the busiest half hour, the standout
 * costumes, the creature's best lines and how long it was awake. Rehearsal lines are skipped.
 * Also the once-a-night ntfy push with the headline stats (never photos or anything about visitors).
 */

export interface RecapGroup {
  /** Seconds since midnight. */
  at: number;
  time: string;
  /** arrived: walked up; joined: more people joined a group; new: a camera check found someone new. */
  kind: "arrived" | "joined" | "new";
  people: number;
  /** Where `people` came from (see the method note on the page). */
  counted: "detector" | "description";
}

export interface RecapCostume extends GalleryItem {
  /** The vision model's "standout: …" details from the caption. */
  standouts: string[];
  /** False when the photo was turned off or deleted since. */
  hasImage: boolean;
}

export interface Recap {
  day: string;
  groups: RecapGroup[];
  people: number;
  /** Every half hour from the first group's to the last one's (seconds since midnight). */
  halfHours: { start: number; groups: number; people: number }[];
  busiest: { start: number; groups: number; people: number } | null;
  costumes: RecapCostume[];
  lines: { time: string; text: string }[];
  /** Voice session open time, summed. */
  awakeSeconds: number;
  voiceSessions: number;
  /** From the first wake (or visitor) to the last of: visitor, voice session closing, kill switch. */
  onDuty: { from: number; to: number } | null;
  /** When the kill switch went on after the last visitor, if it did. */
  asleepAt: number | null;
}

export interface RecapOptions {
  day: string;
  logText: string;
  /** Snapshot files that exist (snapshots/x.jpg); null when snapshots are turned off. */
  snapshots: ReadonlySet<string> | null;
  maxCostumes?: number;
  maxLines?: number;
}

const HALF_HOUR = 1800;
/** A vision line belongs to the dashboard note ("Visitors arrived (3)") from up to this long before. */
const NOTE_BEFORE_S = 30;
const NOTE_AFTER_S = 5;

const VISION = /^\[vision\] (\w+)(?: \((NEW|SAME|CHANGED)\))? in \d+ ms: ([\s\S]*)$/;
const ARRIVED_NOTE = /^Visitors arrived \((\d+)\)/;
const JOINED_NOTE = /^More visitors \((\d+) → (\d+)\)/;
const VOICE_NOTE = /^Voice session (open|closed)\b/;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNTED = new RegExp(
  `\\b(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:[a-z-]+\\s+)?(?:visitors?|people|persons?|kids?|children|trick-or-treaters?)\\b`,
  "i",
);
const STANDOUT = /standout:\s*([^.;\n)]+)/gi;

const rehearsal = (l: LogLine) => l.text.startsWith(REHEARSAL_MARK) || l.text.includes(`[vision] ${REHEARSAL_MARK}`);

/** The "standout: …" details the vision model names, one per costume. */
export function standoutDetails(caption: string): string[] {
  return [...caption.matchAll(STANDOUT)].map((m) => m[1]!.trim().replace(/,$/, "")).filter(Boolean);
}

/**
 * How many people a vision description mentions: the number it states ("Two visitors: …"), or
 * one per "standout:" detail (it names one per costume), whichever is more; at least 1.
 */
export function peopleInCaption(caption: string): number {
  const m = COUNTED.exec(caption);
  const stated = m ? (NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1])) : 0;
  return Math.max(1, stated, standoutDetails(caption).length);
}

const STOP_WORDS = new Set("a an and are as at be but by for from has have in is it its of on one or the their them they this to two three with you your visitor visitors wearing who what standout".split(" "));
const wordSet = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );

/** Word overlap (Jaccard) of two texts, 0..1. */
export function similarity(a: string, b: string): number {
  const x = wordSet(a);
  const y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * The visitor groups of the night. Arrivals and joiners come from the dashboard's notes, which
 * carry the person detector's count; each is matched to its vision line, so a failed look still
 * counts. Camera checks that found someone new (returns, swaps) count with the number of people
 * the description mentions. Manual greetings, same-group returns and costume changes don't count.
 */
export function visitorGroups(lines: LogLine[]): RecapGroup[] {
  const sorted = lines.filter((l) => !rehearsal(l)).sort((a, b) => a.at - b.at);
  const notes = sorted.filter((l) => l.tag === "note");
  const arrivals = notes.flatMap((l) => (ARRIVED_NOTE.exec(l.text) ? [{ line: l, people: Number(ARRIVED_NOTE.exec(l.text)![1]), used: false }] : []));
  const joins = notes.flatMap((l) => {
    const m = JOINED_NOTE.exec(l.text);
    return m ? [{ line: l, people: Math.max(1, Number(m[2]) - Number(m[1])), used: false }] : [];
  });
  const groups: RecapGroup[] = [];
  const add = (l: LogLine, kind: RecapGroup["kind"], people: number, counted: RecapGroup["counted"]) =>
    groups.push({ at: l.at, time: l.time, kind, people: Math.max(1, people), counted });

  for (const l of sorted) {
    const m = l.tag === "server" ? VISION.exec(l.text) : null;
    if (!m) continue;
    const [, reason, verdict, caption] = m;
    if (reason === "arrived" || reason === "grew") {
      const pool = reason === "arrived" ? arrivals : joins;
      const note = pool.find((n) => !n.used && n.line.at >= l.at - NOTE_BEFORE_S && n.line.at <= l.at + NOTE_AFTER_S);
      if (note) note.used = true;
      // For joiners without a note, the description covers the whole group: count one newcomer.
      const people = note ? note.people : reason === "arrived" ? peopleInCaption(caption!) : 1;
      add(note?.line ?? l, reason === "arrived" ? "arrived" : "joined", people, note ? "detector" : "description");
    } else if (verdict === "NEW") {
      add(l, "new", peopleInCaption(caption!), "description");
    }
  }
  // Arrivals whose look failed (no vision line) were still visitors.
  for (const n of arrivals) if (!n.used) add(n.line, "arrived", n.people, "detector");
  for (const n of joins) if (!n.used) add(n.line, "joined", n.people, "detector");
  return groups.sort((a, b) => a.at - b.at);
}

/** Groups per half hour, from the first group's half hour to the last one's. */
export function halfHourCounts(groups: RecapGroup[]): Recap["halfHours"] {
  if (!groups.length) return [];
  const first = Math.floor(groups[0]!.at / HALF_HOUR);
  const last = Math.floor(groups[groups.length - 1]!.at / HALF_HOUR);
  const out = Array.from({ length: last - first + 1 }, (_, i) => ({ start: (first + i) * HALF_HOUR, groups: 0, people: 0 }));
  for (const g of groups) {
    const slot = out[Math.floor(g.at / HALF_HOUR) - first]!;
    slot.groups++;
    slot.people += g.people;
  }
  return out;
}

/** The half hour with the most groups (more people breaks a tie, then the earlier one). */
export function busiestHalfHour(halfHours: Recap["halfHours"]): Recap["busiest"] {
  let best: Recap["busiest"] = null;
  for (const h of halfHours) if (!best || h.groups > best.groups || (h.groups === best.groups && h.people > best.people)) best = h;
  return best && best.groups ? { ...best } : null;
}

/**
 * The standout costumes: one snapshot per group (snapshots after a new group's greeting, such as a
 * costume change or a same-group return, belong to it), best first. New greetings with a vivid
 * "standout:" detail and a photo still on disk score highest; a group that looks like one already
 * picked (the same kids back after a while) is skipped.
 */
export function topCostumes(items: GalleryItem[], snapshots: ReadonlySet<string> | null, max = 6): RecapCostume[] {
  const clusters: RecapCostume[][] = [];
  for (const item of items) {
    if (item.caption.includes(REHEARSAL_MARK.trim())) continue;
    const costume: RecapCostume = { ...item, standouts: standoutDetails(item.caption), hasImage: item.file ? (snapshots?.has(item.file) ?? false) : false };
    const startsGroup = item.label === "arrived" || item.label === "grew" || item.verdict === "NEW";
    if (startsGroup || !clusters.length) clusters.push([costume]);
    else clusters[clusters.length - 1]!.push(costume);
  }
  const score = (c: RecapCostume) => {
    let s = c.verdict === "NEW" || (c.label === "arrived" && !c.verdict) ? 3 : c.label === "grew" ? 2 : c.verdict === "CHANGED" ? 1 : 0;
    if (c.standouts.length) s += 2 + Math.min(4, Math.max(...c.standouts.map((d) => d.split(/\s+/).length))) * 0.5;
    if (c.hasImage) s += 2;
    if (c.line) s += 0.5;
    return s;
  };
  const best = clusters
    .map((cluster) => cluster.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0]!)
    .filter(({ c }) => c.verdict !== "SAME")
    .sort((a, b) => b.s - a.s);
  const picked: RecapCostume[] = [];
  const text = (c: RecapCostume) => `${c.standouts.join(" ")} ${c.caption}`;
  for (const { c } of best) {
    if (picked.length >= max) break;
    if (picked.some((p) => similarity(text(p), text(c)) >= 0.5)) continue;
    picked.push(c);
  }
  return picked;
}

/** The creature's best lines of the night: about what it saw, real sentences, no near-repeats. */
export function bestLines(lines: LogLine[], max = 5): Recap["lines"] {
  const sorted = lines.filter((l) => !rehearsal(l)).sort((a, b) => a.at - b.at);
  const looks = sorted.flatMap((l) => {
    const m = l.tag === "server" ? VISION.exec(l.text) : null;
    return m ? [{ at: l.at, caption: m[3]! }] : [];
  });
  const scored = sorted
    .filter((l) => l.tag === "creature" && l.text.trim().length >= 25 && l.text.trim().length <= 240)
    .map((l) => {
      // The look just before the line (or the one it was waiting on, a few seconds later).
      const look = [...looks].reverse().find((v) => v.at <= l.at + 10 && v.at >= l.at - 120);
      return { time: l.time, text: l.text.trim(), score: scoreLine(l.text, look?.caption ?? "") };
    })
    .sort((a, b) => b.score - a.score);
  const picked: Recap["lines"] = [];
  for (const line of scored) {
    if (picked.length >= max) break;
    if (picked.some((p) => similarity(p.text, line.text) >= 0.6)) continue;
    picked.push({ time: line.time, text: line.text });
  }
  return picked;
}

/** Everything on the recap page, from one day's log.txt. */
export function buildRecapData({ day, logText, snapshots, maxCostumes = 6, maxLines = 5 }: RecapOptions): Recap {
  const lines = parseLogText(logText);
  const groups = visitorGroups(lines);
  const halfHours = halfHourCounts(groups);

  // Awake time: each "Voice session open" until its "closed" (or a server restart, or the log's end).
  const sorted = lines.filter((l) => !rehearsal(l)).sort((a, b) => a.at - b.at);
  let awakeSeconds = 0;
  let voiceSessions = 0;
  let openAt: number | null = null;
  let lastAt = 0;
  let firstWake: number | null = null;
  let lastClose: number | null = null;
  let killAt: number | null = null;
  for (const l of sorted) {
    if (l.tag === "=====" && openAt !== null) {
      awakeSeconds += lastAt - openAt;
      openAt = null;
    }
    const voice = l.tag === "note" ? VOICE_NOTE.exec(l.text) : null;
    if (voice?.[1] === "open" && openAt === null) {
      openAt = l.at;
      voiceSessions++;
      firstWake ??= l.at;
    } else if (voice?.[1] === "closed" && openAt !== null) {
      awakeSeconds += l.at - openAt;
      openAt = null;
      lastClose = l.at;
    }
    if (l.tag === "note" && l.text.startsWith("Kill switch:")) killAt = l.at;
    lastAt = l.at;
  }
  if (openAt !== null) awakeSeconds += lastAt - openAt;

  const lastGroup = groups.length ? groups[groups.length - 1]!.at : null;
  const from = Math.min(firstWake ?? Infinity, groups[0]?.at ?? Infinity);
  const to = Math.max(lastGroup ?? -Infinity, lastClose ?? -Infinity, killAt ?? -Infinity);
  return {
    day,
    groups,
    people: groups.reduce((n, g) => n + g.people, 0),
    halfHours,
    busiest: busiestHalfHour(halfHours),
    costumes: topCostumes(galleryItems(logText), snapshots, maxCostumes),
    lines: bestLines(lines, maxLines),
    awakeSeconds,
    voiceSessions,
    onDuty: Number.isFinite(from) && Number.isFinite(to) && to >= from ? { from, to } : null,
    asleepAt: killAt !== null && (lastGroup === null || killAt > lastGroup) ? killAt : null,
  };
}

// --- formatting ---

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (s: number) => {
  const h = Math.floor(s / 3600) % 24;
  return { h12: h % 12 || 12, mm: pad(Math.floor((s % 3600) / 60)), ampm: h < 12 ? "am" : "pm" };
};
/** 19:05 → "7:05 pm". */
export const clockTime = (s: number) => {
  const p = parts(s);
  return `${p.h12}:${p.mm} ${p.ampm}`;
};
/** A half hour as "7:00–7:30 pm" (the am/pm only once when it's the same). */
export function halfHourLabel(start: number): string {
  const a = parts(start);
  const b = parts(start + HALF_HOUR);
  return `${a.h12}:${a.mm}${a.ampm === b.ampm ? "" : ` ${a.ampm}`}–${b.h12}:${b.mm} ${b.ampm}`;
}
/** 6120 s → "1 h 42 min". */
export function duration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Jacques" from "Jacques O'Lantern, Pumpkin Critic"; "Sir Reginald" keeps the Sir. */
export function shortName(name: string): string {
  const words = name.split(",")[0]!.trim().split(/\s+/);
  return (words[0] === "Sir" ? words.slice(0, 2) : words.slice(0, 1)).join(" ") || "The creature";
}

/** The push text: numbers and times only, nothing about any visitor. */
export function headline(recap: Recap, name = "Jacques"): string {
  const parts = [`${name} met ${plural(recap.groups.length, "group")} tonight (about ${plural(recap.people, "person", "people")})`];
  if (recap.busiest) parts.push(`busiest ${halfHourLabel(recap.busiest.start)} (${plural(recap.busiest.groups, "group")})`);
  return `${parts.join(", ")}.${recap.awakeSeconds >= 60 ? ` Awake ${duration(recap.awakeSeconds)}.` : ""}`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const LABELS: Record<string, string> = { arrived: "New visitors", grew: "More joined", returned: "Came back", manual: "Greet now" };

function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

/** The recap page for one day. Family-only like the gallery: kids' photos, no sharing, no scripts. */
export function buildRecap(opts: RecapOptions & { name?: string }): string {
  const r = buildRecapData(opts);
  const name = opts.name ?? "Jacques";
  const day = escapeHtml(r.day);
  const base = `/api/session-logs/${day}`;
  const peak = Math.max(1, ...r.halfHours.map((h) => h.groups));
  const detector = r.groups.filter((g) => g.counted === "detector").length;

  const tiles = [
    ["Visitor groups", String(r.groups.length), r.groups.length ? `first ${clockTime(r.groups[0]!.at)}, last ${clockTime(r.groups[r.groups.length - 1]!.at)}` : ""],
    ["People, roughly", `≈ ${r.people}`, r.groups.length ? `about ${(r.people / r.groups.length).toFixed(1)} per group` : ""],
    ["Busiest half hour", r.busiest ? halfHourLabel(r.busiest.start) : "–", r.busiest ? `${plural(r.busiest.groups, "group")}, ≈ ${r.busiest.people} people` : ""],
    ["Awake", r.awakeSeconds ? duration(r.awakeSeconds) : "–", r.voiceSessions ? `over ${plural(r.voiceSessions, "voice session")}` : ""],
    ["On duty", r.onDuty ? duration(r.onDuty.to - r.onDuty.from) : "–", r.onDuty ? `${clockTime(r.onDuty.from)} to ${clockTime(r.onDuty.to)}${r.asleepAt !== null ? ", then put to sleep" : ""}` : ""],
  ]
    .map(([label, value, sub]) => `<div class="tile"><div class="label">${escapeHtml(label!)}</div><div class="value">${escapeHtml(value!)}</div><div class="sub">${escapeHtml(sub!)}</div></div>`)
    .join("");

  const bars = r.halfHours
    .map((h) => {
      const top = r.busiest?.start === h.start;
      const label = halfHourLabel(h.start);
      const tip = `${label}: ${plural(h.groups, "group")}, about ${plural(h.people, "person", "people")}`;
      return (
        `<div class="bar-row${top ? " top" : ""}" title="${escapeHtml(tip)}"><span class="when">${escapeHtml(label)}</span>` +
        `<span class="track"><span class="bar" style="width:${((h.groups / peak) * 100).toFixed(1)}%"></span></span><span class="n">${h.groups}</span></div>`
      );
    })
    .join("\n");

  const cards = r.costumes
    .map((c) => {
      const tag = [LABELS[c.label] ?? c.label, c.verdict === "CHANGED" ? "new look" : ""].filter(Boolean).join(" · ");
      return (
        `<figure class="card">` +
        (c.hasImage && c.file
          ? `<a href="${base}/${escapeHtml(c.file)}" target="_blank"><img src="${base}/${escapeHtml(c.file)}" alt="Costume snapshot at ${c.time}" loading="lazy"></a>`
          : `<div class="noimg">🎃<span>${opts.snapshots ? "photo no longer saved" : "photos are off"}</span></div>`) +
        `<figcaption><div class="meta"><time>${clockTime(Number(c.time.slice(0, 2)) * 3600 + Number(c.time.slice(3, 5)) * 60)}</time> <span class="tag">${escapeHtml(tag)}</span></div>` +
        (c.standouts.length ? `<p class="standout">✨ ${c.standouts.map(escapeHtml).join(" · ")}</p>` : "") +
        `<p class="caption">${escapeHtml(c.caption)}</p>` +
        (c.line ? `<blockquote>${escapeHtml(c.line)}</blockquote>` : "") +
        `</figcaption></figure>`
      );
    })
    .join("\n");

  const quotes = r.lines.map((l) => `<blockquote><time>${l.time.slice(0, 5)}</time> ${escapeHtml(l.text)}</blockquote>`).join("\n");

  const method =
    `<details class="method"><summary>How these are counted</summary><ul>` +
    `<li><strong>A group</strong> is each greeting of new visitors: people walking up, more people joining a group already there, and someone new found by the camera check (a group coming back judged new, or a swap). ` +
    `Manual "Greet now"s, the same group coming back, and costume changes don't count. A group that comes back after more than 90 seconds away is greeted, and counted, again.</li>` +
    `<li><strong>People</strong> are added up per group: the person detector's count when they walked up (or how many joined), for ${plural(detector, "group")} here; ` +
    `otherwise how many the camera's description mentions (the number it gives, or one per costume it describes). The detector only counts people close to the pumpkin, so grown-ups waiting on the sidewalk and small kids hidden behind others are missed: treat it as a rough count.</li>` +
    `<li><strong>Awake</strong> is the time the voice session was open (it sleeps after a few minutes of empty porch). <strong>On duty</strong> runs from the first wake or visitor to the last visitor, voice session or kill switch.</li>` +
    `<li>Rehearsal lines (pretend visitors) are left out of everything.</li></ul></details>`;

  const body = r.groups.length
    ? `<section class="tiles">${tiles}</section>
<h2>Visitor groups per half hour</h2>
<div class="chart" role="img" aria-label="Visitor groups per half hour">${bars}</div>
${method}
${cards ? `<h2>Top costumes</h2><div class="grid">${cards}</div>` : ""}
${quotes ? `<h2>${escapeHtml(name)}'s best lines</h2><div class="quotes">${quotes}</div>` : ""}`
    : `<p class="empty">No visitors in this day's log${opts.logText.includes(REHEARSAL_MARK) ? " (rehearsals don't count)" : ""}.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>Night recap · ${day}</title>
<style>
:root { color-scheme: dark; --bg: #120a1c; --panel: #1e1330; --line: #3a2858; --text: #f3eaff; --muted: #a99bc0; --orange: #ff7a1a; --purple: #b26bff; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: 16px; max-width: 1100px; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 16px; margin: 22px 0 10px; }
a { color: var(--orange); }
.privacy { background: #2a1a12; border: 1px solid #5a3418; border-radius: 10px; padding: 8px 12px; margin: 0 0 14px; font-size: 14px; }
.empty, .sub, .meta, .method { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.tile .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.tile .value { font-size: 22px; font-weight: 700; color: var(--orange); margin: 2px 0; }
.tile .sub { font-size: 13px; }
.chart { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.bar-row { display: grid; grid-template-columns: 9.5em 1fr 2.5em; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; }
.bar-row .when { color: var(--muted); font-variant-numeric: tabular-nums; }
.track { height: 14px; }
.bar { display: block; height: 100%; min-width: 2px; background: var(--purple); border-radius: 0 4px 4px 0; }
.bar-row.top .bar { background: var(--orange); }
.bar-row.top .when, .bar-row.top .n { color: var(--text); font-weight: 600; }
.bar-row .n { text-align: right; font-variant-numeric: tabular-nums; }
.method { margin: 10px 0 0; font-size: 13px; }
.method summary { cursor: pointer; color: var(--orange); }
.method li { margin: 4px 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.card { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.card img, .noimg { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #000; }
.noimg { display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 42px; color: var(--muted); }
.noimg span { font-size: 12px; }
figcaption { padding: 10px 12px 12px; }
.meta { font-size: 12px; }
.tag { color: var(--orange); }
.standout { margin: 6px 0 0; color: var(--orange); font-weight: 600; font-size: 14px; }
.caption { margin: 6px 0; font-size: 14px; overflow-wrap: anywhere; }
blockquote { margin: 8px 0 0; padding: 8px 10px; background: #2e1d10; border-radius: 8px; font-size: 14px; overflow-wrap: anywhere; }
blockquote::before { content: "🎃 "; }
.quotes blockquote { font-size: 16px; }
.quotes time { color: var(--muted); font: 12px ui-monospace, monospace; margin-right: 4px; }
footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
</style></head><body>
<header>
  <h1>🌙 ${escapeHtml(name)}'s night · ${escapeHtml(longDay(r.day))}</h1>
  <div><a href="${base}/gallery.html">🖼️ Gallery</a> · <a href="${base}/log.html">Full log</a> · <a href="/api/session-logs">All days</a></div>
</header>
<p class="privacy">🔒 <strong>Family only.</strong> These photos show other people's kids. Please keep them to yourselves: don't share, post or send them.</p>
${body}
<footer>Built from ${day}'s log.txt each time you open it. Times are this computer's local time.</footer>
</body></html>
`;
}

// --- serving ---

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The evening a moment belongs to: it runs noon to noon, so 1 am still recaps the night before. */
export function eveningDay(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < 12 ? 1 : 0));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function readDay(logDir: string, day: string, logSnapshots: boolean) {
  const logText = await readFile(join(logDir, day, "log.txt"), "utf8").catch(() => null);
  if (logText === null) return null;
  // Snapshots deleted since (or never saved) just show a placeholder.
  const snapshots = logSnapshots ? new Set((await readdir(join(logDir, day, "snapshots")).catch(() => [])).map((f) => `snapshots/${f}`)) : null;
  return { logText, snapshots };
}

export interface RecapRouteOptions {
  logDir: string;
  logSnapshots: boolean;
  name?: string;
  now?: () => Date;
}

/**
 * GET /recap/<day> (and /recap for the latest evening). Not under /api, so a phone that isn't
 * signed in is sent to the PIN page; the access guard (server/remote.ts) must be installed first.
 */
export function installRecap(app: Hono, opts: RecapRouteOptions): void {
  const now = opts.now ?? (() => new Date());
  app.get("/recap", async (c) => {
    const evening = eveningDay(now());
    const days = (await readdir(opts.logDir).catch(() => [])).filter((d) => LOG_DAY.test(d) && d <= evening).sort();
    return days.length ? c.redirect(`/recap/${days[days.length - 1]}`, 302) : c.text("No logs yet.", 404);
  });
  app.get("/recap/:day", async (c) => {
    const { day } = c.req.param();
    if (!LOG_DAY.test(day)) return c.notFound();
    const data = await readDay(opts.logDir, day, opts.logSnapshots);
    if (!data) return c.notFound();
    return c.html(buildRecap({ day, ...data, name: opts.name }), 200, PAGE_HEADERS);
  });
}

// --- the end-of-night push ---

/** RECAP_AT ("22:00") as minutes after midnight; empty is null (no clock trigger). */
export function parseRecapAt(value: string | undefined): number | null {
  const v = value?.trim() ?? "";
  if (!v) return null;
  const m = /^(\d{1,2}):(\d\d)$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`RECAP_AT must be a time like 22:00, got "${v}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Where the phone can reach this server, for the link in the push, or null. Without REMOTE_PIN the
 * server only answers this computer, so there's no link. REMOTE_URL wins; then a specific HOST;
 * then this computer's home-network address.
 */
export function phoneBaseUrl(opts: {
  pinSet: boolean;
  remoteUrl?: string;
  host: string;
  port: number;
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>;
}): string | null {
  if (!opts.pinSet) return null;
  const configured = opts.remoteUrl?.trim().replace(/\/+$/, "");
  if (configured) return /^https?:\/\/[\w.:[\]-]+$/.test(configured) ? configured : null;
  if (opts.host && opts.host !== "0.0.0.0" && opts.host !== "::" && /^[\w.-]+$/.test(opts.host) && !/^(127\.|localhost$)/.test(opts.host)) return `http://${opts.host}:${opts.port}`;
  for (const list of Object.values(opts.interfaces)) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && PRIVATE_V4.test(i.address)) return `http://${i.address}:${opts.port}`;
  }
  return null;
}

export interface NightRecapPushOptions {
  logDir: string;
  notifier: Notifier;
  /** RECAP_AT in minutes after midnight, or null. */
  atMinutes: number | null;
  /** The kill switch on this long counts as asleep for the night; null: don't push on sleep. */
  sleepMs: number | null;
  /** The phone-reachable base URL (see phoneBaseUrl), or null: the push carries the stats only. */
  baseUrl: string | null;
  name?: string;
  now?: () => Date;
  /** After a failed push, wait this long before trying again. */
  retryMs?: number;
}

/** Marks a day whose recap went out, so a restarted server doesn't push it again. */
export const RECAP_SENT_FILE = "recap-sent.txt";

/**
 * One ntfy push per evening with the night's headline stats and (when the phone can reach this
 * server) a link to the recap: when the kill switch has been on for a while, or at RECAP_AT.
 * Never photos or captions: ntfy topics are only as private as their name.
 */
export class NightRecapPush {
  private readonly now: () => Date;
  private readonly retryMs: number;
  private asleepSince: number | null = null;
  private readonly sent = new Set<string>();
  private retryAt = 0;
  private busy = false;

  constructor(private readonly opts: NightRecapPushOptions) {
    this.now = opts.now ?? (() => new Date());
    this.retryMs = opts.retryMs ?? 10 * 60_000;
  }

  /** From the dashboard's check-ins: asleep means woken with the kill switch on. */
  dashboardStatus(status: Pick<DashboardStatus, "woken" | "autopilot">): void {
    if (status.woken && !status.autopilot) this.asleepSince ??= this.now().getTime();
    else this.asleepSince = null;
  }

  /** Whether it's time: asleep long enough, or past RECAP_AT in this evening (noon to noon). */
  due(): boolean {
    const now = this.now();
    if (this.opts.sleepMs !== null && this.asleepSince !== null && now.getTime() - this.asleepSince >= this.opts.sleepMs) return true;
    if (this.opts.atMinutes === null) return false;
    const sinceNoon = (m: number) => (m - 720 + 1440) % 1440;
    return sinceNoon(now.getHours() * 60 + now.getMinutes()) >= sinceNoon(this.opts.atMinutes);
  }

  /** Call about once a minute. Resolves true when a push went out. */
  async tick(): Promise<boolean> {
    if (this.busy || this.now().getTime() < this.retryAt || !this.due()) return false;
    return this.push(eveningDay(this.now()));
  }

  /** Pushes a day's recap unless it already went out or there's nothing to tell. */
  async push(day: string): Promise<boolean> {
    if (this.busy || this.alreadySent(day)) return false;
    this.busy = true;
    try {
      const data = await readDay(this.opts.logDir, day, false);
      if (!data) return false;
      const recap = buildRecapData({ day, logText: data.logText, snapshots: null });
      if (!recap.groups.length) return false;
      const link = this.opts.baseUrl ? `${this.opts.baseUrl}/recap/${day}` : undefined;
      const text = headline(recap, this.opts.name) + (link ? `\nRecap: ${link}` : "");
      try {
        await this.opts.notifier.send({ title: "Tonight's recap", text, level: "warn", click: link });
      } catch (err) {
        this.retryAt = this.now().getTime() + this.retryMs;
        console.warn(`[recap] push failed: ${(err as Error).message}`);
        return false;
      }
      this.sent.add(day);
      try {
        writeFileSync(join(this.opts.logDir, day, RECAP_SENT_FILE), `${this.now().toISOString()}\n`);
      } catch {
        /* the in-memory mark still holds until a restart */
      }
      console.log(`[recap] pushed ${day}'s recap: ${headline(recap, this.opts.name)}`);
      return true;
    } finally {
      this.busy = false;
    }
  }

  alreadySent(day: string): boolean {
    return this.sent.has(day) || existsSync(join(this.opts.logDir, day, RECAP_SENT_FILE));
  }

  start(everyMs = 60_000): NodeJS.Timeout {
    const timer = setInterval(() => void this.tick(), everyMs);
    timer.unref();
    return timer;
  }
}
