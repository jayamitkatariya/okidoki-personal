# The engine

The engine is okidoki's harness runtime: the process that runs Claude Code,
Codex, OpenCode, Cursor, Gemini, Pi and Muse, plus the built-in loop that can
use the shell, files, browser and computer tools. It is part of the brain's
local backend and never talks to a hosted service.

## Process model

- `brain/` owns the HTTP surface the app uses (port 4329 by default) and every
  model call the app makes directly.
- `brain/src/engine/` is a Bun child process the brain starts and supervises.
  It listens on `127.0.0.1:4332` with a per-launch secret
  (`X-Okidoki-Engine-Secret`).
- The brain proxies `/engine/*` to it, so the app has one local backend.
- A harness crash cannot take the brain down; the supervisor restarts the
  engine with backoff. If the brain is force-quit, the engine exits on its own.

## Local mode

`OKIDOKI_LOCAL=1` switches the engine's control-plane seam to local answers:

- Activation needs no runtime-env file; it uses `OKIDOKI_WORKSPACE_ID`
  (`personal` by default).
- Credential refreshers, heartbeat, analytics upload and the identity proxy are
  off. The workspace SDK is not installed.
- Chat naming, auto-compact and fallback plans are answered locally.

## Storage

Everything lives under the app's support folder:

```
~/Library/Application Support/Okidoki/engine/
  chats.json                 chats and their provider
  events.jsonl               append-only event stream
  claude-histories/          one JSONL transcript per chat
  codex-histories/           (same, per provider)
  cursor-histories/
  gemini-histories/
  muse-histories/
  opencode-histories/
  pi-histories/
  forks/
  workspaces/                project roots
  engine.log                 supervisor and engine logs
```

Set `OKIDOKI_ENGINE_STATE_DIR` to move the whole tree (tests use a temporary
directory).

## Environment contract

| Variable | Meaning |
|---|---|
| `OKIDOKI_LOCAL` | `1` runs without a control plane |
| `OKIDOKI_ENGINE_SECRET` | per-launch bearer secret |
| `OKIDOKI_ENGINE_PORT` | engine port (default 4332) |
| `OKIDOKI_WORKSPACE_ID` | local workspace id (default `personal`) |
| `OKIDOKI_ENGINE_STATE_DIR` | chats, histories, logs |
| `OKIDOKI_WORKSPACE_ROOT` | project roots (default `engine/workspaces`) |
| `OKIDOKI_ENGINE_ENTRY` | override the engine entry file |
| `OKIDOKI_ENGINE_DISABLED` | `1` keeps the brain from starting the engine |

## Endpoints

The engine serves the harness API the panel will use: `/health`, `/chats` (CRUD,
messages, interrupts, queue and steering), `/chats/:id/subagents`, `/fork`,
`/repos`, `/terminal/sessions`, `/events` (SSE with Last-Event-ID), `/canvas`,
`/previews` and `/credentials`. Through the brain, prefix each with `/engine`.

## Develop

```bash
cd brain
bun run typecheck          # brain and engine
bun test tests             # brain suites
bun run build:engine       # dist/engine.js for the app build
```

The engine externalizes the harness SDKs (`@anthropic-ai/claude-agent-sdk`,
`@cursor/sdk`, `@earendil-works/pi-coding-agent`, `@opencode-ai/sdk`) and the
native modules (`node-pty`, `node-datachannel`, `sharp`). `brain/engine-runtime/`
pins those packages for a packaged build; development runs resolve them from
`brain/node_modules`.

## Chats through the engine

Harness chat is opt-in: **Settings › Advanced › Hand work to coding agents ›
Use the harness runtime**. With it on, the brain starts a chat on the engine
instead of spawning the agent's CLI. With it off (the default), the CLI path is
unchanged.

What the bridge does:

- creates one engine chat per conversation, with a title from the prompt;
- opens the engine event stream first, then sends the prompt, so no turn event
  is missed;
- translates engine events into the stream the Mac already renders
  (`session`, `text`, `tool`, `tool_done`, `end`) with the display-message
  parsers from `shared/`;
- emits the engine chat id as the session id, so a follow-up in the same
  conversation resumes the harness's own context;
- interrupts the chat when the person stops the run;
- falls back to the agent's CLI when the engine is not healthy or the chat
  cannot start.

Verified against Claude Code: one turn and a context-retaining follow-up.

### Known edges

- **Tool-input approvals are not bridged yet.** A harness turn that pauses for
  a permission decision stays open until it times out. Bridging means emitting a
  question into the run, handing the person's answer back through
  `POST /chats/:id/tool-input`.
- **Access mode is not mapped.** `workspace` and `full` do not yet change the
  engine's permission policy.
- **One workspace root.** All engine chats run in the app's coding folder, not
  a per-run `cwd`.
- **Packaging.** Development runs resolve the harness SDKs from
  `brain/node_modules` and `tsx`; the app bundle does not ship them yet.
