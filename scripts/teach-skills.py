#!/usr/bin/env python3
"""Teaches the library's read-only templates on the real sites, then proves each replays.

For every template below: an everyday request that no skill covers yet (smart replay picks the
library template, the agent does it once following its outline, and the run is kept as a learned
smart skill), then two requests with different data, which should be replays of that skill. Nothing
here sends, buys, books or posts: every task only reads.

Needs okidoki running with OKIDOKI_DEV_HOOKS=1 (scripts/launch-app.sh) and an Anthropic key.

  scripts/teach-skills.py                    # every template
  scripts/teach-skills.py --only wikipedia-lookup,npm-package
  scripts/teach-skills.py --replays-only     # skills already learned: just the two replays

Report: build/replay/teach-<time>.json and a table: per request, who did it (template run → agent,
replay → skill), whether it finished, seconds, model calls, and whether the answer looks right.
"""
import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki") / "state.json"
DOMAIN = "dev.okidoki.mac"
TERMINAL = {"done", "failed", "cancelled", "asked"}

# template id → three requests (learn, replay, replay) and what a right answer contains.
LESSONS = {
    "wikipedia-lookup": (["go to Wikipedia and look up the population of Lisbon",
                          "go to Wikipedia and look up the population of Porto",
                          "go to Wikipedia and look up the population of Kyoto"], r"\d[\d,.]{4,}"),
    "npm-package": (["check the npm package react on npmjs.com",
                     "check the npm package lodash on npmjs.com",
                     "check the npm package express on npmjs.com"], r"\d+\.\d+\.\d+"),
    "github-repo": (["check the GitHub repo facebook/react",
                     "check the GitHub repo vercel/next.js",
                     "check the GitHub repo denoland/deno"], r"(?i)star"),
    "word-definition": (["define the word serendipity on Merriam-Webster",
                         "define the word ephemeral on Merriam-Webster",
                         "define the word ubiquitous on Merriam-Webster"], r"(?i)noun|adjective|verb"),
    "currency-convert": (["convert 100 USD to INR on xe.com",
                          "convert 250 EUR to GBP on xe.com",
                          "convert 1000 JPY to USD on xe.com"], r"\d+[.,]\d+"),
    "imdb-rating": (["look up the IMDb rating of Inception",
                     "look up the IMDb rating of The Godfather",
                     "look up the IMDb rating of Parasite"], r"\d\.\d"),
    "weather-forecast": (["check the weather in London on timeanddate.com",
                          "check the weather in Tokyo on timeanddate.com",
                          "check the weather in Mumbai on timeanddate.com"], r"°"),
    "amazon-price": (["check the price of a Kindle Paperwhite on Amazon",
                      "check the price of AirPods Pro 2 on Amazon",
                      "check the price of a Logitech MX Master 3S mouse on Amazon"], r"\$\s?\d"),
    "youtube-search": (["find YouTube videos about swift concurrency",
                        "find YouTube videos about sourdough baking",
                        "find YouTube videos about rust ownership"], r"(?i)views|channel"),
    "hotel-search": (["search Booking.com for hotels in Lisbon from 2026-12-10 to 2026-12-12 for 2 adults",
                      "search Booking.com for hotels in Porto from 2026-12-14 to 2026-12-16 for 2 adults",
                      "search Booking.com for hotels in Seville from 2026-12-18 to 2026-12-20 for 2 adults"], r"\d"),
}


def post(name, obj=""):
    script = ('ObjC.import("Foundation");function run(argv){$.NSDistributedNotificationCenter.defaultCenter'
              '.postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}')
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, f"{DOMAIN}.{name}", obj], capture_output=True)


def state():
    for _ in range(10):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": [], "skills": []}


def seconds(run):
    parse = lambda v: datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None
    a, b = parse(run.get("startedAt") or run.get("createdAt")), parse(run.get("endedAt"))
    return round((b - a).total_seconds(), 1) if a and b else None


def ask(text, timeout):
    """Sends a request the way the dashboard does; the run it started, once finished."""
    before = {r["id"] for r in state()["runs"]}
    post("dev.ask", text)
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.5)
        # Read-only tasks never reach the gate, but answer it the way an agreeing person would.
        post("dev.browser", "gate carry")
        fresh = [r for r in state()["runs"] if r["id"] not in before]
        # The brain answering in words ("model unavailable", or a reply instead of doing it) ends it too.
        work = [r for r in fresh if r.get("kind") != "answer"]
        if work and work[-1].get("status") in TERMINAL:
            return work[-1]
        if fresh and not work and fresh[-1].get("status") == "done":
            run = fresh[-1]
            run["builtin"] = "answer: " + (run.get("title") or "")
            return run
    post("dev.stop")
    return run


def learned_skill(template_id):
    """The person's own skill learned from this template, if there is one."""
    skills = [s for s in state()["skills"] if not s.get("deletedAt")]
    template = next((s for s in skills if s.get("source") == f"library:{template_id}"), None)
    if not template:
        return None
    return next((s for s in skills if s.get("learned") and s.get("templateID") in (template["id"], template.get("source"))), None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--replays-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    if subprocess.run(["pgrep", "-xq", "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    wanted = [w.strip() for w in args.only.split(",") if w.strip()] or list(LESSONS)
    post("dev.browser", "hybrid on")
    time.sleep(0.5)
    rows = []
    try:
        for tid in wanted:
            requests, shape = LESSONS[tid]
            plan = requests[1:] if args.replays_only else requests
            for n, text in enumerate(plan):
                first = n == 0 and not args.replays_only
                print(f"· {tid} · {'learn' if first else 'replay'}: {text}", flush=True)
                run = ask(text, args.timeout)
                if first:
                    # The learned skill is saved, then generalized by the compiler: wait for its inputs.
                    for _ in range(90):
                        skill = learned_skill(tid)
                        if skill and skill.get("inputs"):
                            break
                        time.sleep(2)
                answer = (run or {}).get("summary") or ""
                row = {
                    "template": tid, "request": text, "phase": "learn" if first else "replay",
                    "by": (run or {}).get("builtin") or (run or {}).get("kind"), "status": (run or {}).get("status"),
                    "seconds": seconds(run) if run else None, "calls": (run or {}).get("modelCalls") or 0,
                    "looksRight": bool(re.search(shape, answer)), "answer": answer[:300],
                    "skill": (learned_skill(tid) or {}).get("name"),
                }
                rows.append(row)
    finally:
        post("dev.browser", "hybrid off")
    out = ROOT / "build/replay"
    out.mkdir(parents=True, exist_ok=True)
    path = out / time.strftime("teach-%Y%m%d-%H%M%S.json")
    path.write_text(json.dumps(rows, indent=2))
    print(f"\n{'template':<18} {'phase':<7} {'by':<8} {'status':<9} {'secs':>6} {'calls':>5}  ok  answer")
    for r in rows:
        print(f"{r['template']:<18} {r['phase']:<7} {str(r['by']):<8} {str(r['status']):<9} {str(r['seconds']):>6} {r['calls']:>5}  "
              f"{'✓' if r['looksRight'] and r['status'] == 'done' else '✗'}   {r['answer'][:90]}")
    print(f"\nreport: {path}")


if __name__ == "__main__":
    main()
