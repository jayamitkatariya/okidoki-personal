# Contributing

Thanks for helping. The bar is simple: the change works on a real Mac, and the tests for what you
touched pass.

## Setup

```bash
make app && make run     # installs "/Applications/Okidoki.app" and starts it via launchd
```

Run the installed copy, not `build/`. macOS ties Accessibility and Screen Recording grants to the app's
location, and an app opened from a terminal gets its grants filed under the terminal.

## Tests

| Suite | Command | Touches your Mac? |
|---|---|---|
| Everything short of a real screen | `make verify` | no |
| Brain | `cd brain && bun test tests` | no |
| Control panel | `cd web && bun test tests` | no |
| Swift logic | `swift test --filter 'ChatCommandsTests\|LocalVaultTests\|SkillBundleTests\|WatchPipelineTests\|DrivePolicyTests\|CollabTests'` | no |
| Swift, everything | `swift test` | **yes**: some tests drive real apps (`SkillReplayRealAppTests`, `ComputerUseTests`) |
| The whole loop, end to end | `ANTHROPIC_API_KEY=… scripts/golden-path.sh` | yes, its own isolated profile |
| Computer use | `scripts/cu-eval.py --reps 3` | yes, against the installed app |

Point test data away from your own with `OKIDOKI_SUPPORT_DIR=/tmp/okidoki-test`.

CI (`.github/workflows/ci.yml`) runs the brain and panel suites, compiles the whole app, and runs the
logic-only Swift suites on every push. The golden path and the evals need a key and macOS grants, so
they are local gates. The release bar and how to record baselines live in [docs/quality.md](docs/quality.md).

## Style

- Match the code around you. Comments say *why*, in plain sentences.
- UI copy is short and lowercase in the notch and cards, sentence case in the panel.
- New dashboard pages reuse the existing tiles, rows and buttons (`web/src/components/ui.tsx`).

## Good first issues

- **Library templates** (`Resources/skills/*.okiskill`) — a ready-made skill for a site you use;
  the format is [docs/skill-format.md](docs/skill-format.md).
- **Eval scenarios** (`scripts/cu-scenarios.json`, `scripts/replay-scenarios.json`) — one more task
  with its own independent check.
- **Swift 6 readiness** — `swift build` prints a handful of actor-isolation warnings; each is a
  small, self-contained fix.
- **The session joiner page** (`web/src/collab/`) — small UX wins on a self-contained page.
