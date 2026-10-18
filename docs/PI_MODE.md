# Raspberry Pi mode (after the Mac version works)

The Pi runs the **same code**: the Node server plus Chromium in kiosk mode, showing the same dashboard. The webcam, USB sound card (or speakerphone), hub and Arduino all move from the Mac to the Pi's USB ports. It boots straight into the creature and restarts it if it crashes, so your laptop stays free. **It has never been run on a real Pi yet**: try it a week before Halloween, and keep the Mac as the backup.

## Quick setup
```bash
git clone https://github.com/jeremymatthewwerner/halloween-watchful-creature.git
cd halloween-watchful-creature
bash scripts/pi/setup.sh    # installs Node 22 and Chromium, builds, sets up the service and kiosk
nano .env                   # add OPENAI_API_KEY (a capped, Pi-only key: see below), VOICE, REMOTE_PIN, NTFY_TOPIC
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
- **Audio devices:** set the C920 as the input and the USB sound card as the output in the Pi's audio settings, or pick them in the dashboard's Settings (remembered by name).
- **Voice:** copy `VOICE=…` from the Mac's `.env`, or pick the voice in the dashboard's **Voice** picker on the Pi (picks are per browser).
- **Internet:** the Pi needs a solid Wi-Fi connection, since all the AI runs in the cloud. If you can, use a short Ethernet run.

## Before you leave it on the porch
A Pi outside can be stolen, and its SD card holds everything in the project folder. About $225 of Pi hardware is the small part; protect what's on the card:
- **OpenAI key:** create a **separate OpenAI project and key just for the Pi**, with a low monthly budget (say $20–30). If the Pi goes missing, revoke that key; the most anyone can spend is the cap.
- **Wi-Fi:** put the Pi on a **guest network**, or be ready to change the Wi-Fi password.
- **Photos of visitors:** set `LOG_SNAPSHOTS=false` (or `LOG_DIR=none`) on the Pi, so no photos of trick-or-treaters sit on a device outside.
- **Placement:** keep the Pi and hub out of sight behind the pumpkin, cables zip-tied, everything under the porch roof.
