#!/usr/bin/env bash
# One-shot Raspberry Pi 5 setup (Raspberry Pi OS Bookworm, 64-bit, desktop).
# Run from the repo root:  bash scripts/pi/setup.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"
RUN_USER="$(id -un)"

echo "==> Installing Node.js 22 and Chromium"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium

echo "==> Installing dependencies and building the dashboard"
npm install
npm run build

if [ ! -f .env ]; then
  cp .env.example .env
  echo "!! Created .env: edit it and set OPENAI_API_KEY before starting."
fi

echo "==> Serial access for the Arduino"
sudo usermod -aG dialout "$RUN_USER"

echo "==> Installing the server service"
sed -e "s|^User=.*|User=$RUN_USER|" -e "s|^WorkingDirectory=.*|WorkingDirectory=$REPO_DIR|" \
  scripts/pi/creature-server.service | sudo tee /etc/systemd/system/creature-server.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now creature-server

echo "==> Installing the kiosk autostart"
mkdir -p ~/.config/autostart
BROWSER="$(command -v chromium-browser || command -v chromium)"
sed -e "s|chromium-browser|$BROWSER|" scripts/pi/creature-kiosk.desktop > ~/.config/autostart/creature-kiosk.desktop

echo
echo "Done. Next:"
echo "  1. Put your key in $REPO_DIR/.env, then: sudo systemctl restart creature-server"
echo "  2. Check it: npm run doctor"
echo "  3. Reboot. The dashboard opens full screen and the creature wakes by itself."
