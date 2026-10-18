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
- **Quick modes:** one-tap buttons that change how the creature acts until you tap them again. A lit button (marked **ON**) is on. They're remembered for the evening, even if you reload the page, and are sent again each time a new voice session starts.
  - **🍬 Candy's low:** asks everyone to take just one piece.
  - **🚫 Candy's out:** says sorry, kindly, that the candy is gone, and still compliments costumes.
  - **🧸 Toddler mode:** extra gentle, nothing spooky, very short lines.
  - **⏳ Back in 5:** tells visitors the candy helpers will be back in a few minutes.
  - **🌙 Last call:** greets as usual, then says a warm goodnight.

  Each tap is noted in the Conversation panel and today's log.
- **Spookiness:** a dial under the quick modes for how spooky the creature is tonight. It works the same way as the quick modes: it applies right away, is sent again to each new voice session, and is remembered for the evening.
  - **🌼 Gentle (0):** cheerful and sweet, nothing scary at all.
  - **🎃 Playful (1, the default):** the creature's normal, light spooky fun.
  - **👻 Spooky (2):** eerie voice moments, creaky laughs and spooky jokes, then friendly again.
  - **🦇 Scary (teens) (3):** creepier and more dramatic, but never gory, cruel or mean. If a young child walks up, or anyone seems scared or says so, it switches to gentle by itself.
  - **🕰️ Auto:** follows the clock: gentle until 7 pm, playful from 7, spooky from 8 pm. Auto never picks Scary.

  The level also flavors the greetings' variety twists (a sunny hello when gentle, an eerie pause or a ghost-story line when spooky or scary). **🧸 Toddler mode** wins over the dial: while it's on, the creature is gentle (plus tiny words and very short lines), whatever the dial says, and goes back to the dial's level when you turn it off. Gentle is for a calm evening; Toddler mode is for when very little kids are at the door.
- **Make it say…:** type a line and the creature says it in character.
- **Voice:** a picker listing every voice the current engine can use. Each shows what OpenAI's docs say about it (for GPT-Live: language, regional influence, presentation and source; the docs don't describe tone) and our own notes from testing. English voices come first; the other-language voices carry their language's accent.
  - The voice in effect is marked **current**, with where it comes from. Order: your pick here (remembered in this browser, per engine) > `VOICE` in `.env` > the character's default. **Use default** forgets your pick.
  - A new voice starts with the next voice session. While a session is running with another voice, **🔄 Restart voice session now** ends it; if visitors are there it reconnects right away with the new voice.
  - The server only accepts voices on its list (`shared/voices.ts`); anything else is ignored and logged.
- **Conversation:** live transcript plus system notes.
- **Server log:** the server's terminal output, live. Its links open **today's log**, today's **costume gallery** and **all logs**.
- **Alerts:** health problems (see below), shown only when there are any.

## Phone remote and alerts
Watch and steer the creature from the couch, and get a push on your phone when something breaks. The dashboard on the creature's computer stays the brain: the phone's buttons go through the server to the dashboard, and its status comes back the same way.

### Phone remote
1. In `.env`, set a PIN of at least 6 characters (longer is better), then restart the server:
   ```
   REMOTE_PIN=pick-something-long
   ```
   With a PIN set, the server also listens on your home network (all interfaces, same port). Without one, it only answers this computer, as before.
2. Find the computer's address: on a Mac, **System Settings → Wi-Fi → Details** (or `ipconfig getifaddr en0`); on the Pi, `hostname -I`.
3. On your phone, on the same Wi-Fi, open **`http://<that address>:8787/remote`** and enter the PIN. Tip: add it to your home screen.
   - This works the same in development (`npm run dev`) and on Halloween night (`npm start`): the phone always talks to the server on port 8787, never to the Vite dev server on 5173 (that one only serves this computer, since it hands out project files without a PIN).
   - macOS may ask whether to allow incoming connections for `node`: allow it.

The remote shows whether the creature is awake, asleep (kill switch) or waiting for a tap, visitors at the door, the voice session, the Arduino, today's awake minutes and estimated cost, and the latest alerts. Its buttons: **🛑 Sleep / ▶️ Wake** (the kill switch), **👋 Greet now**, **Make it say…**, the **quick modes**, and links to today's log, the costume gallery and all logs.

**Security:**
- LAN access is off unless `REMOTE_PIN` is set. Setting `HOST=0.0.0.0` without a PIN is ignored (the server stays on 127.0.0.1 and says so). `HOST` can still pick a specific address when a PIN is set.
- Every request from another device needs a signed-in session: all `/api` routes (including logs, snapshots and galleries) and the `/ws` socket. Only the PIN page and the PIN check itself are open. The dashboard on the creature's computer (loopback, addressed as `localhost`) needs no PIN.
- The PIN is sent once, in the body of a POST, and swapped for an `HttpOnly`, `SameSite=Strict` session cookie (24 hours; restarting the server signs phones out). It's compared in constant time and never logged or put in a URL.
- Wrong PINs: 5 per phone per 15 minutes, and 20 from all devices together, then sign-in locks for the rest of the 15 minutes.
- Even signed in, the phone can't use the dashboard-only routes: it can't start voice sessions, call the vision model or drive the Arduino. The existing origin check still applies.
- It's plain HTTP on your home network, so anyone who can watch your Wi-Fi traffic could see the PIN and cookie. Use it on a home network you trust, not on public Wi-Fi.

### Watchdog
The dashboard watches itself and recovers:
- **Camera frames stopped:** it restarts the camera; if frames don't come back within 20 s, it reloads the page.
- **Person detector errors** (many in a row, or it failed to load): reloads.
- **Voice session failing to start** 5 times in a row: alerts, and reloads if this computer is known to wake without a click (see below).
- **Page frozen:** a frozen page can't fix itself. The dashboard checks in with the server every 2 s; after 45 s of silence the server raises an alert. On the Pi, `scripts/pi/kiosk.sh` also restarts Chromium when the dashboard has been silent for 90 s.

At most 3 automatic reloads per hour (never in the first minute after loading), then it only alerts. A page that was awake in the last 15 minutes wakes again by itself after a reload, with the kill switch as it was.

**Sound after a reload:** browsers block sound until someone clicks the page. If that happens, the dashboard waits, shows *Click to wake* and raises a **Dashboard needs a tap** alert. Pressing **Wake** on the remote retries, but a tap on the phone can't unblock sound on another device's browser: someone has to click the dashboard once. For unattended use, start Chrome with:
```bash
# Mac
open -na "Google Chrome" --args --autoplay-policy=no-user-gesture-required "http://localhost:8787/?autowake"
```
The Pi kiosk already uses this flag. The setting only lasts while that Chrome window runs, so quit Chrome fully first.

### Alerts
Alerts show on the dashboard and the remote: camera lost, person detector failed, Arduino disconnected, vision errors piling up, voice session failing, daily cost cap reached, the watchdog reloading the page, the dashboard needing a tap, and the dashboard not checking in. Repeats of a problem that's still going are counted, not listed again, and they're marked when they clear up by themselves.

**Push to your phone (optional), with [ntfy](https://ntfy.sh):**
1. Install the **ntfy** app (iOS or Android).
2. Make up a long, random topic name: anyone who knows it can read your alerts. For example, run `openssl rand -hex 12` and use `jacques-<that>`.
3. In the app, tap **+** and subscribe to that topic (server `ntfy.sh`).
4. In `.env`, set `NTFY_TOPIC=jacques-<that>` and restart the server.

Pushes are short fixed messages (like "Camera stopped. Check the USB cable…"): never photos, transcripts or anything about visitors. Each kind of problem is pushed at most once per 15 minutes, and at most 6 pushes per hour in total. `NTFY_SERVER` and `NTFY_TOKEN` are for a self-hosted ntfy server or a protected topic.

### Rehearsal mode (testing without walking into frame)
**Settings → 🎭 Rehearsal (developer)** pretends visitors walk up, using sample images instead of the camera. Wake the creature first, then tick **Rehearsal on**.
- **Sample images:** upload image files (kept in the page's memory only, never saved), and/or click greeting snapshots from a day's log (read from `/api/session-logs`). Click a chosen image to make it the camera frame.
- **🚶 Visitor arrives**, **👋 Leaves**, **👯 Second visitor joins** (a "grew"), and **🔁 Swap to next image**: the visitor steps out of view for 3 s and comes back as the next image, which exercises the gap check and the vision model's NEW/CHANGED verdicts.
- **▶️ Run script:** arrive, wait 20 s, swap, wait 10 s, leave, wait 15 s, come back (a "returned").
- While it's on, a red **REHEARSAL — not the real camera** banner covers the video, and real detections are ignored (the detector isn't even run). Untick it to go back to the camera.
- The real tracker and director run, with their real timings: "left" counts after 8 s out of view, and a joiner is greeted only 30 s after the last greeting.
- **It uses the real voice and vision APIs**, so it costs money like real visitors.
- **Logs:** vision lines say `[REHEARSAL]`, and conversation lines from the rehearsal start with `[REHEARSAL]` in `log.txt` and are greyed in `log.html`. **No snapshots are saved** for rehearsal looks: the images are uploads (meant to stay in memory) or log snapshots (already saved), and leaving them out keeps the costume gallery clean. The gallery also skips rehearsal lines. Rehearsal greetings don't count toward tonight's visitor tally or the "don't repeat yourself" memory.

How it works: `web/rehearsal.ts` sits behind two small seams in `web/main.ts`: the frame source (`capture`) and the person detections fed to the tracker. Everything downstream is unchanged.

## Logs on disk
Each day gets a folder in `logs/` (for example `logs/2026-10-31/`). Server restarts append to the same day.
- `log.html`: everything in one readable page: server lines, what visitors and the creature said, system notes, and a **snapshot** of each greeting with the vision verdict (click a snapshot for full size).
- `log.txt`: the same as plain text, for `grep`.
- `snapshots/`: the camera frame of each greeting.

The **costume gallery** (`/api/session-logs/<day>/gallery.html`, linked from the dashboard and from **All logs**) turns a day into a grid of greetings: each snapshot with what the camera saw and the creature's best line from that moment. Click a costume, or **▶️ Slideshow**, to see them big (arrow keys move, Esc closes). It's built from the day's `log.txt` each time you open it, so there's nothing extra to save. It's for the family only: it shows other people's kids, so it has no share or upload buttons.

This keeps photos and speech of visitors (often children) on your computer. Set `LOG_SNAPSHOTS=false` to skip the photos (the gallery then shows words only), or `LOG_DIR=none` to keep no logs at all (no gallery either). Delete old days by deleting their folders.

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
| `VOICE` | (character's) | Fallback voice, e.g. `vesper`, `gleam`, `meridian`. Used when nothing is picked in the dashboard's **Voice** picker (which overrides it); beats the character's default |
| `BODY_SERIAL_PORT` | `auto` | `auto` finds the Arduino; `none` disables it; or a device path |
| `BODY_MODES` | `eyes` | Any of `eyes,jaw,relay` |
| `IDLE_CLOSE_SECONDS` | `180` | Close the voice session after the porch has been empty this long |
| `BACKGROUND_FRAME_SECONDS` | `30` | While visitors stay, refresh what it sees this often |
| `MAX_VOICE_MINUTES_PER_DAY` | `240` | Safety cap. After this many awake minutes in a day (about $12 on GPT-Live), it goes to sleep until you press Wake. |
| `REMOTE_PIN` | (off) | Turns on the phone remote: the server listens on your network and asks other devices for this PIN (6+ characters) |
| `HOST` | `127.0.0.1`, or `0.0.0.0` with a PIN | Address to listen on; anything other than loopback needs `REMOTE_PIN` |
| `NTFY_TOPIC` | (off) | ntfy.sh topic for push alerts; make it long and random |
| `NTFY_SERVER` / `NTFY_TOKEN` | `https://ntfy.sh` / (none) | Self-hosted ntfy server, or a token for a protected topic |

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
- **"Saved camera … isn't connected: using the default":** the dashboard remembers devices by ID and by name, so re-plugging the gear into another port or hub is usually fine. If it can't find one at all, pick it again in **Settings**.
- **The Arduino isn't found:**
  - close the Arduino IDE's Serial Monitor;
  - check the server log for `[body]` lines;
  - set `BODY_SERIAL_PORT` to the port shown in the Arduino IDE.
