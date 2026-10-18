# Soak test

A repeatable rehearsal of Halloween night at high speed, to find leaks and stalls before the real thing, **at no API cost**.

```bash
npm run soak                      # a 4-hour evening in about 75 minutes of wall time
npm run soak -- --hours 0.5       # a quick check (~8 min)
```

| Option | Default | Meaning |
|---|---|---|
| `--hours` | `4` | Length of the evening to play |
| `--seed` | `1031` | Same seed, same evening (visitors, failures, remote presses) |
| `--sample` | `20` | Seconds between samples |
| `--out` | a new folder in the system temp dir | Where results go |
| `--headful` | off | Show the Chrome window |
| `--no-build` | off | Skip `npm run build` (reuse `dist/`) |
| `--chrome` | `CHROME_PATH`, else the usual install paths | Chrome or Chromium to run |

It exits 0 when every check passes, 1 if one fails, 2 if it couldn't run. It is not part of `npm test`; its helpers are (`tests/soak.test.ts`).

## What runs

- **The real server** (`server/index.ts`, production build), with a fake key and `OPENAI_API_BASE` pointed at a **local mock of OpenAI** (`scripts/soak/mockOpenAI.ts`). The soak refuses to start unless the base URL is the mock. `.env` is ignored (`DOTENV_CONFIG_PATH` points at an empty file), so a real key, `NTFY_TOPIC` or `REMOTE_PIN` can't leak in. `BODY_SERIAL_PORT=none`, logs and the rehearsal cache go to the temp folder.
- **The real dashboard** in headless Chrome, driven over the DevTools protocol (`scripts/soak/cdp.ts`, on the `ws` package the server already uses; no Puppeteer). Fake camera and mic (`--use-fake-device-for-media-stream`), sound allowed without a click (`--autoplay-policy=no-user-gesture-required`), opened with `?autowake`.
- **Rehearsal mode**, through its real panel buttons: the soak "generates" 8 sample visitors (groups of 1–4) through the real `/api/rehearsal/generate` (the mock returns pictures Chrome drew), adds them, ticks *Rehearsal on*, then presses 🚶 / 👋 / 👯 / 🔁 on schedule. The real tracker, director, engine, vision calls, logs, watchdog, remote link, ambience and eye loop all run. One difference: vision requests are sent without the `rehearsal` flag, so the server saves greeting snapshots exactly as on a real night and disk growth is realistic.
- **WebRTC is faked in the page** (`scripts/soak/pageHooks.ts`): an `RTCPeerConnection` and `oai-events` data channel that act like GPT-Live (session.started, transcripts, usage, delegations, `session.close`/`closed`, about 1 in 25 sessions dropping its connection, about 1 in 12 greeting requests ignored so the nudge runs), plus a synthesized voice so the voice meter, eyes and "is it talking" logic see real audio. The SDP offer still goes to the real `/api/session` and on to the mock's `/live/sessions`.

### The mock (`scripts/soak/mockOpenAI.ts`)
`/v1/live/sessions`, `/v1/realtime/calls`, `/v1/responses` (costume descriptions; for comparing looks, SAME when the photo is the greeting photo again, otherwise NEW and CHANGED in turn), `/v1/images/generations` and `/v1/audio/speech`. It checks for a bearer token and counts calls. The soak injects 2% failures on sessions and vision, and one 75-second **outage** (every call 503) about 60% of the way through.

### The evening (`scripts/soak/scenario.ts`)
A seeded Halloween from 5:30 pm: about 20 groups an hour at first, 55 at the peak, 15 at the end (about 140 groups in 4 hours). Groups of 1–4 stay 20–70 s; a quarter are joined by more visitors, some swap to a different look (a 3 s gap), some come back soon (silence expected) or later (welcome back), some groups step in before "left" counts (a swap-in), and the odd passer-by comes close for a moment (wakes the session, then nobody arrives).

**Compression:** empty-porch gaps run 12× faster, visits 3× faster (at least 10 s), and the server gets `IDLE_CLOSE_SECONDS=15` and `BACKGROUND_FRAME_SECONDS=10` to match. Thresholds the dashboard code keeps to itself (8 s to count as left, 90 s for a return, 45 s for a welcome back, 30 s between "grew" greetings) stay real, so the code runs exactly as on the night. A 4-hour evening (about 135 groups with the default seed) takes about 75 minutes.

**Alongside:** a phone-remote press every 2.5–4.5 minutes (greet, say, quick modes on and off, sleep then wake), two `/api/logs` clients and one `/api/remote/stream` client that keep disconnecting (half cleanly, half with a TCP reset) and reconnecting with `Last-Event-ID`, and one log client that connects and never reads for 3 minutes. The night ends with the owner pressing **Greet now** on the empty porch (does it still work?), after which the session must go back to sleep.

## What it measures

Every sample (after forcing garbage collection in both processes):
- **Server:** RSS, heap, live timers and sockets (through the Node inspector), `/api/health` latency, open streams (`/api/health` → `streams`: log, phone and dashboard streams), the dashboard's heartbeat age.
- **Browser:** JS heap, DOM nodes (including detached ones), event listeners, Web Audio nodes (`Performance.getMetrics`), live timers and intervals, open EventSources and WebSockets, open voice sessions, in-flight and stuck fetches, the longest main-thread stall, oversized context appends (over 2,000 characters, about GPT-Live's 500-token limit).
- **Disk:** the log folder's size and snapshot count.
- **Voice:** sessions started and their billed minutes in this run, and a **projection for the real night**: the same visits with the real 3-minute idle close.

Results go to the output folder: `samples.csv` (one row per sample), `summary.json` (everything below), `timeline.json` (the evening, what the page sent the session, session spans, remote presses), `server.log`, `page-console.log`, and the day's `logs/`.

### Checks (pass/fail)
- **Leaks:** growth per hour after warm-up (the first 15%, at least 3 minutes), by least squares: server heap ≤ 3 MB/h, server RSS ≤ 40 MB/h, browser heap ≤ 5 MB/h, DOM nodes ≤ 1,000/h, listeners ≤ 200/h, Web Audio nodes ≤ 60/h. Skipped (⏭️) when less than 15 minutes is left after warm-up.
- **Timers and connections:** intervals flat after warm-up (in both processes), at most 2 EventSources, 1 WebSocket and 1 voice session open, and after the extra clients leave, exactly 1 log stream, 1 dashboard command stream and 0 phone streams on the server.
- **Stalls:** `/api/health` under 1 s, heartbeat under 10 s old, no main-thread stall over 2 s, no fetch over 10 s, every phone command run by the dashboard, no page reloads or uncaught errors.
- **Behavior:** at most 3% of new groups not greeted within 20 s (not counting kill-switch and outage windows), no voice session left open on an empty porch for more than a minute in total, and none open at the end.

## What it can't cover
- **Real WebRTC and GPT-Live:** audio, ICE, the real model's timing and wording, and real session expiry are faked. The mock answers in the documented shapes, not with real model output.
- **The real camera and person detector:** rehearsal mode replaces detections, so MediaPipe loads but never runs on frames; camera stalls and detector failures (the watchdog's reloads) aren't exercised.
- **The Arduino:** `BODY_SERIAL_PORT=none`; body messages go over `/ws/body` to a null sink.
- **Real sound output, the USB sound card and speaker selection** (Chrome runs muted).
- **The phone over Wi-Fi with a PIN** (the soak's clients are on loopback), and **ntfy** pushes (off).
- **Time compression:** per-hour leaks show up per wall hour; per-event leaks show up about 4× sooner than on the night (four hours of visits in one).
