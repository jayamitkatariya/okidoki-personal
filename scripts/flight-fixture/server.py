#!/usr/bin/env python3
"""A small flight-booking site for scripts/flight-replay.py.

Search a route, pick a fare, take the seat map's default, pay. Every booking is kept, so the harness
checks what the site actually received rather than what a run claimed.

Two knobs make a second run a *different* trip on the *same* flow:
  drift   — the airline renames its buttons and ids (the same flow, new markup), so the saved
            selectors stop matching and a replay has to find the controls by what they are.
  slow    — every page builds itself 0.7–1.6s after loading, the way a real airline site does.

  scripts/flight-fixture/server.py --port 8788
  curl -XPOST localhost:8788/config -d '{"drift": true}'
  curl localhost:8788/bookings
"""
import argparse
import json
import random
import string
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "site"
CONFIG = {"drift": False, "slow": False, "seats": False}
BOOKINGS = []


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def end_headers(self):
        # Never cached: a knob flipped between runs must change the very next page load.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

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
        if self.path.startswith("/bookings"):
            return self.send_json({"bookings": BOOKINGS})
        if self.path in ("/", ""):
            self.path = "/search.html"
        return super().do_GET()

    def do_POST(self):
        if self.path == "/book":
            data = self.body()
            if CONFIG.get("slow"):
                time.sleep(1.2)
            reference = "BK-" + "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
            BOOKINGS.append({**data, "ref": reference})
            return self.send_json({"ref": reference})
        if self.path == "/config":
            CONFIG.update(self.body())
            return self.send_json({"ok": True})
        if self.path == "/reset":
            BOOKINGS.clear()
            return self.send_json({"ok": True})
        return self.send_json({"error": "no such route"}, 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8788)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"flight fixture on http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
