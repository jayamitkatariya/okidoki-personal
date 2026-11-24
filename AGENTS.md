# House rules for AI agents

okidoki is a local-first Mac app: a Swift shell, a Bun brain, and a React
control panel. Everything runs on the person's Mac; nothing ships with keys.

## Working style

- **Go all the way.** Finish the feature: implement, test end to end, and leave
  the repo green (`make verify`).
- **Own the output.** Test what you changed, including the failure paths.
- **Minimal code.** Prefer the smallest change that reads clearly.
- **DRY, but inline first.** Extract a helper when logic is reused or an inline
  block stops being readable.
- **No comments that restate code.** Comment only non-obvious *why*.
- **Shared types live in `shared/`.** Code consumed by both the brain and the
  panel belongs there.
- **Result types for expected failures.** New code uses `Result<T, K>` from
  `@okidoki/shared` for validation, not-found and authorization outcomes; throw
  only for exceptional conditions.
- **Tolerant enums.** A client must read an unknown status, provider or event
  type as its raw value without dropping the rest of the response.
- **Local-only runtime.** The shipped app must not require a hosted service.
  A control-plane-shaped seam is fine; it must answer locally.

## Web panel (`web/`)

- **No `useEffect`.** Derive state during render, move work into handlers, or use
  the bridge's pushed state.
- **Design tokens only.** No hardcoded colors; use the theme variables.
- **Flat, edge-to-edge sections.** Thin separators, no gaps or rounded boxes
  between sections; cards are the exception.
- **Right-aligned selection indicators.** A selected check/radio owns the far
  right slot; trailing counts give way to it.
- **No console logging.**

## Engine (`brain/src/engine/`)

- **Prompt-cache stability.** Per-turn facts ride in tagged message blocks;
  system prompts stay byte-stable across a live session.
- **Append-only events.** Transcripts are JSONL; resumable streams carry ordered
  ids. Never load full transcripts into `state.json`.
- **Per-launch secrets.** Localhost requests carry the engine secret; no token
  in a URL or a log line.
- **Local mode.** `OKIDOKI_LOCAL=1` disables control-plane refreshers and runs
  activation from the workspace id alone.

## Naming

- The donor lineage's name must never appear in this repository. The guard is
  `scripts/check-clean-names.sh`, run by `make verify` and CI.
