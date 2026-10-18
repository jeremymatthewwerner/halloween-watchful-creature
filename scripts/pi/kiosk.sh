#!/bin/sh
# Runs the dashboard in Chromium kiosk mode and keeps it running: restarts Chromium if it exits,
# or if the dashboard stops checking in with the server (a frozen or crashed page can't reload
# itself). The page then wakes by itself (?autowake), and sound works without a click thanks to
# --autoplay-policy=no-user-gesture-required.
PORT="${PORT:-8787}"
URL="http://localhost:$PORT/?autowake"
BROWSER="${BROWSER:-$(command -v chromium-browser || command -v chromium)}"
# Restart when the dashboard has been silent this long (seconds). The server alerts at 45 s.
STALE="${KIOSK_STALE_SECONDS:-90}"

while true; do
  "$BROWSER" --kiosk --noerrdialogs --disable-infobars --hide-crash-restore-bubble \
    --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required "$URL" &
  PID=$!
  sleep 60 # time to start up and wake
  while kill -0 "$PID" 2>/dev/null; do
    sleep 15
    # Seconds since the dashboard last checked in; -1 if it hasn't since the server started.
    AGE="$(curl -fsS --max-time 5 "http://localhost:$PORT/api/remote/heartbeat" 2>/dev/null)"
    case "$AGE" in '' | *[!0-9]*) continue ;; esac # server down or restarting, or not seen yet
    if [ "$AGE" -gt "$STALE" ]; then
      echo "kiosk: dashboard silent for ${AGE}s, restarting Chromium"
      kill "$PID" 2>/dev/null
      sleep 5
      kill -9 "$PID" 2>/dev/null
      pkill -f -- "--kiosk.*$URL" 2>/dev/null
      break
    fi
  done
  sleep 3
done
