# Design

## System overview

```
          ┌──────────────────────── Porch (the prop) ──────────────────────────┐
          │ 13" plastic pumpkin: C920 webcam + its mics (behind the mouth)     │
          │   one Z150 speaker inside (the other behind it, via a USB sound    │
          │   card), eyes = NeoPixel Jewels or plain LEDs ── Arduino Uno       │
          │        └────── powered USB hub (behind the pumpkin) ──────┘        │
          └──────────────────────────────┬─────────────────────────────────────┘
                                         │ 16 ft active USB cable (or the Pi sits at the porch)
┌──────────────────────── Mac (or Pi 5) ─┴─────────────────────────────────────────┐
│  Chrome dashboard (web/) = the brain           Node server (server/)             │
│  ├─ Camera + MediaPipe person detector ─────▶  POST /api/vision ──▶ OpenAI vision │
│  ├─ VisitorTracker → Director                  POST /api/session ─▶ OpenAI        │
│  ├─ Voice engine (WebRTC) ◀═══ audio + events ═══════════════════▶ GPT-Live      │
│  ├─ VoiceMeter → body state ── WS /ws/body ──▶ BodyController ── USB ──▶ Arduino  │
│  ├─ Operator UI: modes, spookiness, voice,     Logs: logs/<day>/ (+ gallery)     │
│  │  kill switch, "make it say…", rehearsal     Remote relay + alerts ──▶ ntfy.sh │
│  ├─ Ambience + lure (local audio only)                 ▲                          │
│  └─ Watchdog, heartbeat ───────────────────────────────┤ PIN + cookie            │
└────────────────────────────────────────────────────────┼──────────────────────────┘
                                                Phone: /remote over home Wi-Fi
```

**Why a browser page?** Chrome gives us WebRTC (low-latency audio to OpenAI), **echo cancellation** (so the creature doesn't hear itself through the speaker), camera access and a GPU person detector, all for free. The same page runs in Chromium on a Raspberry Pi, so Pi mode needs no new code.

**Why a local server?** It keeps the OpenAI API key off the page, starts voice sessions, calls the vision model, and talks USB serial to the Arduino.

## Voice engines

Choose an engine with `ENGINE` in `.env`.

| | `live` (default) | `realtime` |
|---|---|---|
| Model | **GPT-Live-1** (`gpt-live-1`) | `gpt-realtime-2.1` |
| Why | OpenAI's newest and most natural voice, full duplex (it can listen while it talks) | Takes images natively; a single model does everything |
| Seeing | Camera frames go to a **vision model** (`VISION_MODEL`, a Responses model). Its text description is passed into the conversation. | `input_image` items sent straight to the voice model |
| Greeting | `session.commentary.append` ("say this, in your own words") | image + `response.create` |
| Fresh look on request | GPT-Live **delegates** to our client. We capture a frame, describe it, and reply on that delegation. | Model calls the `look` tool |
| Silent background view | `session.thinking.append` | image item without a response |
| Operator "say…" | `session.instructions.append` | system item + `response.create` |
| Cost | $0.05 per minute of voice, plus vision tokens | tokens (audio + images) |

Both engines implement the same `Engine` interface (`web/engines/types.ts`), so the rest of the app doesn't care which one is running.

### GPT-Live specifics we rely on
- `POST /v1/live/sessions` with `{ session: { model, instructions, audio.output.voice, delegation: { type: "client" } }, transport: { type: "webrtc", sdp } }` returns `{ session.id, transport.sdp }`. The server makes this call (`server/openai.ts`).
- Data channel `oai-events`. The browser waits for `session.started` before sending commands, and does a graceful `session.close` followed by `session.closed`.
- Transcripts arrive as `session.input_transcript.delta` / `session.output_transcript.delta`, and usage as `session.usage.updated` (`usage.seconds`).
- Context appends take ≤ 500 tokens each. `delegation_id: null` means general context.

## Behavior: the Director (`web/director.ts`)

```
person detector (5 fps, local) ─▶ VisitorTracker ─▶ sighted / arrived / grew / returned / gap / left ─▶ Director
```

- **VisitorTracker** (`web/visitors.ts`, pure logic, unit tested):
  - A person only counts when they're **close**: their box covers at least `minArea` of the frame. You set this with a slider on the dashboard.
  - `sighted` fires the moment anyone appears on an empty porch. They must be seen for 0.7 s before they count as arrived. Detection dropouts shorter than 0.5 s are ignored.
  - `grew` fires when a bigger group is stable for 2.5 s, with a 30 s cooldown between greetings.
  - `left` fires after 8 s with nobody visible.
  - `gap` fires when someone reappears after 2–8 s with nobody visible, once they've been back in view for 1 s, so the check photographs them properly rather than half in the doorway. That's too short to count as leaving, but long enough for one person to step out and another to step in. The Director logs every gap and asks the engine to **recheck** (at most once per 10 s).
  - `returned` fires when someone reappears within 90 s of `left`. For every return, the **vision model compares the fresh photo with the description of the group just greeted** and answers SAME or NEW, leaning toward NEW whenever anything differs or it's unsure:
    - **NEW:** a full greeting.
    - **SAME, back in under 45 s:** silence (a background update only). This covers detection flicker and someone stepping aside.
    - **SAME, back after 45 s or more:** a quick "welcome back".
    - **No clear look** (vision call failed, or no camera frame): the creature says it can't see well and asks whether they're back or new, instead of assuming strangers. The next return with a clear look still compares with the group greeted before.
    - **Over 90 s away:** a normal `arrived` greeting with no comparison.
  - The return comparison sends **the photo the group was greeted from** along with its description, so the vision model compares two photos rather than a photo against text.
- **sighted:** if the voice session is asleep, start connecting right away (mic still muted), so it's nearly ready when the arrival is confirmed. If nobody arrives within 15 s, it goes back to sleep.
- **arrived:** unmute the mic and **greet with a snapshot**. To cut the delay before the first sound, the vision look **starts while the session is still connecting**. If vision hasn't answered 250 ms after the session is open, the creature gives a **quick in-character hello** first, then compliments the costumes once vision describes them. Returns skip the quick hello, because the same people back soon should get silence.
- **grew:** greet the newcomers, unless a recheck greeted them in the last 20 s.
- **Big groups** (`web/bigGroup.ts`): the Director passes each greeting the tracker's head count and how many times the group has grown this visit. A group of `BIG_GROUP_SIZE` (4) or more, or one that has grown `LINE_GROWS` (2) times (a line forming), gets one quick group welcome, a shout-out to one or two standout costumes and one fun group moment (a joke, "everybody say trick or treat!"), and no mini-game, instead of costume-by-costume compliments. GPT-Live also reads a head count stated in the vision description ("Five visitors…") and takes the larger of the two: the detector misses kids bunched together or in masks but doesn't invent people, so vision can raise the count but never lower it. The quick hello only has the tracker's count, so a group vision finds bigger switches at the follow-up. The group's openings and finishes come from their own variety lists, never the same twice in a row. The realtime engine sends the same group greeting on the tracker's count alone. Each one logs a `big group (N)` system note. Same-group returns and newcomer checks are unchanged.
- **While present:** a background frame every `BACKGROUND_FRAME_SECONDS` (default 30), skipped while it's talking. Background frames and gap rechecks are also **compared with the greeting photo**, leaning SAME: only someone clearly different counts as new, not the same person who took off a hat or turned around. That catches **swaps** the tracker can't see, such as one person leaving and another arriving within 8 s, or crossing in frame. The check answers one of three verdicts:
  - **NEW** (someone clearly different): a greeting and a snapshot in the log.
  - **CHANGED** (same people, but a hat, mask, cape, wig or prop clearly put on, taken off or swapped): one quick, playful remark plus a snapshot. A change found after a gap (someone stepped out and back in) is deliberate, so it always gets a remark. Changes spotted by background looks are capped at one remark per 30 s, so a hat tipped back mid-chat doesn't make it chatty. Later checks compare with the new look.
  - **SAME**: "reference only, don't greet again".
- **Nudge:** a greeting request that doesn't make the creature start a **new** utterance within 5 s gets one firmer instruction, worded for the case (visitors, newcomers to a group, or someone new). The tail of a reply already under way when the request went out doesn't count. That's how a newcomer's greeting got lost while the creature was mid-sentence.
- **left:** mute the mic, so street noise doesn't get answers. After `IDLE_CLOSE_SECONDS` (default 180) of empty porch, **close the session** to stop the meter. Visitors reconnect it automatically, in about 1–2 s.
- **Session drops mid-visit** (expired or network): it reconnects and catches up silently, without greeting again.
- **Greet now on an empty porch** (the owner checking it works): the session still goes back to sleep after `IDLE_CLOSE_SECONDS` if nobody comes.
- **Kill switch:** closes the session and ignores visitors until you press Wake (and stops a recorded greeting).

### Offline mode (`web/offline.ts`, in the Director)
The voice session can fail to start (`/api/session` error, no network) or be too slow. Instead of silence:
- **A greeting waits 5 s** (`connectTimeoutMs`, counted from the arrival; the session started waking at the sighting) for the session to open. If it hasn't, a **recorded greeting** plays (`web/public/greeting/<character>/`, 16 costume-agnostic lines for Jacques) and the live greeting is **owed**. The connection carries on: if it opens, the live greeting follows once the clip has finished. A drop mid-visit that doesn't reconnect within 5 s also gets one recorded line (not one per retry); once back, it catches up silently.
- **The first failed start puts it offline.** Arrivals, returns and "grew" then get a recorded greeting at once, without asking the engine (so no vision call that would fail too).
- **Clips:** never the same one twice in a row (`pickDifferent`, shared with lure mode), at most one per 20 s (`clipCooldownMs`), except the operator's Greet now. A recorded greeting counts as the creature talking, so ambience and call-outs wait.
- **Retries** with backoff: 5 s, doubling to 60 s (`retryMinMs`, `retryMaxMs`), on ticks, sightings and arrivals; failures in flight are shared, so each is counted once. With visitors there, the first success gives the owed greeting live. With the porch empty, a background check opens a session and closes it at once when it works, so the next visitor gets the live voice.
- **Telling the owner:** going offline and recovering are logged (Conversation panel, and the server log via the alert: `[alert] Voice offline: playing recorded greetings: <error>`, then `[alert] cleared: … (live voice back after 95 s offline)`). The `voice-offline` alert is pushed through ntfy with fixed text, at most once per 15 minutes by `AlertCenter`'s per-kind limit, however often it flaps. The watchdog's `voice-errors` alert is held back while offline (its page reload for repeated failures still applies, at most 3 an hour).
- **Timeouts:** the server gives up on OpenAI's session endpoints after 12 s and the browser on `/api/session` after 20 s, so a hung request can't block retries.

### Variety across the night (`web/engines/variety.ts`, `web/evening.ts`)
Each voice session starts with no memory, and sessions sleep after 3 minutes of empty porch, so left alone the creature reuses its favourite lines all night.
- **Style twists:** every greeting asks for a random opening and a random way to finish (never the same twist twice in a row).
- **"Already said tonight" memory:** the creature's last 20 finished transcript lines (each shortened to about 120 characters, keeping its start and end) are saved in `localStorage` (`creature.evening`), so they survive page reloads. When a GPT-Live session starts, they go in as one `session.thinking.append` (`[MEMORY]`, capped at 1,800 characters so it stays under the 500-token append limit): "don't reuse these lines, jokes or verdicts".
- **Running gags:** the store also counts the visitor groups greeted tonight (arrivals, returns judged new, groups that grew, newcomers found by a check; not manual greetings, same-group returns or newcomers already greeted) and tallies costume kinds from the vision descriptions with a short, conservative keyword list (witch, dinosaur, superhero…; a grown group's costumes aren't counted twice). Each counted greeting ends with optional `[TONIGHT]` fun facts: the group's number, any costume streak ("the fourth dinosaur tonight"), the night's top costumes, and a milestone every 25 groups. They're offered, not scripted.
- **The evening** runs noon to noon on local time, so a party past midnight is one evening; the store resets the next day. Only the GPT-Live engine reads the store; lines are recorded under either engine.

### Between visitors: ambience and lure mode (`web/ambience.ts`, `web/porchSounds.ts`)
Local audio only: neither ever opens the (billed) voice session. `AmbienceScheduler` (pure logic, unit tested with fake time) runs every 200 ms on the tracker state, the far-away people count, whether the creature is talking (voice audible or the engine thinking), the kill switch and the two Settings toggles. `PorchSoundPlayer` plays its decisions through a `MediaStreamAudioDestinationNode` and an `<audio>` element, so `setSinkId` sends them to the same USB speaker as the voice.
- **Silence first:** anyone close (tracker not `empty`), the creature talking, or the kill switch stops whatever is playing at once (50 ms fade) and plays nothing.
- **Ambience:** synthesized with Web Audio (creak, owl, thunder, wind, cackle, howl, bell), at low volume with per-sound levels evened out. It plays every 20–60 s at random, never the same sound twice in a row, and waits a fresh delay after each visit.
- **Lure:** someone in view but below `minArea` for 1 s (detection gaps under 1 s tolerated) gets a recorded call-out from `web/public/lure/<character>/`. It never repeats a clip twice in a row, has a 45 s cooldown plus up to 15 s of jitter (configurable in Settings), and waits 30 s after visitors were close or the creature talked. A call-out interrupts ambience. Clips come from `scripts/make-lure-clips.ts` (OpenAI TTS, generated once and committed).
- **Eyes:** recorded clips (call-outs and offline greetings) also feed `PorchSoundPlayer.voiceTap`, before their volume. A second `VoiceMeter` follows it, and while a clip is audible the body state is `speaking` with the clip's loudness, so the eyes and jaw move as they do for the live voice (an offline greeting also starts with the greeting sparkle). Ambience isn't the creature talking: it only triggers a `slowblink` flourish.

### Recorded clips in the session voice (`server/clips.ts`, `shared/voices.ts`)
`gpt-4o-mini-tts` has 13 voices (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar; the docs recommend marin or cedar and describe none of them). Every gpt-realtime voice is one of them; of GPT-Live's, only `marin`. `ttsVoiceFor()` picks the closest reading:

| Session voice | Read by |
|---|---|
| a TTS voice (`marin`, every gpt-realtime voice, or `VOICE=cedar`) | itself |
| GPT-Live, masculine | `cedar`, plus the accent |
| GPT-Live, feminine | `marin`, plus the accent |
| accent | English voices: their region (`ripple` → cedar, Australian; `willow` → marin, Irish; `cinder` → cedar, Southern U.S.), none for North American (`meridian`, `gleam`). Other languages: the language (`sillage` → cedar, French; `nuri` → marin, German) |
| a voice with no known presentation | no match: the bundled clips |

The cedar/marin pairing by presentation is by ear, since OpenAI doesn't describe the TTS voices; the accent goes in the TTS instructions ("Speak English with a light, friendly Australian accent."), which gpt-4o-mini-tts follows. On wake and on every pick, the dashboard sends `POST /api/clips` with its pick; the server resolves the session voice exactly as `/api/session` does, makes any missing clips (3 requests at a time, one job per set), caches them in `<CLIP_CACHE_DIR>/<character>/<voice>[-<accent>]/<kind>/` and returns their URLs (`GET /api/clips/…`). Voices with the same reading share a set. Unchanged clips are never remade, so a cached set works with no key or network. Both routes are in `DASHBOARD_ONLY`: a phone signed in with the PIN can't trigger billed TTS. On any failure the dashboard keeps (or goes back to) the bundled `cedar` clips.

### Operator controls: standing instructions (`web/modes.ts`, `web/spookiness.ts`, `web/standing.ts`, `web/voiceChoice.ts`)
- **Quick modes** (Candy's low, Candy's out, Toddler mode, Back in 5, Last call) and the **spookiness dial** (Gentle, Playful, Spooky, Scary for teens, or Auto by the clock; Auto never picks Scary) combine into one **standing instruction**. It's sent with `session.instructions.append` as soon as it changes, re-sent at the start of every new voice session (sessions restart often), and remembered for the evening in `localStorage`. Toddler mode holds the creature at gentle whatever the dial says. Playful adds no instruction.
- **Voice:** the dashboard's pick (per engine, in `localStorage`) > `VOICE` in `.env` > the character's default. The browser sends its pick with `POST /api/session`; the server only accepts voices on its allowlist (`shared/voices.ts`, with OpenAI's own descriptions). A new voice applies from the next session.
- **Every toggle is logged** to the Conversation panel and the day's log.

## Logs, the costume gallery and the night recap (`server/logs.ts`, `server/gallery.ts`, `server/snapshots.ts`, `server/recap.ts`)
- The server mirrors its console into an in-memory buffer (streamed to the dashboard's **Server log** panel over SSE, `/api/logs`) and into **`logs/<YYYY-MM-DD>/`**: `log.txt`, `log.html` and `snapshots/`. Restarts append to the same day.
- The dashboard sends each finished Conversation line (visitor and creature speech, system notes) to `/api/conversation`, so the day's log has the whole story.
- The camera frame of each greeting, and of each check that found someone new or a costume change (`wantsSnapshot()`), is saved as a snapshot next to the vision verdict (a `snapshot` line in `log.txt`).
- The **gallery** (`/api/session-logs/<day>/gallery.html`) is built from `log.txt` on request: each greeting's snapshot, caption and the creature's best line from that moment. Family only; no sharing.
- **Snapshot privacy** (the photos are mostly of kids; pure rules in `shared/snapshots.ts`, deleting in `server/snapshots.ts`):
  - `SNAPSHOTS=off` writes no frames at all. A greeting's look is still logged, as a `look` line with the label, verdict and caption (and a "📷 snapshots off" placeholder in `log.html`), so the gallery tells the story in words and says snapshots are turned off. The older `LOG_SNAPSHOTS=false` also turns them off; either one saying off wins.
  - `SNAPSHOT_RETENTION_DAYS` (default 7) deletes the photos of day folders more than that many calendar days old (by folder name, in local time): with 7, Oct 31's photos go on Nov 8. It runs at server start and then every 24 h. Why 7: the family gets the week after Halloween to enjoy the gallery, and other people's kids' photos don't linger past that. `0` or `off` keeps them forever.
  - Removing keeps `log.txt` untouched and rewrites each removed photo's `<a><img></a>` in that day's `log.html` to a small inline-styled "📷 photo removed after N days" placeholder (inline, so older `log.html` files show it right). The gallery shows the same words for an expired day and states the retention in its privacy note.
  - **Delete all snapshots now** (dashboard, `POST /api/snapshots/delete-all` with `{"confirm": true}`, after a browser confirm) removes every day's photos, today's included, with a "📷 photo deleted" placeholder. It's dashboard-only in `server/auth.ts`, so a signed-in phone gets 403. `/api/config` tells the dashboard the current setting, shown under the log links.
  - **Path safety:** the log dir is resolved with `realpath` first; then only real directories (not symlinks) named like `LOG_DAY` that are inside it, only their own `snapshots/` (also not a symlink), and only regular files named like `SNAPSHOT_FILE` (`HH-MM-SS-label.jpg|png|webp`) are deleted. Day names that aren't real dates (`2026-13-45`) are never expired. Symlinked `log.html` files aren't rewritten.
- The **night recap** (`/recap/<day>`) is also built from `log.txt` on request, rehearsal lines skipped. Groups come from the dashboard's notes ("Visitors arrived (3)", "More visitors (3 → 5)", carrying the detector's count) matched to their vision lines, plus vision NEW verdicts on returns and checks (counted from the description). It adds a per-half-hour bar chart (CSS, no script), one top costume per group (scored on NEW greetings, "standout:" details and a photo still on disk; near-duplicate captions dropped), the best creature lines (the gallery's `scoreLine`), and awake time from "Voice session open/closed" notes. Missing snapshot files show a placeholder. It's outside `/api` so an unsigned phone is redirected to the PIN page; the same guard applies.
- **End-of-night push** (`NightRecapPush`): once per evening (noon to noon), when the dashboard has reported the kill switch on for `RECAP_SLEEP_MINUTES`, or at `RECAP_AT`. Headline numbers only; a link only when `REMOTE_PIN` is set and an address the phone can reach is known (`REMOTE_URL`, a specific `HOST`, or a private IPv4 address). Marked sent with `recap-sent.txt` in the day's folder; a failed push retries after 10 minutes.
- `LOG_DIR=none` keeps nothing.

## Phone remote, alerts and watchdog (`server/auth.ts`, `server/remote.ts`, `server/alerts.ts`, `web/remoteLink.ts`, `web/watchdog.ts`)
- **The dashboard stays the brain.** It posts its status to the server every 2 s (which doubles as a heartbeat) and receives the phone's commands from the server. The phone page (`/remote`) only talks to the server.
- **Auth:** off the LAN by default. With `REMOTE_PIN` set, the server listens on all interfaces; every non-loopback request to `/api` and `/ws` needs a session cookie from the PIN check (constant-time compare, rate-limited, `HttpOnly`, `SameSite=Strict`). Even signed in, the phone can't start voice sessions, call vision, drive the Arduino or delete snapshots. The Vite dev server never listens on the LAN; the phone always uses port 8787.
- **Alerts** are collected on the server (camera lost, detector failed, Arduino disconnected, vision or voice errors piling up, cost cap reached, watchdog reload, needs a tap, dashboard silent), deduplicated, shown on the dashboard and the phone, and optionally pushed via ntfy (`NTFY_TOPIC`): fixed short texts only, rate-limited. The night recap's one push per evening carries numbers and times only.
- **Watchdog:** restarts a stalled camera, reloads the page on repeated detector or voice failures (at most 3 reloads an hour), and resumes awake after a reload. Browsers block sound until a click after a reload, so unattended machines need Chrome's `--autoplay-policy=no-user-gesture-required` (the Pi kiosk has it; `scripts/pi/kiosk.sh` also restarts a frozen Chromium).

## Rehearsal mode (`web/rehearsal.ts`, `web/rehearsalPanel.ts`)
Two seams in `web/main.ts` replace the camera frame (what vision sees) and the person detections (what the tracker sees) with sample images and pretend visitors. Everything downstream (tracker, Director, engines, vision) is the real thing, so it costs money like real visitors. Rehearsal greetings use a throwaway evening memory, are marked `[REHEARSAL]` in the logs, and save no snapshots, so tonight's tally and the gallery stay clean.

## Characters (`prompts/`)

- `base.md` holds the shared rules, so every character is kid-safe:
  - never *truly* scary: no gore, death, threats, cruelty, meanness or jump-scares; within that, the operator's **spookiness dial** sets how spooky it gets (its "Spookiness tonight" instruction never lifts those limits, and Scary restates them);
  - no costume is fine: warm and simple ("you're still awesome!");
  - compliment **costumes only**, never bodies or appearance;
  - be brief;
  - no personal questions;
  - reply in the visitor's language.
- `characters/<id>.md` holds the persona and gimmick, with frontmatter for the voice, the realtime voice, the eye colors and style, and `games: on|off`.
- **Jacques** talks kid-first: name the costume and its standout detail in plain words, a big silly verdict, at most one short food joke. His full food-critic routine is only for grown-ups who play along. He has no French accent or French words, never says "chef's kiss", and is told how to sound ("big, bouncy energy, like a children's TV host").
- `games.md` holds optional trick-or-treat mini-games (a "trick" riddle, a roar or spooky-laugh contest, "guess what I am") and a small bank of riddles and jokes for 4–8-year-olds. A character opts in with `games: on` in its frontmatter (Jacques does). The rules: at most one game per visit, short, everyone wins, and candy never depends on a game.
- The server builds the instructions from `base.md`, then the persona, then `games.md` if the character opted in, then engine-specific notes on how sight works.
- To add a character, add a file. It then shows up in the dashboard's character picker.

The voice below is each character's default; the dashboard's **Voice** picker and `VOICE` in `.env` override it (see Operator controls). The owner currently runs Jacques with `ripple`.

| id | Character | GPT-Live voice | Eyes |
|---|---|---|---|
| `pumpkin` | Jacques O'Lantern, Pumpkin Critic: reviews costumes like fine dishes | `meridian` | red-orange candle flicker |
| `reginald` | Sir Reginald Bonesworth, Skeleton Butler: announces guests at a ball | `vesper` | cool blue glow |
| `raven` | Edgar the Raven, Rhyming Critic: rhyming couplets | `stone` | amber, blinks |

## Body (`server/body/`, `firmware/creature_body/`)

- The browser derives one **body state** about 60×/s:
  - `sleeping`: the creature is asleep (not woken, or the kill switch is on). Awake with the voice session closed (autopilot waiting for visitors) is `idle`;
  - `speaking`: the voice, or a recorded clip, is audible;
  - `thinking`: waiting on vision or the model;
  - `listening`: a visitor spoke within the last 1.5 s;
  - `idle`: none of the above.
- The voice **loudness** comes from a WebAudio analyser on the remote voice track.
- Both go over a WebSocket to the server's `BodyController`, which:
  - auto-detects the Arduino;
  - replays the palette and state when the Arduino reconnects;
  - heartbeats only while a dashboard is attached.
- Serial line protocol (38400 baud; faster loses bytes while the NeoPixels update):

| Command | Meaning |
|---|---|
| `M eyes,jaw,relay` | enable modes (`BODY_MODES`) |
| `P <state> r g b` | eye color per state (from the character file) |
| `Y flicker\|glow\|blink` | idle eye style |
| `S <state>` | current state |
| `L 0-255` | voice loudness |
| `F sparkle\|gasp\|slowblink` | one-shot eye flourish over the current state (~1 s): sparkle when a greeting starts, gasp for a welcome back, a blink (the lid sweeping down and up) on starting to think |

- **Fail-safe:** if no line arrives for 2 s, the firmware dims the eyes to "sleeping", opens the relay and closes the jaw.
- **Modes:**
  - **eyes:** two NeoPixel Jewels (`EYES_NEOPIXEL 1`, the default) in the state's color, each LED animated on its own (`pixelMotion()`: a candle flicker per LED when idle, with the center breathing toward dark purple every 3.2 s and, every 3–7 s, a warm white spark racing twice round the rings from a random pixel, a random way round (idle and sleeping eyes also blink a black lid every 4–8 s), a soft spot circling while listening, a comet spinning while thinking, and a warm ripple while speaking, with brightness following the voice from dim between words to full, a blink every 3–6 s (a black lid sweeps down over each eye and back up in under 0.4 s; `EYE_TOP_PIXEL` says which ring LED is on top as mounted), and a whirl (about 1.5 fast extra turns) when the voice jumps loud, at most every 5 s and at least every 9 s; the two eyes turn in mirror image, and the dashboard preview runs the same math in `web/eyeFlourish.ts`); or two plain LEDs on D3/D5 (`EYES_NEOPIXEL 0`), brightness only, gamma-corrected so the states look distinct. Flourishes (`F …`) degrade to brightness-only twinkles on plain LEDs.
  - **jaw:** an SG90 servo whose angle follows the loudness.
  - **relay:** a 400 ms "button press" on a store animatronic's trigger when speech starts, with an 8 s cooldown.

## Safety, privacy and cost
- **Kid safety:**
  - the prompt rules above;
  - OpenAI's built-in moderation;
  - the operator kill switch, quick modes (Toddler mode) and the spookiness dial, also from the phone remote;
  - Scary (teens) never auto-engages, and drops to gentle if a young child walks up or anyone seems scared;
  - the vision model is told to describe costumes only, never bodies. For each costume it also names one **standout detail** ("standout: glow-in-the-dark bones"), and greeting requests ask the creature to praise that detail, so every compliment is specific.
- **Privacy:** frames are sent to OpenAI only when someone is close. The vision model never judges age, bodies or faces. The day's log in `logs/` keeps the conversation and one snapshot per greeting on the local disk, for 7 days by default (`SNAPSHOT_RETENTION_DAYS`; `SNAPSHOTS=off` skips the photos, the dashboard can delete them all at once, `LOG_DIR=none` keeps nothing); the gallery is family-only. The phone remote needs a PIN and is off by default; ntfy pushes carry no visitor data. On a Pi left outside, see the security notes in `PI_MODE.md`. Consider a small sign saying the decoration is AI-powered and records.
- **Cost controls:**
  - the voice session only runs while visitors are around (plus the idle timeout);
  - background frames are rate-limited;
  - vision uses `detail: "low"` on 768 px JPEGs;
  - the voice session starts waking on the first sighting but goes back to sleep after 15 s if nobody arrives;
  - lure call-outs and ambience are local audio and never open the voice session;
  - the dashboard and phone show a live cost meter, and `MAX_VOICE_MINUTES_PER_DAY` puts it to sleep (with an alert) at a daily cap.
  - Also set a monthly limit on the OpenAI project.

## Known limits and risks
- **Tested on the Mac** (Oct 17–18) with the C920, the Z150 on a USB sound card and plain-LED eyes. Not yet tested: NeoPixel Jewel eyes on hardware, Pi mode, the phone remote on a real phone, ntfy delivery, and lure and ambience on the porch speaker.
- **Soak test** (`npm run soak`, [SOAK_TEST.md](SOAK_TEST.md)): a 4-hour evening compressed into about 75 minutes, with the real server and dashboard against a mock OpenAI and faked WebRTC. It covers memory, timers, streams, disk and stalls, but not real WebRTC, the real camera and detector, or the Arduino.
- GPT-Live's docs say appended context "may" be spoken. The quick hello, follow-up compliments and the nudge make greetings reliable in testing; tune the wording in `web/engines/live.ts` if needed.
- GPT-Live voices don't follow accent instructions reliably (only a native-language voice carries an accent), so the voice picker matters more than the prompt for how it sounds. Recorded clips are text-to-speech: apart from `marin`, GPT-Live's voices only get the closest TTS voice plus an accent, so call-outs and offline greetings sound similar to the live voice, not the same.
- Offline mode and the clip-driven eyes are unit tested and the audio path was checked in Chrome, but not yet on the porch speaker or real Arduino eyes, nor with a real Wi-Fi outage.
- At night, the camera needs light on visitors. Detection and costume descriptions both degrade in the dark; tall hats get cut off if the camera sits too low or the visitor stands too close.
- After an automatic reload, a browser without the autoplay flag waits for a click before it can speak.
