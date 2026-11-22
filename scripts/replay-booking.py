#!/usr/bin/env python3
"""The replay property, measured on a real site (Google Flights by default).

Show okidoki a booking once. It replays it for another route — deterministically, at speed, with the
model asked only for the steps the site has changed. That is the whole promise; this script measures
it instead of asserting it.

  1. LEARN   the agent does the booking once in okidoki's browser; the run's steps are kept as a skill.
  2. REPLAY  the skill runs for a different route. Every step is found by the selectors recorded with
             it, so a clean replay makes no model calls and finishes in seconds.
  3. DRIFT   (--drift) with `drift` on, every element's selector scheme is scrambled for the next
             replay: the saved selectors no longer match, so the replay must ask the model for the
             steps it can't find — and record the fix.
  4. FREEZE  (--freeze) replay the scrambled page again: the fix from step 3 should make this one
             deterministic again (no model calls).

Needs okidoki running with OKIDOKI_DEV_HOOKS=1, and an Anthropic key (the learn run and any rescue
need one; a clean replay does not).

  scripts/replay-booking.py --url "https://www.google.com/travel/flights?hl=en"
  scripts/replay-booking.py --drift --freeze
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = os.environ.get("OKIDOKI_BUNDLE_ID") or "dev.okidoki.mac"
TERMINAL = {"done", "failed", "cancelled", "asked"}

DEFAULT_SITE = "https://www.google.com/travel/flights?hl=en"
SKILL = "book a flight"

# Two bookings of the same shape. The first is learned; the second is replayed.
TRIPS = {
    "learn": {"from": "San Francisco", "to": "Lisbon", "date": "2026-12-18"},
    "replay": {"from": "San Jose", "to": "Chicago", "date": "2027-01-12"},
}


def post(name, obj):
    script = ('ObjC.import("Foundation");'
              "function run(argv){$.NSDistributedNotificationCenter.defaultCenter"
              ".postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}")
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, f"{DOMAIN}.{name}", obj], capture_output=True)


def browser(command):
    post("dev.browser", command)


def load_state():
    for _ in range(10):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": [], "skills": []}


def find_skill(name):
    return next((s for s in load_state().get("skills", []) if s.get("name") == name and not s.get("deletedAt")), None)


def seconds(run):
    from datetime import datetime

    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None

    start, end = parse(run.get("startedAt") or run.get("createdAt")), parse(run.get("endedAt"))
    return round((end - start).total_seconds(), 1) if start and end else None


def goal(site, trip):
    return (f"Go to the flight search at {site}. Set the trip to {trip['from']} to {trip['to']}, departing "
            f"{trip['date']}, one adult, economy. Search, and tell me the cheapest nonstop fare you can see. "
            f"Do not book or pay.")


def wait_run(before, match, timeout):
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.0)
        # Smart replay's "check before submitting" card, answered the way a person who agrees would.
        browser("gate carry")
        runs = [r for r in load_state().get("runs", []) if r["id"] not in before and match(r)]
        if runs:
            run = runs[-1]
            if run.get("status") in TERMINAL:
                return run
    post("dev.stop", "")
    return run


def learn(site, timeout):
    """The agent does the search once; its steps are kept as the skill."""
    if find_skill(SKILL):
        browser(f"forget {SKILL}")
        time.sleep(1)
    trip = TRIPS["learn"]
    before = {r["id"] for r in load_state().get("runs", [])}
    text = goal(site, trip)
    post("dev.browse", "[fresh] " + text)
    run = wait_run(before, lambda r: r.get("prompt") == text, timeout)
    if not run or run.get("status") != "done":
        return None, f"the learn run didn't finish: {(run or {}).get('status')} {(run or {}).get('summary')}"
    browser(f"keep {SKILL}")
    for _ in range(30):
        time.sleep(0.5)
        if find_skill(SKILL):
            return run, None
    return run, "the run finished but the skill wasn't saved"


def replay(trip, timeout):
    """Runs the saved skill once, with this trip's values."""
    skill = find_skill(SKILL)
    if not skill:
        return None, "no skill"
    before = {r["id"] for r in load_state().get("runs", [])}
    # Values the compiled skill asks for, filled for this trip. A skill that recorded literal text has
    # no placeholders and replays exactly as recorded — which is the honest "deterministic" reading.
    values = [dict(trip, ref=trip["to"])]
    browser("replayjson " + json.dumps({"skill": SKILL, "values": values}))
    run = wait_run(before, lambda r: r.get("builtin") == "skill", timeout)
    return run, None


def line(label, run, error=None):
    if error:
        return f"  ✗ {label}: {error}"
    if not run:
        return f"  ✗ {label}: never ran"
    calls = run.get("modelCalls") or 0
    took = seconds(run)
    verdict = run.get("status")
    speed = f"{took}s" if took is not None else "?"
    suffix = f" — {run.get('summary')}" if run.get("summary") else ""
    return f"  · {label}: {verdict} in {speed}, {calls} model call(s){suffix}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_SITE)
    parser.add_argument("--drift", action="store_true", help="also replay with every saved selector scrambled")
    parser.add_argument("--freeze", action="store_true", help="replay the scrambled page twice: the second must need no model")
    parser.add_argument("--relearn", action="store_true")
    parser.add_argument("--timeout", type=int, default=420)
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")

    browser("open " + args.url)
    time.sleep(2)

    if args.relearn or not find_skill(SKILL):
        print("· learning: the agent books once, in okidoki's browser …", flush=True)
        run, error = learn(args.url, args.timeout)
        print(line("learn", run, error))
        if error:
            return 1
        skill = find_skill(SKILL)
        steps = len(skill.get("steps", [])) if skill else 0
        inputs = [i.get("name") for i in (skill or {}).get("inputs", [])]
        print(f"  {steps} steps saved as “{SKILL}” · inputs {inputs or 'none (replays exactly as recorded)'}")

    print("\n· replay · a different route, same flow", flush=True)
    run, error = replay(TRIPS["replay"], args.timeout)
    print(line("replay", run, error))
    if run and (run.get("modelCalls") or 0) == 0:
        print("  ✓ deterministic: the model wasn't needed at all")

    if args.drift:
        print("\n· replay · every saved selector scrambled (the site changed)", flush=True)
        scramble = (ROOT / "scripts" / "scramble-selectors.py")
        if not scramble.exists():
            print("  – needs scripts/scramble-selectors.py (writes each saved selector to one that can't match)")
            return 0
        subprocess.run([sys.executable, str(scramble), SKILL, "--on"], check=False)
        run, error = replay(TRIPS["replay"], args.timeout)
        print(line("drifted", run, error))
        rescued = (run or {}).get("modelCalls") or 0
        if rescued:
            print(f"  · the model was asked for {rescued} step(s) the page no longer matched")
        if args.freeze:
            print("\n· replay again · the fix should have stuck", flush=True)
            run, error = replay(TRIPS["replay"], args.timeout)
            print(line("after the fix", run, error))
            if run and (run.get("modelCalls") or 0) == 0:
                print("  ✓ deterministic again: one rescue, then no model")
            else:
                print("  ✗ still needed the model: the lesson didn't stick")
    return 0


if __name__ == "__main__":
    sys.exit(main())
