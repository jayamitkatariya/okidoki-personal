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
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path.home() / "Library/Application Support/Okidoki Personal"
STATE = SUPPORT / "state.json"
DOMAIN = "dev.okidoki.personal"
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


def wait_run(before_ids, match, timeout):
    """The first run started after `before_ids` that `match` accepts, once it has finished."""
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.0)
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
        if str(got.get(key, "")) != str(item[key]):
            wrong.append(f"{key} {got.get(key)!r}≠{item[key]!r}")
    want = sorted((d["section"], d["amount"]) for d in item["deductions"])
    have = sorted((d.get("section"), d.get("amount")) for d in got.get("deductions", []))
    if want != have:
        wrong.append(f"deductions {have}≠{want}")
    return (not wrong), ("ok · " + got.get("ref", "")) if not wrong else "; ".join(wrong)


def skill_exists(name):
    return any(s.get("name") == name and not s.get("deletedAt") for s in load_state().get("skills", []))


def learn(spec, timeout):
    """The agent files the learn item once; its steps are kept as the skill."""
    item = spec["items"][spec["learnItem"]]
    fixture("/config", {"drift": False, "banner": False})
    goal = goal_for(spec["site"], item)
    before = {r["id"] for r in load_state().get("runs", [])}
    post(f"{DOMAIN}.dev.browse", "[fresh] " + goal)
    run, error = wait_run(before, lambda r: r.get("prompt") == goal, timeout)
    if error or not run or run.get("status") != "done":
        sys.exit(f"couldn't teach the skill: {error or (run or {}).get('summary')}")
    browser(f"keep {spec['skill']}")
    for _ in range(20):
        time.sleep(0.5)
        if skill_exists(spec["skill"]):
            print(f"learned “{spec['skill']}” in {seconds(run)}s, {run.get('modelCalls') or 0} model calls")
            return
    sys.exit("the run finished but the skill wasn't saved")


def run_mode(spec, scenario, mode, timeout):
    items = [spec["items"][name] | {"ref": name} for name in scenario["items"]]
    fixture("/config", {"drift": scenario["drift"], "banner": False})
    fixture("/reset", {})
    before = {r["id"] for r in load_state().get("runs", [])}
    started = time.time()
    runs, notes = [], []
    if mode == "agent":
        # One agent run per person: the agent has no skill to repeat.
        for item in items:
            goal = goal_for(spec["site"], item)
            post(f"{DOMAIN}.dev.browse", "[fresh] " + goal)
            run, error = wait_run(before, lambda r, g=goal: r.get("prompt") == g, timeout)
            runs.append(run)
            if error:
                notes.append(error)
            before |= {r["id"] for r in load_state().get("runs", [])}
    else:
        browser("hybrid on" if mode == "hybrid" else "hybrid off")
        time.sleep(0.5)
        values = [{k: v for k, v in item.items() if k != "deductions"} for item in items]
        browser("replayjson " + json.dumps({"skill": spec["skill"], "values": values}))
        run, error = wait_run(before, lambda r: r.get("builtin") == "skill", timeout * len(items))
        runs.append(run)
        if error:
            notes.append(error)
    wall = round(time.time() - started, 1)
    submissions = fixture("/submissions")["submissions"]
    results = [(item["ref"],) + check(item, submissions) for item in items]
    passed = sum(1 for _, ok, _ in results if ok)
    return {
        "scenario": scenario["id"], "mode": mode, "passed": passed, "total": len(items),
        "seconds": wall, "runSeconds": [seconds(r) for r in runs if r],
        "modelCalls": sum((r or {}).get("modelCalls") or 0 for r in runs),
        "items": [{"item": ref, "ok": ok, "detail": detail} for ref, ok, detail in results],
        "runs": [{"id": r.get("id"), "status": r.get("status"), "summary": r.get("summary")} for r in runs if r],
        "notes": notes,
    }


def table(rows, baseline=None):
    base = {(r["scenario"], r["mode"]): r for r in (baseline or {}).get("results", [])}
    print(f"\n{'scenario':<11} {'mode':<8} {'pass':>6} {'secs':>7} {'calls':>6}   vs baseline")
    for r in rows:
        b = base.get((r["scenario"], r["mode"]))
        delta = ""
        if b:
            delta = f"pass {b['passed']}/{b['total']} → {r['passed']}/{r['total']} · {b['seconds']}s → {r['seconds']}s · calls {b['modelCalls']} → {r['modelCalls']}"
        print(f"{r['scenario']:<11} {r['mode']:<8} {r['passed']:>3}/{r['total']:<2} {r['seconds']:>7} {r['modelCalls']:>6}   {delta}")
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

    if subprocess.run(["pgrep", "-xq", "OkidokiPersonal"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    spec = json.loads((ROOT / "scripts/replay-scenarios.json").read_text())
    proc = start_fixture()
    try:
        modes = [m.strip() for m in args.modes.split(",") if m.strip()]
        if args.relearn or (set(modes) - {"agent"} and not skill_exists(spec["skill"])):
            learn(spec, args.timeout)
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        rows = []
        for scenario in spec["scenarios"]:
            if wanted and scenario["id"] not in wanted:
                continue
            for mode in modes:
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
        if proc:
            proc.terminate()


if __name__ == "__main__":
    main()
