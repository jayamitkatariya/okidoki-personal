#!/bin/bash
# Drives okidoki's browser in a running okidoki (launched with OKIDOKI_DEV_HOOKS=1) and prints how
# each run went, from the state file.
#
#   scripts/dev-browser.sh browse "find the weather in Lisbon"   # a browser run; waits and prints its log
#   scripts/dev-browser.sh open https://example.com
#   scripts/dev-browser.sh record | save "my flow" | keep "my flow"   # keep = save the last run's steps
#   scripts/dev-browser.sh replay "my flow"                         # waits and prints the replay
#   scripts/dev-browser.sh eval "return document.title"             # in the browser's page; prints the result
#   scripts/dev-browser.sh dash "return location.hash"              # in the dashboard's page
#   scripts/dev-browser.sh route skills | winfo                     # show a dashboard page | where the browser is
set -euo pipefail

SUPPORT="$HOME/Library/Application Support/Okidoki Personal"
STATE="$SUPPORT/state.json"
TIMEOUT="${OKIDOKI_SCENARIO_TIMEOUT:-240}"

post() {
  osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run(argv) {
      $.NSDistributedNotificationCenter.defaultCenter
        .postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);
    }' "$1" "$2" >/dev/null
}

pgrep -xq OkidokiPersonal || { echo "okidoki isn't running" >&2; exit 1; }
cmd="${1:?command required}"; shift || true
arg="${1:-}"

newest() { python3 -c "import json;r=json.load(open('$STATE'))['runs'];print(r[0]['id'] if r else '')"; }

# Waits for the newest run started after `before` to finish, then prints it.
wait_run() {
  local before="$1" started; started=$(date +%s)
  while :; do
    sleep 1.5
    out=$(python3 - "$STATE" "$before" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1])); runs = d['runs']
if not runs or runs[0]['id'] == sys.argv[2]: sys.exit(0)
r = runs[0]
if r.get('status') in ('running', 'waiting', 'previewing', 'paused'): sys.exit(0)
icon = {'done': '✓', 'failed': '✗', 'cancelled': '⏹', 'asked': '?'}.get(r['status'], '?')
secs = ''
if r.get('startedAt') and r.get('endedAt'):
    from datetime import datetime
    p = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
    secs = f" · {(p(r['endedAt']) - p(r['startedAt'])).total_seconds():.1f}s"
print(f"{icon} {r['kind']} · {r['status']}{secs} · {r['title']}")
print(f"  summary: {r.get('summary')}")
for line in (r.get('output') or '').splitlines()[-30:]: print(f"    {line[:180]}")
for s in r.get('steps', []): print(f"    [{s['status']}] {s['title'][:120]}")
EOF
)
    [ -n "$out" ] && { echo "$out"; break; }
    if [ $(( $(date +%s) - started )) -ge "$TIMEOUT" ]; then
      echo "✗ timed out after ${TIMEOUT}s"; post "dev.okidoki.personal.dev.stop" ""; exit 1
    fi
  done
  pgrep -xq OkidokiPersonal || { echo "✗ OKIDOKI CRASHED"; exit 2; }
}

case "$cmd" in
  browse)
    before=$(newest); post "dev.okidoki.personal.dev.browse" "$arg"; echo "▸ browse: $arg"; wait_run "$before" ;;
  replay)
    before=$(newest); post "dev.okidoki.personal.dev.browser" "replay $arg"; echo "▸ replay: $arg"; wait_run "$before" ;;
  eval|dash|winfo)
    rm -f "$SUPPORT/dev-browser.json"; post "dev.okidoki.personal.dev.browser" "$cmd${arg:+ $arg}"
    for _ in $(seq 1 40); do [ -f "$SUPPORT/dev-browser.json" ] && break; sleep 0.25; done
    cat "$SUPPORT/dev-browser.json" 2>/dev/null; echo ;;
  *)
    post "dev.okidoki.personal.dev.browser" "$cmd${arg:+ $arg}" ;;
esac
