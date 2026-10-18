/**
 * The costume gallery: a day's greeting snapshots (from log.txt, as written by SessionLog) with
 * their vision captions and the creature's best line from around that time, as one HTML page.
 */

export interface LogLine {
  /** Seconds since midnight. */
  at: number;
  time: string;
  tag: string;
  text: string;
}

export interface GalleryItem {
  time: string;
  /** Path relative to the day's folder, e.g. snapshots/18-05-09-arrived.jpg. */
  file: string;
  label: string;
  verdict?: string;
  caption: string;
  /** The creature's best line near this snapshot, if any. */
  line?: string;
}

const LINE = /^(\d\d):(\d\d):(\d\d) (\S+)\s+(.*)$/;
const SNAPSHOT = /^(snapshots\/[\w-]+\.(?:jpg|png|webp)) {2}(\S+) (?:\[(\w+)\] )?([\s\S]*)$/;
/** Continuation lines (multi-line text) are indented under their timestamp. */
const CONTINUATION = "         ";

/** Parses log.txt into entries; continuation lines are joined onto their entry. */
export function parseLogText(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith(CONTINUATION) && lines.length) {
      lines[lines.length - 1]!.text += `\n${raw.slice(CONTINUATION.length)}`;
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, h, min, s, tag, rest] = m;
    lines.push({ at: Number(h) * 3600 + Number(min) * 60 + Number(s), time: `${h}:${min}:${s}`, tag: tag!, text: rest! });
  }
  return lines;
}

/** Look at creature lines from a little before a snapshot (the quick hello) until this long after it. */
const BEFORE_S = 10;
const AFTER_S = 90;

const STOP_WORDS = new Set(
  "a an and are as at be but by for from has have in is it its of on one or the their them they this to two three with you your visitor visitors wearing who what".split(" "),
);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );

/**
 * How good a creature line is as the "quote" for a costume: it should talk about what the
 * camera saw (shared words with the caption), and be a real line rather than "Hi!" or a ramble.
 */
export function scoreLine(line: string, caption: string): number {
  const captionWords = words(caption);
  let overlap = 0;
  for (const w of words(line)) if (captionWords.has(w)) overlap++;
  const len = line.trim().length;
  const lengthScore = len < 25 ? -2 : len > 260 ? -1 : Math.min(len, 140) / 70;
  return overlap * 2 + lengthScore + (/[!]/.test(line) ? 0.5 : 0);
}

/** Each snapshot in the log, with its caption and the creature's best line from around then. */
export function galleryItems(logText: string): GalleryItem[] {
  const lines = parseLogText(logText);
  const snaps = lines.filter((l) => l.tag === "snapshot").sort((a, b) => a.at - b.at);
  // Conversation lines reach the log a few seconds late, so match by time, not file order.
  const creature = lines.filter((l) => l.tag === "creature" && l.text.trim());
  const items: GalleryItem[] = [];
  snaps.forEach((snap, i) => {
    const m = SNAPSHOT.exec(snap.text);
    if (!m) return;
    const [, file, label, verdict, caption] = m;
    const next = snaps[i + 1]?.at ?? Infinity;
    const until = Math.min(snap.at + AFTER_S, next);
    let best: { text: string; score: number } | undefined;
    for (const c of creature) {
      if (c.at < snap.at - BEFORE_S || c.at >= until) continue;
      const score = scoreLine(c.text, caption!);
      if (!best || score > best.score) best = { text: c.text.trim(), score };
    }
    items.push({ time: snap.time, file: file!, label: label!, verdict: verdict || undefined, caption: caption!.trim(), line: best?.text });
  });
  return items;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const LABELS: Record<string, string> = { arrived: "New visitors", grew: "More joined", returned: "Came back", manual: "Greet now" };
const VERDICTS: Record<string, string> = { NEW: "someone new", CHANGED: "new look", SAME: "same group" };

export interface GalleryOptions {
  day: string;
  logText: string;
  /** Snapshot files that exist (paths like snapshots/x.jpg); null when snapshots are turned off. */
  snapshots: ReadonlySet<string> | null;
  title?: string;
}

/** The gallery page for one day. Family-only: no share or upload buttons, and a privacy note. */
export function buildGallery({ day, logText, snapshots, title = "Costume gallery" }: GalleryOptions): string {
  const items = galleryItems(logText);
  const cards = items.map((item, i) => {
    const hasImage = snapshots?.has(item.file) ?? false;
    const tag = [LABELS[item.label] ?? item.label, item.verdict ? VERDICTS[item.verdict] ?? item.verdict : ""].filter(Boolean).join(" · ");
    return (
      `<figure class="card" data-index="${i}" tabindex="0">` +
      (hasImage
        ? `<img src="${escapeHtml(item.file)}" alt="Costume snapshot at ${item.time}" loading="lazy">`
        : `<div class="noimg">🎃<span>${snapshots ? "photo not saved" : "photos are off"}</span></div>`) +
      `<figcaption><div class="meta"><time>${item.time}</time> <span class="tag">${escapeHtml(tag)}</span></div>` +
      `<p class="caption">${escapeHtml(item.caption)}</p>` +
      (item.line ? `<blockquote>${escapeHtml(item.line)}</blockquote>` : "") +
      `</figcaption></figure>`
    );
  });
  const off = snapshots === null ? `<p class="note">Snapshots are turned off (<code>LOG_SNAPSHOTS=false</code>), so this shows words only.</p>` : "";
  const empty = `<p class="empty">No costume snapshots on this day yet. They show up here after Jacques greets someone.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · ${escapeHtml(day)}</title>
<style>
:root { color-scheme: dark; --bg: #120a1c; --panel: #1e1330; --line: #3a2858; --text: #f3eaff; --muted: #a99bc0; --orange: #ff7a1a; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
h1 { font-size: 20px; margin: 0; }
header a, header button { color: var(--orange); }
button { background: #2c1c46; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
button:hover { border-color: var(--orange); }
.privacy { background: #2a1a12; border: 1px solid #5a3418; border-radius: 10px; padding: 8px 12px; margin: 0 0 14px; font-size: 14px; }
.note, .empty { color: var(--muted); }
code { background: #140c22; padding: 0 4px; border-radius: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
.card { margin: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; cursor: pointer; display: flex; flex-direction: column; }
.card:hover, .card:focus { border-color: var(--orange); outline: none; }
.card img, .noimg { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: #000; }
.noimg { display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 42px; color: var(--muted); }
.noimg span { font-size: 12px; }
figcaption { padding: 10px 12px 12px; }
.meta { font-size: 12px; color: var(--muted); }
.meta time { font-family: ui-monospace, monospace; }
.tag { color: var(--orange); }
.caption { margin: 6px 0; font-size: 14px; overflow-wrap: anywhere; }
blockquote { margin: 8px 0 0; padding: 8px 10px; background: #2e1d10; border-radius: 8px; font-size: 14px; overflow-wrap: anywhere; }
blockquote::before { content: "🎃 "; }
.show { position: fixed; inset: 0; background: rgba(8, 4, 14, .96); display: none; flex-direction: column; align-items: center; justify-content: center; padding: 16px; gap: 12px; }
.show.open { display: flex; }
.show .frame { max-width: min(100%, 1100px); width: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.show img, .show .noimg { max-width: 100%; height: 64vh; width: auto; object-fit: contain; border-radius: 10px; }
.show .noimg { width: min(100%, 480px); }
.show .text { max-width: 760px; text-align: center; }
.show .caption { font-size: 17px; }
.show blockquote { font-size: 18px; text-align: left; }
.show .controls { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.show .count { color: var(--muted); font-size: 13px; align-self: center; }
</style></head><body>
<header>
  <h1>🎃 ${escapeHtml(title)} · ${escapeHtml(day)}</h1>
  <div>${items.length ? `<button id="play" type="button">▶️ Slideshow</button> ` : ""}<a href="log.html">Full log</a> · <a href="/api/session-logs">All days</a></div>
</header>
<p class="privacy">🔒 <strong>Family only.</strong> These photos show other people's kids. Please keep them to yourselves: don't share, post or send them. They stay on this computer, and you can delete a day by deleting its folder in <code>logs/</code>.</p>
${off}
${items.length ? `<p class="note">${items.length} greeting${items.length === 1 ? "" : "s"}. Click a costume to see it big.</p><div class="grid">${cards.join("\n")}</div>` : empty}
<div class="show" id="show" role="dialog" aria-modal="true" aria-label="Slideshow">
  <div class="frame" id="frame"></div>
  <div class="controls">
    <button type="button" id="prev">◀ Back</button>
    <button type="button" id="auto">⏸ Pause</button>
    <button type="button" id="next">Next ▶</button>
    <button type="button" id="close">✕ Close</button>
    <span class="count" id="count"></span>
  </div>
</div>
<script>
(() => {
  const cards = [...document.querySelectorAll(".card")];
  const show = document.getElementById("show"), frame = document.getElementById("frame"), count = document.getElementById("count"), auto = document.getElementById("auto");
  let index = 0, timer = null;
  const render = () => {
    const card = cards[index];
    const media = card.querySelector("img, .noimg").cloneNode(true);
    media.removeAttribute("loading");
    const text = document.createElement("div");
    text.className = "text";
    text.append(...[...card.querySelector("figcaption").children].map((n) => n.cloneNode(true)));
    frame.replaceChildren(media, text);
    count.textContent = (index + 1) + " / " + cards.length;
  };
  const go = (step) => { index = (index + step + cards.length) % cards.length; render(); };
  const stop = () => { clearInterval(timer); timer = null; auto.textContent = "▶️ Play"; };
  const play = () => { stop(); timer = setInterval(() => go(1), 6000); auto.textContent = "⏸ Pause"; };
  const open = (i, autoplay) => { index = i; render(); show.classList.add("open"); autoplay ? play() : stop(); };
  const close = () => { stop(); show.classList.remove("open"); };
  cards.forEach((card, i) => {
    card.addEventListener("click", () => open(i, false));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(i, false); } });
  });
  document.getElementById("play")?.addEventListener("click", () => open(0, true));
  document.getElementById("prev").addEventListener("click", () => { stop(); go(-1); });
  document.getElementById("next").addEventListener("click", () => { stop(); go(1); });
  document.getElementById("close").addEventListener("click", close);
  auto.addEventListener("click", () => (timer ? stop() : play()));
  document.addEventListener("keydown", (e) => {
    if (!show.classList.contains("open")) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") { stop(); go(-1); }
    else if (e.key === "ArrowRight") { stop(); go(1); }
  });
})();
</script>
</body></html>
`;
}
