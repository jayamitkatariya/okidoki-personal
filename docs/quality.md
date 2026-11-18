# Quality

okidoki's bar: **the change works on a real Mac, end to end, and the numbers say so.** Three harnesses
measure it, one script walks it, and CI keeps the logic honest on every push.

## The gates

| Gate | What it proves | Where it runs |
|---|---|---|
| `make verify` | brain + panel + Swift logic, no screen needed | every push (CI), and locally |
| `swift build` | the whole app compiles — notch, servers, VM | every push (CI) |
| `scripts/golden-path.sh` | the whole loop on a fresh profile: learn → save → replay with new values → shared session, each checked independently | locally, before a release |
| `scripts/cu-eval.py` | computer-use scenarios: pass rate, timings, model calls | locally, before/after driving changes |
| `scripts/replay-eval.py` | agent vs classic replay vs smart replay, A/B on the same tasks | locally, before/after replay changes |
| `scripts/agent-eval.py` | learn → save → replay on public practice sites, through the control API | locally, before/after browser changes |

CI runs the logic suites only — the ones that need no screen, no accessibility, no real apps. The full
Swift suite (`make test`) drives real Macs and stays local. The golden path and the evals need an
Anthropic key and (for the Act/VM steps) macOS grants, so they are local gates, not CI gates.

## The release bar

A release ships when, on a current Apple-silicon Mac:

- **Golden path**: every non-skipped step passes (`--with-mac` and `--with-vm` included).
- **Computer use** (`cu-eval.py --reps 3`): ≥ 90% pass.
- **Classic replay** (`replay-eval.py`): ≥ 95% pass.
- **Smart replay**: ≥ 90% pass, with fewer model calls than the full agent on the same tasks.
- **Learn → save → replay** (`agent-eval.py`): ≥ 85% of lessons replay correctly with new data.

These are the bars, not the current numbers. Record a baseline before changing driving or replay, and
compare after:

```bash
scripts/cu-eval.py --label baseline --reps 3 --save-baseline
scripts/cu-eval.py --label change --compare build/scenarios/baseline.json
scripts/replay-eval.py --modes agent,classic,hybrid --label baseline --save-baseline
```

Smart replay becomes the default only when its A/B numbers beat classic replay on success with fewer
model calls — the harness exists to make that decision, not a vibe.

## The golden path

```bash
ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh              # browser loop + shared session
ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh --with-mac   # + Act on this Mac
ANTHROPIC_API_KEY=sk-… scripts/golden-path.sh --with-vm    # + a task in the private Mac
```

It builds and runs its **own** okidoki (bundle id `dev.okidoki.golden`, its own support folder and
ports), so it never touches the installed app, its data or its keys. The key comes from the
environment. Every filing is checked against the fixture site's own submissions, and every session
step against the session API's own answers — never against what a run claimed. Steps that need macOS
grants or the 15 GB private Mac are opt-in flags; without them the script says SKIP and why.

## Failure states worth walking before a release

No key · denied Accessibility/Screen Recording · an Intel Mac (no private Mac) · an interrupted macOS
download · local-network permission denied (macOS 15+) · the host sleeping mid-session · a joiner
dropping and reconnecting · a run failing mid-step. Each should end in a human message and a way
forward, never a hang or a silent nothing.
