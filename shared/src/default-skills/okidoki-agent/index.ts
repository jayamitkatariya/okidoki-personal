import {
  OKIDOKI_AGENT_ABILITIES,
  OKIDOKI_AGENT_ABILITY_REGISTRY,
  type OkidokiAgentAbility,
} from './registry';
import type { OkidokiAgentSkillFile } from './types';
import type { ConnectedIntegrations } from '../../prompts';

export {
  OKIDOKI_AGENT_ABILITIES,
  OKIDOKI_AGENT_ABILITY_REGISTRY,
} from './registry';
export type {
  OkidokiAgentAbility,
  OkidokiAgentAbilityFlags,
} from './registry';
export type {
  OkidokiAgentAbilityDescriptor,
  OkidokiAgentReferenceFile,
  OkidokiAgentSkillFile,
} from './types';

const FRONTMATTER = `---
name: okidoki-agent
description: Guide for background coding agents running inside Okidoki cloud workspaces
---`;

const PREAMBLE = `# Okidoki Agent

You are a background coding agent running inside a Okidoki cloud workspace (a remote VM). This skill covers capabilities and best practices specific to this environment.

## Capabilities

This skill provides detailed guides for the following capabilities. **Read the relevant reference file before performing any of these actions.**`;

const FOOTER = `For *questions about how Okidoki works* (concepts, pricing, what a feature does), check https://docs.okidoki.dev first and only fall back to this skill when the user is asking you to take an action.`;

// GitHub stays on: repos can be cloned without our integration (public ones), and `gh` still applies to them.
const INTEGRATION_ABILITIES: Partial<Record<OkidokiAgentAbility, (integrations: ConnectedIntegrations) => boolean>> = {
  github: () => true,
  gitlab: ({ native }) => native.gitlab,
  linear: ({ native }) => native.linear,
  plugins: ({ plugins }) => plugins.some((plugin) => plugin.connected),
  sentry: ({ native }) => native.sentry,
  slack: ({ native }) => native.slack,
};

// Teaching an unconnected integration sends the agent to a gateway with no credentials, past any token the customer set up themselves.
export function filterConnectedOkidokiAgentAbilities(
  abilities: ReadonlyArray<OkidokiAgentAbility>,
  integrations?: ConnectedIntegrations,
): OkidokiAgentAbility[] {
  return abilities.filter((ability) => !integrations || (INTEGRATION_ABILITIES[ability]?.(integrations) ?? true));
}

const INTEGRATIONS_SECTION = `### TypeScript integrations
Use the workspace-scoped \`@okidoki/sdk\` library for connected services. It batches naturally and never exposes Composio or provider credentials.

**Reference:** \`references/INTEGRATIONS.md\``;

const INTEGRATIONS_REFERENCE = `# TypeScript Integrations

Import \`okidoki\` from \`@okidoki/sdk\`. The library authenticates the current workspace; never inspect integration environment variables, request raw credentials, or invent organization, user, session, scope, or account IDs.

Use \`okidoki.integrations.list()\` for discovery, not as a required preflight for known service APIs. If listing returns a 5xx or \`Internal server error\`, skip it and call the known direct SDK service API (for example, \`okidoki.linear.graphql\` or \`okidoki.slack.call\`) with workspace authentication. A listing failure does not mean an integration is disconnected. Only recommend reconnecting when the direct gateway reports missing credentials or an unrecoverable authentication failure.

Write each disposable script to a new \`mktemp\` file, since other chats share this machine's \`/tmp\`. Run it with Bun, print only the result the user needs, and remove it afterward:

\`\`\`bash
script=$(mktemp --suffix=.ts)
bun "$script"
rm "$script"
\`\`\`

Combine independent calls with \`Promise.all\`. Keep dependent filtering, joins, and aggregation inside one script so the agent does not spend a separate model turn on every provider call. Expected provider and connection failures are thrown as errors with a safe message; handle them or report the connection action the user needs.
`;

// Canonical ability order so the composed SKILL.md reads identically across
// orgs that enabled the same subset.
export function buildOkidokiAgentSkill(params: {
  abilities: ReadonlyArray<OkidokiAgentAbility>;
}): OkidokiAgentSkillFile[] {
  const enabled = new Set<OkidokiAgentAbility>(params.abilities);
  const orderedEnabled = OKIDOKI_AGENT_ABILITIES.filter((a) => enabled.has(a));

  const hasIntegrations = orderedEnabled.some((ability) => ability in INTEGRATION_ABILITIES);
  const sections = [
    hasIntegrations ? INTEGRATIONS_SECTION : '',
    ...orderedEnabled.map((a) => OKIDOKI_AGENT_ABILITY_REGISTRY[a].section),
  ].filter(Boolean).join('\n\n');
  const skillMd = [FRONTMATTER, PREAMBLE, sections, FOOTER].filter(Boolean).join('\n\n') + '\n';

  const files: OkidokiAgentSkillFile[] = [{ path: 'SKILL.md', content: skillMd }];
  if (hasIntegrations) files.push({ path: 'references/INTEGRATIONS.md', content: INTEGRATIONS_REFERENCE });
  for (const a of orderedEnabled) {
    const ref = OKIDOKI_AGENT_ABILITY_REGISTRY[a].referenceFile;
    files.push({ path: `references/${ref.name}`, content: ref.content });
  }
  return files;
}
