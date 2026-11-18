# Changelog

## 0.9.2 — the shared session

One Mac hosts its private Mac; everyone on the same WiFi joins in a browser — no install. A live
screen, a group chat, your skills one tap away, and okidoki acting while everyone watches.
**Collab shares okidoki's Mac, never yours.**

- **The shared session**: a join code and per-person tokens gate the door; a joiner's ask drives the
  shared Mac while the run streams step by step; anything risky waits for the host's okay in the
  notch; the host can kick, reclaim, and end. Anyone can **take the wheel** and drive — one driver at
  a time, everyone watching their cursor — and the wheel and okidoki never drive at once.
- **A mode**, asked in onboarding and settable any time in Settings › Mode: *just you*, or *with
  people*. Personal keeps sharing out of sight entirely; collab adds Shared session to Settings.
  Onboarding also asks where okidoki should work — this Mac, or its own private Mac (a macOS VM).
- **One design language end to end**: the joiner page is the panel's own card and chrome in the app's
  tokens, light or dark with the system. Only the VM screen is dark — it's a screen.
- **One purpose**: sharpened to a single loop — *show it once, it does it forever* — on three stages
  (your Mac · the private Mac · a shared session). The agent-platform surface (connectors, coding
  agents) folded into Advanced; one local identity instead of personal/work accounts.
- **Hardening**: CI compiles the whole app and runs the logic suites; `scripts/golden-path.sh` walks
  the whole loop on an isolated profile with independent checks; `docs/quality.md` sets the release
  bar and how to record eval baselines.
- **One name: okidoki.** The app sheds the "Personal" split — it installs as `/Applications/Okidoki.app`
  (bundle id `dev.okidoki.mac`, data in `~/Library/Application Support/Okidoki`) and adopts an
  existing Personal installation's data by copy on first launch, so nothing is lost and the older
  app keeps working until it's replaced. The CLI, the eval scripts and the docs follow.
- **CI runs again** — every run since the repo's creation had failed at startup on the retired
  `macos-15` runner image; the workflow now tracks `macos-latest`.

Earlier releases predate this changelog.
