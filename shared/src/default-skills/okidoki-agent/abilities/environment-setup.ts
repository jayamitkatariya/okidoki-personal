import { ENVIRONMENT_SETUP_LIMITS as L } from '../../../routes/environment-setups';
import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Environment setup (agent-led)
Explore a codebase, get it running in this workspace, verify it end to end, and propose the Okidoki environment configuration (start hook, warm hook, system prompt, variables) plus a few automations for the user to review and save.

**Reference:** \`references/ENVIRONMENT-SETUP.md\`

Use this when:
- This workspace was started as an environment setup run (\`okidoki environment-setup status\` succeeds)
- The user asks you to set up, configure, audit, or improve a Okidoki environment for a repository
- The user asks what should go in a start hook, warm hook, or environment system prompt
- A warm pool, warm hook, or start hook is failing, or the fix you found belongs in the environment rather than the repository`;

const REFERENCE = `# Environment setup (agent-led)

Use this workflow to make a repository fully usable by Okidoki background agents: agents booted from the environment should be able to install, run, test, verify, and demo changes without a human babysitting them. In a setup run, the result is a **proposal**, never a direct change: the user reviews, edits, and saves it in the Environment panel next to the chat. Outside a setup run, see below.

## Mental model

Every Okidoki workspace is a remote Linux VM. Repositories are cloned under \`~/workspaces/<repo-name>\`, or \`~/workspaces/<full-path-with-dashes>\` (like \`groupA-app\`) when two share a name. An **environment** is the org-scoped template a workspace is built from. It lists the repositories to clone, in checkout order (one, several for multi-repo stacks, or none), and carries:

| Piece | When it runs | Put here |
| --- | --- | --- |
| **Warm hook** | Once, while Okidoki builds the warm-pool snapshot for the environment. Its *filesystem* state is baked into every new workspace; its *processes* are not. Default timeout 60 minutes. | Slow, deterministic setup: dependency installs from the lockfile, toolchain downloads, \`docker pull\`, one-time builds, code generation. |
| **Start hook** | On every workspace boot, alongside the agent, which is told to wait for it before using the setup. Default timeout 5 minutes. | Fast per-boot reconciliation: start daemons and databases, run migrations against local services, launch dev servers with \`okidoki service start\`, health checks. Must be idempotent. |
| **System prompt** | Injected into the agent's instructions for every workspace in the environment. | Only what an agent cannot learn from the repository itself: team conventions, review expectations, how to verify, gotchas you hit while setting up. |
| **Variables** | Exported into every workspace (and available inside hooks). Values are encrypted. | API keys, tokens, feature flags, local service URLs. |
| **Files** | Materialized on the workspace filesystem at boot. | \`.env\` files, dotfiles, config that must not be committed. |
| **Automations** | Saved prompts fired by triggers (cron, pull request events, Slack, Sentry, webhooks). Each run creates a workspace in an environment. | Recurring engineering work that fits this repository. |

Hooks run with \`bash -lc\` from \`~/workspaces\` (the parent of every repository checkout), so start scripts with \`cd ~/workspaces/<repo-name>\`. A repository may also ship its own \`okidoki.json\` / \`okidoki.yaml\` with \`startHook\`, \`warmHook\`, and \`systemPrompt\`; repository hooks run after the environment hooks. Prefer proposing environment hooks unless the repository already manages its own.

Forks inherit everything their parent sets; never propose putting repository-specific setup in an environment other environments fork from.

## Progress and the setup run

When this workspace was started as a setup run, the dashboard shows a live checklist next to the chat. Keep it honest with:

\`\`\`bash
okidoki environment-setup status
okidoki environment-setup step <key> <status>
\`\`\`

\`status\` prints the environment, repositories, and current steps. Step statuses are \`pending\`, \`in_progress\`, \`completed\`, and \`skipped\`. Step keys, in order: \`understand\`, \`install\`, \`verify\`, \`configure\`, \`propose\`. Mark the first step \`in_progress\` before your first tool call, keep exactly one step \`in_progress\`, and mark a step \`completed\` only after its work actually succeeded. Use \`skipped\` when something genuinely cannot run (for example no browser UI to record) and say so in the proposal.

If \`okidoki environment-setup status\` reports that there is no active setup run, you are in an ordinary workspace, either because the user asked for this or because the fix you found while debugging belongs in the environment. Follow the same discovery and verification steps, show the exact change in chat, and offer to apply and test it yourself. Ask the user before changing the environment, since it affects every workspace built from it. Once they approve:

- Warm hook: \`okidoki environment warm-hooks save-test <env> -f <file>\` runs it in an isolated sandbox and saves it only if it passes.
- Start hook: \`okidoki environment start-hooks test <env> -f <file>\`, then \`okidoki environment start-hooks save <env> -f <file>\` with the same file once it passes.
- Variables and files: apply with \`okidoki environment vars set\` or \`files set\`, then confirm with \`vars list\` or \`files list\`.
- Automations: apply with \`okidoki automation ...\`, then read back with \`okidoki automation get <id>\`.

When a test fails, fix the earliest failure and test again instead of saving. If the fix materially changes what the user approved, show the revised change and ask again before saving. Report what you changed and the test result.

## 1. Understand the codebase

Investigate in parallel before changing anything:

1. Identify the products and services in the repository. Separate what is required for an end-to-end development flow from what is optional.
2. Read setup entry points: \`README\`, \`CONTRIBUTING\`, \`AGENTS.md\`, \`CLAUDE.md\`, package-manager files, tool-version files (\`.nvmrc\`, \`.tool-versions\`, \`.python-version\`), Makefiles, setup scripts, devcontainer and Docker Compose files, CI workflows.
3. Find the canonical install, dev-server, lint, type-check, test, and build commands. CI workflows and pre-commit hooks encode the checks that matter.
4. Learn the team's conventions from history: \`git log --oneline -50\`, and \`gh pr list --state merged --limit 20\` plus \`gh pr view <n>\` on a few merged pull requests (or the GitLab equivalents). Note branch naming, commit style, review expectations, and recurring chores that could become automations.
5. Identify required secrets, test accounts, databases, queues, browser dependencies, and external services. Check \`.env.example\`, config loaders, and CI secrets for variable names. Never read or print secret values. As soon as you know the names, ask for them (see "Asking for variables") and keep going.
6. Inspect any existing \`okidoki.json\` and the current environment (\`okidoki environment get <name>\`, \`okidoki environment start-hooks get <name>\`, \`okidoki environment warm-hooks get <name>\`) so the proposal builds on what exists instead of competing with it. List the organization's automations with \`okidoki automation list --owner org\` and read each one attached to this environment with \`okidoki automation get <id>\` (the environment id is in \`okidoki environment-setup status\`); every one of them needs a decision in the proposal.

Use subagents for broad, independent analysis when available, but read the files and run the commands yourself before adopting their conclusions.

## Asking for variables

The user may be watching or may have walked away, so ask early and wait late:

1. Right after step 1, ask in one command for only the secrets you need to run the app and test its main flow (usually including sign-in) that you cannot replace locally. First check for a local stand-in the app supports, such as a local database, an auth emulator, or documented test credentials. Do not request values you can generate, values that duplicate another key, or values that are not secret, and list optional integrations in the proposal instead of requesting them.

\`\`\`bash
okidoki environment vars request FIREBASE_PRIVATE_KEY --reason "Service account key for a dev Firebase project, to test sign-in" --no-wait
\`\`\`

2. Keep working on everything that does not need the values. The form appears above the chat composer; the user pastes values there (saved encrypted on the environment, never in chat) or skips them.
3. At the point you actually need a value, say in chat which keys you are waiting for and why, then run the same command without \`--no-wait\`. It returns when the keys are provided or skipped, or when the time runs out (\`--timeout 15m\`), and loads provided values into \`~/.okidoki/runtime-env.sh\`. Run commands as \`. ~/.okidoki/runtime-env.sh && <command>\` and restart anything you started with \`okidoki service start\` before that point. Never print the values.
4. For anything skipped or still unanswered, use the safest local substitute (local database, mock, documented test value), say so in the verification rows, and list the key in the proposal, marked required only if the app cannot start or its main flow cannot be tested without it. Do not ask again for a key the user skipped.
5. Values the user saved are already on the environment. Still list those keys in the proposal so the review shows them as set.

## 2. Install and run

Work from the smallest failing layer, in this workspace:

1. Install system dependencies and toolchains the repository pins.
2. Run the install command to completion, then run it a second time to prove idempotence.
3. Start infrastructure and long-running processes with \`okidoki service start <name> "<command>"\` so they survive turn boundaries (see \`OKIDOKI.md\`). Start the Docker daemon first if Compose is involved (see \`DOCKER.md\`).
4. Run the canonical lint, type-check, test, and build commands for the agreed scope. Record what passed, what failed, and why.

Use the repository's pinned package manager and lockfile. Do not upgrade dependencies, rewrite lockfiles, or change application code to make setup pass; environment configuration and narrowly necessary fixes to setup scripts are in scope. Do not deploy, publish, or touch production resources.

When something needs a secret you do not have, request it and wait for it at the point you need it (see "Asking for variables"). If it is skipped or unanswered, use the safest local substitute, keep going, and record the variable in the proposal with a clear description. Never invent or paste secret values anywhere.

## 3. Verify and record

Loading a page is not verification. Perform a representative real action through the product: create a record, submit a form, run a CLI command against the running service, call an endpoint and check the response.

For anything with a UI, record it:

\`\`\`bash
okidoki computer record start /tmp/walkthrough.mp4
okidoki computer launch chrome http://localhost:<port>
okidoki computer browser-state /tmp/state.png --full
okidoki computer browser-click "<button that starts the core flow>"
okidoki computer record stop
okidoki media upload /tmp/walkthrough.mp4 --name "<Project> walkthrough"
\`\`\`

Keep the recording short (one to three minutes) and focused on the flow that proves the environment works. \`okidoki media upload\` prints a chat embed line and a \`View in Okidoki\` link ending in \`?mode=media&media=<media-id>\`; keep both. The media id goes into the proposal, and the embed line goes into your final message. Follow \`MEDIA.md\` for anything shared outside the dashboard.

Add screenshots of important states (a passing test run, the running app) with \`okidoki computer screenshot\` and upload them the same way when they help the user trust the result.

## 4. Draft the configuration

Design from what you verified, not from what the README promises.

**Warm hook** — everything slow and deterministic that produced files on disk during step 2: dependency install, toolchain setup, \`docker compose pull\`, one-time builds, code generation. Non-interactive, \`set -euo pipefail\`, safe to rerun.

**Start hook** — everything that must be alive when an agent starts: start Docker, start databases and caches, run migrations, launch dev servers with \`okidoki service start\`, then wait for readiness (poll a health endpoint) and exit 0. Guard every step so a second run is a no-op. Keep it under a couple of minutes; anything heavier belongs in the warm hook.

**System prompt** — short, and only for what is not obvious from the repository. Agents read the README, CONTRIBUTING, AGENTS.md, and CLAUDE.md themselves, so do not repeat what the product is, how the code is organized, or the standard commands. Include what you learned from history and from running the app: commit and pull request style, review expectations, what to run before opening a pull request, how to verify a change (ports, non-secret test accounts), and gotchas that cost you time. Aim for under 200 words. Use \`null\` when the repository docs already cover everything. Never include secrets or anything Okidoki already tells the agent.

**Variables** — every key the application or hooks need, with a one-line description and whether it is required to run locally. Keys only, never values.

**Automations** — the set that should exist for this repository after saving. Propose only what the repository shows the team would use, like a chore people repeat or a check reviewers keep asking for. Each run uses a workspace, so zero new ones is a fine answer. Each entry has a \`key\` and an \`action\`. \`create\` (the default) adds a new automation and needs a name, one-sentence description, a complete prompt an agent can execute unattended, and triggers. For an automation that already exists, pass its \`automation_id\` and a one-sentence \`note\` the reviewer sees next to it, then choose: \`update\` rewrites it with the full new content (also how you replace it with something better, under a new name if needed), \`keep\` leaves it untouched, \`disable\` turns it off. Every automation already attached to the environment must appear with one of those three; ones you leave out are not shown to the reviewer. Ideas, if the evidence supports them: pull request review focused on this codebase's conventions (\`pull_request.opened\` + \`pull_request.synchronize\`), nightly or weekly health checks (cron), documentation sync when code changes, dependency or security review, flaky-test triage.

Trigger shapes:

\`\`\`json
{ "type": "github", "config": { "event": "pull_request.opened" } }
{ "type": "github", "config": { "event": "pull_request.synchronize", "excluded_actors": ["dependabot[bot]"] } }
{ "type": "gitlab", "config": { "event": "merge_request.opened" } }
{ "type": "cron", "config": { "schedule": "0 9 * * 1-5", "timezone": "UTC" } }
\`\`\`

GitHub events: \`pull_request.opened\`, \`pull_request.synchronize\`, \`pull_request.ready_for_review\`, \`pull_request.review_requested\` (requires a \`reviewer_logins\` list of GitHub usernames), \`pull_request.merged\`, \`pull_request.closed\`. GitLab events: \`merge_request.opened\`, \`merge_request.updated\`, \`merge_request.merged\`, \`merge_request.closed\`. Use one trigger type family per automation and pick the code host the repositories actually live on.

Test the hooks before proposing them: run the drafted warm hook and start hook scripts in this workspace (from \`~/workspaces\`) and fix the earliest failure until both exit 0 on a second run.

## 5. Propose

The \`summary\` and \`verification\` fields are read by a person in the Environment panel, so write them for a person:

- \`summary\`: two or three plain sentences. What the product is, what it takes to run it, and anything notable you found. No command names, file paths, or version numbers; those belong in the system prompt or in verification details.
- \`verification\`: three to six rows, one per outcome, in plain words. Group related commands into one row ("Installed and built the app", "Ran the unit and browser tests") and keep each \`detail\` to one sentence with the specifics. Never use a raw command as a label.
- Limits, enforced by \`propose\`: \`summary\` ${L.summaryChars} characters; \`verification\` ${L.verificationItems} rows with \`detail\` ${L.verificationDetailChars} characters each; \`stack\` ${L.stackItems} items; \`variables\` ${L.variables}, descriptions ${L.variableDescriptionChars} characters; \`automations\` ${L.automations} new ones (decisions on existing automations do not count), each with ${L.automationTriggers} triggers, a ${L.automationPromptChars}-character prompt, and a ${L.automationNoteChars}-character note; \`media\` ${L.mediaItems} items; \`system_prompt\` ${L.systemPromptChars} characters; each hook ${L.hookChars} characters; names ${L.nameChars} and \`description\` ${L.descriptionChars} characters.

Write the proposal to a file and submit it:

\`\`\`bash
okidoki environment-setup propose --file /tmp/proposal.json
\`\`\`

\`\`\`json
{
  "summary": "An online storefront: a Next.js site backed by a small Bun API and a Postgres database. Everything runs locally with Docker Compose and no external accounts. Payments are optional and stay disabled without a Stripe test key.",
  "stack": ["Bun", "Next.js", "Postgres", "Docker Compose", "Vitest"],
  "environment": {
    "description": "Storefront web app and API",
    "system_prompt": "Pull requests use conventional commit titles (feat:, fix:, chore:) and need a passing \`bun run check\` before review. Verify UI changes in the browser at http://localhost:3000 with the seeded account listed in docs/testing.md; the API is on port 4000. Database changes go through a migration in db/migrations, never a direct schema edit.",
    "start_hook": "#!/usr/bin/env bash\\nset -euo pipefail\\n...",
    "warm_hook": "#!/usr/bin/env bash\\nset -euo pipefail\\n..."
  },
  "variables": [
    { "key": "STRIPE_SECRET_KEY", "description": "Stripe test-mode key used by checkout; omit to run with payments disabled", "required": false }
  ],
  "automations": [
    {
      "key": "pr-review",
      "name": "Review pull requests",
      "description": "Reviews every PR against this repository's conventions and leaves inline comments.",
      "prompt": "Review this pull request...",
      "triggers": [
        { "type": "github", "config": { "event": "pull_request.opened" } },
        { "type": "github", "config": { "event": "pull_request.synchronize" } }
      ]
    }
  ],
  "verification": [
    { "label": "Installed and built the app", "status": "passed", "detail": "A second install made no changes." },
    { "label": "Ran lint, type checks, and unit tests", "status": "passed", "detail": "142 tests passed, matching CI." },
    { "label": "Completed a checkout in the browser", "status": "passed", "detail": "Added an item and placed a test order." },
    { "label": "Payment webhooks", "status": "skipped", "detail": "Needs a Stripe test key." }
  ],
  "media": [
    { "media_id": "<media-id from okidoki media upload>", "title": "Checkout walkthrough" }
  ]
}
\`\`\`

When the environment already has automations, their entries look like this:

\`\`\`json
{ "key": "nightly-tests", "action": "keep", "automation_id": "<id from okidoki automation list>", "note": "Already runs the full suite on the schedule CI uses." },
{ "key": "pr-review", "action": "update", "automation_id": "<id>", "name": "Review pull requests", "description": "...", "prompt": "...", "triggers": [ ... ], "note": "Adds the migration checklist reviewers keep asking for." },
{ "key": "docs-sync", "action": "disable", "automation_id": "<id>", "note": "The docs folder it watched was removed in May." }
\`\`\`

Rules:
- Omit \`description\`, \`system_prompt\`, \`start_hook\`, or \`warm_hook\` to keep the environment's current value. Set one to \`null\` to remove it when the repository genuinely needs none; explain why in \`summary\` or \`verification\`.
- Omit \`environment.name\` unless the current name is misleading.
- Every verification row must reflect something you actually ran. Do not list checks you did not run as passed.
- A proposal does not change anything. Do not call \`okidoki environment edit\`, \`vars set\`, \`files set\`, \`start-hooks save\`, \`warm-hooks save\`, or \`okidoki automation create\` during a setup run.
- If the user asks for changes after reviewing, revise and run \`propose\` again; the panel shows the latest proposal.

## 6. Final message

After \`propose\` succeeds, mark the \`propose\` step completed and send one message with this shape:

\`\`\`text
<Project> is running and ready to review.

**What I tested**
- <outcome in plain words> — <one-sentence result>
- <outcome in plain words> — <one-sentence result>

**What I found**
- <two to four findings about the codebase that shaped the configuration, written for a person>

![<Project> walkthrough](<chat embed URL printed by okidoki media upload>)

**Proposed configuration**
Review the start hook, warm hook, system prompt, variables, and automations in the Environment panel on the right. Edit anything inline, then select **Save configuration**. Ask me here if you want changes and I will revise the proposal.
\`\`\`

Keep it under 250 words plus the lists. Do not paste the hooks or system prompt into chat; the panel shows them. Never imply the configuration was saved: in a setup run, saving is the user's action.

## Safety

- Never put tokens, passwords, or private keys in hooks, prompts, files, logs, or chat. Values that arrive through \`okidoki environment vars request\` are written to \`~/.okidoki/runtime-env.sh\`; never echo, cat, or paste them.
- Do not weaken network, certificate, or package-integrity settings to make setup pass.
- Do not run destructive git operations, force pushes, or anything against production endpoints.
- Do not change application code to hide an environment problem. Report it instead.
`;

export const ENVIRONMENT_SETUP_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Environment setup',
  description: 'Explore a codebase, verify it runs, and propose environment hooks, a system prompt, variables, and automations for review.',
  bullet: '- Setting up, auditing, fixing, or improving a Okidoki environment for a repository (hooks, system prompt, variables, automations), including a failing warm pool or hook',
  section: SECTION,
  referenceFile: { name: 'ENVIRONMENT-SETUP.md', content: REFERENCE },
};
