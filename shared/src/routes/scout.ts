import { z } from 'zod';
import {
  SCOUT_PRESET_ICONS,
  SCOUT_PRESET_NAME_MAX_LENGTH,
  SCOUT_PROACTIVITY_LEVELS,
  SCOUT_SETTINGS_OFFERS,
  SCOUT_SOURCE_TYPES,
  getScoutSourceId,
  type ScoutMonitoredSource,
  type ScoutPreset,
  type ScoutProactivity,
  type ScoutSlackConnectDefaults,
} from '../scout';
import { VALID_AGENT_PROVIDERS, VALID_THINKING_LEVELS } from '../agent';
import { OKIDOKI_MCP_TOOLS, automationToolInputSchema } from '../okidoki-mcp';
import { isRecord } from '../type-guards';

export const SCOUT_LINEAR_ACTIONS = ['ask', 'start'] as const;
// Stored Linear session statuses. `mothership` here is Scout's name from before it was renamed, not a Manager.
export const SCOUT_LINEAR_AWAITING_INPUT_STATUS = 'mothership_awaiting_input';
export const SCOUT_LINEAR_STARTING_STATUS = 'mothership_starting';
export type ScoutLinearAction = (typeof SCOUT_LINEAR_ACTIONS)[number];
/** Already posted in Linear comments, so they keep Scout's old name, `mothership`. */
export const SCOUT_LINEAR_COMMENT_MARKERS = {
  ask: '<!-- okidoki:mothership-ask -->',
  start: '<!-- okidoki:mothership-start -->',
} satisfies Record<ScoutLinearAction, string>;

export const scoutLinearSessionIntentRequestSchema = z.object({
  comment_id: z.string().trim().min(1).describe('Id of the Linear comment the session will be created on.'),
  action: z.enum(SCOUT_LINEAR_ACTIONS).describe('`ask` when the comment is a clarifying question, `start` when it hands off the task.'),
});

export const scoutLinearStartRequestSchema = z.object({
  issue_id: z.string().describe("Linear issue id from the envelope's `issue_id`."),
  agent_session_id: z.string().describe("Existing Linear agent session id from the envelope's `agent_session_id`."),
  prompt: z.string().trim().min(1).describe("The latest request, in its author's words. The workspace already receives the issue and its comments."),
});

export const scoutRouteLinearTicketRequestSchema = z.object({
  agent_session_id: z.string().trim().min(1).describe("The ticket's `agent_session_id` from the envelope."),
  environment_id: z.string().trim().min(1).optional().describe('Start the ticket in this environment.'),
  manager_id: z.string().trim().min(1).optional().describe('Hand the ticket to this Manager instead.'),
}).refine((args) => !(args.environment_id && args.manager_id), 'Pass environment_id or manager_id, not both.');

export interface UpdateScoutSettingsRequest {
  sources: ScoutMonitoredSource[];
  presets: ScoutPreset[];
  /** The organization's default level. Omit to keep it. */
  proactivity?: ScoutProactivity;
  /** Mutes every Slack Connect channel without its own setting. Omit to keep it. */
  mute_slack_connect?: boolean;
  slack_connect_defaults?: ScoutSlackConnectDefaults;
}

export interface ScoutSettingsResponse extends UpdateScoutSettingsRequest {
  proactivity: ScoutProactivity;
  mute_slack_connect: boolean;
  slack_connect_defaults: ScoutSlackConnectDefaults;
}

export function parseScoutSettings(value: unknown): UpdateScoutSettingsRequest | null {
  if (!isRecord(value) || !Array.isArray(value.sources) || !Array.isArray(value.presets)) return null;
  const proactivity = value.proactivity === undefined ? undefined : SCOUT_PROACTIVITY_LEVELS.find((level) => level === value.proactivity);
  if (value.proactivity !== undefined && !proactivity) return null;
  if (value.mute_slack_connect !== undefined && typeof value.mute_slack_connect !== 'boolean') return null;
  const defaults = value.slack_connect_defaults;
  const defaultProactivity = isRecord(defaults) ? SCOUT_PROACTIVITY_LEVELS.find((level) => level === defaults.proactivity) : undefined;
  if (defaults !== undefined && (
    !isRecord(defaults) ||
    (defaults.preset_id !== undefined && typeof defaults.preset_id !== 'string') ||
    (defaults.instructions !== undefined && typeof defaults.instructions !== 'string') ||
    (defaults.proactivity !== undefined && !defaultProactivity)
  )) return null;
  const sourceIds = new Set<string>();
  const sources: ScoutMonitoredSource[] = [];
  for (const source of value.sources) {
    if (!isRecord(source)) return null;
    const sourceType = SCOUT_SOURCE_TYPES.find((type) => type === source.source);
    const sourceProactivity = source.proactivity === undefined
      ? undefined
      : SCOUT_PROACTIVITY_LEVELS.find((level) => level === source.proactivity);
    if (
      !sourceType ||
      (source.proactivity !== undefined && (!sourceProactivity || sourceType !== 'slack')) ||
      typeof source.external_id !== 'string' ||
      !source.external_id.trim() ||
      (source.instructions !== undefined && typeof source.instructions !== 'string') ||
      (source.preset_id !== undefined && typeof source.preset_id !== 'string') ||
      (source.muted !== undefined && (typeof source.muted !== 'boolean' || sourceType !== 'slack'))
    ) return null;
    const id = getScoutSourceId(sourceType, source.external_id);
    if (sourceIds.has(id)) return null;
    sourceIds.add(id);
    sources.push({
      source: sourceType,
      external_id: source.external_id,
      ...(source.instructions !== undefined ? { instructions: source.instructions } : {}),
      ...(source.preset_id !== undefined ? { preset_id: source.preset_id } : {}),
      ...(sourceProactivity ? { proactivity: sourceProactivity } : {}),
      ...(typeof source.muted === 'boolean' ? { muted: source.muted } : {}),
    });
  }

  const presetIds = new Set<string>();
  const presets: ScoutPreset[] = [];
  for (const preset of value.presets) {
    if (!isRecord(preset)) return null;
    const icon = preset.icon === undefined
      ? undefined
      : SCOUT_PRESET_ICONS.find((candidate) => candidate === preset.icon);
    if (
      typeof preset.id !== 'string' ||
      !preset.id.trim() ||
      preset.id === 'custom' ||
      preset.id !== preset.id.trim() ||
      typeof preset.name !== 'string' ||
      !preset.name.trim() ||
      preset.name.length > SCOUT_PRESET_NAME_MAX_LENGTH ||
      typeof preset.instructions !== 'string' ||
      (preset.icon !== undefined && !icon) ||
      (preset.description !== undefined && typeof preset.description !== 'string') ||
      presetIds.has(preset.id)
    ) return null;
    presetIds.add(preset.id);
    presets.push({
      id: preset.id,
      name: preset.name,
      instructions: preset.instructions,
      ...(icon ? { icon } : {}),
      ...(preset.description !== undefined ? { description: preset.description } : {}),
    });
  }
  if ([...sources, ...(isRecord(defaults) ? [defaults] : [])].some((source) => typeof source.preset_id === 'string' && source.preset_id && !presetIds.has(source.preset_id))) return null;
  return {
    sources,
    presets,
    ...(proactivity ? { proactivity } : {}),
    ...(typeof value.mute_slack_connect === 'boolean' ? { mute_slack_connect: value.mute_slack_connect } : {}),
    ...(isRecord(defaults) ? {
      slack_connect_defaults: {
        ...(typeof defaults.preset_id === 'string' && defaults.preset_id ? { preset_id: defaults.preset_id } : {}),
        ...(typeof defaults.instructions === 'string' && defaults.instructions.trim() ? { instructions: defaults.instructions } : {}),
        ...(defaultProactivity ? { proactivity: defaultProactivity } : {}),
      },
    } : {}),
  };
}

export interface ScoutChannel {
  chat_id: string;
  type: string;
  channel_id: string;
  label?: string;
}

export interface ScoutChannelsResponse {
  channels: ScoutChannel[];
}

export interface ScoutSlackMonitoredChannel {
  channel_id: string;
  instructions?: string;
  preset_id?: string;
}

export interface ScoutSlackChannelsResponse extends UpdateScoutSlackChannelsRequest {
  /** Legacy mirror of `channels`, for clients that read only channel ids. */
  channel_ids: string[];
}

export interface UpdateScoutSlackChannelsRequest {
  channels: ScoutSlackMonitoredChannel[];
  presets: ScoutPreset[];
}


const slackChannelIdSchema = z.string().describe("Slack channel id from the envelope's `channel_id`.");
const slackThreadTsSchema = z.string().describe("Slack thread timestamp from the envelope's `thread_ts`.");

const scoutSlackMessageReferenceSchema = z.object({
  channel_id: slackChannelIdSchema,
  thread_ts: slackThreadTsSchema,
  message_ts: z.string().describe("The envelope's `message_ts`. The server verifies this message and its author."),
  user_id: z.string().describe("Slack user id of that message's author (the envelope's `user_id`)."),
});

export type ScoutSlackMessageReference = z.infer<typeof scoutSlackMessageReferenceSchema>;

export function isScoutSlackMessageReference(value: unknown): value is ScoutSlackMessageReference {
  return scoutSlackMessageReferenceSchema.safeParse(value).success;
}

export const scoutSlackSpawnRequestSchema = z.object({
  channel_id: slackChannelIdSchema,
  thread_ts: slackThreadTsSchema,
  message_ts: z.string().describe("Timestamp of the Slack message that asked for the work (the envelope's `message_ts`). The server verifies this message and its author."),
  user_id: z.string().describe("Slack user id of that message's author (the envelope's `user_id`). The workspace is attributed to them."),
  prompt: z.string().describe("The person's request in their own words, quoting earlier messages only when it points to them. The workspace already receives the Slack thread, so add no research, plan, or guesses."),
  acknowledgement_ts: z.string().optional().describe('`ts` of the one-line reply you posted in this thread before spawning. The server appends the workspace link to it and tells the workspace not to acknowledge again.'),
  environment_id: z.string().optional().describe(`Environment id from \`${OKIDOKI_MCP_TOOLS.listEnvironments}\`. Pass it only when clearly confident it fits; omit it to let routing choose. If routing cannot choose, the call fails and nothing is posted, so pick one or ask the person.`),
});

export const scoutSlackSpawnInNewThreadRequestSchema = scoutSlackSpawnRequestSchema.extend({
  title: z.string().trim().min(1).max(500).describe('One or two sentences stating the task, posted as the new top-level message.'),
  prompt: z.string().describe("The person's request in their own words. The full source thread is attached as background, so add no summary, research, plan, or guesses."),
  acknowledgement_ts: z.string().optional().describe('`ts` of the one-line reply you posted in this thread before spawning. The server appends the new thread\'s link to it.'),
});

export const scoutSlackRelayRequestSchema = z.object({
  channel_id: slackChannelIdSchema,
  thread_ts: slackThreadTsSchema,
  message: z.string().describe("The follow-up to deliver: every fresh message that belongs to this update, in its author's words, with no research, plan, or guesses added. When forwarding to a `workspace_id` other than the thread's own workspace, also quote exactly the thread messages the request points to (\"forward this\"), since that workspace gets only this message."),
  user_id: z.string().optional().describe("Slack user id of the follow-up's author (the envelope's `user_id`), so it is attributed to them. Defaults to the thread's original requester. Required with `workspace_id`."),
  queue: z.boolean().optional().describe('Set true only when the person explicitly asked for this to happen after the current task finishes. Delivers behind the active turn instead of interrupting it.'),
  workspace_id: z.string().optional().describe(`Existing workspace id, from \`${OKIDOKI_MCP_TOOLS.listWorkspaces}\` or a workspace link in the thread, to bind a thread without a workspace to before relaying. The author must be able to see it. Binding a Manager gives it the person's own Slack message and the thread instead of \`message\`. In a thread already bound to a different workspace, or in a Manager's channel, nothing is bound: the workspace or Manager gets only \`message\`, once, with a link back to Slack, and the thread stays where it is. Omit to relay into the thread's own workspace.`),
  message_ts: z.string().optional().describe("Timestamp of the Slack message that led to this relay (the envelope's `message_ts`). Required with `workspace_id`; the server verifies this message and its author."),
});

export const scoutSlackSetThreadMutedRequestSchema = z.object({
  channel_id: slackChannelIdSchema,
  thread_ts: slackThreadTsSchema,
  muted: z.boolean().describe('true to mute Okidoki in this thread, false to unmute it.'),
});

export const scoutSlackStopWorkspaceRequestSchema = scoutSlackMessageReferenceSchema.extend({
  archive: z.boolean().describe('true only when the person also asked to close or archive the workspace.'),
});

export const scoutListWorkspacesRequestSchema = z.object({
  channel_id: slackChannelIdSchema,
  thread_ts: slackThreadTsSchema,
  message_ts: z.string().describe("The envelope's `message_ts`. The server verifies this message and its author."),
  user_id: z.string().describe("Slack user id of that message's author (the envelope's `user_id`). Only workspaces they can see are listed."),
  query: z.string().trim().min(1).optional().describe('Case-insensitive text to match against workspace and Manager names and pull request URLs.'),
});

const scoutSlackConfirmationSchema = z.object({
  confirmation_channel_id: z.string().describe('`channel_id` from the envelope of the Slack message that asked for or accepted this.'),
  confirmation_thread_ts: z.string().describe("`thread_ts` from that message's envelope."),
  confirmation_message_ts: z.string().describe("`message_ts` from that message's envelope."),
  confirmation_user_id: z.string().describe("`user_id` from that message's envelope."),
});

export const scoutAutomationToolInputSchema = automationToolInputSchema.extend(scoutSlackConfirmationSchema.shape);

const scoutSettingsConfirmationSchema = scoutSlackConfirmationSchema.partial().extend({
  confirmation_dashboard_token: z.string().optional().describe('For a request from a person in the Okidoki dashboard: the `confirmation_dashboard_token` given in that message. Pass it instead of the Slack `confirmation_*` fields; the server authorizes the person who sent it, while it is still the latest message in its chat.'),
});
export type ScoutSettingsConfirmation = z.infer<typeof scoutSettingsConfirmationSchema>;

export const scoutSaveChannelPresetToolInputSchema = scoutSettingsConfirmationSchema.extend({
  preset_id: z.string().optional().describe(`Id of the preset to update, from \`${OKIDOKI_MCP_TOOLS.listChannelSettings}\`. Omit to create a new preset.`),
  name: z.string().trim().min(1).max(SCOUT_PRESET_NAME_MAX_LENGTH).optional().describe('Preset name. Required when creating.'),
  description: z.string().optional().describe('One-line summary of what the preset is for.'),
  icon: z.enum(SCOUT_PRESET_ICONS).optional(),
  instructions: z.string().optional().describe('Complete preset instructions; replaces the existing text. Required when creating.'),
});

export const scoutUpdateChannelSettingsToolInputSchema = scoutSettingsConfirmationSchema.extend({
  source: z.enum(SCOUT_SOURCE_TYPES).optional().describe('Defaults to `slack`.'),
  external_id: z.string().describe('Slack channel id or Linear team id.'),
  monitored: z.boolean().optional().describe('Linear: `true` starts monitoring the team (organization admins only), `false` stops. Slack: kept for older callers; prefer `proactivity`. `false` means `tagged`, and `true` lifts a `tagged` channel back to the organization\'s level. Omit to keep it.'),
  preset_id: z.string().nullable().optional().describe('Preset to assign; `null` removes the preset. Omit to keep it.'),
  instructions: z.string().nullable().optional().describe('Complete channel-specific instructions, applied after the preset; replaces the existing text. `null` clears them. Omit to keep them.'),
  proactivity: z.enum([...SCOUT_PROACTIVITY_LEVELS, 'organization']).optional().describe('Slack only: this channel\'s or group DM\'s own level, overriding the organization\'s here alone. `organization` makes it follow the organization\'s level again. Omit to keep it. 1:1 DMs are always addressed to Okidoki, so they take no level.'),
  silent: z.enum(['on', 'off', 'default']).optional().describe(`Slack only, organization admins only: \`on\` puts this channel in silent mode, where Okidoki reads it and follows its instructions but never posts, reacts, or starts work there. \`off\` turns silent mode off here, \`default\` follows the Slack Connect default from \`${OKIDOKI_MCP_TOOLS.setSlackConnectDefaults}\`. Omit to keep it.`),
  muted: z.enum(['on', 'off', 'default']).optional().describe('Kept for older callers; prefer `silent`.'),
});

export const managerSlackChannelLevelToolInputSchema = scoutSlackConfirmationSchema.extend({
  proactivity: scoutUpdateChannelSettingsToolInputSchema.shape.proactivity.unwrap().describe("This channel's own level. `organization` makes it follow the organization's level again, which a Manager's channel raises to at least `balanced`."),
});

export const scoutSetSlackConnectMutedToolInputSchema = scoutSettingsConfirmationSchema.extend({
  muted: z.boolean().describe('`true` puts every Slack Connect channel without its own setting in silent mode; `false` lets them follow their levels again.'),
});

export const scoutSetSlackConnectDefaultsToolInputSchema = scoutSettingsConfirmationSchema.extend({
  silent: z.boolean().optional().describe('`true` puts every Slack Connect channel without its own setting in silent mode; `false` lets them follow their levels again. Omit to keep it.'),
  muted: z.boolean().optional().describe('Kept for older callers; prefer `silent`.'),
  preset_id: z.string().optional().describe('Preset for every Slack Connect channel without its own preset or instructions; an empty string removes it. Omit to keep it.'),
  instructions: z.string().optional().describe('Complete default instructions, applied after that preset; replaces the existing text. An empty string clears them. Omit to keep them.'),
  proactivity: z.enum([...SCOUT_PROACTIVITY_LEVELS, 'default']).optional().describe('Level for every Slack Connect channel without its own level. `default` returns them to `tagged`. Omit to keep it.'),
});
export type ScoutSetSlackConnectDefaultsToolInput = z.infer<typeof scoutSetSlackConnectDefaultsToolInputSchema>;

export const scoutSetOrganizationProactivityToolInputSchema = scoutSettingsConfirmationSchema.extend({
  proactivity: z.enum(SCOUT_PROACTIVITY_LEVELS).describe(`The level every Slack channel and group DM follows unless it has its own. Slack Connect channels without their own level follow the shared-channel default from \`${OKIDOKI_MCP_TOOLS.setSlackConnectDefaults}\` instead.`),
});

export const scoutDeleteChannelPresetToolInputSchema = scoutSettingsConfirmationSchema.extend({
  preset_id: z.string().describe(`Id of the preset to delete, from \`${OKIDOKI_MCP_TOOLS.listChannelSettings}\`.`),
});

const RESET_TO_DEFAULT = 'default';
const resettable = <T extends z.ZodTypeAny>(schema: T, description: string) =>
  z.union([schema, z.literal(RESET_TO_DEFAULT)]).optional().describe(`${description} \`${RESET_TO_DEFAULT}\` falls back to the organization default. Omit to keep it.`);

export const scoutSetSlackAgentDefaultsToolInputSchema = scoutSettingsConfirmationSchema.extend({
  agent_provider: resettable(z.enum(VALID_AGENT_PROVIDERS), 'Agent for Slack-triggered workspaces. Changing it without `model` resets the model to that agent\'s default.'),
  model: resettable(z.string(), 'Model id for that agent; the default is the agent\'s own.'),
  thinking_level: resettable(z.enum(VALID_THINKING_LEVELS), 'Thinking level.'),
  goal_mode: resettable(z.boolean(), 'Goal mode.'),
  fast_mode: resettable(z.boolean(), 'Fast mode.'),
});

export const scoutClaimSettingsOfferToolInputSchema = z.object({
  channel_id: slackChannelIdSchema,
  kind: z.enum(SCOUT_SETTINGS_OFFERS).describe('`proactivity`: offering a lower level after frustration. `raise_proactivity`: offering a higher level after someone had to @mention you. `instructions`: offering channel instructions or a preset. `organization_proactivity` and `raise_organization_proactivity`: offering to lower or raise the workspace default; only decline them, the server claims them for you.'),
  user_id: z.string().optional().describe("The envelope's `user_id`. Required for `proactivity` and `raise_proactivity`, so the server can say whether they are an organization admin."),
  declined: z.boolean().optional().describe('true when the person declined an offer you already made, so it is not made again.'),
});
