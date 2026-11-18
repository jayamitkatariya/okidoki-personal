#!/usr/bin/env python3
"""Replay A/B harness: the full agent vs classic replay vs smart (hybrid) replay, on the same tasks.

Needs a running okidoki launched with OKIDOKI_DEV_HOOKS=1 (scripts/launch-app.sh). Starts the fixture
site itself, teaches the skill once with the agent if it doesn't exist, then runs every scenario in
every mode and checks what the site actually received, independently of what the run claimed.

  scripts/replay-eval.py --modes agent,classic,hybrid --label baseline --save-baseline
  scripts/replay-eval.py --modes classic,hybrid --compare build/replay/baseline.json
  scripts/replay-eval.py --only drift --modes hybrid
  scripts/replay-eval.py --relearn          # forget the skill and teach it again first

Report: build/replay/<label>.json, plus a table on stdout (success, seconds, model calls per mode).
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# A test build (scripts/build-app.sh with OKIDOKI_BUNDLE_ID/OKIDOKI_SUPPORT_DIR) is driven the same way:
# its dev hooks listen on its own bundle id, and its state lives in its own support folder.
SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = os.environ.get("OKIDOKI_BUNDLE_ID") or "dev.okidoki.mac"
FIXTURE = "http://127.0.0.1:8777"
TERMINAL = {"done", "failed", "cancelled"}


def post(name, obj):
    script = (
        'ObjC.import("Foundation");'
        "function run(argv){$.NSDistributedNotificationCenter.defaultCenter"
        ".postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}"
    )
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, name, obj], capture_output=True)


def browser(command):
    post(f"{DOMAIN}.dev.browser", command)


def load_state():
    for _ in range(10):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": [], "skills": []}


def fixture(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(FIXTURE + path, data=data, method="POST" if body is not None else "GET",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def start_fixture():
    try:
        fixture("/submissions")
        return None
    except Exception:
        proc = subprocess.Popen([sys.executable, str(ROOT / "scripts/replay-fixture/server.py"), "--port", "8777"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(30):
            time.sleep(0.2)
            try:
                fixture("/submissions")
                return proc
            except Exception:
                continue
        sys.exit("the fixture site didn't start")


GATE = {"answer": "carry"}
# The person, for scenarios that need one: what they do when smart replay says "your turn".
PERSON = {"solve": None, "seen": 0, "then": None}


def wait_run(before_ids, match, timeout):
    """The first run started after `before_ids` that `match` accepts, once it has finished."""
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.0)
        # Smart replay's "check before submitting" card, answered the way a person who agrees would.
        browser("gate " + GATE["answer"])
        if PERSON["solve"]:
            # Each new "your turn" in the log: do what a person would on that page.
            turns = sum((r.get("output") or "").count("your turn") for r in load_state().get("runs", []) if r.get("id") not in before_ids)
            if turns > PERSON["seen"]:
                PERSON["seen"] = turns
                time.sleep(1.5)
                browser("tabjs " + PERSON["solve"])
                if PERSON["then"] == "notch":
                    # Then the play button in the notch, on the run that's waiting for them.
                    time.sleep(1.0)
                    waiting = [r for r in load_state().get("runs", []) if r.get("id") not in before_ids and r.get("status") == "paused"]
                    if waiting:
                        browser("pause " + waiting[-1]["id"])
        runs = [r for r in load_state().get("runs", []) if r.get("id") not in before_ids and match(r)]
        if runs:
            run = runs[-1]
            # A run that asks a question can't be answered here: count it as a failure.
            if run.get("status") in TERMINAL or run.get("status") == "asked":
                return run, None
    post(f"{DOMAIN}.dev.stop", "")
    return run, f"timed out after {timeout}s"


def seconds(run):
    from datetime import datetime
    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    start, end = parse(run.get("startedAt") or run.get("createdAt")), parse(run.get("endedAt"))
    return round((end - start).total_seconds(), 1) if start and end else None


def goal_for(site, item):
    deductions = ", ".join(f"{d['section']} ₹{d['amount']}" for d in item["deductions"]) or "none"
    gains = f"capital gains ₹{item['gains']} (tick the shares/property box)" if item["gains"] else "no capital gains"
    return (f"Go to {site}, sign in with username eval and password eval, and file a return for {item['name']}: "
            f"PAN {item['pan']}, annual income {item['income']}, {item['regime']} regime, {gains}, "
            f"deductions: {deductions}. Submit it and tell me the reference number.")


def check(item, submissions):
    """The newest submission for this person, compared field by field with what should have been filed."""
    mine = [s for s in submissions if s.get("pan") == item["pan"] or s.get("name") == item["name"]]
    if not mine:
        names = [s.get("name") for s in submissions]
        return False, f"nothing filed for {item['name']} (filed: {names or 'nothing'})"
    got = mine[-1]
    wrong = []
    for key in ["name", "pan", "income", "regime", "gains"]:
        # A name as the document writes it ("BHARAT MEHTA") is still the right name.
        same = str(got.get(key, "")).lower() == str(item[key]).lower() if key == "name" else str(got.get(key, "")) == str(item[key])
        if not same:
            wrong.append(f"{key} {got.get(key)!r}≠{item[key]!r}")
    want = sorted((d["section"], d["amount"]) for d in item["deductions"])
    have = sorted((d.get("section"), d.get("amount")) for d in got.get("deductions", []))
    if want != have:
        wrong.append(f"deductions {have}≠{want}")
    return (not wrong), ("ok · " + got.get("ref", "")) if not wrong else "; ".join(wrong)


def find_skill(name):
    return next((s for s in load_state().get("skills", []) if s.get("name") == name and not s.get("deletedAt")), None)


def skill_exists(name):
    return find_skill(name) is not None


def learn(spec, timeout):
    """The agent files the learn item once; its steps are kept as the skill."""
    item = spec["items"][spec["learnItem"]]
    configure({})
    goal = goal_for(spec["site"], item)
    before = {r["id"] for r in load_state().get("runs", [])}
    post(f"{DOMAIN}.dev.browse", "[fresh] " + goal)
    run, error = wait_run(before, lambda r: r.get("prompt") == goal, timeout)
    if error or not run or run.get("status") != "done":
        sys.exit(f"couldn't teach the skill: {error or (run or {}).get('summary')}")
    # The same run kept twice: as recorded (classic replay) and generalized (smart replay).
    browser("hybrid off")
    time.sleep(0.4)
    browser(f"keep {spec['skill']}")
    for _ in range(20):
        time.sleep(0.5)
        if skill_exists(spec["skill"]):
            break
    else:
        sys.exit("the run finished but the skill wasn't saved")
    print(f"learned “{spec['skill']}” in {seconds(run)}s, {run.get('modelCalls') or 0} model calls")
    browser("hybrid on")
    time.sleep(0.4)
    browser(f"keep {spec['smartSkill']}")
    started = time.time()
    while time.time() - started < 200:
        time.sleep(1)
        smart = find_skill(spec["smartSkill"])
        if smart and smart.get("inputs"):
            names = [i["name"] for i in smart["inputs"]]
            thinks = sum(1 for s in smart["steps"] if s.get("mode") == "think")
            print(f"compiled “{spec['smartSkill']}” in {round(time.time() - started, 1)}s: inputs {names}, {thinks} think steps")
            break
    else:
        print("warning: the smart skill wasn't generalized; hybrid replays it as recorded")
    browser("hybrid off")


def vault_root():
    folder = load_state().get("settings", {}).get("vaultFolder") or str(Path.home() / "Desktop/Okidoki Vault")
    return Path(folder) / "replay-eval"


def write_documents(spec, names):
    """Each person's documents into their own vault folder: text PDFs, and scans as image-only PDFs."""
    from PIL import Image, ImageDraw, ImageFont
    root = vault_root()
    for name in names:
        folder = root / name
        folder.mkdir(parents=True, exist_ok=True)
        for doc in spec["documents"].get(name, []):
            target = folder / doc["file"]
            if doc.get("scan"):
                image = Image.new("RGB", (1240, 1754), "white")
                draw = ImageDraw.Draw(image)
                try:
                    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Courier New.ttf", 30)
                except Exception:
                    font = ImageFont.load_default()
                for n, line in enumerate(doc["text"].splitlines()):
                    draw.text((80, 120 + n * 52), line, fill="black", font=font)
                image.save(target, "PDF", resolution=150)
            else:
                text_file = folder / (doc["file"] + ".txt")
                text_file.write_text(doc["text"])
                with open(target, "wb") as out:
                    subprocess.run(["cupsfilter", str(text_file)], stdout=out, stderr=subprocess.DEVNULL)
                text_file.unlink()
    time.sleep(2.5)  # the vault notices new files through FSEvents


KNOBS = ["drift", "banner", "randomIds", "slow", "popups", "expire", "busy", "random", "wipe", "captcha", "decoys", "captchaSlow", "newBox", "redesign"]


def configure(scenario):
    """The site as the scenario wants it: every hard-mode knob off unless the scenario turns it on."""
    knobs = {k: False for k in KNOBS} | {"drift": scenario.get("drift", False)} | scenario.get("site", {})
    fixture("/config", knobs)
    # Pages the browser kept from an earlier setting would hide this one.
    browser("clearcache")
    time.sleep(0.5)


def given(item):
    """What a request would say for this item: its values, written the way the item's `given` says
    (money with commas, "Old" for old, "24(b)" for 24B). Keys in `omit` aren't given at all."""
    out = {k: v for k, v in item.items() if k not in ("deductions", "given", "omit")}
    deductions = item["deductions"]
    for key, value in item.get("given", {}).items():
        if key == "deductions":
            deductions = value
        else:
            out[key] = value
    out["deductions"] = json.dumps(deductions)
    for key in item.get("omit", []):
        out.pop(key, None)
    return out


def run_mode(spec, scenario, mode, timeout):
    items = [spec["items"][name] | {"ref": name} for name in scenario["items"]]
    configure(scenario)
    # How a person answers smart replay's "check before submitting" card in this scenario.
    GATE["answer"] = scenario.get("gate", "carry")
    PERSON.update(solve=scenario.get("person"), seen=0, then=scenario.get("personThen"))
    fixture("/reset", {})
    before = {r["id"] for r in load_state().get("runs", [])}
    started = time.time()
    runs, notes = [], []
    if mode == "agent":
        # One agent run per person: the agent has no skill to repeat.
        for item in items:
            goal = goal_for(spec["site"], item)
            # Each agent run is a new run: the person hasn't seen its "your turn" yet.
            PERSON["seen"] = 0
            post(f"{DOMAIN}.dev.browse", "[fresh] " + goal)
            if scenario.get("pauseAfter"):
                notes.extend(pause_midway(before, scenario["pauseAfter"], kinds=("browser", None)))
            run, error = wait_run(before, lambda r, g=goal: r.get("prompt") == g, timeout)
            runs.append(run)
            if error:
                notes.append(error)
            before |= {r["id"] for r in load_state().get("runs", [])}
    else:
        browser("hybrid on" if mode == "hybrid" else "hybrid off")
        time.sleep(0.5)
        if scenario.get("ask"):
            names = [item["ref"] for item in items]
            text = scenario["ask"].replace("{names}", ", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else names[0])
            post(f"{DOMAIN}.dev.ask", text)
            run, error = wait_run(before, lambda r: r.get("builtin") in ("skill", "browser"), timeout * len(items))
            runs.append(run)
            if error:
                notes.append(error)
            if run and run.get("builtin") != "skill":
                notes.append("the agent took it instead of a replay")
            values = None
        elif scenario.get("fromDocuments"):
            # Only who it's for: everything else has to come from their documents.
            values = [{"ref": item["ref"]} for item in items]
        elif mode == "hybrid":
            # Lists travel as JSON, like any value.
            values = [given(item) for item in items]
        else:
            values = [{k: v for k, v in given(item).items() if k != "deductions"} for item in items]
        if values is not None:
            skill = spec["smartSkill"] if mode == "hybrid" else spec["skill"]
            browser("replayjson " + json.dumps({"skill": skill, "values": values}))
            if scenario.get("stopAfter"):
                stopped = stop_midway(before, scenario["stopAfter"])
                notes.extend(stopped)
            if scenario.get("pauseAfter"):
                notes.extend(pause_midway(before, scenario["pauseAfter"]))
            if scenario.get("teach"):
                notes.extend(teach_while_paused(before, scenario["teach"]))
            run, error = wait_run(before, lambda r: r.get("builtin") == "skill", timeout * len(items))
            runs.append(run)
            if error:
                notes.append(error)
            if scenario.get("teach"):
                # The person said "add to skill": the same job again must now go by itself, no model.
                time.sleep(1.5)
                browser("teach")
                time.sleep(1.5)
                fixture("/reset", {})
                before |= {r["id"] for r in load_state().get("runs", [])}
                browser("replayjson " + json.dumps({"skill": skill, "values": values}))
                again, error = wait_run(before, lambda r: r.get("builtin") == "skill", timeout * len(items))
                runs.append(again)
                if error:
                    notes.append(error)
                if again and again.get("modelCalls"):
                    notes.append(f"after learning, the replay still needed the model {again['modelCalls']} times")
                if again and "while paused you" in (again.get("output") or ""):
                    notes.append("the second run was paused too")
                fresh_runs = {r["id"]: r for r in load_state().get("runs", [])}
                if not any("added 1 step" in (fresh_runs.get((r or {}).get("id"), {}).get("output") or "") for r in runs):
                    notes.append("nothing was learned from the person")
                # Put the skill back as it was for the other scenarios.
                browser("dropstep " + skill + "|" + scenario["teach"]["step"])
    wall = round(time.time() - started, 1)
    submissions = fixture("/submissions")["submissions"]
    results = []
    for item in items:
        ok, detail = check(item, submissions)
        if item["ref"] in scenario.get("expectNotFiled", []):
            # Something it should refuse to do (a value is missing): passing means nothing was filed,
            # and the run said why.
            said = " ".join((r or {}).get("summary") or "" for r in runs)
            ok, detail = (not ok and item["ref"] in said), (f"not filed, as it shouldn't be" if not ok else "filed although it shouldn't have been")
            if not ok and "not filed" in detail:
                detail += f" — but the run didn't say why (summary: {said[:160]!r})"
        results.append((item["ref"], ok, detail))
    # A return with nobody's details on it is always wrong.
    empty = [s.get("ref") for s in submissions if not s.get("name") and not s.get("pan")]
    if empty:
        notes.append(f"filed {len(empty)} empty return(s): {empty}")
        results = [(ref, False, detail + " · and an empty return was filed") if ref in scenario.get("expectNotFiled", []) else (ref, ok, detail)
                   for ref, ok, detail in results]
    # Filing anyone twice is always wrong.
    pans = [s.get("pan") for s in submissions]
    twice = sorted({p for p in pans if pans.count(p) > 1})
    if twice:
        notes.append(f"filed twice: {twice}")
    if scenario.get("stopAfter"):
        # After a stop: whatever was filed is whole, and nothing else is.
        run = runs[-1] if runs else None
        if not run or run.get("status") != "cancelled":
            notes.append(f"the run wasn't cancelled (status {(run or {}).get('status')})")
        results = [(ref, True, detail) if not ok and "nothing filed" in detail else (ref, ok, detail) for ref, ok, detail in results]
    # Hand-offs: a check counts once per item, never a flicker of cards; decoys never count.
    turns = sum((r or {}).get("output", "").count("your turn") for r in runs)
    if scenario.get("maxTurns") is not None and turns > scenario["maxTurns"]:
        notes.append(f"handed off {turns} times (at most {scenario['maxTurns']} expected)")
        results = [(ref, False, detail + " · too many hand-offs") for ref, ok, detail in results]
    passed = sum(1 for _, ok, _ in results if ok)
    return {
        "scenario": scenario["id"], "mode": mode, "passed": passed, "total": len(items),
        "seconds": wall, "runSeconds": [seconds(r) for r in runs if r],
        "modelCalls": sum((r or {}).get("modelCalls") or 0 for r in runs),
        "pauses": sum((r or {}).get("output", "").count("paused before") for r in runs),
        "handoffs": turns,
        "items": [{"item": ref, "ok": ok, "detail": detail} for ref, ok, detail in results],
        "runs": [{"id": r.get("id"), "status": r.get("status"), "summary": r.get("summary"), "log": (r.get("output") or "")[-1500:]} for r in runs if r],
        "notes": notes,
    }


def stop_midway(before, after_seconds):
    """Waits until the replay has been going `after_seconds`, then stops it the way the stop button does."""
    deadline = time.time() + 60
    while time.time() < deadline:
        runs = [r for r in load_state().get("runs", []) if r.get("id") not in before and r.get("builtin") == "skill"]
        if runs and runs[-1].get("status") == "running":
            time.sleep(after_seconds)
            filed_before = len(fixture("/submissions")["submissions"])
            post(f"{DOMAIN}.dev.stop", "")
            time.sleep(6)
            filed_after = len(fixture("/submissions")["submissions"])
            return [] if filed_after == filed_before else [f"{filed_after - filed_before} filed after the stop"]
        time.sleep(0.3)
    return ["the replay never started"]


def pause_midway(before, after_seconds, kinds=("skill",)):
    """Takes the page over mid-run (the notch's pause button), holds it a few seconds, then hands it back
    (the same button). Nothing may be filed while paused, and the run must show as paused, then running."""
    deadline = time.time() + 60
    while time.time() < deadline:
        runs = [r for r in load_state().get("runs", []) if r.get("id") not in before and r.get("builtin") in kinds]
        if runs and runs[-1].get("status") == "running":
            run_id = runs[-1]["id"]
            time.sleep(after_seconds)
            browser("pause " + run_id)
            time.sleep(1)
            notes = []
            now = next((r for r in load_state().get("runs", []) if r.get("id") == run_id), {})
            if now.get("status") != "paused":
                notes.append(f"pause didn't pause (status {now.get('status')})")
            filed = len(fixture("/submissions")["submissions"])
            time.sleep(5)
            moved = len(fixture("/submissions")["submissions"]) - filed
            browser("pause " + run_id)  # the same button again: take it back
            time.sleep(1)
            now = next((r for r in load_state().get("runs", []) if r.get("id") == run_id), {})
            if now.get("status") not in ("running", "done"):
                notes.append(f"play didn't resume (status {now.get('status')})")
            if moved:
                notes.append(f"{moved} filed while it was paused")
            return notes
        time.sleep(0.3)
    return ["the run never started"]


def teach_while_paused(before, teach):
    """Pauses the replay once it's on `teach['on']` (a page path), does `teach['js']` there as the person, and
    takes it back: the run should offer to learn what they did."""
    deadline = time.time() + 90
    while time.time() < deadline:
        runs = [r for r in load_state().get("runs", []) if r.get("id") not in before and r.get("builtin") == "skill"]
        if runs and runs[-1].get("status") == "running":
            browser("tabs")
            time.sleep(0.4)
            try:
                tabs = json.loads((SUPPORT / "dev-browser.json").read_text()).get("result", [])
            except Exception:
                tabs = []
            front = next((t for t in tabs if t.get("active")), {})
            if teach["on"] in (front.get("url") or ""):
                browser("pause " + runs[-1]["id"])
                time.sleep(1.0)
                browser("tabjs " + teach["js"])
                time.sleep(1.5)
                browser("pause " + runs[-1]["id"])
                return []
        time.sleep(0.15)
    return [f"never saw {teach['on']} to step in on"]


def table(rows, baseline=None):
    base = {(r["scenario"], r["mode"]): r for r in (baseline or {}).get("results", [])}
    print(f"\n{'scenario':<13} {'mode':<8} {'pass':>6} {'secs':>7} {'calls':>6}   vs baseline")
    for r in rows:
        b = base.get((r["scenario"], r["mode"]))
        delta = ""
        if b:
            delta = f"pass {b['passed']}/{b['total']} → {r['passed']}/{r['total']} · {b['seconds']}s → {r['seconds']}s · calls {b['modelCalls']} → {r['modelCalls']}"
        print(f"{r['scenario']:<13} {r['mode']:<8} {r['passed']:>3}/{r['total']:<2} {r['seconds']:>7} {r['modelCalls']:>6}   {delta}")
        for note in r.get("notes", []):
            print(f"{'':<21}! {note}")
        for it in r["items"]:
            if not it["ok"]:
                print(f"{'':<21}✗ {it['item']}: {it['detail']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--modes", default="classic,hybrid")
    parser.add_argument("--only", default="")
    parser.add_argument("--label", default=time.strftime("run-%Y%m%d-%H%M%S"))
    parser.add_argument("--save-baseline", action="store_true")
    parser.add_argument("--compare", default="")
    parser.add_argument("--relearn", action="store_true")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    spec = json.loads((ROOT / "scripts/replay-scenarios.json").read_text())
    proc = start_fixture()
    try:
        modes = [m.strip() for m in args.modes.split(",") if m.strip()]
        if args.relearn:
            for name in (spec["skill"], spec["smartSkill"]):
                if skill_exists(name):
                    browser(f"forget {name}")
            time.sleep(1)
        if set(modes) - {"agent"} and not (skill_exists(spec["skill"]) and skill_exists(spec["smartSkill"])):
            learn(spec, args.timeout)
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        rows = []
        for scenario in spec["scenarios"]:
            if wanted and scenario["id"] not in wanted:
                continue
            if scenario.get("fromDocuments"):
                write_documents(spec, scenario["items"])
            for mode in modes:
                if scenario.get("modes") and mode not in scenario["modes"]:
                    continue
                print(f"· {scenario['id']} · {mode} …", flush=True)
                rows.append(run_mode(spec, scenario, mode, args.timeout))
        out = ROOT / "build/replay"
        out.mkdir(parents=True, exist_ok=True)
        report = {"label": args.label, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "results": rows}
        (out / f"{args.label}.json").write_text(json.dumps(report, indent=2))
        if args.save_baseline:
            (out / "baseline.json").write_text(json.dumps(report, indent=2))
        baseline = json.loads(Path(args.compare).read_text()) if args.compare else None
        table(rows, baseline)
        print(f"\nreport: {out / (args.label + '.json')}")
    finally:
        browser("hybrid off")
        import shutil
        if vault_root().exists():
            shutil.rmtree(vault_root())
        if proc:
            proc.terminate()


if __name__ == "__main__":
    main()
