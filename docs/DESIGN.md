# Design

## System overview

```
                 ┌──────────────────────── Porch (the prop) ────────────────────────┐
                 │  Foam pumpkin:  webcam (behind mouth)   NeoPixel eyes            │
                 │                 speakerphone (inside)   [jaw servo]  [relay]     │
                 │        └───────────── powered USB hub ──── Arduino ─┘            │
                 └──────────────────────────────┬───────────────────────────────────┘
                                                │ one 16 ft active USB cable
┌─────────────────────────────── Mac (or Pi 5) ─┴──────────────────────────────────┐
│  Chrome dashboard (web/)                         Node server (server/)            │
│  ├─ Camera + MediaPipe person detector  ──────▶  POST /api/vision ──▶ OpenAI      │
│  ├─ VisitorTracker → Director                    POST /api/session ─▶ OpenAI      │
│  ├─ Voice engine (WebRTC) ◀════ audio + events ════════════════════▶ GPT-Live     │
│  ├─ VoiceMeter → body state ── WS /ws/body ───▶  BodyController ── USB serial ──▶ Arduino
│  └─ Operator UI: transcript, cost, kill switch, "make it say…"                    │
└───────────────────────────────────────────────────────────────────────────────────┘
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
- **arrived:** unmute the mic and **greet with a snapshot**. To cut the delay before the first sound, the vision look **starts while the session is still connecting**. If vision hasn't answered 250 ms after the session is open, the creature gives a **quick in-character hello** first ("leaning in for a closer look"), then compliments the costumes once vision describes them. Returns skip the quick hello, because the same people back soon should get silence.
- **grew:** greet the newcomers, unless a recheck greeted them in the last 20 s.
- **While present:** a background frame every `BACKGROUND_FRAME_SECONDS` (default 30), skipped while it's talking. Background frames and gap rechecks are also **compared with the greeting photo**, leaning SAME: only someone clearly different counts as new, not the same person who took off a hat or turned around. That catches **swaps** the tracker can't see, such as one person leaving and another arriving within 8 s, or crossing in frame. The check answers one of three verdicts:
  - **NEW** (someone clearly different): a greeting and a snapshot in the log.
  - **CHANGED** (same people, but a hat, mask, cape, wig or prop clearly put on, taken off or swapped): one quick, playful remark plus a snapshot. A change found after a gap (someone stepped out and back in) is deliberate, so it always gets a remark. Changes spotted by background looks are capped at one remark per 30 s, so a hat tipped back mid-chat doesn't make it chatty. Later checks compare with the new look.
  - **SAME**: "reference only, don't greet again".
- **Nudge:** a greeting request that doesn't make the creature start a **new** utterance within 5 s gets one firmer instruction, worded for the case (visitors, newcomers to a group, or someone new). The tail of a reply already under way when the request went out doesn't count. That's how a newcomer's greeting got lost while the creature was mid-sentence.
- **left:** mute the mic, so street noise doesn't get answers. After `IDLE_CLOSE_SECONDS` (default 180) of empty porch, **close the session** to stop the meter. Visitors reconnect it automatically, in about 1–2 s.
- **Session drops mid-visit** (expired or network): it reconnects and catches up silently, without greeting again.
- **Failed start** (bad key or no network): it backs off 15 s instead of retrying every second.
- **Kill switch:** closes the session and ignores visitors until you press Wake.

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

## Characters (`prompts/`)

- `base.md` holds the shared rules, so every character is kid-safe:
  - never scary;
  - compliment **costumes only**, never bodies or appearance;
  - be brief;
  - no personal questions;
  - reply in the visitor's language.
- `characters/<id>.md` holds the persona and gimmick, with frontmatter for the voice, the realtime voice, and the eye colors and style.
- `games.md` holds optional trick-or-treat mini-games (a "trick" riddle, a roar or spooky-laugh contest, "guess what I am") and a small bank of riddles and jokes for 4–8-year-olds. A character opts in with `games: on` in its frontmatter (Jacques does). The rules: at most one game per visit, short, everyone wins, and candy never depends on a game.
- The server builds the instructions from `base.md`, then the persona, then `games.md` if the character opted in, then engine-specific notes on how sight works.
- To add a character, add a file. It then shows up in the dashboard's character picker.

| id | Character | GPT-Live voice | Eyes |
|---|---|---|---|
| `pumpkin` | Jacques O'Lantern, Pumpkin Critic: reviews costumes like fine dishes | `meridian` | orange candle flicker |
| `reginald` | Sir Reginald Bonesworth, Skeleton Butler: announces guests at a ball | `vesper` | cool blue glow |
| `raven` | Edgar the Raven, Rhyming Critic: rhyming couplets | `stone` | amber, blinks |

## Body (`server/body/`, `firmware/creature_body/`)

- The browser derives one **body state** about 60×/s:
  - `sleeping`: no session;
  - `speaking`: the voice is audible;
  - `thinking`: waiting on vision or the model;
  - `listening`: a visitor spoke within the last 1.5 s;
  - `idle`: none of the above.
- The voice **loudness** comes from a WebAudio analyser on the remote voice track.
- Both go over a WebSocket to the server's `BodyController`, which:
  - auto-detects the Arduino;
  - replays the palette and state when the Arduino reconnects;
  - heartbeats only while a dashboard is attached.
- Serial line protocol (115200 baud):

| Command | Meaning |
|---|---|
| `M eyes,jaw,relay` | enable modes (`BODY_MODES`) |
| `P <state> r g b` | eye color per state (from the character file) |
| `Y flicker\|glow\|blink` | idle eye style |
| `S <state>` | current state |
| `L 0-255` | voice loudness |
| `F sparkle\|gasp\|slowblink` | one-shot eye flourish over the current state (~1 s): sparkle when a greeting starts, gasp for a welcome back, slow blink on starting to think |

- **Fail-safe:** if no line arrives for 2 s, the firmware dims the eyes to "sleeping", opens the relay and closes the jaw.
- **Modes:**
  - **eyes:** two NeoPixel jewels whose color follows the state and whose brightness follows the voice.
  - **jaw:** an SG90 servo whose angle follows the loudness.
  - **relay:** a 400 ms "button press" on a store animatronic's trigger when speech starts, with an 8 s cooldown.

## Safety, privacy and cost
- **Kid safety:**
  - the prompt rules above;
  - OpenAI's built-in moderation;
  - the operator kill switch;
  - the vision model is told to describe costumes only, never bodies. For each costume it also names one **standout detail** ("standout: glow-in-the-dark bones"), and greeting requests ask the creature to praise that detail, so every compliment is specific.
- **Privacy:** frames are sent to OpenAI only when someone is close. The day's log in `logs/` keeps the conversation and one snapshot per greeting on the local disk (`LOG_SNAPSHOTS=false` skips the photos, `LOG_DIR=none` keeps nothing). Consider a small sign saying the decoration is AI-powered and records.
- **Cost controls:**
  - the voice session only runs while visitors are around (plus the idle timeout);
  - background frames are rate-limited;
  - vision uses `detail: "low"` on 768 px JPEGs;
  - the dashboard shows a live cost meter.
  - Also set a monthly limit on the OpenAI project.

## Known limits and risks
- I couldn't test GPT-Live against the real API in the build sandbox (no key), so the first run on the Mac is the real integration test. The Realtime engine is the fallback (`ENGINE=realtime`).
- GPT-Live's docs say startup and appended context "may" be paraphrased, and greetings aren't guaranteed. Check on the porch that it greets reliably, and tune the wording in `web/engines/live.ts` if needed.
- At night, the camera needs light on visitors. Detection and costume descriptions both degrade in the dark.
