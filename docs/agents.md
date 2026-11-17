# okidoki for other agents

Claude Code, Codex, Cursor or a plain script can hand okidoki work on this Mac. They can start web tasks in okidoki's browser (it has the person's logins), tasks in the Mac's apps, and replays of saved skills. They can wait for the result, steer a run, and read the person's memory and vault.

okidoki itself must be running. Anything risky still waits for the person's okay in the notch, and captchas and one-time codes are always theirs to pass.

## Install

```sh
make install                     # builds the app, puts `okidoki` in ~/.local/bin and installs the okidoki skill
scripts/install-cli.sh           # the command and the skill, for an app that's already installed
scripts/install-cli.sh --no-skill  # just the command
```

Or open okidoki → Settings › Agents, which does the same from the app.

The **okidoki skill** (`mcp/skill/SKILL.md`) is how agents learn the command: it goes to `~/.claude/skills/okidoki/` (Claude Code), `~/.agents/skills/okidoki/` (agents that read the shared folder) and `~/.codex/skills/okidoki/` when Codex is installed. Once it's there, an agent picks it up whenever the person asks for something on a website or in a Mac app. There is no MCP server for okidoki: the skill and the command are the one way in.

## The command

```sh
okidoki do "find a 2-bedroom in Lisbon under €1500 on idealista"    # okidoki picks: a skill if one fits, else the agent
okidoki browse "what's the status of my last Amazon order" --wait 300
okidoki computer "make a new note in Notes called Groceries with milk and eggs"
okidoki chat "what did I say my passport number's expiry was?"

okidoki skills                                   # saved skills, with the inputs each needs
okidoki replay "file a return" --item name=Asha pan=ABCDE1234F --item name=Ravi pan=PQRSX6789K
okidoki replay "invoice a client" --items clients.json --wait 600

okidoki status · okidoki runs · okidoki run <id> --log · okidoki wait <id>
okidoki pause <id> · okidoki resume <id> · okidoki stop <id> · okidoki reply <id> "the blue one"

okidoki open https://news.ycombinator.com        # a tab of your own → its number
okidoki page                                     # text + numbered elements
okidoki click 12 · okidoki type "#q" "rust ownership" --submit · okidoki screenshot -o page.png

okidoki memory · okidoki remember "prefers aisle seats" · okidoki vault "W-2 2025"
```

Add `--json` to any command for the raw answer.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | done |
| `1` | failed or stopped |
| `2` | needs the person; the output says what for |
| `3` | still running when `--wait` ran out; follow it with `okidoki wait <id>` |
| `4` | the command itself failed, e.g. okidoki isn't running |

## Writing an agent against it

- **Say what you want, not how.** `okidoki do` routes the request:
  - If a saved skill fits, it replays in seconds and adapts to the new data. Values the request doesn't give come from the item's vault documents.
  - Otherwise okidoki's agent does the task, and the run can become a skill.
- **Check `okidoki skills` before repeating anything.** Replaying a skill for 20 items is one call: `--item` per item, or `--items file.json`.
- **When a run has `needs`, tell the person and `okidoki wait <id>`.**
  - **"the person's okay in the notch":** a risky step. They approve it in the notch; you can't.
  - **"the person to get past a captcha":** okidoki has shown them the page. It carries on by itself once they're through.
  - **"an answer":** the run asked a question. Relay it, then `okidoki reply <id> "…"`.
  - **"the person (they paused it)":** they took over. It carries on when they press play, or when you `okidoki resume <id>`.
- **Follow-ups stay in one conversation.** Pass `--thread <id>` from the last result, as in `okidoki do --thread t… "now add the cheapest to the cart"`.
- **Tabs you open are yours.** You can drive them with `click`, `type`, `select`, `press`, `scroll` and `goto`. You can read the page and screenshot of tabs that runs you started are working in. The person's own tabs are off limits. Vault passwords are never typed through this; to sign in somewhere, ask okidoki with `okidoki browse "sign in to … and …"`.

## HTTP

The command sits on a small HTTP endpoint at `127.0.0.1`. Its port and token are in `~/Library/Application Support/Okidoki Personal/control.json`, which only the owner can read. Every request needs `Authorization: Bearer <token>`, and requests that carry an `Origin` header are refused, so web pages can't reach it.

`GET /` lists the routes:

| Route | What it does |
|---|---|
| `GET /status` | what's running, whether a key is set, whether smart replay is on |
| `POST /tasks {text, mode?, thread?, wait?}` | a task in plain words; `mode` is `auto`, `browser`, `computer` or `chat` |
| `GET /runs?limit=` | recent runs |
| `GET /runs/<id>?log=1` | one run: status, result, what it's waiting for |
| `GET /runs/<id>/wait?timeout=` | waits until it's done, or needs the person |
| `POST /runs/<id>/stop`, `/pause`, `/resume`, `/takeback` | steer a run |
| `POST /runs/<id>/reply {text}` | answer the question a run asked |
| `GET /skills` | saved skills, with their inputs |
| `GET /library` | ready-made templates |
| `POST /skills/<name or id>/run {items?, values?, times?, wait?}` | replay a skill |
| `GET /browser/tabs` | okidoki's browser tabs |
| `POST /browser/open {url}` | a new tab for you |
| `GET /browser/page?tab=` | a tab's text and numbered elements |
| `POST /browser/act {tab, action, ref?, selector?, text?, value?, key?}` | act in one of your tabs |
| `GET /browser/screenshot?tab=` | a PNG, base64 |
| `POST /browser/close {tab}` | close one of your tabs |
| `GET /memory` | what okidoki remembers |
| `POST /memory {text}` | tell it a lasting fact |
| `GET /vault/search?q=` | find documents in the vault |

A run, as every route returns it:

```json
{ "id": "…", "kind": "browser", "by": "replay", "status": "done", "done": true,
  "result": "file a return · done for Asha, Ravi", "said": ["…"], "seconds": 14.2, "modelCalls": 1,
  "needs": "…only while it waits on the person…", "thread": "…" }
```

## The other way: okidoki hands work to your coding agent

Settings › Agents also lists the coding agents installed on this Mac — Claude Code, Codex, Amp, Pi, OpenCode,
Gemini CLI, Cursor Agent — plus any command you add (`{prompt}` and `{cwd}` are filled in, safely quoted).
Turn one or more on, pick a default and a working folder (the vault unless you choose another).

Jobs on files, folders, documents, code and the terminal then go to that agent (or pick **Agent** under Where in
the composer to send anything). okidoki runs it without a window in the working folder, streams each command and
edit into the chat, lets you stop it, and resumes the same session for follow-ups in that conversation. The agent
is told `okidoki` is there for the web, logins, Mac apps, skills, memory and the vault.

Access defaults to the safest mode that can still do the job:

| agent | working folder (default) | full access |
|---|---|---|
| Claude Code | `--permission-mode acceptEdits` + an allow-list of safe commands; `rm`, `sudo`, installs, `curl` denied — denied steps come back as "allow and continue" | `bypassPermissions` |
| Codex | `codex exec -s workspace-write` (writes only in the folder, no network) | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini CLI | `--approval-mode auto_edit` | `--approval-mode yolo` |
| OpenCode | its own permission config | `--auto` |
| Cursor Agent | its sandbox and allow-list | `--force` |
| Amp | its own permission rules | same |
| Pi, custom commands | no permission layer: every job waits for your okay | same |

Full access, Pi and custom commands always wait for your okay before a job starts. Each agent uses its own
sign-in; okidoki never passes it a key.
