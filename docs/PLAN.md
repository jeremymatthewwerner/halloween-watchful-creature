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
| Brain | OpenAI Realtime speech-to-speech (`gpt-realtime-2.1`, configurable) | It's the best live voice model. It also takes **image input** in the same session, so one model sees and talks. |
| Where it runs | **Mac first.** A Raspberry Pi 5 mode comes later on the same code. | The fastest path. The prop holds only USB devices. |
| Client | A web page in Chrome, using WebRTC to OpenAI | Low latency, plus built-in **echo cancellation** so it doesn't hear itself. The Pi just runs Chromium. |
| Vision | A local MediaPipe person detector decides **when** to send a snapshot | The camera is "always watching" for free. We only pay to send a frame when someone walks up or asks. |
| Characters | Pluggable persona files. **Pumpkin Critic first**, then Sir Reginald (skeleton) and Edgar the Raven. | One file per character. Switch from `.env` or the dashboard. |
| Body | One USB Arduino with three modes: **eyes** (NeoPixels) → **jaw** (servo) → **relay** (animatronic, parked) | One kit covers everything, and it works with both Mac and Pi. |
| Animatronic | Parked | No friendly store prop that can be triggered was confirmed, and props with built-in voices would talk over ours. |

## Milestones
- [ ] **0. Buy parts.** See [SHOPPING_LIST.md](SHOPPING_LIST.md) and [BOM.md](BOM.md).
- [ ] **1. Talks.** Repo scaffold, the ephemeral-key server, the WebRTC voice loop and the Pumpkin Critic persona. Talk to it with the Mac's built-in cam and mic.
- [ ] **2. Sees.** Person detection, the visitor state machine, arrival greetings with a snapshot, the `look` tool, and the dashboard video.
- [ ] **3. Porch-ready.** Mic gating when nobody's there, idle sleep and reconnect, device pickers, cost meter, kill switch, and the operator "make it say…" box.
- [ ] **4. Glowing eyes.** Body WebSocket, Arduino serial driver, and firmware eyes mode.
- [ ] **5. Prop build and porch tuning.** Pumpkin assembly, lighting, volume, VAD tuning, detection distance.
- [ ] **6. Pi mode.** Chromium kiosk, systemd services, setup script.
- [ ] **7. More characters.** Sir Reginald Bonesworth and Edgar the Raven.
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
