#!/bin/bash
# Sends one demo line to a running okidoki (launched with OKIDOKI_DEV_HOOKS=1), waits for the run it
# starts, and prints its steps with timings, its result, and a screenshot path.
#
#   scripts/demo-meridian/rehearse.sh "file the entry for MTS-4471"
#   scripts/demo-meridian/rehearse.sh "add the CBP 3461 to the compliance vault"
set -euo pipefail
TEXT="${1:?what to ask}"
TIMEOUT="${REHEARSE_TIMEOUT:-180}"
STATE="$HOME/Library/Application Support/Okidoki/state.json"
OUT="${REHEARSE_DIR:-build/rehearsal}"
mkdir -p "$OUT"
pgrep -xq Okidoki || { echo "okidoki isn't running" >&2; exit 1; }

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
osascript -l JavaScript -e '
  ObjC.import("Foundation");
  function run(argv) {
    $.NSDistributedNotificationCenter.defaultCenter
      .postNotificationNameObjectUserInfoDeliverImmediately($("com.jaykatariya.okidoki.dev.ask"), $(argv[0]), $(), true);
  }' "$TEXT" >/dev/null
echo "▸ $TEXT"

status=0
python3 - "$STATE" "$since" "$TIMEOUT" <<'EOF' || status=$?
import json, sys, time, datetime
state, since, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
start = time.time()
def parse(s):
    return datetime.datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S") if s else None
seen = None
while time.time() - start < timeout:
    time.sleep(1)
    try:
        runs = json.load(open(state))["runs"]
    except Exception:
        continue
    mine = [r for r in runs if r.get("createdAt", "") >= since and r["kind"] != "answer"]
    answers = [r for r in runs if r.get("createdAt", "") >= since and r["kind"] == "answer"]
    if not mine and answers and time.time() - start > 3:
        r = answers[-1]; print(f"  answer: {r['title']}"); sys.exit(0)
    if not mine:
        continue
    r = sorted(mine, key=lambda r: r["createdAt"])[0]
    if r["status"] in ("done", "failed", "cancelled"):
        t0 = parse(r.get("startedAt") or r["createdAt"])
        for s in r.get("steps", []):
            a, b = parse(s.get("startedAt")), parse(s.get("endedAt"))
            took = f"{(b - a).total_seconds():4.0f}s" if a and b else "    "
            print(f"  {s['status']:<9}{took}  {s['title'][:90]}" + (f"  — {s['detail'][:60]}" if s.get("detail") else ""))
        end = parse(r.get("endedAt"))
        print(f"\n  {r['status'].upper()} in {(end - t0).total_seconds():.0f}s · {r['title']}" if end and t0 else f"\n  {r['status'].upper()}")
        print(f"  {r.get('summary','')}")
        sys.exit(0 if r["status"] == "done" else 2)
print("  timed out"); sys.exit(3)
EOF
shot="$OUT/$(date +%H%M%S).png"
screencapture -x "$shot"
echo "  screenshot: $shot"
exit $status
