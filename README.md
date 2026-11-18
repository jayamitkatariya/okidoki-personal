# okidoki

**Show it once. It does it forever.**

okidoki lives in your Mac's notch. Shake your pointer and it's there. Show it a task once — it records
every click, keystroke and scroll — and it replays it forever: with different values, on a schedule,
from another agent, or for everyone in the room. It re-finds each control by its accessibility label,
then by sight if the window moved, and asks a model only for the one step that broke.

That loop runs on three stages:

- **Your Mac** — ask for a result ("export this as PDF", "send mom a message") and okidoki drives the
  Mac itself, narrating as it goes. Esc takes control back instantly. Or say "watch me", do the task
  once, and replay it any time.
- **Private Mac** — give okidoki its own macOS, in a window. Runs happen there while you keep your
  screen, cursor and keyboard. Watch it live in the shell. *(Apple silicon.)*
- **Shared session** — one Mac hosts its private Mac; everyone on the same WiFi joins in a browser.
  A live screen, a group chat, and your skills replayed on request. okidoki acts, the host approves,
  and anyone can take the wheel and drive. **Collab shares okidoki's Mac, never yours.**

Everything lives on your Mac. Bring your own Anthropic key; nothing ships with the app. See
[docs/purpose.md](docs/purpose.md) for the one idea every feature answers to.

## Install

Requires macOS 14+, the Xcode command line tools and [Bun](https://bun.sh). The private Mac (and the
shared session) need Apple silicon.

```bash
git clone https://github.com/<you>/okidoki-personal && cd okidoki-personal
make run        # builds, installs "/Applications/Okidoki.app", starts it
```

Onboarding asks how you'll use okidoki — **just you**, or **with people** (shared sessions on your
WiFi) — where it should work (this Mac or its own private Mac), for Accessibility and Screen
Recording (needed to see and drive the screen), and your
[Anthropic key](https://console.anthropic.com/settings/keys). Any of it changes later in Settings.
Optional keys — Cartesia (voices), Moss (semantic recall), Apify (web data) — go in **Settings ›
Keys**. Keys live in
`~/Library/Application Support/Okidoki/keys.json`, readable only by you.
`~/Library/Application Support/Okidoki/keys.json`, readable only by you.

## Your first skill (2 minutes)

The fastest wow needs only a key — no VM, no download:

1. Shake your pointer and type **watch me do the weather check**.
2. Open Safari, search for the weather, and press **Save** in the notch.
3. Shake again: **replay the weather check**. Or **replay the weather check 3 times**.
4. Type a placeholder while recording (`{{city}}`), then: **replay the weather check with city=Lisbon**.

Or skip teaching: open **Replay › Library**, add a ready-made skill, and just ask for it. The first run
learns it; after that it replays in seconds.

Skills are files you can share: the share icon on a skill saves a `.okiskill`
([format](docs/skill-format.md)), and **Import** on the Replay page adds one.

## The private Mac

In **Settings › Private Mac**, give okidoki its own macOS. It downloads the latest macOS restore image
(about 15 GB), installs it once, and boots into Setup Assistant for you to click through. After that,
runs that drive apps happen there by default while you keep working here, and you can watch the screen
live in the shell. Closing its window hides it; the VM keeps running.

## Share it with the room

In **Settings › Shared session**, start a session. okidoki shows a join code and a link; everyone on
your WiFi opens it in a browser — no install — enters a name and the code, and lands in the live
session: the private Mac's screen, a group chat, and your saved skills one tap away. Anyone can ask
okidoki to do something (it drives the shared Mac), or **take the wheel** and drive it themselves while
everyone watches their cursor. Anything risky still waits for your okay in the notch. Ending the
session stops sharing and disconnects everyone. See [docs/collab.md](docs/collab.md).

![A live session: the private Mac's screen, the group chat, skill cards](https://api.replicas.dev/v1/media/public/02be8f45-ff11-4444-897d-0d9df703d1b8/0BuXQfOBnQh6RR-rHAFYPjUn5ELbszdpWmS1baCtnh8)

## Use it from Claude Code, Cursor and other agents

Other agents hand okidoki work through the **okidoki skill** and the `okidoki` command it teaches them.
`make install` puts both in place, or open the app → Settings › Use from agents:

```bash
okidoki do "find the cheapest direct flight SFO→JFK next Friday" --wait 300
okidoki replay "file a return" --item name=Asha pan=ABCDE1234F --item name=Ravi pan=PQRSX6789K
```

They look for a saved skill first, replay it, and hand okidoki the rest — web tasks in its browser with
your logins, tasks in your Mac's apps, replays for many items at once. They can wait for the result,
pause or take back a run, answer its questions, and read your memory and vault. Anything risky still
waits for your okay in the notch, and captchas are always yours. See [docs/agents.md](docs/agents.md).

## The cursor card

| Type | What happens |
|---|---|
| anything | the brain decides: answer, act on the Mac, or work in the browser |
| pick **Act / Browser / Chat** on the chip | forces that mode |
| `watch me …`, `replay …`, `again`, `my skills` | recordings and replays, instant, no key needed |
| `add the W-9 to the vault` | finds the PDF, downloads it into the vault folder |

## How it works

| Part | Where | What |
|---|---|---|
| Mac app | `Sources/` (Swift, SwiftUI, AppKit) | notch, overlays, recorder and replayer, computer use, browser, private Mac, local store |
| Brain | `brain/` (TypeScript, Bun, local HTTP on 127.0.0.1) | routing, Claude calls, computer use and browser loops, MCP client, memory index |
| Control panel | `web/` (React, Vite) | the shell, bundled into the app |
| CLI + agent skill | `mcp/okidoki.ts`, `mcp/skill/SKILL.md` | okidoki for other agents, through the app's local control endpoint |

Data: `~/Library/Application Support/Okidoki/` (state, keys, skill pictures, telemetry).
The vault: `~/Desktop/Okidoki Vault` unless you move it in the Vault page. More in
[docs/architecture.md](docs/architecture.md).

## Develop

```bash
make app                        # build/Okidoki.app
make verify                     # everything that needs no real screen: brain, panel, Swift logic
make test                       # Swift tests (some drive real apps; see CONTRIBUTING)
cd brain && bun test tests      # brain
cd web && bun test tests        # control panel
cd web && bun run dev           # the panel in a browser, with demo data
```

Quality is measured, not asserted. Three harnesses run against the installed app and check results
independently of what the model claimed:

- `scripts/cu-eval.py` — computer-use scenarios (pass rate, timings, model calls).
- `scripts/replay-eval.py` — the full agent vs classic replay vs smart replay, A/B on the same tasks.
- `scripts/agent-eval.py` — learn → save → replay on public practice sites, through the control API.

Run them before and after any change to driving or replay. The release bar, the golden path
(`scripts/golden-path.sh`) and how to record baselines: [docs/quality.md](docs/quality.md).

## License

MIT. See [LICENSE](LICENSE).
