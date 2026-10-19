# Project plan

## Goal
A friendly Halloween creature on the front porch that:
- **sees** visitors through a camera and compliments their costumes with funny, kid-friendly jokes (spooky only as far as the family dials it);
- **talks and listens**, holding a real back-and-forth conversation;
- **moves or glows** while it talks.

Halloween is 2026-10-31. We buy off-the-shelf parts wherever possible and write only the glue code.

## Decisions
| Topic | Decision | Why |
|---|---|---|
| Voice | **OpenAI GPT-Live** (`gpt-live-1`, launched Sep 2026), with `gpt-realtime-2.1` kept as a fallback engine | GPT-Live is OpenAI's newest and most natural full-duplex voice, at $0.05/min. It can't take images, so a vision model describes the camera frames and the descriptions are fed in as context. |
| Vision | A vision-capable Responses model (`VISION_MODEL`, default `gpt-6-luna`) | Describes costumes from a snapshot. The text goes into GPT-Live as `commentary` (spoken) or `thinking` (silent). |
| Where it runs | **Mac first** (tethered by a 16 ft active USB cable). A Raspberry Pi 5 mode comes later on the same code. | The fastest path. The prop holds only USB devices. |
| Audio | **C920 webcam mics + Logitech Z150 speakers on a USB sound card** ("plan B"); a USB speakerphone stays optional | No local store had a speakerphone; Chrome's echo cancellation handles plan B on the bench. |
| Client | A web page in Chrome, using WebRTC to OpenAI | Low latency, plus built-in **echo cancellation** so it doesn't hear itself. The Pi just runs Chromium. |
| Person detection | A local MediaPipe person detector decides **when** to send a snapshot | The camera is "always watching" for free. We only pay to send a frame when someone walks up or asks. |
| Characters | Pluggable persona files. **Pumpkin Critic first**, then Sir Reginald (skeleton) and Edgar the Raven. | One file per character. Switch from `.env` or the dashboard. |
| Body | One USB Arduino with three modes: **eyes** (NeoPixel Jewels; plain LEDs until they arrive) → **jaw** (servo, skipped this year) → **relay** (animatronic, parked) | One kit covers everything, and it works with both Mac and Pi. |
| Character | **Jacques talks kid-first**, no French, no chef talk; voice chosen in the dashboard | Testing showed kids need plain words and big verdicts; GPT-Live voices don't do accents reliably. |
| Animatronic | Parked | No friendly store prop that can be triggered was confirmed, and props with built-in voices would talk over ours. |

## Milestones
- [x] **0. Buy parts.** See [SHOPPING_LIST.md](SHOPPING_LIST.md) and [BOM.md](BOM.md). *Bought; NeoPixel Jewels (4) ordered from Adafruit, and solder, hookup wire and a carving kit from Amazon (Oct 18). A clamp light waits on the dusk test.*
- [x] **1. Talks.** Repo scaffold, the session server, the WebRTC voice loop and the Pumpkin Critic persona.
- [x] **2. Sees.** Person detection, the visitor state machine, arrival greetings with a snapshot, fresh looks on request (GPT-Live delegation or the realtime `look` tool), and the dashboard video.
- [x] **3. Porch-ready.** Mic gating when nobody's there, idle sleep and reconnect, device pickers, cost meter, kill switch, and the operator "make it say…" box.
- [x] **4. Glowing eyes.** Body WebSocket, Arduino serial driver, and firmware eyes mode. *Plain-LED eyes tested on the Uno (Oct 18); NeoPixel Jewels and the new flourishes still need a hardware test.*
- [x] **4b. First real run on the Mac** (Oct 17–18). Greeting reliability, return visits, swaps and costume changes, lag (about 1 s to the first sound), logs, the webcam and speakers.
- [x] **4c. Night-of features** (on the integration branch). Tonight's memory and running gags, standout details, mini-games, quick modes, spookiness dial, voice picker, costume gallery, eye flourishes, lure call-outs and ambience, phone remote and alerts, watchdog, rehearsal mode.
- [ ] **5. Prop build and porch tuning.** Carve with the [template](templates/pumpkin-carving-template.pdf), fit the eye cups, webcam and speaker, then a dusk rehearsal: lighting, framing for tall hats, volume, hum, detection distance.
- [ ] **5b. NeoPixel eyes.** Solder the Jewels, set `EYES_NEOPIXEL 1`, re-flash, test the flourishes.
- [ ] **6. Pi mode.** Chromium kiosk, systemd services, setup script: written but never run on a Pi. Optional: the Mac works on the night.
- [ ] **6b. Halloween-night readiness.** A 3–4 hour soak test, the daily cost cap, the phone remote and ntfy on a real phone, the kill switch, and a small "AI-powered, records" sign.
- [ ] **7. More characters.** Sir Reginald Bonesworth and Edgar the Raven. *Persona files are written; their props still need building.*
- [ ] **8. Jaw servo** (optional, skipped this year). The animatronic relay mode stays in the firmware for later.

## Safety and privacy
- Persona rules: compliment **costumes only**, never bodies or appearance. Kid-safe, never truly scary (the spookiness dial stays within that), no personal questions.
- Camera snapshots go to OpenAI to generate replies. The day's log keeps the conversation and a snapshot per greeting **on the local disk** (`SNAPSHOTS=off` / `LOG_DIR=none` turn that off), and photos are deleted after 7 days (`SNAPSHOT_RETENTION_DAYS`); the gallery is family-only.
- The phone remote is off unless `REMOTE_PIN` is set; ntfy alerts carry no visitor data.
- Consider a small sign: "This pumpkin talks back (it's AI!)".
- Set a **monthly spend limit** on the OpenAI project. The dashboard shows a live cost estimate.

## Verification
- **Unit tests** (`npm test`, about 240) cover the visitor tracker, the director, both engines, vision prompts and verdicts, variety and memory, logs and the gallery, modes and spookiness, voices, the remote's auth and alerts, the watchdog, rehearsal, ambience and lure scheduling, and the body protocol.
- **Rehearsal mode** on the dashboard exercises greetings, swaps, joins and returns with sample photos, without walking into frame.
- **Manual on the Mac:**
  - Talk to it, and interrupt it mid-sentence.
  - Walk into frame and get greeted within about 2 s.
  - Ask "what am I dressed as?" so the `look` tool fires.
  - Walk away: the mic gates and the session sleeps.
  - Play loud audio with nobody in frame: no reply.
- **Firmware:** serial monitor commands change the eyes, and silence fails safe to idle.
- **A night-time porch dry run** before Oct 31.
