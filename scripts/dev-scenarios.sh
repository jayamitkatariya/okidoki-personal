#!/bin/bash
# Runs a batch of computer-use scenarios through scripts/dev-drive.sh and writes a summary.
# okidoki must be running with OKIDOKI_DEV_HOOKS=1.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT="${OKIDOKI_SCENARIO_DIR:-build/scenarios}"
mkdir -p "$OUT"
LOG="$OUT/batch-$(date +%H%M%S).log"

rm -f "$HOME/Desktop/okidoki-test.txt"
scenarios=(
  "create a new note in the Notes app that says: okidoki test note"
  "open safari in a private window and go to apple.com"
  "open calculator and work out 123 times 45"
  "open textedit, make a new document, type hello from okidoki, then save it to the desktop as okidoki-test.txt"
  "open the downloads folder in finder"
  "set the system volume to 30 percent"
  "open whatsapp, open the chat where i message myself (it is labelled You), and send it the message: okidoki test"
  "open wikipedia.org in safari and scroll to the bottom of the page"
  "open reminders and add a reminder called okidoki test"
  "--ask open the appearance pane in system settings"
)

pass=0; fail=0; crash=0
for goal in "${scenarios[@]}"; do
  echo "" | tee -a "$LOG"
  if [[ "$goal" == --ask* ]]; then
    ./scripts/dev-drive.sh --ask "${goal#--ask }" 2>&1 | tee -a "$LOG"
  else
    ./scripts/dev-drive.sh "$goal" 2>&1 | tee -a "$LOG"
  fi
  code=${PIPESTATUS[0]}
  if [ "$code" = "2" ]; then crash=$((crash+1)); break; fi
  if tail -n 30 "$LOG" | grep -q "^✓"; then pass=$((pass+1)); else fail=$((fail+1)); fi
  sleep 3
done
echo "" | tee -a "$LOG"
echo "passed $pass · failed $fail · crashed $crash" | tee -a "$LOG"
echo "log: $LOG"
