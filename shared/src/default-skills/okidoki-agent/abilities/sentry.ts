import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Sentry
Read issues and project data through the workspace-scoped TypeScript SDK.

**Reference:** \`references/SENTRY.md\`

Use this when:
- A user shares a Sentry link (sentry.io or a self-hosted Sentry server)
- You need to inspect Sentry projects or issues
- A user asks for error-monitoring context outside a webhook-triggered task`;

const REFERENCE = `# Sentry Integration

Use \`@okidoki/sdk\`; never request or read a Sentry token. Sentry access is organization-scoped and read-only.

Call Sentry directly; integration listing is optional. If \`okidoki.integrations.list()\` returns a 5xx or \`Internal server error\`, skip it and continue through \`okidoki.sentry.request\`. Only recommend reconnecting when the direct gateway reports missing credentials or an unrecoverable authentication failure.

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const issues = await okidoki.sentry.request('/organizations/acme/issues/?query=is:unresolved');
\`\`\`

## Read a pasted issue link

Map the link to API paths instead of fetching the page. For \`https://acme.sentry.io/issues/4512345678/?project=123\` or \`https://sentry.io/organizations/acme/issues/4512345678/\`, the organization slug is \`acme\` and the issue ID is \`4512345678\`:

\`\`\`ts
const issue = await okidoki.sentry.request('/organizations/acme/issues/4512345678/');
const latest = await okidoki.sentry.request('/organizations/acme/issues/4512345678/events/latest/');
\`\`\`

Self-hosted Sentry links work the same way: for \`https://sentry.example.com/organizations/acme/issues/4512345678/\`, request \`/organizations/acme/issues/4512345678/\`. The gateway sends it to the organization's connected Sentry server.

A link ending in \`/events/<eventId>/\` names a specific event: \`/organizations/acme/issues/4512345678/events/<eventId>/\`. Resolve a short ID such as \`BACKEND-1A2\` with \`/organizations/acme/shortids/BACKEND-1A2/\`. The event's \`entries\` hold the stack trace and breadcrumbs.

Pass only a relative Sentry API path. The Okidoki gateway selects the connected organization credential and rejects writes, absolute URLs, oversized responses, and long-running requests.
`;

export const SENTRY_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Sentry',
  description: 'Read Sentry projects and issues through @okidoki/sdk.',
  bullet: '- Interacting with Sentry (reading projects, issues, and error context, including any Sentry issue link the user shares): use okidoki.sentry.request from @okidoki/sdk. Read references/SENTRY.md to turn an issue link into API paths.',
  section: SECTION,
  referenceFile: { name: 'SENTRY.md', content: REFERENCE },
};
