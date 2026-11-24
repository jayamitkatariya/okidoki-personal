import {
  SLACK_BLOCK_KIT_GUIDANCE,
  SLACK_CONCISE_REPLY_SHAPE,
  SLACK_PR_BUTTON_GUIDANCE,
  SLACK_QUOTE_REPLY_GUIDANCE,
} from '../../../slack-response-style';
import type { OkidokiAgentAbilityDescriptor } from '../types';

const SECTION = `### Slack
Send messages, read threads, search conversations, and transfer files through the workspace-scoped TypeScript SDK.

**Reference:** \`references/SLACK.md\`

Use this when:
- You need to send a message to a Slack channel or thread
- You need to read or search Slack conversations
- You need to download a file attached to a Slack message
- You encounter a Slack message link and need its full thread`;

const REFERENCE = `# Slack Integration

Use \`@okidoki/sdk\`; never read or send a Slack token directly. The SDK calls Okidoki, which selects only this workspace's organization connection.

Call Slack directly; integration listing is optional. If \`okidoki.integrations.list()\` returns a 5xx or \`Internal server error\`, skip it and continue through \`okidoki.slack.call\`. Only recommend reconnecting when the direct gateway reports missing credentials or an unrecoverable authentication failure.

## Read a thread

For a link such as \`https://team.slack.com/archives/C0123ABC/p1234567890123456\`, the channel is \`C0123ABC\` and the timestamp is \`1234567890.123456\`.

\`\`\`ts
import { okidoki } from '@okidoki/sdk';

const thread = await okidoki.slack.call('conversations.replies', {
  channel: 'C0123ABC',
  ts: '1234567890.123456',
  limit: 200,
});
\`\`\`

## Download a file

Pass a Slack file object's \`url_private_download\` to the authenticated download helper. Provider credentials stay behind the workspace gateway.

\`\`\`ts
const response = await okidoki.slack.download(file.url_private_download);
await Bun.write('/tmp/recording.mov', response);
\`\`\`

## Send and attach a message

Write like a teammate, not a report. A routine update is ${SLACK_CONCISE_REPLY_SHAPE}.

${SLACK_QUOTE_REPLY_GUIDANCE}

${SLACK_BLOCK_KIT_GUIDANCE}

\`\`\`ts
const message = await okidoki.slack.call<{ channel: string; ts: string }>('chat.postMessage', {
  channel: 'C0123ABC',
  text: 'Update from Okidoki',
});
await okidoki.slack.attachThread({ channel: message.channel, threadTs: message.ts });
\`\`\`

${SLACK_PR_BUTTON_GUIDANCE}

For screenshots, recordings, diagrams, or other media, read \`references/MEDIA.md\` before posting. It is the single source of truth for uploading the Okidoki copy and the raw file to Slack; a dashboard link in \`text\` is not an inline attachment.

Attach every new top-level conversation so future replies route to this workspace. For a reply in another thread, attach its root \`thread_ts\`, not the reply timestamp. Do not attach the originating thread again.

## Search and batch

\`\`\`ts
const [messages, users] = await Promise.all([
  okidoki.slack.call('search.messages', { query: 'launch status' }),
  okidoki.slack.call('users.list', { limit: 200 }),
]);
\`\`\`

Supported methods cover conversations, messages, search, users, reactions, and Slack's external file-upload flow. An unsupported method is rejected by Okidoki before Slack is called.

## Older workspaces without the SDK

If \`@okidoki/sdk\` cannot be imported, use the gateway with workspace authentication. Send JSON containing \`method\` and \`arguments\` on stdin, for example \`{"method":"conversations.list","arguments":{"limit":3,"types":"public_channel"}}\`:

\`\`\`bash
curl -sS --fail-with-body -X POST "\${OKIDOKI_MONOLITH_URL:-$MONOLITH_URL}/v1/engine/slack/api" \\
  -H "Authorization: Bearer $OKIDOKI_ENGINE_SECRET" \\
  -H "X-Workspace-Id: \${OKIDOKI_WORKSPACE_ID:-$WORKSPACE_ID}" \\
  -H "X-Okidoki-Chat-Id: \${OKIDOKI_CHAT_ID:-}" \\
  -H "Content-Type: application/json" \\
  --data-binary @-
\`\`\`
`;

export const SLACK_ABILITY: OkidokiAgentAbilityDescriptor = {
  label: 'Slack',
  description: 'Send messages, read threads, search, and transfer files through @okidoki/sdk.',
  bullet: '- Interacting with Slack (listing channels, sending messages, reading threads, or searching): use okidoki.slack.call from @okidoki/sdk. Read references/SLACK.md; no Slack MCP server or provider token in the VM is required.',
  section: SECTION,
  referenceFile: { name: 'SLACK.md', content: REFERENCE },
};
