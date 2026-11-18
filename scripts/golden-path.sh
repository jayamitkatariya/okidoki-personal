#!/bin/bash
# The golden path: okidoki's whole loop, end to end, on a fresh profile — the regression checklist
# for "it just works", and the two-minute demo. Every step is checked independently of what a run
# claimed (the fixture site's own submissions, the session API's own answers).
#
#   ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh                 # browser loop + shared session
#   ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh --with-mac      # + Act on this Mac (needs grants)
#   ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh --with-vm       # + a task in the private Mac
#   scripts/golden-path.sh --no-build                             # reuse the last golden build
#
# Builds and runs its OWN okidoki (bundle id dev.okidoki.golden, its own support folder and ports),
# so it never touches the installed app, its data or its keys. The key comes from the environment,
# never from the installed app's key file. Steps that need macOS grants or the 15 GB private Mac are
# opt-in flags; without them the script says SKIP and why, never a silent pass.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

WITH_MAC=0; WITH_VM=0; BUILD=1
for arg in "$@"; do
  case "$arg" in
    --with-mac) WITH_MAC=1 ;;
    --with-vm) WITH_VM=1 ;;
    --no-build) BUILD=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[ "$(uname)" = "Darwin" ] || { echo "the golden path runs on macOS" >&2; exit 2; }
command -v swift >/dev/null || { echo "swift is missing (Xcode command line tools)" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun is missing (https://bun.sh)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is missing" >&2; exit 2; }
KEY="${ANTHROPIC_API_KEY:-}"
[ -n "$KEY" ] || { echo "set ANTHROPIC_API_KEY (the test profile's own key; the installed app is never read)" >&2; exit 2; }

# --- the isolated identity ---------------------------------------------------------------------
export OKIDOKI_BUNDLE_ID="dev.okidoki.golden"
export OKIDOKI_APP_NAME="Okidoki Golden"
export OKIDOKI_EXEC="OkidokiGolden"
GOLDEN="$ROOT/build/golden"
APP="$GOLDEN/OkidokiGolden.app"
SUPPORT="$GOLDEN/support"
export OKIDOKI_SUPPORT_DIR="$SUPPORT"
export OKIDOKI_KEYS_FILE="$SUPPORT/keys.json"
export OKIDOKI_DEV_HOOKS=1
export OKIDOKI_BRAIN_PORT=4529
export OKIDOKI_CONTROL_PORT=4530
FIXTURE_PORT="${GOLDEN_FIXTURE_PORT:-8799}"
SITE="http://127.0.0.1:$FIXTURE_PORT/login.html"
FIXTURE_PID=""

PASS=0; FAIL=0; SKIP=0
step()  { printf '\n▸ %s\n' "$1"; }
ok()    { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
skip()  { SKIP=$((SKIP+1)); printf '  – SKIP: %s\n' "$1"; }

cleanup() {
  OKIDOKI_INSTALLED_APP="$APP" scripts/launch-app.sh --stop >/dev/null 2>&1
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
}
trap cleanup EXIT

post() { # post <notification suffix> <string> — the dev hooks, namespaced by bundle id
  osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run(argv) {
      $.NSDistributedNotificationCenter.defaultCenter
        .postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);
    }' "$OKIDOKI_BUNDLE_ID.$1" "$2" >/dev/null
}

# --- build + fresh profile ---------------------------------------------------------------------
step "build the golden okidoki (its own bundle id, data and ports)"
mkdir -p "$GOLDEN"
if [ "$BUILD" = 1 ]; then
  OKIDOKI_APP_DIR="$APP" ./scripts/build-app.sh debug >"$GOLDEN.build.log" 2>&1 || {
    bad "build failed — see $GOLDEN.build.log"; exit 1; }
fi
[ -x "$APP/Contents/MacOS/$OKIDOKI_EXEC" ] || { bad "no golden app at $APP"; exit 1; }
ok "built $APP"

rm -rf "$SUPPORT"; mkdir -p "$SUPPORT"
printf '{"anthropic": "%s"}' "$KEY" > "$OKIDOKI_KEYS_FILE"
chmod 600 "$OKIDOKI_KEYS_FILE"
ok "fresh profile at $SUPPORT (key from the environment)"

step "start the fixture filing site"
python3 scripts/replay-fixture/server.py --port "$FIXTURE_PORT" >"$GOLDEN.fixture.log" 2>&1 &
FIXTURE_PID=$!
for _ in $(seq 1 20); do
  curl -s -m 2 "http://127.0.0.1:$FIXTURE_PORT/submissions" >/dev/null 2>&1 && break; sleep 0.5
done
curl -s -m 2 "http://127.0.0.1:$FIXTURE_PORT/submissions" >/dev/null 2>&1 && ok "fixture on :$FIXTURE_PORT" || { bad "fixture didn't start"; exit 1; }
curl -s -m 2 -X POST "http://127.0.0.1:$FIXTURE_PORT/reset" >/dev/null

step "launch the golden app"
OKIDOKI_INSTALLED_APP="$APP" scripts/launch-app.sh || { bad "didn't launch"; exit 1; }
PORT=""; TOKEN=""
for _ in $(seq 1 60); do
  if [ -f "$SUPPORT/control.json" ]; then
    PORT=$(python3 -c "import json;print(json.load(open('$SUPPORT/control.json'))['port'])" 2>/dev/null)
    TOKEN=$(python3 -c "import json;print(json.load(open('$SUPPORT/control.json'))['token'])" 2>/dev/null)
    [ -n "$PORT" ] && [ -n "$TOKEN" ] && break
  fi
  sleep 0.5
done
[ -n "$PORT" ] && [ -n "$TOKEN" ] || { bad "control endpoint never came up"; exit 1; }
ok "control on 127.0.0.1:$PORT"

ctl() { # ctl <METHOD> <path> [json body]
  if [ -n "${3:-}" ]; then
    curl -s -m 300 -X "$1" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "$3" "http://127.0.0.1:$PORT$2"
  else
    curl -s -m 300 -X "$1" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$2"
  fi
}
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

wait_run() { # wait_run <run id> <timeout s> — gives gates and okays the way an agreeing person would
  local id="$1" deadline=$(( $(date +%s) + ${2:-240} )) run status needs
  while [ "$(date +%s)" -lt "$deadline" ]; do
    run=$(ctl GET "/runs/$id")
    status=$(printf '%s' "$run" | jget "['status']")
    case "$status" in
      done|failed|cancelled) printf '%s' "$run"; return 0 ;;
    esac
    needs=$(printf '%s' "$run" | jget "['needs']")
    case "$needs" in
      *okay*) post dev.browser "gate carry"; post dev.browser "approve $id" ;;
      *answer*) post dev.browser "answer yes, go ahead" ;;
    esac
    sleep 2
  done
  printf '%s' "$run"; return 1
}

# --- 1 · health ---------------------------------------------------------------------------------
step "health: key, brain, status"
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$(ctl GET /status)
  [ "$(printf '%s' "$STATUS" | jget "['brain']")" = "True" ] && break
  sleep 1
done
[ "$(printf '%s' "$STATUS" | jget "['ok']")" = "True" ] && ok "control answers" || bad "control unhealthy"
[ "$(printf '%s' "$STATUS" | jget "['key']")" = "True" ] && ok "anthropic key set" || bad "key not seen"
[ "$(printf '%s' "$STATUS" | jget "['brain']")" = "True" ] && ok "brain ready" || bad "brain not ready"
post dev.browser "hybrid on"
ok "smart replay on (the skill generalizes with inputs)"

# --- 2 · learn: the agent files one return ------------------------------------------------------
step "learn: the agent files Asha's return in the browser"
LEARN_GOAL="Go to $SITE, sign in with username eval and password eval, and file a return for Asha Rao: PAN ABCPR1234K, annual income 1250000, new regime, no capital gains, deductions: none. Submit it and tell me the reference number."
RUN=$(ctl POST /tasks "$(python3 -c "import json,sys;print(json.dumps({'text': sys.argv[1], 'mode': 'browser', 'wait': 10}))" "$LEARN_GOAL")")
RUN_ID=$(printf '%s' "$RUN" | jget "['id']")
if [ -z "$RUN_ID" ]; then bad "no run started: $RUN"; else
  RUN=$(wait_run "$RUN_ID" 300)
  if [ "$(printf '%s' "$RUN" | jget "['status']")" = "done" ]; then
    ok "filed Asha's return ($(printf '%s' "$RUN" | jget "['seconds']")s, $(printf '%s' "$RUN" | jget "['modelCalls']") model calls)"
    FILED=$(curl -s -m 5 "http://127.0.0.1:$FIXTURE_PORT/submissions" | python3 -c "
import sys,json
subs=json.load(sys.stdin)['submissions']
mine=[s for s in subs if s.get('pan')=='ABCPR1234K']
print('yes' if mine and mine[-1].get('name')=='Asha Rao' else 'no')")
    [ "$FILED" = "yes" ] && ok "the fixture actually received it (independent check)" || bad "fixture shows no filing for Asha"
  else
    bad "learn run: $(printf '%s' "$RUN" | jget "['status']") — $(printf '%s' "$RUN" | jget "['result']")"
  fi
fi

# --- 3 · save: the run becomes a skill with inputs ----------------------------------------------
step "save: keep the run as a skill"
SKILL_NAME="golden filing"
SAVED=$(ctl POST "/runs/$RUN_ID/save" "$(python3 -c "import json;print(json.dumps({'name': 'golden filing'}))")")
if [ "$(printf '%s' "$SAVED" | jget "['ok']")" = "True" ]; then
  ok "saved “$SKILL_NAME”"
  INPUTS=$(ctl GET /skills | python3 -c "
import sys,json
skills=json.load(sys.stdin)['skills']
mine=[s for s in skills if s['name']=='golden filing']
print(','.join(i['name'] for i in mine[-1].get('inputs',[])) if mine else '')")
  [ -n "$INPUTS" ] && ok "generalized with inputs: $INPUTS" || bad "no inputs — smart replay didn't generalize"
else
  bad "save failed: $SAVED"
fi

# --- 4 · replay: new person, new values, seconds not minutes ------------------------------------
step "replay: file Bharat's return with the saved skill"
VALUES='{"name":"Bharat Mehta","pan":"BHMPM5678L","income":"980000","regime":"old"}'
REPLAY=$(ctl POST "/skills/golden%20filing/run" "$(python3 -c "import json,sys;print(json.dumps({'values': json.loads(sys.argv[1]), 'wait': 10}))" "$VALUES")")
RID=$(printf '%s' "$REPLAY" | jget "['id']")
if [ -z "$RID" ]; then bad "no replay run: $REPLAY"; else
  REPLAY=$(wait_run "$RID" 240)
  if [ "$(printf '%s' "$REPLAY" | jget "['status']")" = "done" ]; then
    ok "replayed in $(printf '%s' "$REPLAY" | jget "['seconds']")s with $(printf '%s' "$REPLAY" | jget "['modelCalls']") model calls"
    FILED=$(curl -s -m 5 "http://127.0.0.1:$FIXTURE_PORT/submissions" | python3 -c "
import sys,json
subs=json.load(sys.stdin)['submissions']
mine=[s for s in subs if s.get('pan')=='BHMPM5678L']
print('yes' if mine and mine[-1].get('name')=='Bharat Mehta' else 'no')")
    [ "$FILED" = "yes" ] && ok "the fixture received Bharat's values (independent check)" || bad "fixture shows no filing for Bharat"
  else
    bad "replay: $(printf '%s' "$REPLAY" | jget "['status']") — $(printf '%s' "$REPLAY" | jget "['result']")"
  fi
fi

# --- 5 · the shared session ---------------------------------------------------------------------
step "session: start, join, chat, live events, the wheel"
post dev.collab start
CODE=""; CPORT=""
for _ in $(seq 1 30); do
  if [ -f "$SUPPORT/collab.json" ]; then
    CODE=$(python3 -c "import json;print(json.load(open('$SUPPORT/collab.json'))['code'])" 2>/dev/null)
    CPORT=$(python3 -c "import json;print(json.load(open('$SUPPORT/collab.json'))['port'])" 2>/dev/null)
    [ -n "$CODE" ] && [ "$CPORT" != "0" ] && break
  fi
  sleep 0.5
done
if [ -z "$CODE" ] || [ "$CPORT" = "0" ]; then bad "session never came up"; else
  ok "session live on :$CPORT, code $CODE"
  CB="http://127.0.0.1:$CPORT"
  WRONG=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$CB/api/join" -H 'content-type: application/json' -d '{"name":"Eve","code":"WRONG"}')
  [ "$WRONG" = "403" ] && ok "a wrong code is refused (403)" || bad "wrong code got $WRONG"
  JOIN=$(curl -s -m 5 -X POST "$CB/api/join" -H 'content-type: application/json' -d "{\"name\":\"Asha\",\"code\":\"$CODE\"}")
  CTOKEN=$(printf '%s' "$JOIN" | jget "['token']")
  [ -n "$CTOKEN" ] && ok "joined with the code" || bad "join failed: $JOIN"
  CHAT=$(curl -s -m 5 -X POST "$CB/api/chat" -H "Authorization: Bearer $CTOKEN" -H 'content-type: application/json' -d '{"text":"hello from the golden path"}')
  [ "$(printf '%s' "$CHAT" | jget "['ok']")" = "True" ] && ok "group chat sends" || bad "chat failed"
  HELLO=$(curl -s -N -m 2 "$CB/api/events?token=$CTOKEN" | head -c 400)
  printf '%s' "$HELLO" | grep -q '"type":"hello"' && ok "SSE streams the session (hello)" || bad "no SSE hello"
  WHEEL=$(curl -s -m 5 -X POST "$CB/api/wheel" -H "Authorization: Bearer $CTOKEN" -H 'content-type: application/json' -d '{"action":"request"}')
  [ "$(printf '%s' "$WHEEL" | jget "['ok']")" = "True" ] && ok "took the wheel" || bad "wheel failed: $WHEEL"
  curl -s -m 5 -X POST "$CB/api/wheel" -H "Authorization: Bearer $CTOKEN" -H 'content-type: application/json' -d '{"action":"release"}' >/dev/null
  ok "released the wheel"
  post dev.collab stop
  sleep 1
  GONE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$CB/api/state?token=$CTOKEN")
  if [ "$GONE" = "409" ] || [ "$GONE" = "000" ]; then ok "ending the session closes the door"; else bad "session still answers ($GONE)"; fi
fi

# --- 6 · Act on this Mac (opt-in: needs Accessibility + Screen Recording) ------------------------
step "Act on this Mac"
if [ "$WITH_MAC" = 1 ]; then
  ACT=$(ctl POST /tasks '{"text":"open TextEdit and make a new note that says hello from the golden path","mode":"computer","wait":10}')
  AID=$(printf '%s' "$ACT" | jget "['id']")
  if [ -n "$AID" ]; then
    ACT=$(wait_run "$AID" 240)
    [ "$(printf '%s' "$ACT" | jget "['status']")" = "done" ] && ok "drove this Mac" || bad "Act: $(printf '%s' "$ACT" | jget "['result']") (grant Accessibility + Screen Recording to Okidoki Golden in System Settings)"
  else bad "no Act run: $ACT"; fi
else
  skip "needs macOS grants — run with --with-mac"
fi

# --- 7 · a task in the private Mac (opt-in: the 15 GB VM) ----------------------------------------
step "a task in the private Mac, asked from the session"
if [ "$WITH_VM" = 1 ]; then
  echo "  set up the private Mac in the golden app's Settings › Private Mac (about 15 GB, once)."
  echo "  waiting up to 30 minutes for it to run…"
  VM_UP=0
  for _ in $(seq 1 360); do
    [ "$(ctl GET /status | jget "['privateMac']")" = "running" ] && { VM_UP=1; break; }
    sleep 5
  done
  if [ "$VM_UP" = 1 ]; then
    ok "private Mac running"
    post dev.collab start
    sleep 2
    CODE=$(python3 -c "import json;print(json.load(open('$SUPPORT/collab.json'))['code'])" 2>/dev/null)
    CPORT=$(python3 -c "import json;print(json.load(open('$SUPPORT/collab.json'))['port'])" 2>/dev/null)
    JOIN=$(curl -s -m 5 -X POST "http://127.0.0.1:$CPORT/api/join" -H 'content-type: application/json' -d "{\"name\":\"Asha\",\"code\":\"$CODE\"}")
    CTOKEN=$(printf '%s' "$JOIN" | jget "['token']")
    curl -s -m 5 -X POST "http://127.0.0.1:$CPORT/api/chat" -H "Authorization: Bearer $CTOKEN" -H 'content-type: application/json' \
      -d '{"text":"okidoki, open Safari in the shared Mac and show the weather in Lisbon","ask":true}' >/dev/null
    sleep 5
    SID=$(ctl GET /runs?limit=5 | python3 -c "
import sys,json
runs=json.load(sys.stdin)['runs']
print(next((r['id'] for r in runs if r.get('kind')=='computer_use'), ''))")
    if [ -n "$SID" ]; then
      VMRUN=$(wait_run "$SID" 420)
      [ "$(printf '%s' "$VMRUN" | jget "['status']")" = "done" ] && ok "a session ask drove the private Mac" || bad "VM run: $(printf '%s' "$VMRUN" | jget "['result']")"
    else bad "no session run appeared"; fi
    post dev.collab stop
  else
    bad "the private Mac never reached running (set it up in Settings › Private Mac)"
  fi
else
  skip "needs the 15 GB private Mac — run with --with-vm"
fi

# --- summary -------------------------------------------------------------------------------------
printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
printf 'golden path: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
printf 'logs: %s.build.log, %s.fixture.log, profile %s\n' "$GOLDEN" "$GOLDEN" "$SUPPORT"
[ "$FAIL" = 0 ] || exit 1
