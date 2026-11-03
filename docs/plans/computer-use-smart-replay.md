# Plan: smart replay for computer use (Mac apps)

The browser already has smart replay: it replays fast and only uses the model on evidence. This plan brings the same system to Mac apps (Numbers, Mail, Finder, Salesforce desktop, any AppKit, Catalyst or Electron app), so a repetitive desktop job replays deterministically per item, even when the data, the window or the app's screens change.

It's written for an agent that hasn't seen the browser work. Read it all once before starting. Every phase ends with tests that must pass before the next phase starts.

---

## 0. Ground rules (non-negotiable)

- **Repo and branch:**
  - Work only in `~/Desktop/okidoki-personal`, on a new branch off `hybrid-replay` (call it `mac-smart-replay`).
  - Never edit, build or run `~/Desktop/okidoki`.
  - The app's bundle id is `dev.okidoki.personal` (see `scripts/identity.sh`).
- **Don't break what works:**
  - With `settings.hybridReplay` off, `SkillReplayer.begin` (classic Mac replay) must behave byte-for-byte as today.
  - Only skills that use v2 features (`Skill.usesSmartReplay`, in `SkillV2.swift`) always take the smart path.
  - The classic results in `scripts/cu-eval.py` must not change.
- **Never on the person's live desktop during development:**
  - Live Mac tests take over the real mouse and keyboard. Run them on the **private Mac**, the Virtualization VM in `PrivateMacSpec.swift` and `Windows/PrivateMac.swift`, or only when the person has said they're away.
  - Never use the person's real Mail, Messages, Finder folders or documents for tests. Use throwaway copies in a temp folder, and delete them after.
- **Same UI:** reuse existing components (run card, approval card, toasts, notch). No new visual styles.
- **Pure logic in `OkidokiCore`, unit-tested.** App-side code only does I/O (Accessibility, events, screenshots).
- **Model use:**
  - Model ids are in `brain/src/skillcompile.ts`: compile on `claude-opus-5-5` (effort high), resolve and route on `claude-sonnet-5-5` (effort low).
  - Structured outputs use `output_config.format` json_schema with `additionalProperties: false`. Forced `tool_choice` returns a 400 on these models; don't use it.
- **Count every model call:** `store.countModelCall(runID)`. The eval's main number is calls per item.

## 1. What exists today (read these first)

| Piece | File | What it does |
|---|---|---|
| Classic Mac replay | `Sources/Okidoki/Windows/SkillReplayer.swift` (`begin`, `perform`, `locate`, `rescue`) | Replays recorded steps with a ghost cursor. Finds targets by AX hit-test → window-relative carry → label search → picture match. One model rescue per stuck step. |
| Smart Mac replay (first cut) | same file, `beginSmart`, `thinkStep` | Values bound up front (`bindItems`), conditions and loops (`HybridReplay.plan`), think steps through `BrainClient.computer`, hand-off to the model up to the next irreversible step. **Never live-tested.** No anchors, no expectations, no read-back, no popups, no learning. |
| Target finding | `OkidokiCore/Services/SkillTargetResolver.swift`, `SkillReplayGeometry.swift`, `FrameMatcher.swift`, `SkillFrames.swift` | Hit-test, carry with the window, label search, cross-correlation on a recorded crop. |
| Recording | `OkidokiCore/Services/WatchRecorder.swift` (`WatchedTarget`) and the watch-me flow in `AppEnvironment.swift` | Watch-me: the person's clicks and typing become steps, each with the AX target and a picture. |
| The agent on the Mac | `Windows/ComputerUseDriver.swift` (`loop`, `loopV2`), `Windows/DriveExecutor.swift`, `OkidokiCore/Services/ComputerUse.swift`, `DrivePolicy.swift` | Model-driven computer use. **Its runs can't be saved as skills yet.** |
| Screen settle | `OkidokiCore/Services/ScreenSettle.swift` | Waits until frames stop changing. |
| Shared smart-replay core (pure) | `OkidokiCore/Services/HybridReplay.swift` | Planning, conditions, anchors and re-sync, expectations, interrupts, safe dismissals, transient errors, refusals, the shown-values check, render and read-back comparison, capture, the gate. **Reuse it; don't fork it.** |
| Binding | `OkidokiCore/Services/SkillBinder.swift`, `App/AppEnvironment+SmartReplay.swift` (`bindItems`, `resolve`, `SmartReplayCache`) | Values per item from the request, records, vault folder, vault search, OCR, memory. Shared as is. |
| Compile | `OkidokiCore/Services/SkillCompiler.swift`, `brain/src/skillcompile.ts` (`/skill/compile`) | A recorded run becomes a v2 skill: inputs, `when`, loops, irreversible steps, think steps. It already supports the Mac (`surface: "mac"`). |
| Promotion | `OkidokiCore/Services/SkillPromoter.swift` | Turns a think step's actions into plain steps. Its selectors are browser-shaped; Mac needs its own (§5.6). |
| Dispatch | `OkidokiCore/Services/ReplayDispatcher.swift`, `dispatchToSkill` | Replay-first routing; this already covers `.computerUse` decisions. |
| The browser engine, as the reference | `Sources/Okidoki/Browser/HybridBrowserReplayer.swift` | **Read it end to end.** Every behaviour below has a browser version there to copy the shape from. |
| Format docs | `docs/skill-format.md` (Version 2 section) | The fields you'll fill. |
| Eval harness | `scripts/cu-eval.py`, `scripts/cu-scenarios.json` (Mac); `scripts/replay-eval.py` and the fixture site (browser) | Copy the browser harness's structure for the Mac fixture (§4). |

## 2. The design, in one paragraph

The model decides **what** (values per item, what changes, what's irreversible); code decides **how** (click, type, check). A pass that sees nothing unexpected makes **zero** model calls. The model is called only on evidence: a target that can't be found, a check that fails, a screen the skill doesn't know, a value that isn't in the request or the documents. Every model call teaches the skill (new labels and pictures, popup rules, promoted think steps), so the next run is deterministic again.

## 3. Browser → Mac translation table

Every browser primitive needs a Mac equivalent built on Accessibility (AX), with screenshots as the fallback.

| Browser (exists) | Mac (to build) | Notes |
|---|---|---|
| `selectors` (id, role\|label, text, css) | **AX locator**: `[bundleID, window role+title pattern, path of (role, subrole, AXIdentifier, title/description/label, index among same-role siblings)]` plus the existing picture crop and window-relative point | Try in order: AXIdentifier → role+label in the same window → role+label anywhere in the app → picture → relative point. Store several, like browser selectors. |
| `anchor.path` / `landmark` | **AppAnchor**: `{app (bundle id), windowTitle contains, sheet/dialog title, landmark: a static text or group label visible in the front window}` | `StepAnchor` already has `app`, `window`, `title`, `landmark`, and `HybridReplay.matches` handles `app`/`window`. |
| `expect.urlContains` / `textContains` / `elementPresent` / `elementGone` | `windowTitleContains`, `labelPresent`, `focusedRole` (already in `StepExpectation`), plus "a sheet appeared", "a sheet is gone", "a file exists at …" (Finder), "the value of control X is …" | Add `fileExists` and `sheetGone` to `StepExpectation`; keep them optional. |
| `tab.observation()` | `MacObservation`: front app, window title, sheet titles, up to 400 chars of visible static text in the front window (AXStaticText / AXTextField values), focused element role | One AX walk with a depth cap (≤6) and an element cap (≤400); about 30 ms on a normal window. Cache it within a step. |
| `tab.value(of:)` (read-back) | `AXValue` of the target, or of the focused element after typing | Compare with `HybridReplay.sameValue`. Numbers survive grouping; text ignores case and spacing. |
| `tab.options(of:)` | AXPopUpButton / AXComboBox children (menu item titles) | Pick with `SkillBinder.choice` (24(b) → 24B). |
| `dialogs()` / `clickInDialog` | AX sheets (`AXSheet`), `AXDialog` / `AXSystemDialog` windows, modal panels, and system alerts from other processes (UserNotificationCenter, SecurityAgent: **never click these, ask**) | Buttons are the sheet's AXButton titles. |
| `isBusy()` | AXProgressIndicator / AXBusyIndicator visible in the front window, an app that isn't responding (AX calls time out), or `ScreenSettle` still changing | |
| `inDialog(selectors)` | the target's AX ancestor chain contains the sheet or dialog | |
| `fieldValues()` + `pageText()` | AX values of all text fields and static texts in the front window | Used by the shown-values check (§5.9). |
| Parallel tabs | **Not possible on one desktop.** Passes are sequential on the person's Mac; parallel only across private Macs (later) | Keep the per-pass isolation: each pass starts from the skill's start state (§5.2). |
| `navigate` step | `open_app` / activate + "open document X" / `open_url` / AppleScript where an app has a dictionary (Numbers, Mail, Finder) | Prefer scriptable starts: they're deterministic. |

## 4. Phase 0: a Mac fixture and harness, before any feature work

Build first, then baseline.

1. **`scripts/cu-fixture/AcmeDesk`**: a tiny AppKit app that is the Mac twin of `scripts/replay-fixture`.
   - A login window, then a details form (name, PAN with a mask, income with money grouping, a regime pop-up, a "capital gains" checkbox that reveals a field), a deductions table with an "Add row" button, a review sheet, and a Submit that writes the submission to `~/Library/Application Support/AcmeDesk/submissions.json` and shows a reference number.
   - Built with `swiftc` into `build/cu-fixture/AcmeDesk.app`.
   - Give it **hard modes** (read from a JSON config file it watches), mirroring the web fixture:
     - `drift`: renamed buttons, moved fields
     - `randomIds`: AXIdentifiers change on every launch
     - `slow`: controls appear 0.7–2.4s late; Submit takes 2.5s
     - `popups`: a "Stay signed in?" sheet mid-typing that swallows clicks, plus an unknown "What's new" sheet
     - `expire`: back to the login window once per return
     - `busy`: the first Submit fails with "busy, try again"
     - `random`: an inserted "Verify email" window, a required declaration checkbox, a decoy "Save draft", a toast with Undo
     - `wipe`: loses one person's data before review
     - `moveWindow`: the window opens at a random position and size every launch
2. **`scripts/cu-replay-eval.py`**: same shape and flags as `scripts/replay-eval.py`.
   - Same scenarios and people, from `scripts/replay-scenarios.json`.
   - Modes: agent, classic, hybrid.
   - Checks what `submissions.json` actually received, never what a run claims.
   - Also checks: nobody filed twice, no empty returns, stop leaves nothing half-done.
   - Answers the gate through `dev.browser gate carry|skip` (the gate is shared).
3. **Run it on the private Mac** (copy the fixture app in), or with the person's explicit go-ahead.
4. **Save the baseline**: `build/cu-replay/baseline.json`. The merge bar is §8.

## 5. The work, phase by phase

### 5.1 Mac observation and locator (core + app)
- **Core, pure:** `OkidokiCore/Services/MacLocator.swift`.
  - `struct AXLocator: Codable` (the fields from §3).
  - `func candidates(_ locator: AXLocator) -> [LocatorTry]`: the order to try them.
  - Ranking for ambiguous hits: same window, nearest to the recorded relative point, same index.
  - Unit tests on synthetic trees.
- **App:** `Windows/MacObserver.swift`.
  - Holds `observation()`, `find(locator) -> AXUIElement?`, `value(of:)`, `options(of:)`, `dialogs()`, `isBusy()`, `inDialog()`, `windowText()`.
  - Off the main thread with timeouts. An AX call to a hung app must not freeze okidoki; use `AXUIElementSetMessagingTimeout` at 0.5s.
- **Recording:** extend watch-me (`WatchRecorder`) to save an `AXLocator` on every step, next to the existing label, role and picture. It goes in the new optional field `SkillStep.axLocator` (encoded as `SkillStep` already encodes `window` and `frame`). Old skills decode unchanged.

### 5.2 A start state per pass
Browser passes start with `navigate`. Mac passes need the same idea: each pass begins from a known screen.
- The compiler marks the first step(s) that bring the app to its start state (activate the app, close stray sheets, open the document or window). The replayer runs them at the start of every pass.
- Before pass N+1, close the sheets pass N left open. Press Escape only in the skill's own app, never in another app.

### 5.3 The smart Mac pass loop
New file `Windows/HybridMacReplayer.swift`. Move the smart path out of `SkillReplayer.beginSmart` into it and leave `begin` alone. Structure it exactly like `HybridBrowserReplayer.runPass`:
1. **Anchor check**, with `HybridReplay.matches` on a `MacObservation`. On a mismatch:
   - clear interrupts (§5.5)
   - wait while busy (up to 8s)
   - re-sync with `HybridReplay.resync`: jumping back starts at the first step of that screen; it never jumps over an irreversible step
   - press past an unknown screen (§5.7)
   - only then hand off to the agent
2. **Gate** before irreversible steps, with `HybridReplay.pauseReasons` and the existing `presentReplayGate`.
   - On the Mac the person is often away: if the run is unattended (`isUnattended`), a gate means **stop before the step** and report. Never guess.
3. **Readiness:**
   - wait while `isBusy()` (up to 8s)
   - for irreversible steps, wait until the target's AX title matches the recorded label (up to 5s) and the window has settled (`ScreenSettle`)
4. **Clear popups before acting**, unless the target is inside the popup.
5. **Act.**
   - Keep the existing ghost-cursor and EventActuator paths.
   - Typing goes only into the step's own app, which must be frontmost. That check already exists in `perform`; keep it.
6. **Read back typed and chosen values.** One retype, then add a doubt (it feeds the gate).
7. **Expect:**
   - **Not irreversible:** wait up to 4s (+8s while busy) → clear popups and retry once → re-sync to a known screen → hand off.
   - **Irreversible:** copy the browser rule exactly:
     - wait up to 25s
     - retry only on `HybridReplay.transientError`
     - on `HybridReplay.refusal` (the app says "please confirm…"), the model fixes only that, then the gate, then replay presses the step itself
     - otherwise the outcome is **unconfirmed**: fail the pass with "may have gone through, check first". It's never retried and never offered in "retry those".
8. **Capture** (a reference number) with `HybridReplay.capture` over the window text.
9. **Hand-off:**
   - `thinkStep` drives the Mac with `BrainClient.computer` up to, never through, the next irreversible step, which the replay then does itself after the gate.
   - Pass the remaining step texts and this pass's values (the browser's `spelled(skill:values:)` shape; secrets never included).

### 5.4 Escape and stop
- The existing Esc monitor must cancel cleanly: no event may be posted after cancel.
- Check `Task.isCancelled` before every event post.
- A stop never leaves a half-typed field followed by an Enter.

### 5.5 Popups (interrupts)
- Use `HybridReplay.interrupts(showing:skill:dialogText:)` and `safeDismissal(in:generic:)` with sheet and dialog button titles.
- **Built-ins to add for macOS:**
  - "Save changes?" sheet → **never** dismiss it automatically; it's the gate's job
  - "… would like to access …" (TCC prompts) → stop and ask
  - "Software Update" / "Not Now"
  - "Keychain" prompts → never click
- **Learning:** on an unknown modal sheet that blocks a step, make one model call. Its click becomes an `InterruptHandler(source: "learned")` keyed by `HybridReplay.dialogKey(sheet text)`, saved on the skill at the end of the run, as the browser does in `clearInterrupts`.

### 5.6 Promotion (think steps → plain steps)
- Mac think steps record the actions the model took. Each action gets the `AXLocator` of the element under the click, resolved right after the action, before the screen changes.
- Add `SkillPromoter.promoteMac(...)`: the same logic as `promote`, but per-row locators are templated by the row index in the AX path (`AXRow[2]` → `AXRow[{{item.index}}]`) instead of digits in CSS ids.
- Unit-test it with synthetic trees.

### 5.7 Screens nobody recorded
- If the front window or sheet matches no step's anchor in the plan, press a `HybridReplay.pageSkips` button ("Skip for now", "Not Now", "Later") if one exists.
- When the hand-off agent gets past an unknown screen with one click, save `InterruptHandler(source: "learned-page", whenText: "window:<title key>", clickLabel:)`. This copies `passUnknownPage` and the learning in `escalate`.

### 5.8 Saving an Act run as a skill (the big missing piece)
Today a computer-use run (`ComputerUseDriver`) can't become a skill. Build `ComputerUseDriver → LearnedMacRun`:
- **For every successful pointer or keyboard action:**
  - the AX element under the point, resolved **before** the click (`AXUIElementCopyElementAtPosition`)
  - its `AXLocator`
  - a 220×140 pt picture crop around the point (the `SkillFrames` format)
  - the window title and app
  - the text typed or keys pressed
  - an `observedAfter`: the window title and landmarks after the action settled
- **Sensitive values:** drop screenshots and values for anything typed into secure fields (`AXSecureTextField`), and store a vault reference instead, as browser login steps do.
- **The save path:** the run card's existing "save as skill" plus `generalize(skillID:from:)` (compile with `surface: "mac"`).
- **Templates:** for Mac templates (`startApp` set) this makes the first run learnable. Reuse `templateRuns`, `startTemplateRun` and `browserRunFinished`'s template logic as a `macRunFinished`.

### 5.9 Safety checks carried over from the browser (all already in `HybridReplay`)
- **Shown values:** before an irreversible step whose screen echoes the values (`SkillStep.echoes`, learned at compile or on the first run), pause if none of this pass's values are visible in the window text or field values.
- **Missing values:** an item missing a required value isn't started; the others still run. This is already in `beginSmart`; keep it.
- **Retry:** "retry those" offers only failed, safe passes (`failReplay(retry:)`).

### 5.10 Dispatch
`dispatchToSkill` already includes `.computerUse` decisions and offers uninstalled library templates. Check that:
- a Mac template is picked for "add these rows to my Numbers sheet"
- the learned Mac skill is picked the next time
- "use the agent" overrides both

## 6. Templates to ship for the Mac (`Resources/skills/*.okiskill`, `startApp` set)
Already shipped: `numbers-add-row`, `finder-rename`, `mail-attachment`, `notes-create`. Add, all read-only or local-only:
- **Numbers:** read a value from a named cell; sum a column.
- **Finder:** move files matching a pattern into a folder (the throwaway test folder only).
- **Preview:** export a PDF's page range.
- **Calendar:** list tomorrow's events (read-only).
- **Reminders:** add a reminder.
- **System Settings:** read Wi-Fi name, battery health (read-only).
- **TextEdit:** fill a letter template per row of a CSV.

Each needs an `outline`, `inputs`, `intent` and `itemNoun`. `alwaysConfirm` is required for anything that sends or deletes.

## 7. Speed targets
- An undrifted replay of a 20-step Mac skill: ≤1.2× the classic replay's time, **0 model calls**.
- Per step: one AX hit-test when nothing moved (that path exists). A full AX search only on a miss, then a picture match, then the model.
- Ghost animation: 120 ms on hits, the current duration on searches.
- Bind runs while the start step opens the app.

## 8. Merge bar (from `cu-replay-eval.py`)
- Classic mode: identical to `build/cu-replay/baseline.json`.
- Hybrid, every scenario:
  - nothing filed twice
  - no empty returns
  - stop: nothing after the stop
- Hybrid on undrifted data: 0 model calls.
- Hybrid on drift, popups, expire, slow and random: all items pass. The second run of each makes ≤1 model call per item, and 0 once its popup and page rules are learned.
- Hybrid vs agent-only on new data: ≥5× faster, at least as many items right.
- `swift test` green, `cd brain && bun test` green.

## 9. Lessons from the browser build (do these from day one)
1. **Never redo an irreversible step because a check timed out.** A slow submit looks exactly like a dead one. Only an explicit "busy, try again" justifies a second press.
2. **Wait for readiness before irreversible steps.** On a slow page the Submit button existed before it worked, and the first click was swallowed.
3. **Re-sync before calling the agent.** "Signed in again and sent back to where you were" looked like being lost, and the agent was called for nothing (6 calls → 0).
4. **On a jump back, start at the first step of that screen,** not its last: the screen is a fresh copy and its fields are empty.
5. **Learned popup rules fire only inside popups.** A rule matched against the whole screen clicked page buttons that shared a word.
6. **Never ask the model to dismiss what a step opened on purpose:** check that the target isn't inside the popup first.
7. **Shared UI cleanup can kill a run:** the browser's tab cleanup closed a tab a replay had just opened. On the Mac, the same risk is anything that closes windows or sheets (okidoki's own panel housekeeping).
8. **A plain recording can't serve a request for other people:** route to its smart version (`ReplayDispatcher.smartSibling`).
9. **Router confidence wobbles;** keep its rubric explicit (see `ROUTE_SYSTEM`).
10. **Never phrase test requests with "file … into the vault":** that's the vault-download command. Use throwaway folders for any test files, and delete them.
11. **The harness checks the target's real state,** never what the run claimed: a run once claimed a reference number for an empty return.

## 10. Order of work and commits (one commit each, the eval after each)
1. Fixture app + `cu-replay-eval.py` + baseline
2. `MacLocator` + `MacObserver` + recording `axLocator`
3. `HybridMacReplayer` pass loop (anchors, readiness, read-back, expect, irreversible rules, capture, hand-off)
4. Popups + unknown screens + learning
5. Act run → skill (`LearnedMacRun`, save path, templates' first run)
6. Promotion for the Mac
7. Mac templates + dispatch checks
8. Speed pass + final A/B against the baseline. Write the results into this file under "Results".

## Results
(fill in as phases land)
