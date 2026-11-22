#!/usr/bin/env python3
"""Record the same task twice, side by side: once done by the agent, once replayed.

Two screen recordings of okidoki's browser, started at the same moment so they can be watched (or cut
together) as a comparison:

  left  · the agent does it — the model is asked at every turn.
  right · the saved skill replays it — deterministic, no model calls.

`screencapture -v` records each window; both stop when their run ends. The result is two .mov files
(the exact frames each run produced) plus `timings.json` with the wall clock and model calls of each.

  scripts/replay-sidebyside.py                 # learn if needed, then record both
  scripts/replay-sidebyside.py --no-learn      # only record (needs an existing skill)

Needs okidoki running with OKIDOKI_DEV_HOOKS=1.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = os.environ.get("OKIDOKI_BUNDLE_ID") or "dev.okidoki.mac"
OUT = ROOT / "build" / "replay"
TERMINAL = {"done", "failed", "cancelled", "asked"}
SKILL = "book a flight"
SITE = "https://www.google.com/travel/flights?hl=en"
LEARN = ("San Francisco", "Lisbon", "2026-12-18")
OTHER = ("San Jose", "Chicago", "2027-01-12")


def post(name, obj):
    script = ('ObjC.import("Foundation");'
              "function run(argv){$.NSDistributedNotificationCenter.defaultCenter"
              ".postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}")
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, f"{DOMAIN}.{name}", obj], capture_output=True)


def state():
    for _ in range(10):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": [], "skills": []}


def wait(before, match, timeout):
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(0.4)
        post("dev.browser", "gate carry")
        candidates = [r for r in state().get("runs", []) if r["id"] not in before and match(r)]
        if candidates:
            run = candidates[-1]
            if run.get("status") in TERMINAL:
                return run
    post("dev.stop", "")
    return run


def find_skill():
    return next((s for s in state().get("skills", []) if s.get("name") == SKILL and not s.get("deletedAt")), None)


def window_id(title):
    """The CoreGraphics window id of okidoki's browser window, by title."""
    script = f'''
    ObjC.import("CoreGraphics");
    function run() {{
      const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)));
      const hit = list.find(w => String(w.kCGWindowOwnerName || "").includes("Okidoki") || String(w.kCGWindowName || "").includes("{title}"));
      return hit ? String(hit.kCGWindowNumber) : "";
    }}'''
    result = subprocess.run(["osascript", "-l", "JavaScript", "-e", script], capture_output=True, text=True)
    return result.stdout.strip()


def start_recording(path):
    """Records the whole screen with screencapture, in the background."""
    return subprocess.Popen(["screencapture", "-v", "-x", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def stop_recording(process):
    # screencapture -v ends on SIGINT and finalises the movie.
    process.send_signal(2)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()


def agent_task(trip, timeout):
    origin, destination, date = trip
    text = (f"Go to the flight search at {SITE}. Set the trip to {origin} to {destination}, departing {date}, "
            f"one adult, economy. Search, and tell me the cheapest nonstop fare you can see. Do not book or pay.")
    before = {r["id"] for r in state().get("runs", [])}
    started = time.time()
    post("dev.browse", "[fresh] " + text)
    run = wait(before, lambda r: r.get("prompt") == text, timeout)
    return run, round(time.time() - started, 1)


def replay(trip, timeout):
    origin, destination, date = trip
    before = {r["id"] for r in state().get("runs", [])}
    values = [{"ref": f"{origin} to {destination}", "origin": origin, "destination": destination, "departure_date": date}]
    started = time.time()
    post("dev.browser", "replayjson " + json.dumps({"skill": SKILL, "values": values}))
    run = wait(before, lambda r: r.get("builtin") == "skill", timeout)
    return run, round(time.time() - started, 1)


def summary(run, wall):
    return {"status": (run or {}).get("status"), "wall": wall, "modelCalls": (run or {}).get("modelCalls") or 0,
            "summary": ((run or {}).get("summary") or "")[:300]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-learn", action="store_true")
    parser.add_argument("--timeout", type=int, default=420)
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    OUT.mkdir(parents=True, exist_ok=True)

    skill = find_skill()
    if not args.no_learn or not skill:
        if skill:
            post("dev.browser", f"forget {SKILL}")
            time.sleep(1)
        post("dev.browser", "hybrid on")
        print("· learning once (not recorded) …", flush=True)
        run, wall = agent_task(LEARN, args.timeout)
        post("dev.browser", f"keep {SKILL}")
        for _ in range(120):
            time.sleep(1)
            skill = find_skill()
            if skill and skill.get("inputs"):
                break
        if not skill:
            sys.exit("the learn run didn't save a skill")
        print(f"  learned in {wall}s · {summary(run, wall)['modelCalls']} model calls")

    print("\n· recording the agent doing it …", flush=True)
    post("dev.browser", f"open {SITE}")
    time.sleep(3)
    left = OUT / "side-by-side-agent.mov"
    recorder = start_recording(left)
    time.sleep(1.0)
    agent_run, agent_wall = agent_task(OTHER, args.timeout)
    stop_recording(recorder)

    print("· recording the replay doing it …", flush=True)
    right = OUT / "side-by-side-replay.mov"
    recorder = start_recording(right)
    time.sleep(1.0)
    replay_run, replay_wall = replay(OTHER, args.timeout)
    stop_recording(recorder)

    result = {"agent": summary(agent_run, agent_wall), "replay": summary(replay_run, replay_wall),
              "videos": {"agent": str(left), "replay": str(right)}}
    (OUT / "side-by-side.json").write_text(json.dumps(result, indent=2))

    print(f"\n  agent  : {agent_wall}s · {result['agent']['modelCalls']} model calls · {result['agent']['status']}")
    print(f"  replay : {replay_wall}s · {result['replay']['modelCalls']} model calls · {result['replay']['status']}")
    if agent_wall and replay_wall:
        print(f"  replay is {agent_wall / replay_wall:.1f}× faster")
    print(f"\n  {left}\n  {right}\n  {OUT / 'side-by-side.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
