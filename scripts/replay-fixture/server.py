#!/usr/bin/env python3
"""A small filing site for scripts/replay-eval.py: login, a form with a masked field and an optional
section, an add-row table, a review page and a submit that returns a reference number.

Every submission is kept, so the eval checks what was actually filed, not what a run claimed.
`drift` changes labels, ids and order and adds a survey popup: the same flow, a different page.
Hard mode (randomIds, slow, popups, expire, busy) is described in site/app.js.

  scripts/replay-fixture/server.py --port 8777            # serve
  curl -XPOST localhost:8777/config -d '{"drift": true}'  # change the site while it runs
  curl localhost:8777/submissions | curl -XPOST localhost:8777/reset
"""
import argparse
import json
import random
import string
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "site"
CONFIG = {"drift": False, "banner": False, "randomIds": False, "slow": False, "popups": False, "expire": False, "busy": False, "random": False, "wipe": False, "captcha": False}
BUSY_SEEN = set()
SUBMISSIONS = []


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def send_json(self, obj, status=200, content_type="application/json"):
        body = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        if self.path.startswith("/config.js"):
            return self.send_json(f"window.FIXTURE = {json.dumps(CONFIG)};", content_type="text/javascript")
        if self.path.startswith("/submissions"):
            return self.send_json({"submissions": SUBMISSIONS})
        if self.path in ("/", ""):
            self.path = "/login.html"
        return super().do_GET()

    def do_POST(self):
        if self.path == "/submit":
            data = self.body()
            if CONFIG.get("slow"):
                time.sleep(2.5)
            # Busy: the first try for each return fails; trying again works.
            if CONFIG.get("busy") and data.get("pan") not in BUSY_SEEN:
                BUSY_SEEN.add(data.get("pan"))
                return self.send_json({"error": "The service is busy right now. Please try again."}, 503)
            ref = "REF-" + "".join(random.choices(string.digits, k=6))
            SUBMISSIONS.append({**data, "ref": ref})
            return self.send_json({"ref": ref})
        if self.path == "/config":
            CONFIG.update(self.body())
            return self.send_json(CONFIG)
        if self.path == "/reset":
            SUBMISSIONS.clear()
            BUSY_SEEN.clear()
            return self.send_json({"ok": True})
        return self.send_json({"error": "no such route"}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--drift", action="store_true")
    args = parser.parse_args()
    CONFIG["drift"] = args.drift
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
