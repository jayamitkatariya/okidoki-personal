#!/usr/bin/env python3
"""Mac replay A/B harness: the full agent vs classic replay vs smart (hybrid) replay, on the AcmeDesk
fixture app (scripts/cu-fixture), the Mac twin of scripts/replay-eval.py.

Needs a running okidoki launched with OKIDOKI_DEV_HOOKS=1 (scripts/launch-app.sh). Builds and launches
the fixture itself (in the background, its window far off every display), adds the two AcmeDesk skills
if they aren't there, runs every scenario in every mode, and checks what the fixture actually filed
(its submissions.json), independently of what the run claimed.

Agent and classic replay drive the real mouse and keyboard, and the agent looks at the screen. They only
run with --live-desktop: on the private Mac, or when nobody is using this one. Without it, smart replay
runs through Accessibility alone (`macax on`): no pointer, no keys, no screenshots, nothing in front.

  scripts/cu-replay-eval.py --modes hybrid --label first --save-baseline
  scripts/cu-replay-eval.py --modes hybrid --compare build/cu-replay/baseline.json
  scripts/cu-replay-eval.py --only drift,hard-popups --modes hybrid
  scripts/cu-replay-eval.py --reimport                 # replace the AcmeDesk skills with the files
  scripts/cu-replay-eval.py --modes agent,classic,hybrid --live-desktop   # private Mac only

Report: build/cu-replay/<label>.json, plus a table on stdout (items right, seconds, model calls).
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = "dev.okidoki.mac"
TERMINAL = {"done", "failed", "cancelled"}
FIXTURE_APP = ROOT / "build/cu-fixture/AcmeDesk.app"
# The fixture's own folder for this eval: config, submissions, its log. Deleted at the end. Not under
# ~/Desktop or ~/Documents: macOS would ask the person before letting a new app write there.
ACME = Path.home() / "Library/Application Support/AcmeDesk/eval"
KNOBS = ["drift", "randomIds", "slow", "popups", "expire", "busy", "random", "wipe", "moveWindow"]


def post(name, obj):
    script = (
        'ObjC.import("Foundation");'
        "function run(argv){$.NSDistributedNotificationCenter.defaultCenter"
        ".postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}"
    )
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, name, obj], capture_output=True)


def hook(command):
    post(f"{DOMAIN}.dev.browser", command)


def load_state():
    for _ in range(10):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": [], "skills": []}


def runs_since(before):
    return [r for r in load_state().get("runs", []) if r.get("id") not in before]


# MARK: - The fixture

def submissions():
    try:
        return json.loads((ACME / "submissions.json").read_text())
    except Exception:
        return []


def quit_fixture():
    subprocess.run(["pkill", "-x", "AcmeDesk"], capture_output=True)
    for _ in range(20):
        if subprocess.run(["pgrep", "-xq", "AcmeDesk"]).returncode != 0:
            return
        time.sleep(0.1)


def launch_fixture(scenario, offscreen=True):
    """A fresh AcmeDesk for each scenario and mode: signed out, its hard modes set, nothing filed."""
    quit_fixture()
    ACME.mkdir(parents=True, exist_ok=True)
    knobs = {k: False for k in KNOBS} | scenario.get("site", {}) | {"offscreen": offscreen}
    (ACME / "config.json").write_text(json.dumps(knobs))
    (ACME / "submissions.json").write_text("[]")
    log = ACME / "events.log"
    if log.exists():
        log.unlink()
    subprocess.run(["open", "-g", "-n", "--env", f"ACMEDESK_HOME={ACME}", str(FIXTURE_APP)], check=True)
    for _ in range(50):
        time.sleep(0.1)
        if log.exists() and "launched" in log.read_text():
            return
    sys.exit("the fixture app didn't start")


# MARK: - Runs

GATE = {"answer": "carry"}


def wait_run(before, match, timeout):
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.0)
        # Smart replay's "check before submitting" card, answered the way this scenario's person would.
        hook("gate " + GATE["answer"])
        found = [r for r in runs_since(before) if match(r)]
        if found:
            run = found[-1]
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


def goal_for(item):
    deductions = ", ".join(f"{d['section']} ₹{d['amount']}" for d in item["deductions"]) or "none"
    gains = f"capital gains ₹{item['gains']} (tick the capital gains box)" if item["gains"] else "no capital gains"
    return (f"In the AcmeDesk app, sign in with username eval and password eval, and file a return for {item['name']}: "
            f"PAN {item['pan']}, income {item['income']}, {item['regime']} regime, {gains}, deductions: {deductions}. "
            f"Submit it and tell me the reference number.")


def check(item, filed):
    mine = [s for s in filed if s.get("pan") == item["pan"] or s.get("name") == item["name"]]
    if not mine:
        return False, f"nothing filed for {item['name']} (filed: {[s.get('name') for s in filed] or 'nothing'})"
    got = mine[-1]
    wrong = []
    for key in ["name", "pan", "income", "regime", "gains"]:
        same = str(got.get(key, "")).lower() == str(item[key]).lower() if key in ("name", "regime") else str(got.get(key, "")) == str(item[key])
        if not same:
            wrong.append(f"{key} {got.get(key)!r}≠{item[key]!r}")
    want = sorted((d["section"], d["amount"]) for d in item["deductions"])
    have = sorted((d.get("section"), d.get("amount")) for d in got.get("deductions", []))
    if want != have:
        wrong.append(f"deductions {have}≠{want}")
    return (not wrong), ("ok · " + got.get("ref", "")) if not wrong else "; ".join(wrong)


def given(item):
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


def find_skill(name):
    return next((s for s in load_state().get("skills", []) if s.get("name") == name and not s.get("deletedAt")), None)


def ensure_skills(spec, reimport):
    for name, file in ((spec["skill"], "acmedesk.okiskill"), (spec["smartSkill"], "acmedesk-smart.okiskill")):
        if reimport and find_skill(name):
            hook(f"forget {name}")
            time.sleep(0.6)
        if not find_skill(name):
            hook(f"importskill {ROOT / 'scripts/cu-fixture' / file}")
            for _ in range(60):
                time.sleep(0.5)
                if find_skill(name):
                    break
            else:
                sys.exit(f"couldn't add the skill “{name}” — is okidoki running with OKIDOKI_DEV_HOOKS=1 on this branch?")


def stop_midway(before, after_seconds):
    deadline = time.time() + 60
    while time.time() < deadline:
        found = [r for r in runs_since(before) if r.get("builtin") == "skill"]
        if found and found[-1].get("status") == "running":
            time.sleep(after_seconds)
            filed_before = len(submissions())
            post(f"{DOMAIN}.dev.stop", "")
            time.sleep(6)
            moved = len(submissions()) - filed_before
            return [] if not moved else [f"{moved} filed after the stop"]
        time.sleep(0.3)
    return ["the replay never started"]


def pause_midway(before, after_seconds):
    deadline = time.time() + 60
    while time.time() < deadline:
        found = [r for r in runs_since(before) if r.get("builtin") == "skill"]
        if found and found[-1].get("status") == "running":
            run_id = found[-1]["id"]
            time.sleep(after_seconds)
            hook("pause " + run_id)
            time.sleep(1)
            notes = []
            now = next((r for r in load_state().get("runs", []) if r.get("id") == run_id), {})
            if now.get("status") != "paused":
                notes.append(f"pause didn't pause (status {now.get('status')})")
            filed = len(submissions())
            log = (ACME / "events.log").read_text() if (ACME / "events.log").exists() else ""
            time.sleep(5)
            moved = len(submissions()) - filed
            later = (ACME / "events.log").read_text() if (ACME / "events.log").exists() else ""
            hook("pause " + run_id)  # the same button again: take it back
            time.sleep(1)
            now = next((r for r in load_state().get("runs", []) if r.get("id") == run_id), {})
            if now.get("status") not in ("running", "done"):
                notes.append(f"play didn't resume (status {now.get('status')})")
            if moved:
                notes.append(f"{moved} filed while it was paused")
            acted = [line for line in later[len(log):].splitlines() if "popup" not in line and "config" not in line]
            if acted:
                notes.append(f"the app changed while paused: {acted[:3]}")
            return notes
        time.sleep(0.3)
    return ["the run never started"]


def run_once(spec, people, scenario, mode, timeout, live):
    items = [people[name] | {"ref": name} for name in scenario["items"]]
    GATE["answer"] = scenario.get("gate", "carry")
    before = {r["id"] for r in load_state().get("runs", [])}
    started = time.time()
    runs, notes = [], []
    if mode == "agent":
        for item in items:
            goal = goal_for(item)
            post(f"{DOMAIN}.dev.drive", goal)
            run, error = wait_run(before, lambda r, g=goal: r.get("prompt") == g, timeout)
            runs.append(run)
            if error:
                notes.append(error)
            before |= {r["id"] for r in load_state().get("runs", [])}
    else:
        hook("hybrid on" if mode == "hybrid" else "hybrid off")
        time.sleep(0.4)
        if mode == "hybrid":
            values = [given(item) for item in items]
        else:
            values = [{k: v for k, v in given(item).items() if k != "deductions"} for item in items]
        skill = spec["smartSkill"] if mode == "hybrid" else spec["skill"]
        hook("replayjson " + json.dumps({"skill": skill, "values": values}))
        if scenario.get("stopAfter"):
            notes.extend(stop_midway(before, scenario["stopAfter"]))
        if scenario.get("pauseAfter"):
            notes.extend(pause_midway(before, scenario["pauseAfter"]))
        run, error = wait_run(before, lambda r: r.get("builtin") == "skill", timeout * len(items))
        runs.append(run)
        if error:
            notes.append(error)
    wall = round(time.time() - started, 1)
    filed = submissions()
    results = []
    for item in items:
        ok, detail = check(item, filed)
        if item["ref"] in scenario.get("expectNotFiled", []):
            said = " ".join((r or {}).get("summary") or "" for r in runs)
            ok, detail = (not ok and item["ref"] in said), ("not filed, as it shouldn't be" if not ok else "filed although it shouldn't have been")
            if not ok and "not filed" in detail:
                detail += f" — but the run didn't say why (summary: {said[:160]!r})"
        results.append((item["ref"], ok, detail))
    empty = [s.get("ref") for s in filed if not s.get("name") and not s.get("pan")]
    if empty:
        notes.append(f"filed {len(empty)} empty return(s): {empty}")
    pans = [s.get("pan") for s in filed]
    twice = sorted({p for p in pans if pans.count(p) > 1})
    if twice:
        notes.append(f"filed twice: {twice}")
    if scenario.get("stopAfter"):
        run = runs[-1] if runs else None
        if not run or run.get("status") != "cancelled":
            notes.append(f"the run wasn't cancelled (status {(run or {}).get('status')})")
        results = [(ref, True, detail) if not ok and "nothing filed" in detail else (ref, ok, detail) for ref, ok, detail in results]
    if live is False and mode == "hybrid":
        pointer = [r for r in runs if r and "ghost" in (r.get("output") or "")]
        if pointer:
            notes.append("the pointer was used although Accessibility-only was on")
    return {
        "scenario": scenario["id"], "mode": mode, "passed": sum(1 for _, ok, _ in results if ok), "total": len(items),
        "seconds": wall, "runSeconds": [seconds(r) for r in runs if r],
        "modelCalls": sum((r or {}).get("modelCalls") or 0 for r in runs),
        "pauses": sum((r or {}).get("output", "").count("paused before") for r in runs),
        "items": [{"item": ref, "ok": ok, "detail": detail} for ref, ok, detail in results],
        "runs": [{"id": r.get("id"), "status": r.get("status"), "summary": r.get("summary"), "log": (r.get("output") or "")[-2500:]} for r in runs if r],
        "notes": notes,
    }


def table(rows, baseline=None):
    base = {(r["scenario"], r["mode"]): r for r in (baseline or {}).get("results", [])}
    print(f"\n{'scenario':<14} {'mode':<8} {'pass':>6} {'secs':>7} {'calls':>6} {'2nd':>5}   vs baseline")
    for r in rows:
        if r.get("skipped"):
            print(f"{r['scenario']:<14} {r['mode']:<8}   skipped: {r['skipped']}")
            continue
        b = base.get((r["scenario"], r["mode"]))
        delta = ""
        if b and not b.get("skipped"):
            delta = f"pass {b['passed']}/{b['total']} → {r['passed']}/{r['total']} · {b['seconds']}s → {r['seconds']}s · calls {b['modelCalls']} → {r['modelCalls']}"
        again = r.get("again")
        second = f"{again['modelCalls']}" if again else "-"
        print(f"{r['scenario']:<14} {r['mode']:<8} {r['passed']:>3}/{r['total']:<2} {r['seconds']:>7} {r['modelCalls']:>6} {second:>5}   {delta}")
        for note in r.get("notes", []):
            print(f"{'':<23}! {note}")
        for it in r["items"]:
            if not it["ok"]:
                print(f"{'':<23}✗ {it['item']}: {it['detail']}")
        if again:
            for note in again.get("notes", []):
                print(f"{'':<23}! (2nd) {note}")
            for it in again["items"]:
                if not it["ok"]:
                    print(f"{'':<23}✗ (2nd) {it['item']}: {it['detail']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--modes", default="hybrid")
    parser.add_argument("--only", default="")
    parser.add_argument("--label", default=time.strftime("run-%Y%m%d-%H%M%S"))
    parser.add_argument("--save-baseline", action="store_true")
    parser.add_argument("--compare", default="")
    parser.add_argument("--reimport", action="store_true")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--live-desktop", action="store_true",
                        help="let agent and classic modes take over the real mouse and keyboard (private Mac only)")
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    if not FIXTURE_APP.exists():
        subprocess.run([str(ROOT / "scripts/cu-fixture/build.sh")], check=True)
    spec = json.loads((ROOT / "scripts/cu-replay-scenarios.json").read_text())
    people = json.loads((ROOT / "scripts/replay-scenarios.json").read_text())["items"]
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    ensure_skills(spec, args.reimport)
    # Without the person's go-ahead, smart replay acts through Accessibility only.
    hook("macax off" if args.live_desktop else "macax on")
    rows = []
    try:
        for scenario in spec["scenarios"]:
            if wanted and scenario["id"] not in wanted:
                continue
            for mode in modes:
                if scenario.get("modes") and mode not in scenario["modes"]:
                    continue
                if mode in ("agent", "classic") and not args.live_desktop:
                    rows.append({"scenario": scenario["id"], "mode": mode,
                                 "skipped": "takes over the real mouse and keyboard; run with --live-desktop on the private Mac"})
                    continue
                print(f"· {scenario['id']} · {mode} …", flush=True)
                launch_fixture(scenario, offscreen=not args.live_desktop)
                row = run_once(spec, people, scenario, mode, args.timeout, args.live_desktop)
                if scenario.get("twice"):
                    # The same again on a fresh app: what the first run learned should make this one quiet.
                    time.sleep(1.5)
                    launch_fixture(scenario, offscreen=not args.live_desktop)
                    row["again"] = run_once(spec, people, scenario, mode, args.timeout, args.live_desktop)
                rows.append(row)
    finally:
        hook("hybrid off")
        hook("macax off")
        quit_fixture()
    out = ROOT / "build/cu-replay"
    out.mkdir(parents=True, exist_ok=True)
    report = {"label": args.label, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "liveDesktop": args.live_desktop, "results": rows}
    (out / f"{args.label}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    if args.save_baseline:
        (out / "baseline.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    baseline = json.loads(Path(args.compare).read_text()) if args.compare else None
    table(rows, baseline)
    print(f"\nreport: {out / (args.label + '.json')}")
    shutil.rmtree(ACME, ignore_errors=True)


if __name__ == "__main__":
    main()
