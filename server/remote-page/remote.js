// Phone remote for the creature. Plain script (no build step); served by the creature server at /remote.
// Everything from the server is shown with textContent, never as HTML.
"use strict";

const $ = (id) => document.getElementById(id);
/** Command id → what the button was, so the dashboard's answer can be shown. */
const pending = new Map();
let snapshot = null;
let source = null;
let lastSnapshotAt = 0;
let toastTimer = 0;

function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = bad ? "bad" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 7000 : 3500);
}

function setConn(text, cls) {
  const el = $("conn");
  el.textContent = text;
  el.className = `dot ${cls}`;
}

function showSignIn(message) {
  if (source) source.close();
  source = null;
  $("app").hidden = true;
  $("signin").hidden = false;
  setConn("signed out", "");
  const err = $("pin-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("pin").focus();
}

function showApp() {
  $("signin").hidden = true;
  $("app").hidden = false;
  connect();
}

async function checkSignedIn() {
  try {
    const res = await fetch("/api/remote/me", { cache: "no-store" });
    if (res.ok) return showApp();
    const body = await res.json().catch(() => ({}));
    showSignIn(res.status === 403 ? body.error : "");
  } catch {
    setConn("server unreachable", "bad");
    setTimeout(checkSignedIn, 3000);
  }
}

$("pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("pin").value;
  if (!pin) return;
  try {
    const res = await fetch("/api/remote/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
    const body = await res.json().catch(() => ({}));
    $("pin").value = "";
    if (res.ok) return showApp();
    if (res.status === 401) return showSignIn(`Wrong PIN. ${body.attemptsLeft ?? 0} tries left before a 15-minute lockout.`);
    showSignIn(body.error || `Sign-in failed (HTTP ${res.status})`);
  } catch {
    showSignIn("Can't reach the creature's computer.");
  }
});

$("signout").addEventListener("click", async () => {
  await fetch("/api/remote/logout", { method: "POST" }).catch(() => undefined);
  showSignIn("");
});

function connect() {
  if (source) source.close();
  source = new EventSource("/api/remote/stream");
  lastSnapshotAt = Date.now();
  source.addEventListener("snapshot", (e) => {
    lastSnapshotAt = Date.now();
    snapshot = JSON.parse(e.data);
    render();
  });
  source.onerror = async () => {
    setConn("reconnecting…", "bad");
    // The stream also fails when the session expired (server restart): check before retrying.
    const res = await fetch("/api/remote/me", { cache: "no-store" }).catch(() => null);
    if (res && res.status === 401) showSignIn("Signed out (the server restarted or the session expired). Enter the PIN again.");
  };
}

// The server sends a snapshot at least every 5 s; much longer means the stream is dead.
setInterval(() => {
  if (!source || Date.now() - lastSnapshotAt < 15000) return;
  setConn("reconnecting…", "bad");
  connect();
}, 5000);

function stat(id, text, cls = "") {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

function render() {
  const s = snapshot;
  const d = s.dashboard;
  const online = s.dashboardOnline && d;
  setConn(online ? "live" : "dashboard offline", online ? "on" : "bad");

  const offline = $("offline");
  offline.hidden = Boolean(online);
  offline.textContent = s.dashboardSeenAgo === null
    ? "The dashboard isn't open on the creature's computer."
    : `The dashboard stopped checking in ${s.dashboardSeenAgo} s ago (frozen, crashed or closed). Check the computer by the door.`;

  const tap = $("needs-tap");
  tap.hidden = !(online && d.needsTap);
  tap.textContent =
    "The browser is blocking sound until someone clicks or taps the dashboard screen once. Try Wake below; if it stays blocked, " +
    "someone needs to click the dashboard (or start Chrome with --autoplay-policy=no-user-gesture-required).";

  if (d) {
    const creature = !d.woken ? (d.needsTap ? ["Needs a tap", "bad"] : ["Not woken yet", "warn"]) : d.autopilot ? ["Awake (autopilot)", "good"] : ["Asleep (kill switch)", "warn"];
    stat("s-creature", creature[0], creature[1]);
    stat("s-visitors", d.present ? `${d.visitors || 1} at the door` : "Nobody", d.present ? "good" : "");
    stat("s-voice", { open: "Connected", connecting: "Connecting…", closing: "Closing…", closed: "Asleep" }[d.voice] || d.voice, d.voice === "open" ? "good" : "");
    const camera = d.camera === "stalled" ? " · camera stalled" : d.detector === "failed" ? " · detector failed" : "";
    stat("s-body", `${d.body}${camera}`, camera ? "bad" : "");
    stat("s-cost", `${d.costToday === null ? "" : `≈ $${d.costToday.toFixed(2)} · `}${d.awakeMinutesToday} min${d.capReached ? " · cap reached" : ""}`, d.capReached ? "warn" : "");
  } else {
    for (const id of ["s-creature", "s-visitors", "s-voice", "s-body", "s-cost"]) stat(id, "—");
  }
  stat("s-arduino", !s.arduino.enabled ? "Off" : s.arduino.connected ? "Connected" : "Disconnected", !s.arduino.enabled ? "" : s.arduino.connected ? "good" : "bad");

  const kill = $("kill");
  const awake = d && d.woken && d.autopilot;
  kill.textContent = awake ? "🛑 Sleep (kill switch)" : "▶️ Wake";
  kill.className = `big ${awake ? "sleep" : "wake"}`;
  kill.dataset.command = awake ? "sleep" : "wake";
  kill.disabled = !online;
  $("greet").disabled = !(online && d.woken);
  $("say-button").disabled = !(online && d.woken);

  renderModes(online ? d.modes : null);
  renderAlerts(s.alerts);

  for (const [id, link] of [["today-log", s.links.todayLog], ["gallery", s.links.gallery], ["recap", s.links.recap]]) {
    $(id).hidden = !link;
    if (link) $(id).href = link;
  }

  const result = d && d.lastCommand;
  if (result && pending.has(result.id)) {
    pending.delete(result.id);
    toast(result.message, !result.ok);
  }
}

function renderModes(modes) {
  const box = $("modes");
  if (!modes) {
    box.replaceChildren(Object.assign(document.createElement("span"), { className: "muted", textContent: "Waiting for the dashboard…" }));
    return;
  }
  const buttons = modes.map((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = m.label;
    b.className = m.on ? "on" : "";
    b.setAttribute("aria-pressed", String(m.on));
    b.addEventListener("click", () => send({ type: "mode", mode: m.id, on: !m.on }, `${m.label} ${m.on ? "off" : "on"}`));
    return b;
  });
  box.replaceChildren(...buttons);
}

function renderAlerts(alerts) {
  const list = $("alerts");
  list.replaceChildren(
    ...alerts.map((a) => {
      const li = document.createElement("li");
      li.className = a.resolvedAt ? "resolved" : a.level;
      const title = document.createElement("strong");
      title.textContent = `${a.resolvedAt ? "✅ " : a.level === "error" ? "🚨 " : "⚠️ "}${a.title}${a.count > 1 ? ` ×${a.count}` : ""}`;
      const meta = document.createElement("small");
      meta.textContent = `${a.detail ? `${a.detail} · ` : ""}${ago(a.at)}${a.resolvedAt ? ` · cleared ${ago(a.resolvedAt)}` : ""}`;
      li.append(title, meta);
      return li;
    }),
  );
  $("no-alerts").hidden = alerts.length > 0;
}

async function send(command, label) {
  try {
    const res = await fetch("/api/remote/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return showSignIn("Signed out. Enter the PIN again.");
    if (!res.ok) return toast(body.error || `Failed (HTTP ${res.status})`, true);
    pending.set(body.id, label);
    toast(`${label}: sent…`);
  } catch {
    toast("Can't reach the creature's computer.", true);
  }
}

$("kill").addEventListener("click", () => {
  const cmd = $("kill").dataset.command;
  send({ type: cmd }, cmd === "sleep" ? "Sleep" : "Wake");
});
$("greet").addEventListener("click", () => send({ type: "greet" }, "Greet now"));
$("say-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("say-input").value.trim();
  if (!text) return;
  send({ type: "say", text }, "Say");
  $("say-input").value = "";
});

checkSignedIn();
