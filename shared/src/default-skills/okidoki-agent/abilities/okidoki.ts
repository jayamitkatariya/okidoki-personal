import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Okidoki (in-workspace CLI)
Take action *with* Okidoki itself — manage automations, environments (variables, files), repos, and \`okidoki.json\` config — using the pre-installed, pre-authenticated \`okidoki\` CLI.

**Reference:** \`references/OKIDOKI.md\`

Use this when:
- The user asks you to start a new workspace or thread for a task — use \`okidoki create\`, not an automation
- The user asks you to create, edit, run, or delete an automation
- The user asks you to come back to something later ("check back on this in a week", "remind me tomorrow", "tell me when CI is green") — schedule a follow-up (see *Follow-ups and reminders*)
- The user asks you to manage environments, environment variables, or environment files
- The user asks "what envs / repos / automations do I have?"
- The user asks you to scaffold a \`okidoki.json\` / \`okidoki.yaml\` in a repo
- You need to run a long-lived service (dev server, daemon) — always use \`okidoki service start\` so it survives workspace sleep/wake
- The user asks you to change how their Okidoki app looks (theme, colors, accent) — use \`okidoki theme set\` (see *Themes*)`;

const REFERENCE = `# Okidoki (in-workspace CLI)

This guide covers how to take action *with* Okidoki itself from inside a Okidoki workspace — managing automations, environments (and their variables/files), repos, previews, and the user's \`okidoki.json\` config — using the pre-installed \`okidoki\` CLI.

When the user asks _about_ Okidoki (concepts, pricing, how a feature works), check https://docs.okidoki.dev first. When the user asks you to _do_ something in their Okidoki org, this is the file to use.

## Prerequisites

The CLI is pre-installed in every workspace and pre-authenticated using the workspace's engine secret. You do **not** need to log in or set an API key. Verify:

\`\`\`bash
okidoki whoami
\`\`\`

Expected output (in agent mode):

\`\`\`
Workspace identity:
  Workspace ID:    <uuid>
  Organization ID: <uuid>
\`\`\`

If you get "Not logged in", the workspace is misconfigured — surface this to the user instead of trying to work around it.

In agent mode the CLI hides commands that don't make sense for in-workspace agents (\`login\`, \`logout\`, \`codex-auth\`, \`claude-auth\`, \`org switch\`, \`config\`, \`interact\`, \`code\`). What you have includes:

| Command | What it does |
| --- | --- |
| \`okidoki whoami\` | Print the workspace + org identity |
| \`okidoki create <name> -e <env> -a <agent> -m "<prompt>"\` | Start a new workspace with its own agent (see *Starting a new workspace*) |
| \`okidoki get <id>\` / \`okidoki list\` | Check a workspace's status, or find workspaces. \`okidoki list --kind manager\` lists only Managers |
| \`okidoki identity token [--audience <aud>]\` | Print the current short-lived workspace identity token for an audience |
| \`okidoki identity token --format gcp --audience <aud>\` | Supply a current token to Google's executable credential source |
| \`okidoki identity aws-credentials --role-arn <arn> [--region <region>] [--source-identity]\` | Exchange the current token for AWS credential_process JSON (requires AWS CLI); \`--source-identity\` records the workspace ID in CloudTrail and needs \`sts:SetSourceIdentity\` in the role trust policy |
| \`okidoki identity exec [--audience <aud>] -- <command>\` | Run a command with the current token and audience in its environment |
| \`okidoki init\` | Create a \`okidoki.json\` / \`okidoki.yaml\` in the current directory |
| \`okidoki connect <name>\` | SSH into another workspace (requires user creds — usually only useful when scripting locally) |
| \`okidoki repos\` | List repos connected to the org |
| \`okidoki environment ...\` | Manage environments, env vars, env files |
| \`okidoki automation ...\` | Manage automations (cron + GitHub/GitLab event triggers) |
| \`okidoki environment-setup ...\` | Report progress and propose configuration during an agent-led environment setup run (covered in \`ENVIRONMENT-SETUP.md\`) |
| \`okidoki preview ...\` | Register / list preview URLs (covered in \`PREVIEWS.md\`) |
| \`okidoki service ...\` | Run long-lived services detached so they survive workspace sleep/wake (see below) |
| \`okidoki media ...\` | Upload, list, share, revoke, or delete workspace media; follow \`MEDIA.md\` for destination embedding |
| \`okidoki skills suggest <SKILL.md> --title <text>\` | Suggest saving a lasting user instruction as a learning (an organization skill); the user accepts or dismisses it |
| \`okidoki skills suggest --delete <name-or-id>\` | When the user asks you to delete a learning, suggest removing it; the user accepts or dismisses it |
| \`okidoki slack thread ...\` | Attach or switch Slack thread routing (covered in \`SLACK.md\`) |
| \`okidoki theme get\` / \`okidoki theme set ...\` | Show or change the web and desktop app theme of the person who wrote in this workspace (see *Themes*) |

\`okidoki <command> --help\` is always the source of truth for flags.

## Picking the right command for the user's request

| User says... | Run |
| --- | --- |
| "Spin up a new workspace / thread to work on X" | \`okidoki create <name> -e <env> -a <agent> -m "<prompt>"\` |
| "What environments do I have?" | \`okidoki environment list\` |
| "Add API key X to my staging env" | \`okidoki environment vars set <env> <KEY> <VALUE>\` |
| You need a secret or API key you don't have | \`okidoki environment vars request <KEY>... --reason "..."\` (see "Asking the user for variables") |
| "Make me a \`.env\` file in the workspace with these vars" | \`okidoki environment files set <env> .env --content "..."\` |
| "Create a new env for my \`acme/web\` repo" | \`okidoki environment create <name> -r acme/web\` |
| "What automations do I have?" | \`okidoki automation list\` |
| "Run my nightly automation now" | \`okidoki automation run <id>\` |
| "Check back on this in a week" | \`okidoki automation create ... --in 1w --background --personal\` |
| "Check this daily for a week" | \`okidoki automation create ... --trigger-cron "0 9 * * *" --max-runs 7 --workspace current --background --personal\` |
| "Make an automation that runs every weekday at 9am" | \`okidoki automation create\` (interactive) or \`--trigger-cron "0 9 * * 1-5"\` |
| "Make an automation that runs when a PR opens on \`acme/web\`" | \`okidoki automation create ... --trigger-github pull_request.opened --trigger-github-repos acme/web\` |
| "Make an automation that runs when an MR opens on \`acme/web\`" | \`okidoki automation create ... --trigger-gitlab merge_request.opened --trigger-gitlab-repos acme/web\` |
| "Ignore Dependabot for this PR automation" | \`okidoki automation edit <id> --trigger-github-exclude-users 'dependabot[bot]'\` |
| "Also run this PR automation on every push" | \`okidoki automation edit <id> --keep-triggers --trigger-github pull_request.synchronize --trigger-github-repos acme/web\` |
| "What repos are connected?" | \`okidoki repos\` |
| "Make my Okidoki dark / purple / match these colors" | \`okidoki theme set ...\` (see *Themes*) |
| "Set up a \`okidoki.json\` in this repo" | \`okidoki init\` (\`-y\` for YAML) |

## Environments

Environments are the org-scoped *primitives* workspaces are built from. Each environment lists the repositories to clone (none is fine) and carries environment variables, project files, enabled skills, and MCP servers. A fork inherits everything from its parent environment and stores only its own overrides. The org's default environment is used for Scout. Slack or Linear requests that don't name one use the requester's own default environment, falling back to the org default.

### List / get / create / edit / delete

\`\`\`bash
okidoki environment list
okidoki environment get <id-or-name>
okidoki environment create [name] \\
  --description "..." \\
  --repository <repo-names-or-ids> \\
  --system-prompt "..."
okidoki environment edit <id-or-name> \\
  --name "..." --description "..." \\
  --repository <repo-names-or-ids>
okidoki environment delete <id-or-name> [--force]
\`\`\`

Notes:
- Environments resolve by **name or UUID**. A fork inherits its parent's setup and can override or hide any of it.
- \`--repository\` takes a comma-separated list; pass an empty string to \`edit\` to remove all repositories.
- Without \`--repository\`, \`create\` prompts in a terminal and otherwise creates an environment with no repositories, which backs repo-less workspaces.

### Environment variables

\`\`\`bash
okidoki environment vars list <env>
okidoki environment vars set <env> <KEY> <VALUE>     # upsert (create or update)
okidoki environment vars delete <env> <KEY|VARIABLE_ID> [--force]
\`\`\`

\`vars set\` is upsert: if a variable with that key already exists, it's updated; otherwise created. The CLI accepts either the variable's \`key\` or its UUID for \`delete\`.

These variables are injected into every workspace built from this environment as actual \`env\` vars — perfect for API keys, feature flags, etc. Anything you want available to the agent's tools (Claude, codex, your code, etc.) goes here.

### Asking the user for variables

When you need a secret, API key, or other value you don't have, ask with one command. Never ask for values in chat, and never write instructions for adding them in the dashboard:

\`\`\`bash
okidoki environment vars request AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY --reason "Deploy the stack to AWS" [--optional AWS_REGION]
\`\`\`

The user gets a form above the chat composer in Okidoki, where they can paste a whole \`.env\` and choose to save the values to the environment or keep them in this workspace only. The command waits up to 10 minutes (\`--timeout\`), then writes the values to \`~/.okidoki/runtime-env.sh\` and prints only the key names. Your current shell doesn't have them yet, so run commands as \`. ~/.okidoki/runtime-env.sh && <command>\`, and restart anything you started earlier. Never print the values.

In workspaces started from Slack, Linear, or an automation, nobody may be watching Okidoki, so the command returns right away with a link to the form; share it where you are talking with the user. If the values don't arrive in time, the request stays open. Either way you get a message when the user saves; run the same command again then. If a saved value is wrong, for example the service rejects it, add \`--replace\` to ask for a new one.

### Environment files

Files materialize on the workspace filesystem when a workspace starts, at the destination path you specify. Use this for things like \`.env\` files at the repo root, dotfiles in \`~\`, prompt files for agents, etc.

\`\`\`bash
okidoki environment files list <env>
okidoki environment files set <env> <destination-path> --content "..."        # inline
okidoki environment files set <env> <destination-path> --file <local-path>    # from local file
okidoki environment files set <env> <destination-path> --file <local-path> --name "Friendly name"
okidoki environment files delete <env> <destination-path|FILE_ID> [--force]
\`\`\`

Constraints:
- Each file is capped at 64KB.
- \`set\` is upsert (matched by destination path).
- The display \`--name\` defaults to the basename of the destination path; override only if it would be unclear in the dashboard list.

## Starting a new workspace

When the user asks you to start a task in a new workspace or thread, create it now with \`okidoki create\`. Don't use a one-time automation for this; those are for work that should start later.

\`\`\`bash
okidoki create fix-login-redirect -e <env-name-or-id> -a claude -m "Fix the login redirect loop on /settings. Open a PR when done."
\`\`\`

- Pick the environment with \`okidoki environment list\`; use this workspace's environment when the task is in the same repos. Use \`-a\` with this conversation's agent unless the user asked for another.
- Write \`-m\` as the full task: the new agent can't see this conversation.
- On success it prints the workspace ID and a **Link**. Run \`okidoki get <id>\` to confirm the workspace exists and is starting, then give the user the link.
- If the command fails (it exits non-zero and prints the reason), tell the user the exact error. Never say a workspace was created unless \`okidoki get\` found it.

## Automations

Automations are saved prompts with one or more triggers (cron schedules and/or GitHub or GitLab events). When fired, they create a workspace using the configured environment and run the prompt with the user's coding agent.

### List / get / run / delete

\`\`\`bash
okidoki automation list
okidoki automation get <id>
okidoki automation run <id>          # cron-triggered automations only
okidoki automation delete <id> [--force]
\`\`\`

### Create

Either fully flag-driven or fully interactive — the CLI prompts for anything you don't pass.

\`\`\`bash
# Cron trigger
okidoki automation create "Nightly typecheck" \\
  --prompt "Run \\\`bun typecheck\\\` and report any new errors" \\
  --environment <env-name-or-id> \\
  --trigger-cron "0 4 * * *" \\
  --trigger-cron-timezone "America/New_York"

# GitHub trigger (filter to specific repos)
okidoki automation create "Review my PRs" \\
  --prompt "Leave a code review on this PR" \\
  --environment <env-name-or-id> \\
  --trigger-github pull_request.opened \\
  --trigger-github pull_request.synchronize \\
  --trigger-github-repos acme/web,acme/api \\
  --trigger-github-exclude-users 'dependabot[bot],renovate[bot]'

okidoki automation create "Review my MRs" \\
  --prompt "Leave a code review on this MR" \\
  --environment <env-name-or-id> \\
  --trigger-gitlab merge_request.opened \\
  --trigger-gitlab-repos acme/web,acme/api \\
  --trigger-gitlab-exclude-users 'bot-user'

# Disable on creation
okidoki automation create ... --disabled

# Description and workspace size (small is the default; large, ultra)
okidoki automation create ... --description "..." --size large

# Workspace lifecycle (delete_when_done is the default)
okidoki automation create ... --lifecycle sleep_when_done
okidoki automation create ... --lifecycle default --auto-stop-minutes 30
\`\`\`

Pick the lifecycle by what happens after a run:
- \`delete_when_done\` (default, except one-time \`--in\`/\`--at\` runs, which default to \`default\`): the output lives elsewhere and nobody opens the workspace, e.g. a PR "DRY code check" that posts a comment or check.
- \`sleep_when_done\`: later runs reuse the workspace, e.g. one workspace per PR across pushes.
- \`default\`: people read or follow up in the workspace, e.g. a weekly changelog the team replies to.

When the user says "make me an automation that...", default to **picking the environment for them by listing the available envs** and asking only when the user hasn't already pinned one. Same for repos in GitHub triggers. Don't pepper the user with questions you can answer by reading the existing config.

### Follow-ups and reminders

You cannot wait days yourself. When the user asks you to come back to something later, schedule a one-time automation that delivers a prompt back into **this workspace's conversation** at that time, then deletes itself:

\`\`\`bash
okidoki automation create "Re-check PR #142 CI" \\
  --in 1w \\
  --background --personal \\
  --prompt "A week ago the user asked me to re-check CI on https://github.com/acme/web/pull/142 (flaky e2e job 'checkout'). Check the latest run, fix it if it is still failing, and summarize the result for the user."
\`\`\`

- \`--in <duration>\` (\`30m\`, \`2h\`, \`3d\`, \`1w\`, \`1d12h\`) or \`--at <ISO-8601 with offset>\` (e.g. "tomorrow at 9am" → \`--at 2026-10-08T09:00:00-07:00\`, using the user's timezone if you know it; otherwise say which timezone you assumed).
- Inside a workspace, one-time follow-ups default to \`--workspace current\`, so you resume with this conversation's context. Inside a workspace, \`--environment\` defaults to this workspace's environment (same repositories), including for \`--workspace new\` and \`reuse\`.
- Write \`--prompt\` as instructions to your future self: the links, what to check, what "done" looks like, and how to report back (e.g. reply in the original Slack thread). It runs with no memory of why it was scheduled beyond what you write.
- \`--background\` marks an AI agent's own automation: a reminder, follow-up or recurring check-in for its task. It stays out of the user's main automations list, under **Background**.
- \`--personal\` makes the automation the user's own. Omit it only when the follow-up belongs to the organization.
- Recurring with an end: \`--trigger-cron "0 9 * * *" --max-runs 5 --workspace current\` runs daily five times, then deletes itself. \`--workspace reuse\` creates one new workspace on the first run and sends every later run to it; \`--workspace new\` (the default for non-one-time automations) creates a fresh workspace per run.
- Repeat \`--trigger-cron\` for different times on different days: \`--trigger-cron "0 9 * * 1" --trigger-cron "0 17 * * 5"\` runs Monday at 9 and Friday at 5.
- Only schedule when the user asked for a follow-up or clearly agreed to one; not for "maybe I'll look at this later".
- Confirm using the **Next Run** time the CLI prints, not your own arithmetic. Cancel with \`okidoki automation delete <id> --force\`; find them with \`okidoki automation list --background true\`.

### Edit

\`\`\`bash
okidoki automation edit <id> \\
  --name "..." \\
  --description "..." \\
  --prompt "..." \\
  --size small|large|ultra|auto \\
  --enabled true|false \\
  --environment <env-name-or-id> \\
  --trigger-cron "0 4 * * *"   # replaces existing triggers
\`\`\`

\`okidoki automation edit <id> --trigger-github-exclude-users "dependabot[bot],renovate[bot]"\` updates existing GitHub triggers without replacing the rest of the trigger list. The GitLab equivalent is \`--trigger-gitlab-exclude-users\`. Passing an empty string (for example, \`--trigger-github-exclude-users ""\`) clears existing exclusions for that code host. Passing \`--trigger-cron\`, \`--trigger-github\` or \`--trigger-gitlab\` replaces all triggers (repeat a flag for several events); add \`--keep-triggers\` to add them to the existing triggers instead. The repo, exclude and reviewer flags apply only to the events you pass.

\`okidoki automation edit <id> --move-to-org\` turns a personal automation into a shared one the whole team can see. It can't be undone.

\`--credentials <me|email|org>\` on \`create\` or \`edit\` runs an organization automation on the user's own coding agent credentials (such as their Claude subscription) before the organization's. Use it when the user asks for an automation to use their own subscription; \`org\` switches back.

\`okidoki automation edit <id>\` with no flags drops into interactive mode.

## Long-running services

**Always use \`okidoki service start\` to run anything that should keep running after your current command or turn ends** — dev servers, backend APIs, databases, daemons, watchers. Never leave them attached to your shell, and never rely on plain \`&\`, \`nohup\`, or your own backgrounding: processes started inside your session are torn down when your turn ends and the workspace goes to sleep, so the user finds them dead after waking the workspace. \`okidoki service start\` daemonizes the process into its own session, which survives workspace sleep/wake.

\`\`\`bash
okidoki service start <name> "<command>"        # start (or restart) a named service
okidoki service start web "bun run dev" --cwd ~/workspaces/app
okidoki service list                            # names, pids, running/stopped
okidoki service logs <name> [-n 100]            # tail the service log
okidoki service stop <name>                     # stop the whole process group
\`\`\`

Notes:
- Quote the command if it contains shell operators: \`okidoki service start web "cd app && bun dev"\`.
- \`start\` on an existing name restarts it (the old process group is stopped first). It fails fast and prints the log tail if the service dies within the first second.
- Logs stream to \`~/.okidoki/services/<name>.log\`.
- After starting, verify the service is actually healthy (check \`logs\`, then \`curl\` its port) before telling the user it's up or creating a preview for it.

## Themes

When the user asks you to change how their Okidoki app looks, change it for them. It is saved to their account, so their open web and desktop apps repaint on their own, on every computer. The phone app has its own setting and does not follow it.

\`\`\`bash
okidoki theme get
okidoki theme set --theme light
okidoki theme set --theme dark --color-theme slate
okidoki theme set --accent purple
okidoki theme set --accent ff5500
okidoki theme set --code 0d1117,e6ecf4,ff5500
okidoki theme publish --name "Ocean" --code 0b1622,e6f0f8,f2b94b --wallpaper ./ocean.webp --effect dither
\`\`\`

A color theme always goes with \`--theme light\` or \`--theme dark\`. An accent is a preset name or any hex color. A theme code is three hex colors: background, text, accent. Write hex colors without the \`#\`, which the shell reads as a comment. \`okidoki theme set --help\` and \`okidoki theme publish --help\` list the options. For a look the presets don't cover, choose the three colors yourself and pass them as \`--code\`; the text has to read clearly on the background, or it is refused. \`okidoki theme publish\` publishes to the Okidoki gallery under the workspace writer's account (with optional \`--description\`, \`--wallpaper\`, \`--effect\`, and font flags).

It changes the theme of the one person who has written in this workspace, and prints their email. You cannot pick someone else. When several people have written here, or nobody has yet (a workspace started by an automation, another agent, the API or the CLI, until its person sends a message in it), it refuses: tell them they can change their own under **Themes** in the account menu. A workspace created before this command existed answers \`unknown command\`: say the same.

## Repositories

List connected repos, see which GitHub or GitLab repos are available to connect, or connect one (admins only):

\`\`\`bash
okidoki repos
okidoki repos available [--provider github|gitlab]
okidoki repos add <owner/name> [--provider github|gitlab] [-b <branch>]
\`\`\`

If the org hasn't connected GitHub or GitLab yet, point the user at the integrations page in the dashboard first. Once connected, you can list and add repos directly from the CLI.

## \`okidoki.json\` / \`okidoki.yaml\`

\`okidoki init\` creates a starter config in the current directory. \`-y\` writes YAML, \`-f\` overwrites an existing file. This file controls per-repo workspace setup (warm hooks, start hooks, organization scoping for GitHub triggers). When the user asks to "set up Okidoki in this repo", run \`okidoki init\` and then edit the generated file based on what they need.

## When NOT to use the CLI

- **Don't use the CLI to reach into other tools' state** (Linear, Slack, GitHub) — those have dedicated skill references in this directory.
- **Don't try to install Okidoki, log in, or switch orgs** — those flows are user-facing and aren't available in agent mode anyway.
- **Don't create workspaces** from inside an existing workspace just to run a command. You're already in one.

## Common errors

- \`Missing Okidoki-Org-Id header\` → the workspace is hitting an older monolith that doesn't yet recognize agent auth on this endpoint. Surface this to the user; don't try to work around it by faking headers.
- \`Workspace not found\` → the workspace was deleted while you were running. Stop and tell the user.
- \`An environment with this name already exists\` → use \`environment edit\` instead, or pick a different name.
`;

export const OKIDOKI_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Okidoki',
  description: 'Teach the agent about Okidoki itself — automations, environments, the in-workspace CLI.',
  bullet: "- Getting a secret, API key, or token you don't have from the user: run `okidoki environment vars request <KEY>...`, which shows them a form. Never ask for the value in chat or tell them to add it in settings.",
  section: SECTION,
  referenceFile: { name: 'OKIDOKI.md', content: REFERENCE },
  locked: true,
};
