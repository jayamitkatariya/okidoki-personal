#!/bin/bash
# Starts a computer-use run in a running okidoki (launched with OKIDOKI_DEV_HOOKS=1), waits for it
# to finish, prints its step log, and saves a screenshot of the result.
#
#   scripts/dev-drive.sh "open notes and make a note that says hello"      # drive directly
#   scripts/dev-drive.sh --ask "send hi to dad on whatsapp"                 # through the router
#   scripts/dev-drive.sh --stop
#
# OKIDOKI_SCENARIO_DIR picks where screenshots and logs go (default build/scenarios).
set -euo pipefail

STATE="${OKIDOKI_SUPPORT_DIR:-$HOME/Library/Application Support/Okidoki}/state.json"
OUT="${OKIDOKI_SCENARIO_DIR:-build/scenarios}"
TIMEOUT="${OKIDOKI_SCENARIO_TIMEOUT:-240}"
mkdir -p "$OUT"

post() {
  osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run(argv) {
      $.NSDistributedNotificationCenter.defaultCenter
        .postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);
    }' "$1" "$2" >/dev/null
}

if [ "${1:-}" = "--stop" ]; then
  post "dev.okidoki.mac.dev.stop" ""
  exit 0
fi

MODE="drive"
if [ "${1:-}" = "--ask" ]; then MODE="ask"; shift; fi
GOAL="${1:?goal required}"
SLUG="$(printf '%s' "$GOAL" | tr -cs 'a-zA-Z0-9' '-' | cut -c1-48 | sed 's/-$//')"
STAMP="$(date +%H%M%S)"

if ! pgrep -xq Okidoki; then
  echo "okidoki isn't running" >&2
  exit 1
fi

count_before=$(python3 -c "import json;print(len(json.load(open('$STATE'))['runs']))")
if [ "$MODE" = "ask" ]; then
  post "dev.okidoki.mac.dev.ask" "$GOAL"
else
  post "dev.okidoki.mac.dev.drive" "$GOAL"
fi

echo "▸ $MODE: $GOAL"
started=$(date +%s)
result=""
while :; do
  sleep 2
  result=$(python3 - "$STATE" "$GOAL" "$count_before" <<'EOF'
import json, sys
state, goal, before = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    d = json.load(open(state))
except Exception:
    sys.exit(0)
runs = d['runs']
if len(runs) <= before:
    sys.exit(0)
# createRun inserts at the front; the newest run for this prompt is the one we started.
mine = [r for r in runs if r.get('prompt') == goal]
if not mine:
    sys.exit(0)
r = mine[0]
if r.get('status') in ('running', 'waiting', 'previewing', 'paused'):
    print('RUNNING', r.get('kind'), r.get('status'))
    sys.exit(0)
print(json.dumps(r))
EOF
)
  case "$result" in
    "") ;;
    RUNNING*) ;;
    *) break ;;
  esac
  if [ $(( $(date +%s) - started )) -ge "$TIMEOUT" ]; then
    echo "✗ timed out after ${TIMEOUT}s"
    post "dev.okidoki.mac.dev.stop" ""
    result=""
    break
  fi
done

if ! pgrep -xq Okidoki; then
  echo "✗ OKIDOKI CRASHED during this scenario"
  ls -t ~/Library/Logs/DiagnosticReports/Okidoki* 2>/dev/null | head -1
  exit 2
fi

sleep 1
screencapture -x "$OUT/$STAMP-$SLUG.png"
printf '%s\n' "$result" > "$OUT/$STAMP-$SLUG.json"
python3 - "$result" <<'EOF'
import json, sys
raw = sys.argv[1]
if not raw:
    print("✗ no result"); sys.exit(1)
r = json.loads(raw)
icon = {'done': '✓', 'failed': '✗', 'cancelled': '⏹'}.get(r.get('status'), '?')
print(f"{icon} {r.get('kind')} · {r.get('status')} · {r.get('title')}")
print(f"  summary: {r.get('summary')}")
out = (r.get('output') or '').strip().splitlines()
steps = [l for l in out if l.startswith('→')]
print(f"  steps: {len(steps)}")
for line in out[-24:]:
    print(f"    {line[:160]}")
EOF
echo "  screenshot: $OUT/$STAMP-$SLUG.png"
