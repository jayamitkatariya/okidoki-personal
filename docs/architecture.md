# Architecture

okidoki is three local processes and one optional one:

```
 notch · cursor card · overlays          control panel (WKWebView)
            │                                     │ bridge (postMessage / JS events)
            ▼                                     ▼
 ┌──────────────────────── Mac app (Swift) ────────────────────────┐
 │ AppEnvironment ─ request pipeline ─ OkidokiStore (state.json)    │
 │ WatchRecorder · SkillReplayer · ComputerUseDriver · browser       
 │ LocalVault (folder + vault.json) · routines · ControlServer       │
 └───────────────┬─────────────────────────────────┬────────────────┘
                 │ HTTP 127.0.0.1:4329 (token)      │ HTTP 127.0.0.1:4330 (token in control.json)
                 ▼                                  ▼
        brain (Bun, TypeScript)              `okidoki` CLI (mcp/okidoki.ts) ◀── Claude Code, Codex… (okidoki skill)
        router · Claude · computer use v2
        browser agent · MCP client · Moss index
```

## The Mac app

- **`OkidokiStore`** — everything you see, saved as JSON in the support folder: accounts, threads,
  memory, runs, skills, routines.
- **Request pipeline (`AppEnvironment.handleRequest`)** — chat commands first (instant, no key). Then
  the brain decides a route (`answer`, `computer_use`, `browser`, `quick_action`…). Then the
  mode picked on the card overrides that route.
- **Replay** — `WatchRecorder` turns input events into `SkillStep`s. `SkillReplayer` runs them with
  `SkillTargetResolver` (accessibility, then `FrameMatcher` by sight), and only asks the model to
  rescue a single step.
- **Computer use** — `ComputerUseDriver` streams batches of actions from the brain. `DriveExecutor`
  runs each one, waits for the screen to settle, and checks that it worked.
- **Vault** — `LocalVault` lists a folder, follows changes with FSEvents, and keeps logins sealed
  (AES-GCM; the panel seals them, the Mac stores ciphertext only).
- **`ControlServer`** — local tools reach the app here. It listens on 127.0.0.1 only, needs a
  bearer token, and refuses browser origins.

## The brain

The brain is a Bun HTTP server started by the app. The app holds its token. It owns every model call:

- `router.ts` / `llm.ts` decide what a request is.
- `computer2.ts` is the computer-use loop.
- `mcp.ts` talks to your MCP servers.
- `memory.ts` keeps the Moss index.

## Privacy

Nothing leaves the Mac except model calls (to Anthropic with your key) and services you add keys
for. Screenshots are sent with a request and never stored, apart from the small per-step pictures
skills keep for replay.
