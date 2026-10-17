# Raspberry Pi mode (after the Mac version works)

The Pi runs the **same code**: the Node server plus Chromium in kiosk mode, showing the same dashboard. The webcam, speakerphone, hub and Arduino all move from the Mac to the Pi's USB ports.

## Setup (Pi 5, Raspberry Pi OS Bookworm, 64-bit, desktop)
```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git chromium-browser

git clone https://github.com/jeremymatthewwerner/halloween-watchful-creature.git
cd halloween-watchful-creature
npm install
cp .env.example .env   # add OPENAI_API_KEY
npm run build
sudo usermod -aG dialout "$USER"   # serial access to the Arduino (log out and in again)
```

## Run it
```bash
npm start   # serves the built dashboard on http://localhost:8787
chromium-browser --kiosk --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required "http://localhost:8787/?autowake"
```
- `--use-fake-ui-for-media-stream` auto-approves camera and mic access.
- `?autowake` starts the creature without clicking **Wake the creature**.

## Start on boot
`scripts/pi/` holds two files: `creature-server.service` (a systemd unit for the server) and `creature-kiosk.desktop` (autostarts Chromium after login). To install them:
```bash
sudo cp scripts/pi/creature-server.service /etc/systemd/system/
sudo systemctl enable --now creature-server
mkdir -p ~/.config/autostart && cp scripts/pi/creature-kiosk.desktop ~/.config/autostart/
```

## Notes
- **Person detection:** MediaPipe runs on the Pi's GPU in Chromium. If it struggles, lower the camera resolution in `web/vision.ts`.
- **Audio devices:** set the speakerphone as the default input and output in the Pi's audio settings, or pick them in the dashboard's Settings.
- **Internet:** the Pi needs a solid Wi-Fi connection, since all the AI runs in the cloud. If you can, use a short Ethernet run.
