# 🎃 Halloween Watchful Creature

A friendly talking porch decoration. It **sees** trick-or-treaters, **compliments their costumes** with silly jokes that are never scary, and **chats** with them, powered by OpenAI **GPT-Live**. Its LED eyes glow and pulse while it talks.

The first character is **Jacques O'Lantern, Pumpkin Critic**, who reviews costumes like a fancy food critic ("notes of cobweb, a bold glitter finish, five pumpkins out of five!"). Sir Reginald Bonesworth (skeleton butler) and Edgar the Raven (rhyming critic) are included, and you can switch characters from the dashboard.

| Doc | What's in it |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Goals, decisions, milestones |
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture, behavior, engines, body protocol |
| [docs/BOM.md](docs/BOM.md) | Bill of materials |
| [docs/SHOPPING_LIST.md](docs/SHOPPING_LIST.md) | Where to buy everything (Burlingame, CA route) |
| [docs/PROP_BUILD.md](docs/PROP_BUILD.md) | Building the pumpkin, wiring the eyes, porch checklist |
| [docs/PI_MODE.md](docs/PI_MODE.md) | Running on a Raspberry Pi 5 |

## Quick start (Mac)

1. **Install Node.js 22+**. To keep it isolated from the rest of your Mac, use [nvm](https://github.com/nvm-sh/nvm): it installs to `~/.nvm`, no sudo needed. Run `nvm install && nvm use` in the project folder, which picks up `.nvmrc`. Or use `brew install node`, or the installer from nodejs.org. Also install **Google Chrome**. All project dependencies install into `./node_modules` only.
2. **Get the code and install dependencies:**
   ```bash
   git clone https://github.com/jeremymatthewwerner/halloween-watchful-creature.git
   cd halloween-watchful-creature
   git checkout claude/laughing-ramanujan-tc0edf   # until this branch is merged into main
   npm install
   cp .env.example .env
   ```
3. **Add your OpenAI key:** edit `.env` and set `OPENAI_API_KEY=sk-...`. Also set a monthly spend limit on the OpenAI project.
4. **Check your setup** (Node, key, model access, a test vision call, Arduino):
   ```bash
   npm run doctor
   ```
5. **Run it:**
   ```bash
   npm run dev
   ```
6. **Open Chrome at http://localhost:5173**, click **🎃 Wake the creature**, and allow camera and microphone access.
7. **Walk up to the camera.** It greets you and compliments your outfit. Try asking "what am I dressed as?" or "tell me a joke".

The Mac's built-in camera and mic are fine for testing. Once the USB webcam and speakerphone are plugged in, choose them under **Settings** on the dashboard (your choice is remembered).

### Halloween night
```bash
npm run build
caffeinate -dis npm start     # keeps the Mac awake; serves the dashboard at http://localhost:8787
```
Then open **http://localhost:8787** in Chrome and click **Wake the creature**.

## Dashboard
- **Live video** with person boxes: green means close enough to greet, grey means too far. Tune the distance with **Settings → How close counts as a visitor**.
- **Status pills:**
  - engine;
  - session state (asleep, connecting, awake);
  - body state (sleeping, idle, listening, thinking, speaking);
  - running **cost**.
- **Eye preview:** an on-screen copy of what the LED eyes are doing, so you can test without the Arduino.
- **👋 Greet now:** forces a greeting.
- **🛑 Sleep (kill switch):** ends the voice session and ignores visitors until you press Wake.
- **Make it say…:** type a line and the creature says it in character.
- **Conversation:** live transcript plus system notes.

## How it saves money
The voice session only runs while someone is at the porch.
- A free, local person detector watches the camera.
- When someone walks up, the app wakes the voice session (about 1–2 s) and sends **one snapshot** to describe the costumes.
- When the porch has been empty for 3 minutes (`IDLE_CLOSE_SECONDS`), the session closes.
- The mic is muted whenever nobody is there.

GPT-Live costs about **$0.05 per minute** of voice, plus small vision-model calls.

## Configuration (`.env`)
| Setting | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | (required) | Server-side only; never sent to the browser |
| `CHARACTER` | `pumpkin` | `pumpkin`, `reginald` or `raven` (the dashboard picker overrides it) |
| `ENGINE` | `live` | `live` = GPT-Live; `realtime` = gpt-realtime-2.1 (fallback with native image input) |
| `VISION_MODEL` | `gpt-6-luna` | Vision-capable Responses model that describes costumes for GPT-Live |
| `VISION_REASONING_EFFORT` | `low` | Leave empty for non-reasoning models |
| `VOICE` | (character's) | Override the voice, e.g. `vesper`, `gleam`, `meridian` |
| `BODY_SERIAL_PORT` | `auto` | `auto` finds the Arduino; `none` disables it; or a device path |
| `BODY_MODES` | `eyes` | Any of `eyes,jaw,relay` |
| `IDLE_CLOSE_SECONDS` | `180` | Close the voice session after the porch has been empty this long |
| `BACKGROUND_FRAME_SECONDS` | `15` | While visitors stay, refresh what it sees this often |
| `MAX_VOICE_MINUTES_PER_DAY` | `240` | Safety cap. After this many awake minutes in a day (about $12 on GPT-Live), it goes to sleep until you press Wake. |

Set `BODY_DEBUG=1` to log the commands sent to the Arduino.

## Development
```bash
npm test          # unit tests (visitor tracking, director, body protocol, characters)
npm run typecheck
npm run build
```

**Layout:**
- `server/`: Node server that starts sessions, runs the vision backend and drives the Arduino.
- `web/`: the Chrome dashboard, containing:
  - the camera and person detector;
  - visitor tracking;
  - the director;
  - the voice engines.
- `prompts/`: the shared rules plus one file per character.
- `firmware/`: the Arduino sketch.
- `tests/`: unit tests.

### Add a character
Copy `prompts/characters/pumpkin.md` to `prompts/characters/<id>.md` and edit:
- the frontmatter: name, voice, eye colors and eye style;
- the persona below it.

It appears in the dashboard's character picker.

## Troubleshooting
- **It hears itself or echoes:**
  - use the USB speakerphone (it has hardware echo cancellation);
  - keep the volume reasonable;
  - point the speaker away from any other mic.
- **It greets people on the sidewalk:** raise "How close counts as a visitor".
- **It doesn't notice people at night:** add light on the visitors.
- **"Could not start voice session":**
  - check `OPENAI_API_KEY`;
  - check that your project has GPT-Live access;
  - read the server log for OpenAI's error detail;
  - try `ENGINE=realtime`.
- **The Arduino isn't found:**
  - close the Arduino IDE's Serial Monitor;
  - check the server log for `[body]` lines;
  - set `BODY_SERIAL_PORT` to the port shown in the Arduino IDE.
