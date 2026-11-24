import { z } from 'zod';
import { ENGINE_AGENT_PROVIDERS, VALID_THINKING_LEVELS } from './agent';
import { LINEAR_ISSUE_STATE_CHANGED_EVENT } from './automations/linear';
import { automationTriggerSchema } from './automations/trigger-schemas';
import { AUTOMATION_LIFECYCLE_POLICIES, type CreateAutomationRequest } from './automations/types';
import { forkChatRequestSchema } from './chat-fork';
import { createChatRequestSchema, updateChatDisplayNameRequestSchema } from './engine/v1';
import { createEnvironmentDeviceRequestSchema, createEnvironmentMcpRequestSchema, updateEnvironmentMcpRequestSchema } from './routes/environment';
import { applyEnvironmentConfigSourceRequestSchema, previewEnvironmentConfigSourceRequestSchema } from './routes/environment-config-source';
import { workspaceExecRequestSchema } from './routes/workspaces';
import { WORKSPACE_SIZE_OPTIONS } from './sandbox';

export const OKIDOKI_MCP_SERVER_NAME = 'okidoki-mcp';
export const OKIDOKI_MCP_PATH = '/v1/mcp';

export const OKIDOKI_MCP_TOOLS = {
  listEnvironments: 'list_environments',
  createAutomation: 'create_automation',
  spawn: 'spawn_workspace',
  spawnInNewThread: 'spawn_workspace_in_new_thread',
  relay: 'relay_to_workspace',
  listWorkspaces: 'list_workspaces',
  linearStart: 'start_linear_session',
  linearSessionIntent: 'register_linear_session_intent',
  routeLinearTicket: 'route_linear_ticket',
  listChannelSettings: 'list_channel_settings',
  saveChannelPreset: 'save_channel_preset',
  deleteChannelPreset: 'delete_channel_preset',
  updateChannelSettings: 'update_channel_settings',
  setOrganizationProactivity: 'set_organization_proactivity',
  setSlackAgentDefaults: 'set_slack_agent_defaults',
  claimSettingsOffer: 'claim_settings_offer',
  setThreadMuted: 'set_thread_muted',
  stopWorkspace: 'stop_workspace',
  setSlackConnectMuted: 'set_slack_connect_muted',
  setSlackConnectDefaults: 'set_slack_connect_defaults',
  spawnSubagent: 'spawn_subagent',
  messageSubagent: 'message_subagent',
  listSubagents: 'list_subagents',
  readSubagent: 'read_subagent',
  archiveSubagent: 'archive_subagent',
  mergeWhenReady: 'merge_when_ready',
  waitForSubagents: 'wait_for_subagents',
  sendToChat: 'send_to_chat',
  setStatus: 'set_status',
  getLinearRouting: 'get_linear_routing',
  setLinearRouting: 'set_linear_routing',
  clearLinearRouting: 'clear_linear_routing',
  getSlackChannel: 'get_slack_channel',
  linkSlackChannel: 'link_slack_channel',
  createSlackChannel: 'create_slack_channel',
  unlinkSlackChannel: 'unlink_slack_channel',
  setSlackChannelLevel: 'set_slack_channel_level',
  createReplica: 'create_replica',
  listOkidoki: 'list_okidoki',
  getReplica: 'get_replica',
  deleteReplica: 'delete_replica',
  wakeReplica: 'wake_replica',
  sleepReplica: 'sleep_replica',
  archiveReplica: 'archive_replica',
  waitForReplica: 'wait_for_replica',
  runCommand: 'run_command',
  getReplicaHooks: 'get_replica_hooks',
  whoami: 'whoami',
  sendReplicaMessage: 'send_replica_message',
  readReplicaHistory: 'read_replica_history',
  listChats: 'list_chats',
  createChat: 'create_chat',
  deleteChat: 'delete_chat',
  listRepositories: 'list_repositories',
} as const;

export const automationToolInputSchema = z.object({
  name: z.string().describe('Short automation name.'),
  prompt: z.string().describe('Prompt each automation run starts with.'),
  environment_id: z.string().describe(`Environment id from \`${OKIDOKI_MCP_TOOLS.listEnvironments}\`.`),
  triggers: z.array(automationTriggerSchema).min(1).describe(
    `One or more triggers. Cron: \`{ "type": "cron", "config": { "schedule": "0 9 * * 1", "timezone": "America/New_York" } }\`. GitHub: \`{ "type": "github", "config": { "event": "pull_request.opened", "repository_ids": ["<repository uuid>"] } }\`. Linear: \`{ "type": "linear", "config": { "event": "${LINEAR_ISSUE_STATE_CHANGED_EVENT}", "state_types": ["completed"] } }\`.`,
  ),
  description: z.string().optional().describe('One-line summary shown in the dashboard.'),
  goal_mode: z.boolean().optional(),
  fast_mode: z.boolean().optional(),
  workspace_lifecycle_policy: z.enum(AUTOMATION_LIFECYCLE_POLICIES).optional().describe(
    'What happens to a run\'s workspace when the agent finishes. `delete_when_done` (default, except one-time runs, which default to `default`) when the output lives elsewhere (PR comments, checks, Slack posts); `sleep_when_done` when later runs reuse the workspace, like one per PR across pushes; `default` (keep alive) when people follow up in the workspace.',
  ),
});

const credentialUserIdDescription = (
  `Organization automations only: the user ID (see \`${OKIDOKI_MCP_TOOLS.whoami}\`) of the member whose coding agent credentials, such as their Claude subscription, runs use before the organization's. Only your workspace's owner, or whoever's credentials this workspace runs on.`
);

const automationBackgroundSchema = z.boolean().optional().describe(
  "Marks this as an AI agent's own automation (a reminder, follow-up or recurring check-in for its task). Kept out of the main automations list.",
);

export const automationCreateToolInputSchema = automationToolInputSchema.extend({
  credential_user_id: z.string().optional().describe(`${credentialUserIdDescription} Omit to use the organization's.`),
  background: automationBackgroundSchema,
  scope: z.enum(['org', 'user']).optional().describe('`org` (default) or `user` for a personal automation, which needs a personal API key.'),
});

export const automationUpdateToolInputSchema = automationToolInputSchema.partial().extend({
  automation_id: z.string().describe('Automation ID'),
  enabled: z.boolean().optional(),
  agent_provider: z.enum(ENGINE_AGENT_PROVIDERS).nullable().optional(),
  model: z.string().nullable().optional(),
  thinking_level: z.enum(VALID_THINKING_LEVELS).nullable().optional(),
  workspace_size: z.enum(WORKSPACE_SIZE_OPTIONS).optional(),
  credential_user_id: z.string().nullable().optional().describe(`${credentialUserIdDescription} Null switches back to the organization's.`),
  background: automationBackgroundSchema,
  scope: z.literal('org').optional().describe('`org` moves a personal automation to the organization so teammates can see and edit it. It cannot be moved back.'),
});

const chatPath = { id: z.string().describe('Workspace ID'), chat_id: z.string().describe('Chat ID') };
const { provider, model, thinkingLevel, title, message } = forkChatRequestSchema.shape;
export const createChatToolInputSchema = z.object({ id: chatPath.id, provider, title: createChatRequestSchema.shape.title });
export const forkChatToolInputSchema = z.object({ ...chatPath, provider, model, thinking_level: thinkingLevel, title, message });
export const renameChatToolInputSchema = z.object({ ...chatPath, display_name: updateChatDisplayNameRequestSchema.shape.displayName });

export const runCommandToolInputSchema = z.object({ id: chatPath.id, ...workspaceExecRequestSchema.shape });
const environmentMcpPath = { environment_id: z.string().describe('Environment ID') };
export const createEnvironmentMcpToolInputSchema = z.object({ ...environmentMcpPath, ...createEnvironmentMcpRequestSchema.shape });
export const updateEnvironmentMcpToolInputSchema = z.object({
  ...environmentMcpPath,
  mcp_id: z.string().describe('MCP ID'),
  ...updateEnvironmentMcpRequestSchema.shape,
});

export const createEnvironmentDeviceToolInputSchema = z.object({ ...environmentMcpPath, ...createEnvironmentDeviceRequestSchema.shape });

export function automationRequestFromToolInput(automation: z.infer<typeof automationToolInputSchema>): CreateAutomationRequest {
  return { ...automation, scope: 'org' };
}

export const previewEnvironmentConfigSourceToolInputSchema = previewEnvironmentConfigSourceRequestSchema.safeExtend(environmentMcpPath);
export const applyEnvironmentConfigSourceToolInputSchema = applyEnvironmentConfigSourceRequestSchema.safeExtend(environmentMcpPath);
