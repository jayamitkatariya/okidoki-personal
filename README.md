# okidoki

A macOS assistant that lives in the notch and a control panel. Summon it by shaking
the pointer, ask for something, and approve what it wants to do before it does it.

## Layout

- `Sources/` — the native macOS app (Swift, SwiftUI and AppKit).
- `web/` — the control panel (React, Vite). Built into the app bundle.
- `brain/` — the TypeScript sidecar that routes requests (Bun).
- `backend/` — the optional Convex sync backend.

## Build

Requires macOS, Xcode command line tools, [Bun](https://bun.sh).

```bash
make app      # builds build/Okidoki.app (Swift, control panel, brain)
make run      # builds and opens it
make test     # Swift tests
```

Copy `backend/.env.local.example` to `backend/.env.local` only if you run the sync backend.
Keys are kept in the macOS Keychain, not in the repository.

## License

MIT. See [LICENSE](LICENSE).

## Natural-language terminal actions

Shake the pointer, type what you want, and press Return. Review the plan in the
cursor card, choose a file or folder when asked, then click **Do it**. The card
shows progress and the result; **Stop** also stops child processes. Commands and
raw output are available in expandable sections.

Nobody needs to know the terminal exists. Built-in jobs are planned on the Mac and
work without a model key:

- “install claude code” · “set up hermes agent” · “get opencode” · “install omp”
- “install node” · “install python” · “install ffmpeg” · “install mole”
- “open claude code in my project” · “start hermes” · “run mole” (opens a Terminal window)
- “update everything” · “update claude code”
- “clean up my mac” · “check free disk space” · “what tools do I have”
- “compress this video for Discord” · “make this PDF searchable” · “resize my photos”
- “zip a folder” · “download https://github.com/owner/project” · “show git status”

Add an Anthropic key in **Keys** for broader requests and custom plans.

How it stays end to end:

- **Dependencies come along.** A plan that needs Homebrew, Node, pipx or a catalog tool
  gets those installs added as its first steps, shown before approval. A Mac with nothing
  on it can go from zero to a working coding agent in one approval.
- **Passwords use a native dialog.** Steps that need administrator access (Homebrew's
  installer, Mole's system caches) get a macOS password prompt through a tiny
  `SUDO_ASKPASS` helper in `~/Library/Application Support/Okidoki`. The answer goes
  straight to `sudo` and is never stored or logged. The plan says up front when a step
  will ask.
- **Interactive tools get a real terminal.** Chat UIs and full-screen tools (Claude Code,
  OpenCode, omp, Hermes, `mo analyze`, `ollama run`, editors) open in a Terminal window
  via a `.command` file, after any installs. No automation permission is needed.
- **Failures are explained and fixed.** When a step stops, the cause is diagnosed on the
  Mac first (missing tool, Apple's command line tools, pip's managed environment, no
  internet, wrong password, protected folder…) and a fix-and-retry plan is offered. For
  anything else, the failing command and its output go to the model, which proposes a
  corrected plan. Fixes still need approval; the loop stops after a couple of attempts.

Each plan runs in one zsh session, preserves folder changes and exports, stops after a
failed step, and has a 30-minute limit. A disconnected job is never automatically rerun.
The app can also plan and execute terminal jobs natively when its Bun sidecar is unavailable.

Terminal checks: `bun test brain/tests` and `swift test --filter TerminalActionsTests`.
The native suite also exercises real video compression when ffmpeg is installed.

## Computer use

Ask for a result (“send mom a message on WhatsApp”, “export this as PDF”) and okidoki
drives the Mac itself: one screenshot and one action per step, narrated in the pill at
the bottom. Press **Esc**, click **Stop**, or shake to take control back; escape presses
made by okidoki itself never stop a run.

Each step the model gets the screen before and after its last action (downscaled to
what the API actually looks at, so clicks land where it points), the frontmost window
title, and the app's visible controls with their centers — rows scrolled out of view are
left out. It can **zoom** into a region at full resolution before clicking small
things. Clicks on a named control snap to that control's real center, including in
Electron apps (Slack, Discord, VS Code, Notion, WhatsApp, Chrome), whose accessibility
trees are switched on first. Clicks can hold cmd/shift/opt, keys can repeat, and
double/triple clicks work. Scripts (AppleScript, JXA, zsh) run for anything scriptable;
permission failures come back as plain guidance so the model falls back to clicking.
Typing uses the live keyboard layout, so shortcuts work on non-US layouts; text over
240 characters is pasted and the clipboard is restored afterwards; nothing is typed
while a password field has the keyboard. Apps are found in the usual folders, their
subfolders, by bundle id, or through Spotlight. On more than one display, the one with
the frontmost window is used. A step repeated three times with no effect gets a nudge;
five times stops the run. Transient model errors are retried; driving uses Sonnet unless
you picked another non-Haiku model in Keys.

Needs Accessibility and Screen Recording. Checks: `swift test --filter ComputerUseTests`
and `bun test brain/tests`.

Model requests use `tool_choice: auto` with an explicit tool instruction: Sonnet
and Opus 5.5 reject forced tool calls. Routing can use Haiku while computer use
switches to Sonnet, so both paths must support the same request format.

For a live API smoke check, run `cd brain && bun run smoke:api`. It tests answers
and computer-use planning with Haiku, Sonnet, and Opus 5.5 using the saved Keychain
entry or `ANTHROPIC_API_KEY`. It makes six billed API requests without capturing
the screen or executing the returned actions.
