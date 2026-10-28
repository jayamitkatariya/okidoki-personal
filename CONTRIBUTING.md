# Contributing

Thanks for helping. The bar is simple: the change works on a real Mac, and the tests for what you
touched pass.

## Setup

```bash
make app && make run     # installs "/Applications/Okidoki Personal.app" and starts it via launchd
```

Run the installed copy, not `build/`. macOS ties Accessibility and Screen Recording grants to the app's
location, and an app opened from a terminal gets its grants filed under the terminal.

## Tests

| Suite | Command | Touches your Mac? |
|---|---|---|
| Brain | `cd brain && bun test tests` | no |
| Control panel | `cd web && bun test tests` | no |
| Swift logic | `swift test --filter 'ChatCommandsTests\|LocalVaultTests\|SkillBundleTests\|WatchPipelineTests\|DrivePolicyTests'` | no |
| Swift, everything | `swift test` | **yes**: some tests drive real apps (`SkillReplayRealAppTests`, `ComputerUseTests`) |
| Computer use | `scripts/cu-eval.py --reps 3` | yes, against the installed app |

Point test data away from your own with `OKIDOKI_SUPPORT_DIR=/tmp/okidoki-test`.

## Style

- Match the code around you. Comments say *why*, in plain sentences.
- UI copy is short and lowercase in the notch and cards, sentence case in the panel.
- New dashboard pages reuse the existing tiles, rows and buttons (`web/src/components/ui.tsx`).

## Good first issues

- Recipes for more terminal jobs (`Sources/OkidokiCore/Services/TerminalActions.swift`)
- More Toolbox tools (`Sources/OkidokiCore/Models/ToolCatalog.swift`)
- Example skills in `skills/`
