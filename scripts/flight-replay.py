#!/usr/bin/env python3
"""Record a flight booking once, then replay it for other cities — fast, and with the model only
where it is needed.

This is the property okidoki is supposed to have, measured rather than asserted:

  * the *recording* is a person's real clicks and typing in okidoki's own browser (dev hooks drive
    the same page script a person's clicks hit, through `trustScripted`, so nothing is fabricated);
  * the *replay* is deterministic: every step is found by the selectors recorded with it, so it does
    not call the model at all, and it is fast;
  * with the site *drifted* (renamed buttons and ids — the same flow, new markup) the saved selectors
    stop matching. A deterministic replay fails there. Smart replay is allowed to ask the model for
    the one step it cannot find, and must still finish — and must record the fix so the *next* replay
    of the drifted site needs no model again.

  scripts/flight-replay.py                       # record once, then replay the same site
  scripts/flight-replay.py --drift               # …then replay the drifted site (model helps once)
  scripts/flight-replay.py --drift --freeze      # …and prove the fix stuck: no model the second time

Needs okidoki running with OKIDOKI_DEV_HOOKS=1 (scripts/launch-app.sh), and an Anthropic key for the
recording's rescue model (a plain deterministic replay needs none).
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
SUPPORT = Path(os.environ.get("OKIDOKI_SUPPORT_DIR") or Path.home() / "Library/Application Support/Okidoki")
STATE = SUPPORT / "state.json"
DOMAIN = os.environ.get("OKIDOKI_BUNDLE_ID") or "dev.okidoki.mac"
PORT = int(os.environ.get("FLIGHT_FIXTURE_PORT") or 8788)
SITE = f"http://127.0.0.1:{PORT}/search.html"
TERMINAL = {"done", "failed", "cancelled"}

# Two trips through the same flow. The first is recorded; the second is replayed. The recording types
# placeholders ({{from}}, {{to}}, …) the way the README teaches, so one skill flies any route.
TRIPS = {
    "record": {"from": "{{from}}", "to": "{{to}}", "date": "{{date}}",
               "passenger": "{{passenger}}", "email": "{{email}}"},
    "replay": {"from": "San Jose", "to": "Lisbon", "date": "2026-12-18",
               "passenger": "Bharat Mehta", "email": "bharat@example.com"},
}
SKILL = "kestrel air booking"


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


def fixture_host(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data,
                                     method="POST" if body is not None else "GET",
                                     headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def start_fixture():
    try:
        fixture_host("/bookings")
        return None
    except Exception:
        process = subprocess.Popen([sys.executable, str(ROOT / "scripts/flight-fixture/server.py"), "--port", str(PORT)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(30):
            time.sleep(0.2)
            try:
                fixture_host("/bookings")
                return process
            except Exception:
                continue
        sys.exit("the flight fixture didn't start")


def configure(drift=False, slow=False):
    fixture_host("/config", {"drift": drift, "slow": slow, "seats": False})


def wait_ready(timeout=6.0):
    """The fixture's form is built by `ready()`; on a slow site it isn't there the moment the page loads."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        browser("tabs")
        time.sleep(0.25)
        try:
            tabs = json.loads((SUPPORT / "dev-browser.json").read_text()).get("result", [])
        except Exception:
            tabs = []
        front = next((tab for tab in tabs if tab.get("active")), {})
        if front.get("url", "").startswith(f"http://127.0.0.1:{PORT}"):
            return True
        time.sleep(0.2)
    return False


def page(js, timeout=10):
    """Runs `js` in the tab in front and returns what it answered, by way of the dev hook's file."""
    try:
        (SUPPORT / "dev-browser.json").unlink()
    except FileNotFoundError:
        pass
    browser("eval " + js)
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.15)
        try:
            return json.loads((SUPPORT / "dev-browser.json").read_text()).get("result")
        except Exception:
            continue
    return None


def record(trip, timeout=120):
    """Books the trip once, through okidoki's browser, and keeps what it did as a skill.

    The typing and clicking go through the page's own recorder exactly as a person's would: the dev
    hooks set `trustScripted`, which only okidoki's content world can reach, so a page can never do it.
    """
    configure(drift=False)
    fixture_host("/reset", {})
    browser(f"open {SITE}")
    time.sleep(1.2)
    browser("record")
    time.sleep(0.6)
    page("window.__okidoki.trustScripted(true)")

    steps = [
        ("#from", trip["from"]),
        ("#to", trip["to"]),
        ("#date", trip["date"]),
    ]
    for selector, value in steps:
        page(f"""(() => {{
          const el = document.querySelector('{selector}');
          if (!el) return 'missing {selector}';
          el.focus();
          el.value = {json.dumps(value)};
          el.dispatchEvent(new Event('input', {{bubbles: true}}));
          el.dispatchEvent(new Event('change', {{bubbles: true}}));
          el.blur();
          return 'ok';
        }})()""")
        time.sleep(0.35)
    # The person presses the site's own search button.
    page("""(() => {
      const button = document.querySelector('#f button[type=submit]');
      if (!button) return 'missing search button';
      button.click();
      return 'ok';
    })()""")
    time.sleep(1.4)
    # Results: choose the Flex fare (the middle one).
    page("""(() => {
      const button = document.querySelector('[data-fare="Flex"]');
      if (!button) return 'missing Flex fare';
      button.click();
      return 'ok';
    })()""")
    time.sleep(1.2)
    # Seats: take 1A, then continue.
    page("""(() => {
      const seat = document.querySelector('[data-seat="1A"]');
      if (!seat) return 'missing seat 1A';
      seat.click();
      return 'ok';
    })()""")
    time.sleep(0.5)
    page("""(() => {
      const next = document.querySelector('#next');
      if (!next) return 'missing continue';
      next.click();
      return 'ok';
    })()""")
    time.sleep(1.2)
    # Payment: the passenger, then pay.
    for selector, value in [("#name", trip["passenger"]), ("#email", trip["email"])]:
        page(f"""(() => {{
          const el = document.querySelector('{selector}');
          if (!el) return 'missing {selector}';
          el.focus();
          el.value = {json.dumps(value)};
          el.dispatchEvent(new Event('input', {{bubbles: true}}));
          el.blur();
          return 'ok';
        }})()""")
        time.sleep(0.35)
    page("""(() => {
      const button = document.querySelector('#f button[type=submit]');
      if (!button) return 'missing pay button';
      button.click();
      return 'ok';
    })()""")
    time.sleep(2.5)

    browser(f"save {SKILL}")
    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(0.5)
        if find_skill(SKILL):
            return True
    return False


def find_skill(name):
    return next((s for s in load_state().get("skills", []) if s.get("name") == name and not s.get("deletedAt")), None)


def replay(skill_name, trip, timeout=180):
    """Runs the saved skill once with this trip's values, and reports what actually happened."""
    fixture_host("/reset", {})
    before = {r["id"] for r in load_state().get("runs", [])}
    values = [{
        "ref": trip.get("passenger", "trip"),
        "from": trip["from"], "to": trip["to"], "date": trip["date"],
        "passenger": trip["passenger"], "email": trip["email"],
        # The recorded typing carries the first trip's literal text; the values above only replace it
        # when the skill has placeholders. A plain recording has none, which is what "replay exactly as
        # recorded" means — so a replayed trip must be *re-taught* the values (see `--values` below).
    }]
    started = time.time()
    browser("replayjson " + json.dumps({"skill": skill_name, "values": values}))
    deadline = time.time() + timeout
    run = None
    while time.time() < deadline:
        time.sleep(0.5)
        runs = [r for r in load_state().get("runs", []) if r["id"] not in before and r.get("builtin") == "skill"]
        if runs:
            run = runs[-1]
            if run.get("status") in TERMINAL or run.get("status") == "asked":
                break
    elapsed = round(time.time() - started, 1)
    bookings = fixture_host("/bookings")["bookings"]
    return run, elapsed, bookings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--drift", action="store_true", help="also replay the site after a redesign")
    parser.add_argument("--freeze", action="store_true", help="replay the drifted site twice: the second must need no model")
    parser.add_argument("--relearn", action="store_true")
    parser.add_argument("--only-record", action="store_true")
    args = parser.parse_args()

    if subprocess.run(["pgrep", "-xq", os.environ.get("OKIDOKI_EXEC") or "Okidoki"]).returncode != 0:
        sys.exit("okidoki isn't running — OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh")

    process = start_fixture()
    try:
        if args.relearn and find_skill(SKILL):
            browser(f"forget {SKILL}")
            time.sleep(1)
        if not find_skill(SKILL):
            print("· recording a booking …", flush=True)
            if not record(TRIPS["record"]):
                sys.exit("the recording never produced a skill")
            learned = fixture_host("/bookings")["bookings"]
            print(f"  recorded “{SKILL}”, the site booked {len(learned)}: {[b.get('ref') for b in learned]}")
        else:
            print(f"· using the saved “{SKILL}”")
        if args.only_record:
            return

        print("\n· replay · same site · a different trip", flush=True)
        run, elapsed, bookings = replay(SKILL, TRIPS["replay"])
        print(f"  {status(run)} in {elapsed}s, {calls(run)} model call(s)")
        print(f"  the site booked: {describe(bookings)}")

        if args.drift:
            print("\n· replay · the site renamed its buttons and ids (drift)", flush=True)
            configure(drift=True)
            run, elapsed, bookings = replay(SKILL, TRIPS["replay"])
            print(f"  {status(run)} in {elapsed}s, {calls(run)} model call(s)")
            print(f"  the site booked: {describe(bookings)}")
            if args.freeze:
                print("\n· replay again · the fix should have stuck (no model)", flush=True)
                run, elapsed, bookings = replay(SKILL, TRIPS["replay"])
                print(f"  {status(run)} in {elapsed}s, {calls(run)} model call(s)")
                print(f"  the site booked: {describe(bookings)}")
                if calls(run) > 0:
                    print("  ✗ the second drifted replay still needed the model: the lesson didn't stick")
                    return 1
                print("  ✓ deterministic again after one rescue")
    finally:
        configure()
        if process:
            process.terminate()
    return 0


def status(run):
    if not run:
        return "never ran"
    return f"{run.get('status')}: {run.get('summary') or ''}".strip()


def calls(run):
    return (run or {}).get("modelCalls") or 0


def describe(bookings):
    if not bookings:
        return "nothing"
    return "; ".join(f"{b.get('from')}→{b.get('to')} {b.get('fare')} ${b.get('price')} {b.get('passenger')} {b.get('ref')}" for b in bookings)


if __name__ == "__main__":
    sys.exit(main())
