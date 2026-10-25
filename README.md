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
There is no bring-your-own-key: the app ships with its service credentials. Anything it stores
locally lives in a private file on your Mac (`~/Library/Application Support/Okidoki/keys.json`,
readable only by its owner), never in the repository or the Keychain.

Service credentials (Anthropic, Cartesia, Moss, Apify, the Convex sync secret) are never
compiled in. Put them in a gitignored `.env` at the repo root (`ANTHROPIC_API_KEY=…`, `APIFY_API_KEY=…`
and so on); `make app` copies it into the bundle as `service.env`, leaving out `CONVEX_DEPLOY_KEY`
and `VITE_*`, which are build-only. The launch environment, `OKIDOKI_ENV_FILE`,
or `~/Library/Application Support/Okidoki/service.env` override it. When `APIFY_API_KEY` is set, the
Apify connector in Toolbox starts switched on and the brain uses that key for actor runs.
Cloud sync stays off until it's switched on in Settings.

## Enterprise: work accounts, spaces, workers, the vault

The same app, toggled by the account switcher. Pick a **Work** account and the sidebar gains an
*enterprise* group — **Spaces**, **Team**, **Vault** — and Settings gains **Organization** and
**Worker**. Pick a personal account and none of it is there. Everything enterprise lives on the
Convex deployment behind the sync login (Settings › Sync login), because colleagues have to see
the same thing; a work account that isn't signed in just sees how to sign in.

- **Team.** Link a work account to an organization: create one (you're its owner), enter a
  six-character join code, or ask to join the organization that owns your email domain (an admin
  lets you in). Owners and admins manage roles (owner · admin · member · agent) and codes. On a
  Mac, **Let nearby Macs join** announces a one-day code over Bonjour (`_okidoki._tcp`); any
  okidoki on the same Wi-Fi with a work account sees "Join Acme" and joins with one click.
- **Spaces.** Group chats inside the organization. Anyone in the organization can see and join a
  space; its chat, files and jobs answer only members. Mention `@okidoki` and the message becomes a
  job: a run card appears in the chat with status, steps, output, and — when the run wants an
  okay — **Do it / Not now** buttons anyone in the space can press.
- **Worker.** Settings › Worker › *Accept jobs from my spaces* makes this Mac take those jobs. It
  polls the deployment every few seconds over the same secret-guarded route sync uses, runs the
  job through the ordinary request pipeline in a thread of its own (no card at the cursor, nothing
  spoken), and mirrors what happens back into the chat. A space set to **Private Mac** only hands
  jobs to Macs whose computer target is the private Mac; **Hosted VM** is listed as coming soon.
- **Shared skills.** The share button on a skill publishes it to a space or the whole organization.
  Colleagues see the apps it needs and its `{{parameters}}`, and pull it onto their own Mac to
  replay there (screen pictures stay behind; replay works from labels and the brain's look).
  Republishing bumps the version and keeps history for a rollback. Worker Macs receive a space's
  shared skills with each job, so "replay the expense report" works on a Mac that never recorded it.
- **Vault.** Documents go to Convex file storage, scoped to a space or the organization, and can be
  dropped into a chat. Logins are sealed in the panel with the organization's vault passphrase
  (PBKDF2 + AES-GCM) before they leave the Mac; the deployment stores ciphertext only. The
  passphrase is remembered in the panel's storage and in `keys.json`, next to the other secrets.

Checks: `cd backend && npm test` (organizations, spaces, chat, jobs and the worker routes, shared
skills, vault — against an in-memory Convex with mocked logins), `cd web && bun test`, and
`swift test --filter 'SpaceWorkerTests|NearbyTests'`.

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
- “use hermes agent in terminal to find my Bridge presentation pptx file” (passes the full task to Hermes and returns its answer here)
- “update everything” · “update claude code”
- “clean up my mac” · “check free disk space” · “what tools do I have”
- “compress this video for Discord” · “make this PDF searchable” · “resize my photos”
- “zip a folder” · “download https://github.com/owner/project” · “show git status”
- “import my memory from claude code” · “bring over what chatgpt knows about me”

Broader requests and custom plans go through the model.

Fixed recipes handle a single simple job. Requests with additional actions, destinations,
parameters or constraints go to the planner so those details are preserved. Model-generated
action plans get a separate review against the complete original request and context before
execution; a failed review stops the plan. The review uses Sonnet when routing uses Haiku.
Opening a tool or completing setup cannot substitute for the requested result, and prose
claiming success without a structured decision cannot trigger an action.

## Memory from other assistants

Okidoki can read what other assistants already know about you and add it to Memory. Ask by name
(“import my memory from hermes”) or use the **Memory** page, which lists what it found on this Mac.
Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Hermes, Grok, MiniMax and OpenClaw keep their
notes in files under your home folder; the job reads those files with the terminal and nothing else.
ChatGPT, Gemini and Claude have no files here, so ask them to export what they remember, save the
reply as a text file, and pick it when asked.

Every import is a reviewable plan you approve first. It only adds: nothing already in Memory is
rewritten, the other assistant's files are never changed, and nothing leaves your Mac. Headings,
code, links, secrets and lines addressed to an assistant (“ignore previous instructions…”) are left
out. Each imported memory is tagged with where it came from, so you can edit or forget it afterwards.

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
  via a `.command` file, after any installs finish under the monitored shell. The result
  acknowledges the handoff; it does not claim the interactive session has completed.
  Requests that name an agent and a task use its noninteractive mode, keep the full
  request, and wait for its output in Okidoki. No automation permission is needed.
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

Run `make verify-terminal` to check terminal execution together with Toolbox persistence,
install dependencies, blocked tools, MCP discovery/calls/reconnect/removal, cancellation,
and command argument round trips. MCP tests use local fixture processes and in-memory
HTTP endpoints; they do not spend API credits or install software. GUI permissions and
live provider credentials still need a smoke check in the running app.

## Skills (watch me, replay)

Say “watch me” (optionally “watch me do the expense report”) and do the task once. The
recording is ended only by its own controls — **Save** / **Discard** in the notch, the HUD
pill, the Skills page, or typing “stop”, “done”, “save as …” or “discard” in the chat.
Shaking the pointer is ignored while a recording runs, so hovering and nudging never cut
it short.

Everything about skills can be driven from the chat, instantly and without a model key:
“replay invoice flow”, “replay invoice flow 3 times”, “again”, “my skills”,
“rename invoice flow to billing”, “delete the invoice flow skill”. A replay starts right
away under the ghost cursor; **Esc** or “stop” hands control back.

Replays stay fast: every click is re-found by its accessibility label and posted straight
away. Each recorded click also keeps a small picture of the screen around it (taken from the
frame just before the click, so it shows the control un-pressed; needs Screen Recording).
When the label route misses — a window moved, a list reordered, a web page with no labels —
the replayer finds the control by that picture in a fresh capture (local, ~0.1 s, no model),
checking the small text so look-alike rows don't get mixed up, and waits a couple of
seconds for an app that hasn't caught up. Only when neither finds it does the brain look at
the screen, with the picture and the neighbouring steps for context, and do that one step;
a control it knows is never clicked blind at its old spot. Pictures live in
`~/Library/Application Support/Okidoki/frames` and go when the skill does. Without a key or
without Screen Recording the replay behaves as before.

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
the saved settings name another non-Haiku model.

While it drives, the pointer glides to each target (Settings › Appearance › Driving pace),
a green ring and label follow it, clicks ripple, and key presses show beside it. The pill
at the bottom shows the kind of step, the first line of a running script, and a thumbnail
of what the model saw with a mark where it aimed. The **Live** page in the dashboard
keeps the whole timeline: every screenshot, aim mark, script, zoom crop and result, with
a Stop button. Scriptable apps also hand the model an abridged AppleScript dictionary so
scripts use the app's real commands.

Needs Accessibility and Screen Recording. Checks: `swift test --filter ComputerUseTests`
and `bun test brain/tests`.

**Run the installed copy, started by launchd.** Two macOS rules decide whether clicks and keys
work at all:

- Grants are tied to the app's location as well as its signature. Launching build copies from
  several folders (`build/Okidoki.app`, a lab build, a temp build) leaves a pile of Accessibility
  entries for the same bundle id; System Settings shows one of them as on while every other copy
  is silently denied, with no prompt.
- An app opened from a terminal — `open`, or Finder/AppleScript driven from that terminal — is
  attributed to the terminal as its "responsible process". The grants land under Terminal or
  Ghostty and the permission dialogs name the terminal, so okidoki never becomes trusted itself.

`make run` therefore installs to `/Applications/Okidoki.app` and starts it with
`scripts/launch-app.sh`, a launchd job (how login items start). Only one copy runs at a time: a
new launch asks any running copy to quit first. When okidoki finds itself untrusted it clears its
own stale entry (`tccutil reset … com.jaykatariya.okidoki`) and asks again, so one click on the
toggle makes it good.

End-to-end scenarios: `OKIDOKI_DEV_HOOKS=1 scripts/launch-app.sh`, then `scripts/dev-drive.sh
"open notes and …"` starts a run, waits for it, prints its step log and saves a screenshot under
`build/scenarios/`; `--ask` sends the text through the router instead. `scripts/dev-scenarios.sh`
runs the standard batch. The hooks are distributed notifications and are off unless that variable is set.

### Private Mac

Onboarding asks where okidoki should work, and Settings › Private Mac changes it later:
**This Mac** (the default, above) or **a private Mac** — its own macOS in a window, so
runs happen there while you keep using your Mac. It's a Virtualization.framework VM
(Apple silicon only, needs the `com.apple.security.virtualization` entitlement in
`Resources/Okidoki.entitlements`). Setup downloads the latest macOS restore image
(~15 GB) into `~/Library/Application Support/Okidoki/PrivateMac`, installs it onto a
64 GB sparse disk, and boots into Setup Assistant, which you click through once in the
VM window and then press **It's done**. The VM is sized by `PrivateMacSpec` (up to 4
cores, 4–8 GB, a 1440×900 Retina display) and starts on demand the first time a run
needs it; closing its window hides it, the VM keeps running, and quitting okidoki shuts
it down cleanly.

Inside the VM there is no accessibility tree and no scripting, so the model works from
the picture alone: screenshots come from a window capture of the VM view, and clicks,
drags, scrolls and keys are AppKit events handed straight to that view, which forwards
them to the guest. `open_app` and `open_url` become Spotlight sequences; `script` is
refused with guidance. The brain gets `remote: true` and a prompt that knows all this.
A run that picks the private Mac while it isn't set up fails with a pointer to Settings
rather than silently driving your own Mac. Checks: `swift test --filter PrivateMacSpecTests`.

Model requests use `tool_choice: auto` with an explicit tool instruction: Sonnet
and Opus 5.5 reject forced tool calls. Routing can use Haiku while computer use
switches to Sonnet, so both paths must support the same request format.

For a live API smoke check, run `cd brain && bun run smoke:api`. It tests answers
and computer-use planning with Haiku, Sonnet, and Opus 5.5 using the key saved
in the service `.env` or `ANTHROPIC_API_KEY`. It makes six billed API requests without capturing
the screen or executing the returned actions.
