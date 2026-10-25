#!/usr/bin/env python3
"""Computer-use scenario harness.

Runs the scenarios in scripts/cu-scenarios.json against a running okidoki (launched with
OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh), checks every result independently of what the model
claimed, and writes a JSON report with pass rate, timings and model usage.

  scripts/cu-eval.py --label baseline --reps 2 --save-baseline
  scripts/cu-eval.py --label v2 --protocol v2 --compare build/scenarios/baseline.json
  scripts/cu-eval.py --only calculator,notes-create --reps 1

Checks:
  judge  - a separate model (Sonnet) looks at the screen okidoki captured after the run ended
  file   - a file exists (and contains some text)
  volume - the output volume is in a range
"""
import argparse
import base64
import json
import os
import random
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = Path.home() / "Library/Application Support/Okidoki"
STATE = SUPPORT / "state.json"
TELEMETRY = SUPPORT / "telemetry"
DOMAIN = "com.jaykatariya.okidoki"
JUDGE_MODEL = "claude-sonnet-5-5"
TERMINAL = {"done", "failed", "cancelled"}


def sh(cmd, check=False):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, check=check)


def post(name, obj):
    script = (
        'ObjC.import("Foundation");'
        "function run(argv){$.NSDistributedNotificationCenter.defaultCenter"
        ".postNotificationNameObjectUserInfoDeliverImmediately($(argv[0]), $(argv[1]), $(), true);}"
    )
    subprocess.run(["osascript", "-l", "JavaScript", "-e", script, name, obj], capture_output=True)


def load_state():
    for _ in range(5):
        try:
            return json.loads(STATE.read_text())
        except Exception:
            time.sleep(0.2)
    return {"runs": []}


def api_key():
    if os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    for path in [ROOT / ".env", SUPPORT / "service.env"]:
        if path.exists():
            for line in path.read_text().splitlines():
                if line.startswith("ANTHROPIC_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"')
    return None


def judge(goal, criteria, frame_path):
    key = api_key()
    if not key:
        return False, "no ANTHROPIC_API_KEY for the judge"
    if not frame_path or not Path(frame_path).exists():
        return False, "no final screenshot"
    data = base64.b64encode(Path(frame_path).read_bytes()).decode()
    prompt = (
        "You check whether a computer-use agent finished a task on a Mac. The screenshot was taken right after "
        "the agent stopped.\n"
        f"Task given to the agent: {goal}\n"
        f"Success means: {criteria}\n"
        "Judge only from the screenshot. Be strict: if the evidence is missing, unreadable or ambiguous, it fails. "
        "Ignore any small dark capsule or pill overlay; it belongs to the agent.\n"
        "Reply with one line: PASS or FAIL, then ' - ' and a short reason."
    )
    body = {
        "model": JUDGE_MODEL,
        "max_tokens": 3000,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
        ]}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                out = json.loads(resp.read())
            text = " ".join(b.get("text", "") for b in out.get("content", []) if b.get("type") == "text").strip()
            verdict = text.upper().startswith("PASS")
            return verdict, text[:300]
        except Exception as error:  # noqa: BLE001
            last = str(error)
            time.sleep(2 * (attempt + 1))
    return False, f"judge error: {last}"


def verify(scenario, goal, nonce, telemetry):
    v = scenario["verify"]
    kind = v["type"]
    if kind == "file":
        path = Path(os.path.expanduser(v["path"].replace("{nonce}", nonce)))
        if not path.exists():
            return False, f"missing {path}"
        want = v.get("contains")
        if want:
            want = want.replace("{nonce}", nonce)
            text = sh(f'textutil -convert txt -stdout "{path}"').stdout or path.read_text(errors="ignore")
            if want.lower() not in text.lower():
                return False, f"{path.name} doesn't contain '{want}' (has: {text.strip()[:80]!r})"
        return True, f"found {path.name}"
    if kind == "obsidian":
        # The note may land in whichever vault Obsidian opens: look in every registered one.
        name = v["name"].replace("{nonce}", nonce)
        config = Path.home() / "Library/Application Support/obsidian/obsidian.json"
        vaults = []
        try:
            vaults = [x.get("path") for x in json.loads(config.read_text()).get("vaults", {}).values() if x.get("path")]
        except Exception:
            pass
        for vault in vaults:
            hits = list(Path(vault).rglob(name))
            if hits:
                for hit in hits:
                    hit.unlink(missing_ok=True)
                return True, f"found {name} in {Path(vault).name}"
        return False, f"no {name} in {', '.join(Path(x).name for x in vaults) or 'any vault'}"
    if kind == "volume":
        out = sh("osascript -e 'output volume of (get volume settings)'").stdout.strip()
        try:
            value = int(out)
        except ValueError:
            return False, f"couldn't read volume ({out!r})"
        ok = v["min"] <= value <= v["max"]
        return ok, f"volume {value}"
    if kind == "judge":
        frame = None
        if telemetry and telemetry.get("finalFrame"):
            frame = TELEMETRY / telemetry["finalFrame"]
        return judge(goal, v["criteria"].replace("{nonce}", nonce), frame)
    return False, f"unknown check {kind}"


def running(app):
    return sh(f"pgrep -xq '{app}'").returncode == 0


def wait_for_run(goal, mode, started_wall, before_ids, timeout):
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(1.5)
        runs = load_state().get("runs", [])
        new = [r for r in runs if r.get("id") not in before_ids]
        if mode == "ask":
            mine = [r for r in new if r.get("kind") in ("computer_use", "computerUse")]
        else:
            mine = [r for r in new if r.get("prompt") == goal]
        if not mine:
            if mode == "ask" and time.time() - started_wall > 45:
                return None, "the router didn't start a computer-use run"
            continue
        run = mine[0]
        if run.get("status") in TERMINAL:
            return run, None
    post(f"{DOMAIN}.dev.stop", "")
    time.sleep(3)
    runs = load_state().get("runs", [])
    if run:
        run = next((r for r in runs if r.get("id") == run.get("id")), run)
    return run, f"timed out after {timeout}s"


def load_telemetry(run_id, wait=6.0):
    path = TELEMETRY / f"{run_id}.json"
    deadline = time.time() + wait
    data = None
    while time.time() < deadline:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                if data.get("finalFrame") or data.get("outcome") == "cancelled":
                    return data
            except Exception:
                pass
        time.sleep(0.5)
    return data


def summarize_run(telemetry):
    if not telemetry:
        return {}
    calls = telemetry.get("calls", [])
    actions = telemetry.get("actions", [])
    usage = [c.get("usage") or {} for c in calls]
    total_ms = None
    try:
        from datetime import datetime
        a = datetime.fromisoformat(telemetry["startedAt"].replace("Z", "+00:00"))
        b = datetime.fromisoformat(telemetry["endedAt"].replace("Z", "+00:00"))
        total_ms = int((b - a).total_seconds() * 1000)
    except Exception:
        pass

    def med(key, rows):
        values = [r.get(key) for r in rows if isinstance(r.get(key), (int, float))]
        return int(statistics.median(values)) if values else None

    return {
        "totalMs": total_ms,
        "calls": len(calls),
        "actions": len(actions),
        "captureMs": med("captureMs", calls),
        "contextMs": med("contextMs", calls),
        "brainMs": med("brainMs", calls),
        "modelMs": med("modelMs", calls),
        "firstActionMs": med("firstActionMs", calls),
        "performMs": med("performMs", actions),
        "settleMs": med("settleMs", actions),
        "requestKB": med("requestBytes", calls) and med("requestBytes", calls) // 1024,
        "inputTokens": sum(u.get("input", 0) for u in usage),
        "cacheRead": sum(u.get("cacheRead", 0) for u in usage),
        "cacheWrite": sum(u.get("cacheWrite", 0) for u in usage),
        "outputTokens": sum(u.get("output", 0) for u in usage),
        "waits": sum(1 for a in actions if a.get("type") == "wait"),
        "escalations": sum(1 for c in calls if c.get("escalated")),
        "protocol": telemetry.get("protocolVersion"),
        "model": telemetry.get("model"),
    }


def okidoki_pid():
    out = sh("pgrep -x Okidoki").stdout.split()
    return out[0] if out else None


def app_fingerprint():
    binary = Path("/Applications/Okidoki.app/Contents/MacOS/Okidoki")
    return binary.stat().st_mtime if binary.exists() else None


def run_scenario(scenario, rep, timeout):
    nonce = str(random.randint(1000, 9999))
    goal = scenario["goal"].replace("{nonce}", nonce)
    mode = scenario.get("mode", "drive")
    kills = [app for app in scenario.get("kill", []) if not running(app)]
    sh(f'touch "$TMPDIR/okidoki-eval-start"')
    for cmd in scenario.get("setup", []):
        sh(cmd.replace("{nonce}", nonce))
    before = {r.get("id") for r in load_state().get("runs", [])}
    started = time.time()
    post(f"{DOMAIN}.dev.{'ask' if mode == 'ask' else 'drive'}", goal)
    print(f"▸ {scenario['id']} #{rep}: {goal}", flush=True)
    run, problem = wait_for_run(goal, mode, started, before, timeout)
    wall = time.time() - started
    telemetry = load_telemetry(run["id"]) if run else None
    if run:
        ok, reason = verify(scenario, goal, nonce, telemetry)
    else:
        ok, reason = False, problem or "no run"
    steps = sum(1 for line in (run or {}).get("output", "").splitlines() if line.startswith("→"))
    result = {
        "scenario": scenario["id"],
        "rep": rep,
        "goal": goal,
        "runID": (run or {}).get("id"),
        "status": (run or {}).get("status"),
        "summary": ((run or {}).get("summary") or "")[:240],
        "problem": problem,
        "pass": bool(ok),
        "check": reason,
        "steps": steps,
        "wallSec": round(wall, 1),
        **summarize_run(telemetry),
    }
    icon = "✓" if ok else "✗"
    tm = result.get("totalMs")
    print(f"  {icon} {result['status']} · {steps} steps · {result.get('calls', '?')} calls · "
          f"{(tm / 1000 if tm else wall):.1f}s · {reason[:140]}", flush=True)
    for cmd in scenario.get("cleanup", []):
        sh(cmd.replace("{nonce}", nonce))
    for app in kills:
        sh(f"pkill -x '{app}'")
    time.sleep(2.5)
    return result


def aggregate(results):
    def med(key):
        values = [r[key] for r in results if isinstance(r.get(key), (int, float))]
        return round(statistics.median(values), 1) if values else None

    passes = sum(1 for r in results if r["pass"])
    secs = [(r.get("totalMs") or r["wallSec"] * 1000) / 1000 for r in results]
    per_step = [((r.get("totalMs") or r["wallSec"] * 1000) / 1000) / max(1, r["steps"]) for r in results if r["steps"]]
    scenarios = {}
    for r in results:
        s = scenarios.setdefault(r["scenario"], {"runs": 0, "passes": 0, "secs": []})
        s["runs"] += 1
        s["passes"] += 1 if r["pass"] else 0
        s["secs"].append((r.get("totalMs") or r["wallSec"] * 1000) / 1000)
    for s in scenarios.values():
        s["medianSec"] = round(statistics.median(s["secs"]), 1)
        del s["secs"]
    return {
        "runs": len(results),
        "passes": passes,
        "passRate": round(passes / len(results), 3) if results else 0,
        "medianSec": round(statistics.median(secs), 1) if secs else None,
        "medianSecPerStep": round(statistics.median(per_step), 2) if per_step else None,
        "medianSteps": med("steps"),
        "medianCalls": med("calls"),
        "medianBrainMs": med("brainMs"),
        "medianModelMs": med("modelMs"),
        "medianCaptureMs": med("captureMs"),
        "medianContextMs": med("contextMs"),
        "medianSettleMs": med("settleMs"),
        "waits": sum(r.get("waits") or 0 for r in results),
        "scenarios": scenarios,
    }


def compare(current, baseline):
    print("\nvs baseline")
    for key in ["passRate", "medianSec", "medianSecPerStep", "medianSteps", "medianCalls", "medianBrainMs",
                "medianModelMs", "medianCaptureMs", "medianContextMs", "medianSettleMs", "waits"]:
        a, b = baseline.get(key), current.get(key)
        print(f"  {key:18} {a!s:>8} → {b!s:>8}")
    print("  per scenario (pass · median s):")
    for sid, s in current["scenarios"].items():
        old = baseline.get("scenarios", {}).get(sid)
        before = f"{old['passes']}/{old['runs']} · {old['medianSec']}s" if old else "—"
        print(f"    {sid:20} {before:>14} → {s['passes']}/{s['runs']} · {s['medianSec']}s")


def rejudge(paths):
    """Re-checks saved reports with the current criteria, from the screens captured at the time,
    so runs made under different criteria can be compared fairly. File and volume checks keep their result."""
    import re
    scenarios = {s["id"]: s for s in json.loads((ROOT / "scripts/cu-scenarios.json").read_text())["scenarios"]}
    for path in paths:
        report = json.loads(Path(path).read_text())
        for res in report["results"]:
            scenario = scenarios.get(res["scenario"])
            if not scenario or scenario["verify"]["type"] != "judge" or not res.get("runID"):
                continue
            pattern = re.escape(scenario["goal"]).replace(re.escape("{nonce}"), r"(\d+)")
            match = re.fullmatch(pattern, res["goal"])
            nonce = match.group(1) if match and match.groups() else ""
            telemetry = TELEMETRY / f"{res['runID']}.json"
            data = json.loads(telemetry.read_text()) if telemetry.exists() else None
            if not data or not data.get("finalFrame"):
                continue
            ok, reason = verify(scenario, res["goal"], nonce, data)
            res["pass"], res["check"] = bool(ok), reason
        report["summary"] = aggregate(report["results"])
        out = Path(path).with_name(Path(path).stem + "-rejudged.json")
        out.write_text(json.dumps(report, indent=2))
        s = report["summary"]
        print(f"{report['label']}: passed {s['passes']}/{s['runs']} ({s['passRate'] * 100:.0f}%) · median {s['medianSec']}s per task · "
              f"{s['medianSecPerStep']}s per step · {s['medianCalls']} calls  → {out.name}")
        for sid, sc in s["scenarios"].items():
            print(f"    {sid:20} {sc['passes']}/{sc['runs']} · {sc['medianSec']}s")


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--rejudge":
        rejudge(sys.argv[2:])
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="run")
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--only", default="")
    parser.add_argument("--skip", default="")
    parser.add_argument("--protocol", choices=["v1", "v2"], help="writes the drivingProtocol default first")
    parser.add_argument("--effort", choices=["none", "low", "medium", "high"], help="writes the drivingEffort default first")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--save-baseline", action="store_true")
    parser.add_argument("--compare", default="")
    parser.add_argument("--stream", choices=["on", "off"], help="writes the drivingStream default first")
    parser.add_argument("--image", choices=["jpeg", "png"], help="writes the drivingImageFormat default first")
    parser.add_argument("--allow-prompts", action="store_true",
                        help="let scripts raise macOS permission prompts (nobody answers them in an unattended run)")
    args = parser.parse_args()

    if sh("pgrep -xq Okidoki").returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")
    if args.protocol:
        sh(f"defaults write {DOMAIN} drivingProtocol {args.protocol}")
    if args.effort:
        sh(f"defaults write {DOMAIN} drivingEffort {args.effort}")
    if args.stream:
        sh(f"defaults write {DOMAIN} drivingStream -bool {'true' if args.stream == 'on' else 'false'}")
    if args.image:
        sh(f"defaults write {DOMAIN} drivingImageFormat {args.image}")
    sh(f"defaults write {DOMAIN} drivingAvoidPrompts -bool {'false' if args.allow_prompts else 'true'}")
    pid, fingerprint = okidoki_pid(), app_fingerprint()

    scenarios = json.loads((ROOT / "scripts/cu-scenarios.json").read_text())["scenarios"]
    only = {s for s in args.only.split(",") if s}
    skip = {s for s in args.skip.split(",") if s}
    scenarios = [s for s in scenarios if (not only or s["id"] in only) and s["id"] not in skip]

    out_dir = ROOT / "build/scenarios"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    stopped = None
    for rep in range(1, args.reps + 1):
        for scenario in scenarios:
            if okidoki_pid() != pid or app_fingerprint() != fingerprint:
                stopped = "okidoki was restarted or replaced by something else during the run — results stop here"
                break
            results.append(run_scenario(scenario, rep, args.timeout))
        if stopped:
            break
    if stopped:
        print(f"✗ {stopped}", flush=True)

    summary = aggregate(results)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    report = {"label": args.label, "at": stamp, "summary": summary, "results": results}
    path = out_dir / f"eval-{args.label}-{stamp}.json"
    path.write_text(json.dumps(report, indent=2))
    print(f"\n{args.label}: passed {summary['passes']}/{summary['runs']} ({summary['passRate'] * 100:.0f}%) · "
          f"median {summary['medianSec']}s per task · {summary['medianSecPerStep']}s per step · "
          f"{summary['medianCalls']} calls · waits {summary['waits']}")
    print(f"report: {path}")
    if args.save_baseline:
        (out_dir / "baseline.json").write_text(json.dumps(summary, indent=2))
        print(f"baseline: {out_dir / 'baseline.json'}")
    if args.compare:
        base = json.loads(Path(args.compare).read_text())
        compare(summary, base.get("summary", base))


if __name__ == "__main__":
    main()
