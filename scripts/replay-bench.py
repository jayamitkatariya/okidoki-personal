#!/usr/bin/env python3
"""First time vs second time, on the same real site — the property okidoki promises.

  first time   : the agent does the task, in the browser, calling the model at every turn.
  second time  : a saved skill replays it. Deterministic steps cost no model calls and no thinking.

Both are measured wall-clock from the run's own timestamps, plus the model calls the run recorded.
Run it twice to see the second replay settle (a rescue on the first replay becomes a plain step).

  scripts/replay-bench.py --url "https://www.google.com/travel/flights?hl=en" --runs 3
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = os.environ.get("OKIDOKI_BUNDLE_ID") or "dev.okidoki.mac"
TERMINAL = {"done", "failed", "cancelled", "asked"}
SKILL = "book a flight"

TASKS = [
    ("San Francisco", "Lisbon", "2026-12-18"),
    ("San Jose", "Chicago", "2027-01-12"),
    ("Seattle", "Austin", "2027-02-03"),
]


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


def rfc(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def timing(run):
    """Seconds the run spanned, and where it went: the model's share is its calls' wall time."""
    start = rfc(run.get("startedAt") or run.get("createdAt"))
    end = rfc(run.get("endedAt"))
    total = round((end - start).total_seconds(), 1) if start and end else None
    return total


def wait(before, match, timeout):
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(0.5)
        # The app must stay up for a run to mean anything: a relaunch mid-run aborts it, and the
        # numbers after that are noise (they showed as 7-minute hangs before this check).
        if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
            return run, "okidoki quit mid-run (was it relaunched?)"
        post("dev.browser", "gate carry")
        candidates = [r for r in state().get("runs", []) if r["id"] not in before and match(r)]
        if candidates:
            run = candidates[-1]
            if run.get("status") in TERMINAL:
                return run, None
    post("dev.stop", "")
    return run, f"timed out after {timeout}s"


def agent_task(site, trip, timeout):
    origin, destination, date = trip
    text = (f"Go to the flight search at {site}. Set the trip to {origin} to {destination}, departing {date}, "
            f"one adult, economy. Search, and tell me the cheapest nonstop fare you can see. Do not book or pay.")
    before = {r["id"] for r in state().get("runs", [])}
    started = time.time()
    post("dev.browse", "[fresh] " + text)
    run, error = wait(before, lambda r: r.get("prompt") == text, timeout)
    if error:
        print(f"  ! {error}")
    return run, round(time.time() - started, 1)


def replay(trip, timeout):
    origin, destination, date = trip
    before = {r["id"] for r in state().get("runs", [])}
    values = [{"ref": f"{origin} to {destination}", "origin": origin, "destination": destination, "departure_date": date}]
    started = time.time()
    post("dev.browser", "replayjson " + json.dumps({"skill": SKILL, "values": values}))
    run, error = wait(before, lambda r: r.get("builtin") == "skill", timeout)
    if error:
        print(f"  ! {error}")
    return run, round(time.time() - started, 1)


def find_skill():
    return next((s for s in state().get("skills", []) if s.get("name") == SKILL and not s.get("deletedAt")), None)


def row(label, run, wall):
    calls = (run or {}).get("modelCalls") or 0
    return {
        "label": label,
        "status": (run or {}).get("status"),
        "wall": wall,
        "runSeconds": timing(run) if run else None,
        "modelCalls": calls,
        "summary": ((run or {}).get("summary") or "")[:180],
    }


def show(results):
    print(f"\n{'':22} {'status':10} {'wall':>7} {'run':>7} {'model calls':>12}")
    for r in results:
        print(f"{r['label']:22} {str(r['status']):10} {str(r['wall']):>7} {str(r['runSeconds']):>7} {r['modelCalls']:>12}")
        if r["summary"]:
            print(f"{'':22} {r['summary']}")
    first = next((r for r in results if r["label"].startswith("first time")), None)
    good = [r for r in results if r["label"].startswith("replay") and r["status"] == "done"]
    if not good:
        failed = [r for r in results if r["label"].startswith("replay")]
        print("\n  ✗ no replay finished — the numbers above are not a speed comparison")
        for r in failed:
            print(f"    {r['label']}: {r['summary']}")
        return
    first_done = first and first["status"] == "done"
    best = min(good, key=lambda r: r["wall"])
    if first_done and first["wall"] and best["wall"]:
        speedup = first["wall"] / best["wall"]
        print(f"\n  replay is {speedup:.1f}× faster than doing it the first time "
              f"({first['wall']}s → {best['wall']}s), with {best['modelCalls']} model calls instead of {first['modelCalls']}.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://www.google.com/travel/flights?hl=en")
    parser.add_argument("--runs", type=int, default=2, help="how many replays to time (the pattern shows over repeats)")
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--no-learn", action="store_true", help="use the saved skill; don't re-learn")
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")

    results = []
    skill = find_skill()
    if args.no_learn and skill:
        print(f"· using the saved “{SKILL}” ({len(skill.get('steps', []))} steps)")
    else:
        if skill:
            post("dev.browser", f"forget {SKILL}")
            time.sleep(1)
        post("dev.browser", "hybrid on")
        time.sleep(0.6)
        print("· first time: the agent does it …", flush=True)
        run, wall = agent_task(args.url, TASKS[0], args.timeout)
        results.append(row("first time (agent)", run, wall))
        post("dev.browser", f"keep {SKILL}")
        # `keep` saves the plain recording at once, then generalizes it into a skill with inputs in the
        # background. Replaying before that lands would repeat the recorded details, so wait for it.
        saved = None
        for _ in range(120):
            time.sleep(1)
            saved = find_skill()
            if saved and saved.get("inputs"):
                break
        if not saved:
            sys.exit("the agent finished but the skill wasn't saved")
        inputs = [i.get("name") for i in saved.get("inputs", [])]
        print(f"  saved as “{SKILL}”: {len(saved.get('steps', []))} steps, inputs {inputs or 'none'}")
        if not inputs:
            print("  ! generalized with no inputs: a replay can only repeat the recorded trip")

    for index in range(args.runs):
        trip = TASKS[(index + 1) % len(TASKS)]
        print(f"· replay {index + 1}: {trip[0]} → {trip[1]} …", flush=True)
        run, wall = replay(trip, args.timeout)
        results.append(row(f"replay {index + 1} (skill)", run, wall))

    show(results)
    out = Path("build/replay")
    out.mkdir(parents=True, exist_ok=True)
    (out / "bench.json").write_text(json.dumps(results, indent=2))
    print(f"\nreport: {out / 'bench.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
