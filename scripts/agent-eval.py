#!/usr/bin/env python3
"""Browser use end to end, the way another agent (or a person) uses okidoki: through the control API.

Each lesson runs on a public practice site built for automation testing (the-internet.herokuapp.com, demoqa.com):
dynamic loading, dropdowns, hidden JS dialogs, new windows, hovers, shadow DOM, sortable tables, a React form
with a date picker and autocomplete, ads in the way. For each:

  1. learn   — `POST /tasks` (browser mode): the agent works it out; the answer is checked.
  2. save    — `POST /runs/<id>/save`: kept as a skill, generalized by the compiler.
  3. replay  — `POST /tasks` (auto) with different data, twice: smart replay should take it (by == replay),
               get the new answer right, and make far fewer model calls than the agent did.

Needs okidoki running with OKIDOKI_DEV_HOOKS=1 (scripts/launch-app.sh) and an Anthropic key.

  scripts/agent-eval.py                       # every lesson
  scripts/agent-eval.py --only tables,hovers
  scripts/agent-eval.py --replays-only        # the skills already saved: just the replays

Report: build/replay/agent-<time>.json and a table.
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path.home() / "Library/Application Support/Okidoki Personal"
DOMAIN = "dev.okidoki.personal"
SITE = "https://the-internet.herokuapp.com"

# name → (skill name, [(request, answer regex)] — the first is learned, the rest are replays with new data)
LESSONS = {
    "tables": ("look up an email in the-internet table", [
        (f"On {SITE}/tables, in Example 1, what is the email of the person whose last name is Bach?", r"fbach@yahoo\.com"),
        (f"On {SITE}/tables, in Example 1, what is the email of the person whose last name is Conway?", r"tconway@earthlink\.net"),
        (f"On {SITE}/tables, in Example 1, what is the email of the person whose last name is Doe?", r"jdoe@hotmail\.com"),
    ]),
    "dropdown": ("pick a dropdown option on the-internet", [
        (f"On {SITE}/dropdown choose Option 2 in the dropdown and tell me which option is now selected", r"Option 2"),
        (f"On {SITE}/dropdown choose Option 1 in the dropdown and tell me which option is now selected", r"Option 1"),
    ]),
    "dynamic": ("reveal the hidden text on the-internet", [
        (f"On {SITE}/dynamic_loading/2 press Start, wait for it to finish loading, and tell me the text that appears", r"Hello World"),
        (f"On {SITE}/dynamic_loading/1 press Start, wait for it to finish loading, and tell me the text that appears", r"Hello World"),
    ]),
    "login": ("sign in to the-internet secure area", [
        (f"Sign in at {SITE}/login with username tomsmith and password SuperSecretPassword! and tell me the message shown", r"(?i)secure area"),
        (f"Sign in at {SITE}/login with username tomsmith and password WrongPassword1 and tell me the message shown", r"(?i)password is invalid"),
    ]),
    "hovers": ("read a hover caption on the-internet", [
        (f"On {SITE}/hovers hover over the second profile picture and tell me the name it shows", r"user2"),
        (f"On {SITE}/hovers hover over the third profile picture and tell me the name it shows", r"user3"),
    ]),
    "confirm": ("answer a JS confirm on the-internet", [
        (f"On {SITE}/javascript_alerts click 'Click for JS Confirm', accept it with OK, and tell me the result line", r"You clicked: Ok"),
        (f"On {SITE}/javascript_alerts click 'Click for JS Confirm', dismiss it with Cancel, and tell me the result line", r"You clicked: Cancel"),
    ]),
    "windows": ("open a new window on the-internet", [
        (f"On {SITE}/windows click 'Click Here' and tell me the heading on the page that opens", r"New Window"),
    ]),
    "shadow": ("read shadow DOM text on the-internet", [
        (f"On {SITE}/shadowdom tell me the two list items in the second list", r"(?i)different text"),
    ]),
    "controls": ("toggle a control on the-internet", [
        (f"On {SITE}/dynamic_controls click Enable, wait until the text box is enabled, type 'okidoki' in it, and tell me the message shown", r"(?i)enabled"),
        (f"On {SITE}/dynamic_controls click Remove, wait for the checkbox to go, and tell me the message shown", r"(?i)gone"),
    ]),
    "practice-form": ("fill the demoqa practice form", [
        ("Fill the practice form at https://demoqa.com/automation-practice-form: first name Asha, last name Rao, email asha.rao@example.com, "
         "gender Female, mobile 9876543210, date of birth 15 March 1990, subject Maths. Submit it and tell me the student name and "
         "date of birth from the confirmation table.", r"(?is)Asha Rao.*15 March,?\s*1990|15 March,?\s*1990.*Asha Rao"),
        ("Fill the practice form at https://demoqa.com/automation-practice-form: first name Ravi, last name Iyer, email ravi.iyer@example.com, "
         "gender Male, mobile 9123456780, date of birth 2 July 1985, subject Physics. Submit it and tell me the student name and "
         "date of birth from the confirmation table.", r"(?is)Ravi Iyer.*0?2 July,?\s*1985|0?2 July,?\s*1985.*Ravi Iyer"),
    ]),
}


def control():
    info = json.loads((SUPPORT / "control.json").read_text())
    return info["port"], info["token"]


def api(method, path, body=None, timeout=420):
    port, token = control()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return {"error": json.loads(error.read() or b"{}").get("error", str(error))}


def dev(name, obj=""):
    script = ('ObjC.import("Foundation");function run(argv){$.NSDistributedNotificationCenter.defaultCenter'
              '.postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}')
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, f"{DOMAIN}.{name}", obj], capture_output=True)


def text_of(run):
    return " ".join([run.get("result") or ""] + (run.get("said") or []))


def finish(run, timeout):
    """Waits the run out. An okay or a gate is given the way an agreeing person would (dev hooks); a captcha
    or a question can't be: those count as failures here."""
    deadline = time.time() + timeout
    while run.get("id") and not run.get("done") and time.time() < deadline:
        needs = run.get("needs") or ""
        if "okay" in needs:
            dev("dev.browser", "gate carry")
            dev("dev.browser", "approve " + run["id"])
        run = api("GET", f"/runs/{run['id']}/wait?timeout=20")
    return run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--replays-only", action="store_true")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if subprocess.run(["pgrep", "-xq", "OkidokiPersonal"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    status = api("GET", "/status")
    if status.get("error"):
        sys.exit(f"control endpoint: {status['error']}")
    dev("dev.browser", "hybrid on")
    wanted = [w.strip() for w in args.only.split(",") if w.strip()] or list(LESSONS)
    rows = []
    try:
        for lesson in wanted:
            name, steps = LESSONS[lesson]
            skills = {s["name"]: s for s in api("GET", "/skills").get("skills", [])}
            for n, (text, shape) in enumerate(steps):
                learning = n == 0
                if learning and args.replays_only:
                    continue
                if learning and name in skills:
                    # A fresh lesson: the old skill would answer instead of the agent.
                    dev("dev.browser", "forget " + name)
                    time.sleep(1)
                print(f"· {lesson} · {'learn' if learning else 'replay'}: {text[:90]}", flush=True)
                started = time.time()
                run = api("POST", "/tasks", {"text": text, "mode": "browser" if learning else "auto", "wait": 30})
                if run.get("error"):
                    rows.append({"lesson": lesson, "phase": "learn" if learning else "replay", "ok": False, "note": run["error"]})
                    continue
                run = finish(run, args.timeout)
                answer = text_of(run)
                ok = run.get("status") == "done" and bool(re.search(shape, answer))
                row = {"lesson": lesson, "phase": "learn" if learning else "replay", "request": text, "id": run.get("id"),
                       "by": run.get("by") or run.get("kind"), "status": run.get("status"), "needs": run.get("needs"),
                       "seconds": run.get("seconds") or round(time.time() - started, 1), "calls": run.get("modelCalls", 0),
                       "ok": ok, "answer": answer[:400]}
                if learning and run.get("status") == "done" and len(steps) > 1:
                    saved = api("POST", f"/runs/{run['id']}/save", {"name": name}, timeout=120)
                    skill = saved.get("skill")
                    row["saved"] = skill.get("inputs") and [i["name"] for i in skill["inputs"]] if isinstance(skill, dict) else saved.get("error", skill)
                if not learning and row["by"] != "replay":
                    row["note"] = "the agent did it, not the saved skill"
                rows.append(row)
    finally:
        dev("dev.browser", "hybrid off")
    out = ROOT / "build/replay"
    out.mkdir(parents=True, exist_ok=True)
    path = out / time.strftime("agent-%Y%m%d-%H%M%S.json")
    path.write_text(json.dumps(rows, indent=2))
    print(f"\n{'lesson':<14} {'phase':<7} {'by':<14} {'status':<9} {'secs':>6} {'calls':>5}  ok  answer")
    for r in rows:
        print(f"{r['lesson']:<14} {r['phase']:<7} {str(r.get('by')):<14} {str(r.get('status')):<9} {str(r.get('seconds')):>6} "
              f"{r.get('calls', 0):>5}  {'✓' if r['ok'] else '✗'}   {(r.get('answer') or r.get('note') or '')[:80]}")
        if r.get("saved") is not None:
            print(f"{'':<30}saved · inputs {r['saved']}")
        if r.get("note") and r.get("answer"):
            print(f"{'':<30}! {r['note']}")
        if r.get("needs"):
            print(f"{'':<30}! needs {r['needs']}")
    print(f"\nreport: {path}")


if __name__ == "__main__":
    main()
