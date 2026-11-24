import { ISSUE_PRIORITIES, ISSUE_STATUSES } from '../../../routes/issues';
import type { OkidokiAgentAbilityDescriptor } from '../types';

const codeList = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(', ');

const SECTION = `### Issues
Track work in Okidoki Issues (\`REP-42\`), the shared to-do list of the people and agents in this organization, with \`okidoki issue\`.

**Reference:** \`references/ISSUES.md\`

Use this when:
- You are told to work on an issue, or a message names one like \`REP-42\`
- You receive an \`<issue_event>\` block
- You open a pull request, hear one merged, finish, get blocked, or need a person to decide something on an issue you work on
- Someone asks you to file, update, or split up work`;

const REFERENCE = `# Okidoki Issues

Issues are how people and agents in this organization track work. Each has an identifier like \`REP-42\`, a title, a markdown description, a status, a priority, assignees (people and workspaces), subscribers, comments, linked pull requests, and an activity log. Pass the identifier everywhere an issue is asked for.

The CLI acts as this workspace. Add \`--json\` to any command for machine-readable output. Every command shows a person as \`Name (user:<email>)\` and an agent as \`Name (workspace:<id>)\` (only the handle in \`--json\`); pass the handle back to any command.

\`\`\`bash
okidoki issue view REP-42                     # description, comments, activity, pull requests
okidoki issue list --mine                     # issues assigned to this workspace
okidoki issue list --status todo,in_progress
okidoki issue search "login redirect"
okidoki issue create "Login redirect loses the return path" --description-file /tmp/desc.md --priority high
okidoki issue update REP-42 --status in_progress
okidoki issue update REP-42 --title "..." --description-file /tmp/desc.md
okidoki issue comment REP-42 "Ready for review: https://github.com/acme/app/pull/12"
okidoki issue comment REP-42 "Before and after" --attach /tmp/after.png
okidoki issue assign REP-42 user:alice@acme.com
okidoki issue unassign REP-42 user:alice@acme.com
okidoki issue subscribe REP-42 | unsubscribe REP-42
okidoki issue link-pr REP-42 https://github.com/acme/app/pull/12
okidoki issue unlink-pr REP-42 https://github.com/acme/app/pull/12
okidoki issue relate REP-42 blocks REP-43 | duplicate_of REP-40
\`\`\`

Name a person as \`user:<email>\`, an agent as \`workspace:<id>\`, and this workspace as \`me\`. In comments and descriptions, \`@Name\` or \`@email\` mentions a person or workspace.

Statuses: ${codeList(ISSUE_STATUSES)}. Priorities: ${codeList(ISSUE_PRIORITIES)}.

## Events

You are subscribed to issues you create, are assigned to, comment on, or are mentioned in. Every change someone else makes to them arrives in your chat as an \`<issue_event>\` block: the issue, what changed (old → new for the title and status, the full text of a comment), who did it, and a link. Several changes in a short window arrive as one message. Your own changes are never echoed back.

Read the event and act only when it asks something of you: a person's question or decision in a comment, a new assignment, a status set back to \`todo\`. If it needs nothing from you, end your turn without replying; if you must write something, write only \`No action needed.\`

## Etiquette

**Titles name the problem**, not the fix: "Checkout fails for EU cards", not "Fix Stripe". **Descriptions carry the evidence:** what happens, how to reproduce it, links (Slack threads, logs, Sentry, pull requests), and screenshots. Write the description to a file and pass \`--description-file\`, so markdown survives your shell.

**Show, don't tell.** Attach screenshots and recordings with \`--attach <file>\` on \`create\`, \`update\` or \`comment\`; each file is uploaded through \`okidoki media upload\` and embedded inline. A media URL you already have embeds as \`![caption](url)\`. When you file or delegate a request someone sent screenshots with, attach them: each message says where its images are saved.

**Keep the status true as you go:**
1. \`in_progress\` when you start.
2. When you open a pull request for the issue, link it with \`okidoki issue link-pr\` and comment "Ready for review: <url>". Link only pull requests that do this issue's work, one pull request per issue where you can. Nothing links on its own: \`Fixes REP-42\` in a pull request body is only documentation. Move the issue to \`review\` once it waits only on a person, and assign that person.
3. Linked pull requests then move the status: when every one is approved (merged counts), Okidoki moves the issue to \`approved\`, and when every one is merged, to \`done\`. Pull requests closed without merging don't count. Each move arrives as an \`<issue_event>\` from Okidoki. You still own the result: when it isn't really done (more work is left, or a deploy needs watching), move it back and say why.

**Statuses mean exactly this**, so a person can read only Review and trust the rest:
- \`in_progress\`: work is underway: a check is failing, the pull request has conflicts, review comments need answering, work is missing, or it waits on another pull request.
- \`review\`: waiting only on a person. A linked pull request is open with no conflicts and nothing failing (CI rerunning after a push is fine), and needs someone's review or approval; assign that person. Move it back to \`in_progress\` only for a conflict, a failing check or missing work, never just because something was pushed, so issues don't bounce.
- \`approved\`: every linked pull request is approved, so nothing waits on a person; it just isn't merged or live yet.
- \`done\`: every linked pull request it needs is merged (and deployed when that matters), and nothing is left.
- \`canceled\`: dropped, with a comment saying why.

Keep every property true at all times: status, assignee, linked pull requests (link only the pull requests that do this issue's work; unlink wrong ones with \`okidoki issue unlink-pr\` or the app), and the description, when the plan changes. Before ending a turn, check that your issues' statuses match reality.

**Keep the description current**, the way a good PM does: when the scope or the plan changes, edit it rather than burying the change in comment 14. Comments are for progress, questions, and decisions.

**Ask a person** by assigning them and commenting with exactly what you need decided, mentioning them by \`@Name\` or \`@email\`. Their reply arrives as an \`<issue_event>\`. Once they've answered, unassign them so the issue only shows as theirs while it needs them; they stay subscribed.

**Split big work:** create sub-issues with \`--parent REP-42\`, one per pull request or separable piece, and link blockers with \`relate\`.

**Before filing**, search for an existing issue; if you find one, comment there, or file yours and \`relate ... duplicate_of\` it.
`;

export const ISSUES_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Issues',
  description: 'File, update, and follow Okidoki Issues, and keep their status, description, and pull requests current.',
  bullet: 'Working on, filing, or updating a Okidoki issue (`REP-42`), or receiving an `<issue_event>`',
  section: SECTION,
  referenceFile: { name: 'ISSUES.md', content: REFERENCE },
};
