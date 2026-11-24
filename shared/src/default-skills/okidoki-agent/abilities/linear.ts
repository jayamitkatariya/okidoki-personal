import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Linear
Create tickets, fetch issues, update state, add comments, and search through \`okidoki.linear.graphql\` in \`@okidoki/sdk\`. This works without a Linear MCP server and refreshes authentication automatically. Create tickets through it even when a Linear MCP server is configured: it credits the ticket to the person who asked, while an MCP server files it as whoever signed it in.

**Reference:** \`references/LINEAR.md\`

Use this when:
- You need to create a Linear ticket or issue
- You encounter a linear.app issue link and need to understand the task
- You need to update an issue's state or add a comment
- You need to search Linear issues
- You start working on a Linear issue and need to attach it to this workspace
- A Linear request failed with an authentication error`;

const REFERENCE = `# Linear Integration

Use \`@okidoki/sdk\`; never request or handle a Linear OAuth token. Okidoki refreshes the organization credential behind the gateway.

In all new workspaces, Linear credentials stay on the Okidoki server and the workspace receives only connection metadata. Older workspaces can still carry a legacy token snapshot, but should use the gateway when the SDK is available. A missing Linear MCP server does not prevent SDK access.

Download protected attachments with \`await okidoki.linear.download(url)\`; this returns a \`Response\` without exposing the provider token.

## Attach an issue you own

When you are the one working on an issue (assigned to it, or asked to take it over), attach it once, right when you start:

\`\`\`ts
await okidoki.linear.attachIssue({ issue: 'ENG-123' });
\`\`\`

This opens a Okidoki agent session on the issue, like delegating it to Okidoki: your progress and final responses stream into it, replies there reach this workspace, and the issue moves to In Progress. Attaching the same issue again is a no-op. Do not attach issues you only read, file, or hand to someone else.

## Check access

Call Linear directly; integration listing is optional. If \`okidoki.integrations.list()\` returns a 5xx or \`Internal server error\`, skip it and continue through \`okidoki.linear.graphql\`.

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const result = await okidoki.linear.graphql({ query: 'query { viewer { id } }' });
if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
\`\`\`

The gateway refreshes expired credentials and retries authentication failures once. Check the response's \`errors\` field before using \`data\`.

Initiatives need the \`initiative:read\` scope, which organizations connected before it was requested do not have. If Linear answers \`Invalid scope\`, ask an admin to reconnect Linear under Organization → Integrations; retrying will not help.

Personal → Connections links a person's Linear identity for agent defaults and attribution. Its disconnected state does not mean the organization's Linear integration is disconnected, and connecting it does not refresh the organization's token. Only recommend reconnecting under Organization → Integrations when the gateway reports missing credentials or an unrecoverable OAuth failure, or when Linear answers \`Invalid scope\`. Report transient failures without asking the user to disconnect.

## Create a ticket

Fetch \`query { teams { nodes { id name key } } }\` and choose the requested team's ID. Look up IDs for any requested assignee, state, cycle, or labels rather than inventing them.

\`\`\`ts
const created = await okidoki.linear.graphql({
  query: \`mutation($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier title url } }
  }\`,
  variables: { input: { teamId, title, description } },
});
\`\`\`

When this workspace's user has linked their Linear account, the gateway fills in \`createAsUser\` and \`displayIconUrl\` so the ticket shows them as its creator. Don't set those yourself.

Responses retain Linear's GraphQL \`data\` and \`errors\` fields. Check \`errors\` and \`data.issueCreate.success\` before reporting creation, then return the issue URL. After an ambiguous timeout, search for the issue before retrying creation to avoid duplicates.

## Fetch an issue

\`\`\`ts
const issue = await okidoki.linear.graphql({
  query: \`query($identifier: String!) {
    issue(id: $identifier) {
      id identifier title description state { id name } assignee { name }
      parent { identifier title description }
    }
  }\`,
  variables: { identifier: 'ENG-123' },
});
\`\`\`

For a link such as \`https://linear.app/acme/issue/ENG-123/fix-login\`, the identifier is the path segment after \`/issue/\` (\`ENG-123\`).

## Update and comment in one script

\`\`\`ts
await okidoki.linear.graphql({
  query: \`mutation($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
  }\`,
  variables: { issueId, stateId },
});
await okidoki.linear.graphql({
  query: \`mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
  }\`,
  variables: { issueId, body: 'Implemented in PR #123.' },
});
\`\`\`

Search with \`containsIgnoreCase: $query\` filters, for example on both \`title\` and \`description\`. Batch independent queries with \`Promise.all\` to save round trips.

## Older workspaces without the SDK

If \`@okidoki/sdk\` cannot be imported, use the same refresh-capable gateway with workspace authentication. Send the GraphQL JSON request on stdin:

\`\`\`bash
curl -sS --fail-with-body -X POST "\${OKIDOKI_MONOLITH_URL:-$MONOLITH_URL}/v1/engine/linear/graphql" \\
  -H "Authorization: Bearer $OKIDOKI_ENGINE_SECRET" \\
  -H "X-Workspace-Id: \${OKIDOKI_WORKSPACE_ID:-$WORKSPACE_ID}" \\
  -H "Content-Type: application/json" \\
  --data-binary @-
\`\`\`

For screenshots, recordings, diagrams, or other media, read \`references/MEDIA.md\` before adding it to an issue or comment. It is the single source of truth for uploading the Okidoki copy and the raw file to Linear; a dashboard link alone is not an inline attachment.
`;

export const LINEAR_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Linear',
  description: 'Create tickets, fetch issues, comment, and update state through @okidoki/sdk.',
  bullet: '- Interacting with Linear (creating tickets, fetching issues including any linear.app link the user shares, updating state, commenting, or troubleshooting authentication): use okidoki.linear.graphql from @okidoki/sdk, which refreshes tokens automatically and needs no Linear MCP server. Read references/LINEAR.md before treating a rejected workspace token as a disconnected integration.',
  section: SECTION,
  referenceFile: { name: 'LINEAR.md', content: REFERENCE },
};
