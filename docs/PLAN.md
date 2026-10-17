# Project plan

## Goal
A friendly Halloween creature on the front porch that:
- **sees** visitors through a camera and compliments their costumes with funny jokes that are never scary;
- **talks and listens**, holding a real back-and-forth conversation;
- **moves or glows** while it talks.

Halloween is 2026-10-31. We buy off-the-shelf parts wherever possible and write only the glue code.

## Decisions
| Topic | Decision | Why |
|---|---|---|
| Voice | **OpenAI GPT-Live** (`gpt-live-1`, launched Sep 2026), with `gpt-realtime-2.1` kept as a fallback engine | GPT-Live is OpenAI's newest and most natural full-duplex voice, at $0.05/min. It can't take images, so a vision model describes the camera frames and the descriptions are fed in as context. |
| Vision | A vision-capable Responses model (`VISION_MODEL`, default `gpt-6-luna`) | Describes costumes from a snapshot. The text goes into GPT-Live as `commentary` (spoken) or `thinking` (silent). |
| Where it runs | **Mac first.** A Raspberry Pi 5 mode comes later on the same code. | The fastest path. The prop holds only USB devices. |
| Client | A web page in Chrome, using WebRTC to OpenAI | Low latency, plus built-in **echo cancellation** so it doesn't hear itself. The Pi just runs Chromium. |
| Person detection | A local MediaPipe person detector decides **when** to send a snapshot | The camera is "always watching" for free. We only pay to send a frame when someone walks up or asks. |
| Characters | Pluggable persona files. **Pumpkin Critic first**, then Sir Reginald (skeleton) and Edgar the Raven. | One file per character. Switch from `.env` or the dashboard. |
| Body | One USB Arduino with three modes: **eyes** (NeoPixels) → **jaw** (servo) → **relay** (animatronic, parked) | One kit covers everything, and it works with both Mac and Pi. |
| Animatronic | Parked | No friendly store prop that can be triggered was confirmed, and props with built-in voices would talk over ours. |

## Milestones
- [ ] **0. Buy parts.** See [SHOPPING_LIST.md](SHOPPING_LIST.md) and [BOM.md](BOM.md).
- [x] **1. Talks.** Repo scaffold, the session server, the WebRTC voice loop and the Pumpkin Critic persona. *Code done; first live test needs your API key.*
- [x] **2. Sees.** Person detection, the visitor state machine, arrival greetings with a snapshot, fresh looks on request (GPT-Live delegation or the realtime `look` tool), and the dashboard video. *Code done.*
- [x] **3. Porch-ready.** Mic gating when nobody's there, idle sleep and reconnect, device pickers, cost meter, kill switch, and the operator "make it say…" box. *Code done.*
- [x] **4. Glowing eyes.** Body WebSocket, Arduino serial driver, and firmware eyes mode. *Firmware compiles for Uno; needs a hardware test.*
- [ ] **4b. First real run on the Mac.** Add the key, run `npm run dev`, then tune the greeting reliability and the vision prompt.
- [ ] **5. Prop build and porch tuning.** Pumpkin assembly, lighting, volume, VAD tuning, detection distance.
- [ ] **6. Pi mode.** Chromium kiosk, systemd services, setup script.
- [ ] **7. More characters.** Sir Reginald Bonesworth and Edgar the Raven. *Persona files are written; their props still need building.*
- [ ] **8. Jaw servo** (optional). The animatronic relay mode stays in the firmware for later.

## Safety and privacy
- Persona rules: compliment **costumes only**, never bodies or appearance. Kid-safe, never scary, no personal questions.
- Camera snapshots go to OpenAI to generate replies. Nothing is saved to disk by default.
- Consider a small sign: "This pumpkin talks back (it's AI!)".
- Set a **monthly spend limit** on the OpenAI project. The dashboard shows a live cost estimate.

## Verification
- **Unit tests** (`npm test`) cover the visitor state machine, the director's queueing and the body serial protocol.
- **Manual on the Mac:**
  - Talk to it, and interrupt it mid-sentence.
  - Walk into frame and get greeted within about 2 s.
  - Ask "what am I dressed as?" so the `look` tool fires.
  - Walk away: the mic gates and the session sleeps.
  - Play loud audio with nobody in frame: no reply.
- **Firmware:** serial monitor commands change the eyes, and silence fails safe to idle.
- **A night-time porch dry run** before Oct 31.
