# okidoki

**Show your Mac a task once. It does it forever.**

okidoki lives in your notch. Shake your pointer, and it's there:

- **Replay** — say "watch me", do the task once, and okidoki records every click, keystroke and scroll. Replay it any time, with different values (`{{amount}}`, `{{name}}`), on a schedule, or from another agent. It re-finds each control by its accessibility label, then by sight if the window moved, and asks a model only for the one step that broke.
- **Act** — ask for a result ("export this as PDF", "send mom a message on WhatsApp") and it drives the Mac itself, narrating as it goes. Esc takes control back instantly.
- **Browser** — web tasks run in okidoki's own browser, which reads the page directly instead of guessing from pixels.
- **Chat** — ask anything; it knows what's on screen and your memory.
- **Memory, Vault** — all local. The vault is just a folder on your Desktop.

Everything lives on your Mac. Bring your own Anthropic key; nothing ships with the app.

## Install

Requires macOS 14+, the Xcode command line tools and [Bun](https://bun.sh). The private Mac (a VM to run tasks in) needs Apple silicon.

```bash
git clone https://github.com/<you>/okidoki-personal && cd okidoki-personal
make run        # builds, installs "/Applications/Okidoki Personal.app", starts it
```

Onboarding asks for Accessibility and Screen Recording (needed to see and drive the screen) and your
[Anthropic key](https://console.anthropic.com/settings/keys). Optional keys — Cartesia (voices), Moss
(semantic recall), Apify (web data) — go in **Settings › Keys**. Keys live in
`~/Library/Application Support/Okidoki Personal/keys.json`, readable only by you.

## Your first skill (2 minutes)

1. Shake your pointer and type **watch me do the weather check**.
2. Open Safari, search for the weather, and press **Save** in the notch.
3. Shake again: **replay the weather check**. Or **replay the weather check 3 times**.
4. Type a placeholder while recording (`{{city}}`), then: **replay the weather check with city=Lisbon**.

Skills are files you can share: the share icon on a skill saves a `.okiskill`
([format](docs/skill-format.md)), and **Import** on the Replay page adds one.

## Use it from Claude Code, Cursor and other agents

Other agents (Claude Code, Codex, anything that reads skills) hand okidoki work through the **okidoki skill** and the `okidoki` command it teaches them. `make install` puts both in place, or open the app → Settings › Agents:
- web tasks in its browser, with your logins
- tasks in your Mac's apps
- replays of your skills, for many items at once

They can also wait for the result, pause or take back a run, answer its questions, save a finished run as a skill, drive tabs of their own, and read your memory and vault:

```bash
okidoki do "find the cheapest direct flight SFO→JFK next Friday" --wait 300
okidoki replay "file a return" --item name=Asha pan=ABCDE1234F --item name=Ravi pan=PQRSX6789K
```

Anything risky still waits for your okay in the notch, and captchas are always yours. See [docs/agents.md](docs/agents.md).

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
| Mac app | `Sources/` (Swift, SwiftUI, AppKit) | notch, overlays, recorder and replayer, computer use, browser, local store |
| Brain | `brain/` (TypeScript, Bun, local HTTP on 127.0.0.1) | routing, Claude calls, computer use and browser loops, MCP client, memory index |
| Control panel | `web/` (React, Vite) | the dashboard, bundled into the app |
| CLI + agent skill | `mcp/okidoki.ts`, `mcp/skill/SKILL.md` | okidoki for other agents, through the app's local control endpoint |

Data: `~/Library/Application Support/Okidoki Personal/` (state, keys, skill pictures, telemetry).
The vault: `~/Desktop/Okidoki Vault` unless you move it in the Vault page. More in
[docs/architecture.md](docs/architecture.md).

## Develop

```bash
make app                        # build/Okidoki Personal.app
make test                       # Swift tests (some drive real apps; see CONTRIBUTING)
cd brain && bun test tests      # brain
cd web && bun test tests        # control panel
cd web && bun run dev           # the panel in a browser, with demo data
```

`scripts/cu-eval.py` runs computer-use scenarios against the installed app and reports pass rate and
timings; run it before and after any change to driving or replay.

## License

MIT. See [LICENSE](LICENSE).
