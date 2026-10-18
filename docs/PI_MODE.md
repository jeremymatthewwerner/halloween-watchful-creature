# Raspberry Pi mode (after the Mac version works)

The Pi runs the **same code**: the Node server plus Chromium in kiosk mode, showing the same dashboard. The webcam, speakerphone, hub and Arduino all move from the Mac to the Pi's USB ports.

## Quick setup
```bash
git clone https://github.com/jeremymatthewwerner/halloween-watchful-creature.git
cd halloween-watchful-creature
bash scripts/pi/setup.sh    # installs Node 22 and Chromium, builds, sets up the service and kiosk
nano .env                   # add OPENAI_API_KEY
sudo systemctl restart creature-server && npm run doctor
sudo reboot
```
The manual steps below do the same thing.

## Manual setup (Pi 5, Raspberry Pi OS Bookworm, 64-bit, desktop)
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
`scripts/pi/` holds `creature-server.service` (a systemd unit for the server), `creature-kiosk.desktop` (runs `kiosk.sh` after login) and `kiosk.sh`. The kiosk script starts Chromium with the flags above and keeps it running: it restarts Chromium if it exits, or if the dashboard stops checking in with the server for 90 s (a frozen page can't reload itself). To install them:
```bash
sudo cp scripts/pi/creature-server.service /etc/systemd/system/
sudo systemctl enable --now creature-server
chmod +x scripts/pi/kiosk.sh
mkdir -p ~/.config/autostart
sed "s|REPO_DIR|$PWD|" scripts/pi/creature-kiosk.desktop > ~/.config/autostart/creature-kiosk.desktop
```
For the phone remote and push alerts, see **Phone remote and alerts** in the README.

## Notes
- **Person detection:** MediaPipe runs on the Pi's GPU in Chromium. If it struggles, lower the camera resolution in `web/vision.ts`.
- **Audio devices:** set the speakerphone as the default input and output in the Pi's audio settings, or pick them in the dashboard's Settings.
- **Internet:** the Pi needs a solid Wi-Fi connection, since all the AI runs in the cloud. If you can, use a short Ethernet run.
