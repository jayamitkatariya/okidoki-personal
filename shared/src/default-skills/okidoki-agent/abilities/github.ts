import { GIT_CREDENTIAL_HELPER_FILENAME } from '../../../git';
import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### GitHub
Use the pre-authenticated \`gh\` CLI for repository workflows and the workspace-scoped TypeScript SDK for GitHub API calls.

**Reference:** \`references/GITHUB.md\`

Use this when:
- You need to create, review, or manage pull requests
- You're opening pull requests that build on each other (a stack)
- You need to interact with GitHub issues or actions
- You need to use the GitHub API for advanced operations
- You need to include images in PR descriptions
- Pushing or opening a pull request failed`;

const REFERENCE = `# GitHub Integration

This guide covers how to interact with GitHub from within your Okidoki workspace. Prefer \`@okidoki/sdk\` for API calls so batching and data processing stay in one TypeScript program. The \`gh\` CLI remains useful for ergonomic pull request and git-adjacent workflows.

## Prerequisites

The \`gh\` CLI is pre-installed and authenticated in your workspace. You can verify this:

\`\`\`bash
gh auth status
\`\`\`

If authenticated, you can immediately use \`gh\` for all GitHub operations. No additional setup is needed.

## Using the \`gh\` CLI

The GitHub CLI (\`gh\`) is the recommended way to interact with GitHub. It handles authentication, pagination, and API formatting automatically.

In a workspace spanning GitHub owners, run \`gh\` inside the target checkout or pass \`--repo owner/repo\`. For \`gh api graphql\`, set \`GH_REPO=owner/repo\`; SDK GraphQL requests use the \`repository\` option to select the account. Each request uses one account.

### Pull Requests

\`\`\`bash
# Create a PR
gh pr create --title "Title" --body "Description"

# List open PRs
gh pr list

# View a specific PR
gh pr view 123

# Review/check PR status
gh pr checks 123

# Merge a PR
gh pr merge 123
\`\`\`

### When pushing or opening a pull request fails

Tell the person the real cause and the real fix, not a guess. Check \`git remote -v\`, \`git config --show-origin --get-all credential.helper\`, and \`gh auth status\` first.

- **The Okidoki credential helper says this workspace has no credentials for the repository:** the repository isn't in the workspace's environment, so this workspace can't push to it even if you cloned it yourself. Say so, and that a workspace on an environment that includes the repository can make the change. When it says it has no credentials for the whole host, check \`~/.okidoki/logs\` for a failed GitHub token refresh before choosing a cause.
- **\`Resource not accessible by integration\`, or a 403 or 404 that isn't a rate limit:** the token in use can't write to that repository. When it isn't the workspace's own (Okidoki configures \`gh\` and the \`~/${GIT_CREDENTIAL_HELPER_FILENAME}\` credential helper), it came from the environment, such as a start hook or variable: say that token lacks access and retry with the workspace's own credentials. Otherwise the Okidoki GitHub App can't reach the repository: an organization admin has to install it there or grant it access. A rate limit (\`API rate limit exceeded\`, \`x-ratelimit-remaining: 0\`) only needs a wait and a retry.
- Say to reconnect GitHub only when the error itself says so, which happens when PR user attribution is on and the person's GitHub account is missing or expired.

### Stacked Pull Requests

When a change spans pull requests that build on each other, open each one with \`--base\` set to the branch below it, then link them into a GitHub stack. GitHub then shows the whole stack on every pull request in it. The \`gh stack\` extension is pre-installed.

\`\`\`bash
# Bottom of the stack first. Pass --base when the bottom pull request targets a branch other than the default branch
gh stack link 101 102 103
gh stack link --base develop 101 102 103
\`\`\`

Run \`gh stack --help\` for local stack tracking, rebasing, and merging a stack.

### Issues

\`\`\`bash
# Create an issue
gh issue create --title "Title" --body "Description"

# View an issue
gh issue view 123

# List issues
gh issue list

# Close an issue
gh issue close 123

# Add a comment
gh issue comment 123 --body "Your comment"
\`\`\`

### Repository Operations

\`\`\`bash
# View repo info
gh repo view

# Clone a repo
gh repo clone owner/repo

# List releases
gh release list
\`\`\`

### GitHub Actions / Checks

\`\`\`bash
# List workflow runs
gh run list

# View a specific run
gh run view RUN_ID

# Watch a run in progress
gh run watch RUN_ID

# Re-run failed jobs
gh run rerun RUN_ID --failed
\`\`\`

### GitHub API (Advanced)

For operations not covered by \`gh\` subcommands, use the scoped SDK. Pass only a relative GitHub API path:

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const comments = await okidoki.github.request('/repos/owner/repo/pulls/123/comments');
await okidoki.github.request('/repos/owner/repo/issues/123/comments', {
  method: 'POST',
  body: { body: 'Comment text' },
});

const result = await okidoki.github.request('/graphql', {
  repository: 'owner/repo',
  method: 'POST',
  body: { query: '{ viewer { login } }' },
});
\`\`\`

### Working with PR Reviews

\`\`\`bash
# View PR comments
gh api repos/owner/repo/pulls/123/comments

# View PR review comments
gh api repos/owner/repo/pulls/123/reviews

# Submit a review
gh pr review 123 --approve
gh pr review 123 --request-changes --body "Changes needed"
\`\`\`

## Media in GitHub workflows

Media delivery is owned by \`references/MEDIA.md\`. Read it before adding screenshots, GIFs, recordings, diagrams, or HTML reports to a pull request, issue, review comment, or commit; it covers when to use a GIF instead of screenshots, the public links every image upload prints, recording previews, and organization-only HTML links.
`;

export const GITHUB_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'GitHub',
  description: 'GitHub workflows through gh and API calls through @okidoki/sdk.',
  bullet: '- Interacting with GitHub (creating PRs, managing issues, using the API, etc.)',
  section: SECTION,
  referenceFile: { name: 'GITHUB.md', content: REFERENCE },
};
