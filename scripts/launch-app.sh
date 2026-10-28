#!/bin/bash
# Launches /Applications/Okidoki Personal.app through launchd, the way login items start.
#
# Why not `open`: an app opened from a terminal (even via Finder or AppleScript from that terminal)
# is attributed to the terminal as its "responsible process", so macOS files Okidoki's Accessibility
# and Automation grants under Terminal/Ghostty and the permission dialogs name the terminal.
# A launchd job is the app's own parent, so the grants and dialogs belong to Okidoki.
#
#   scripts/launch-app.sh                 # start (or restart) the installed app
#   OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh   # with the scripted-testing hooks on
#   scripts/launch-app.sh --stop
set -euo pipefail
source "$(dirname "$0")/identity.sh"

APP="${OKIDOKI_INSTALLED_APP:-/Applications/$OKIDOKI_APP_NAME.app}"
LABEL="$OKIDOKI_BUNDLE_ID.launch"
PLIST="${TMPDIR:-/tmp}/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--stop" ]; then
  osascript -e "tell application id \"$OKIDOKI_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  exit 0
fi

[ -x "$APP/Contents/MacOS/$OKIDOKI_EXEC" ] || { echo "no app at $APP — run make install first" >&2; exit 1; }

# The app itself asks any running copy to quit, but waiting here keeps the brain port free.
if pgrep -xq "$OKIDOKI_EXEC"; then
  osascript -e "tell application id \"$OKIDOKI_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -xq "$OKIDOKI_EXEC" || break; sleep 0.25; done
fi

env_block=""
for name in OKIDOKI_DEV_HOOKS OKIDOKI_TEACH_TRACE OKIDOKI_OPEN_DASHBOARD OKIDOKI_OPEN_ONBOARDING OKIDOKI_DEMO OKIDOKI_BRAIN_PORT; do
  value="${!name:-}"
  [ -n "$value" ] && env_block+="<key>$name</key><string>$value</string>"
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/$OKIDOKI_EXEC</string></array>
  <key>EnvironmentVariables</key><dict>$env_block</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
for _ in $(seq 1 40); do pgrep -xq "$OKIDOKI_EXEC" && break; sleep 0.25; done
pgrep -xq "$OKIDOKI_EXEC" && echo "✓ $OKIDOKI_APP_NAME running from $APP" || { echo "✗ $OKIDOKI_APP_NAME didn't start" >&2; exit 1; }
