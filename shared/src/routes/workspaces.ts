import { z } from 'zod';
import { isRecord } from '../type-guards';
import { VALID_AGENT_PROVIDERS } from '../agent';
import { createWorkspaceCredentialSchema, type CreateWorkspaceCredentialRequest, type WorkspaceCredentialSelections } from '../workspace-credentials';
import { AUTOMATED_SOURCES, BILLING_BLOCK_TITLES, isUserlessAutomatedWorkspace, type WorkspaceSource } from '../pricing';
import type { RepositoryRecordWithWorkspaceId } from './repositories';
import type { PullRequestRecord } from './pull-requests';
import { managerSubagentSettingsSchema, type ManagerAvatar, type ManagerChosenAvatar, type ManagerIconPreset, type ManagerSubagentSettings, type ManagerSubagentSummary } from './manager';
import type { SandboxProviderId, SshWebSocketTransport, WorkspaceSizeOption } from '../sandbox';
import type { AgentProvider, ThinkingLevel } from '../agent';
import type { NeedsYouItem, WorkspaceAttentionReason } from '../workspace-attention';
import type { AgentAvailability, OkidokiAgentAvailability } from '../agent-availability';
import type { DefaultSkillsPreferences } from './preferences';
import type { SendDeferredChatMessageRequest, SendDeferredChatMessageResponse } from './workspace-deferred-messages';

export const WORKSPACE_STATUSES = ['active', 'sleeping', 'archived', 'preparing', 'error'] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export type WorkspaceSuspendedStatus = Extract<WorkspaceStatus, 'sleeping' | 'archived'>;
export const WORKSPACE_ARCHIVED_MESSAGE = 'Workspace is archived. Restore it to resume work.';
export const WORKSPACE_EXPIRED_MESSAGE = 'This workspace\'s machine was deleted, so it can\'t be restored. Its chats are read-only.';
export const WORKSPACE_RESUME_FAILED_MESSAGE = 'Workspace failed to resume.';
export const WORKSPACE_LAST_ERROR_PREFIX = 'Last error: ';
export const SUPPORT_EMAIL = 'founders@okidoki.dev';
export const WORKSPACE_SANDBOX_LOST_MESSAGE = `This workspace can't be resumed because its sandbox was lost on our side. That shouldn't happen, and we're sorry. Please start a new workspace, and email ${SUPPORT_EMAIL} so we can look into it.`;
export const STALE_PREPARING_MS = 10 * 60_000;
export const WORKSPACE_ORGANIZATION_MISMATCH_CODE = 'workspace_organization_mismatch';

export interface WorkspaceOrganizationMismatchResponse {
  error: string;
  code: typeof WORKSPACE_ORGANIZATION_MISMATCH_CODE;
  organization_id: string;
}

export function isWorkspaceSuspendedStatus(status: string | null | undefined): status is WorkspaceSuspendedStatus {
  return status === 'sleeping' || status === 'archived';
}

export const WORKSPACE_SUSPENDED_REASONS = {
  outOfMinutes: 'out_of_minutes',
  usageLimit: 'usage_limit',
} as const;
export type WorkspaceSuspendedReason = (typeof WORKSPACE_SUSPENDED_REASONS)[keyof typeof WORKSPACE_SUSPENDED_REASONS];

export const WORKSPACE_PAUSED_COPY: Record<WorkspaceSuspendedReason, { title: string; line: string }> = {
  out_of_minutes: {
    title: BILLING_BLOCK_TITLES.INSUFFICIENT_MINUTES,
    line: 'This workspace was paused because your organization used all its included usage. An admin can subscribe or add credits in billing settings.',
  },
  usage_limit: {
    title: BILLING_BLOCK_TITLES.USAGE_LIMIT_REACHED,
    line: 'This workspace was paused because your organization reached its usage limit for this period. An admin can raise or remove it in billing settings.',
  },
};

export const VALID_LIFECYCLE_POLICIES = ['default', 'archive_when_done', 'sleep_when_done', 'delete_when_done', 'delete_after_inactivity'] as const;
export type WorkspaceLifecyclePolicy = (typeof VALID_LIFECYCLE_POLICIES)[number];

export interface WorkspaceWebhookConfig {
  url: string;
  /** Optional shared secret used to compute the `X-Okidoki-Signature` header (`sha256=` HMAC of the raw JSON body). */
  secret?: string;
}

export interface WorkspaceAutomationConfig {
  agent_provider?: AgentProvider | null;
  model?: string | null;
  thinking_level?: ThinkingLevel | null;
  goal_mode?: boolean | null;
  fast_mode?: boolean | null;
}

export interface ResolvedWorkspaceAutomationConfig {
  agent_provider: AgentProvider | null;
  model: string | null;
  thinking_level: ThinkingLevel | null;
  goal_mode: boolean | null;
  fast_mode: boolean | null;
}

export interface WorkspaceMemoryAccess {
  read: boolean;
  write: boolean;
}

export interface WorkspaceConfig {
  memoryRetentionEnabled?: boolean;
  automation?: WorkspaceAutomationConfig;
  capabilities?: {
    pr_followups?: boolean;
    read_only_contents?: boolean;
  };
  internal?: {
    bypass_pr_user_attribution?: boolean;
    integration_gateway?: boolean;
    credential_selections?: WorkspaceCredentialSelections;
    credential_user_id?: string;
    memory_access?: WorkspaceMemoryAccess;
    manager_subagent?: ManagerSubagentSettings;
    scout_version?: number;
    /** The last name Okidoki generated; a different current name was chosen by a person and is never auto-renamed. */
    generated_name?: string;
    /** Kept here, not with the client-editable preferences, so only the owner's local control endpoint can grant it, and it lasts through sleep and wake but not into new workspaces. */
    local_control?: boolean;
  };
  preferences?: {
    keep_open_on_pr_merge?: boolean;
    keep_open_on_pr_close?: boolean;
  };
  provisioning_error?: {
    message?: string;
    /** A failed create deletes its sandbox, so waking can't recover the workspace. */
    sandbox_deleted?: boolean;
    /** The provider lost the sandbox (a host failure, or a resume it can't serve), so the workspace can only be replaced. */
    sandbox_lost?: boolean;
  };
  webhook?: WorkspaceWebhookConfig;
  /** Pins this workspace to an agent-led environment setup run. Internal-only — set solely via createWorkspace's trusted `environmentSetup` param. */
  environment_setup?: {
    run_id: string;
  };
}

export function isWorkspaceSandboxDeleted(config: WorkspaceConfig | undefined): boolean {
  return config?.provisioning_error?.sandbox_deleted === true;
}

export function isWorkspaceExpired(workspace: { status?: string | null; config?: WorkspaceConfig }): boolean {
  return workspace.status === 'archived' && isWorkspaceSandboxDeleted(workspace.config);
}

export function isWorkspaceSandboxLost(config: WorkspaceConfig | undefined): boolean {
  return config?.provisioning_error?.sandbox_lost === true;
}

export function getWorkspaceAutomationConfig(
  config: WorkspaceConfig | null | undefined,
): ResolvedWorkspaceAutomationConfig {
  const automation = config?.automation;
  return {
    agent_provider: automation?.agent_provider ?? null,
    model: automation?.model ?? null,
    thinking_level: automation?.thinking_level ?? null,
    goal_mode: typeof automation?.goal_mode === 'boolean' ? automation.goal_mode : null,
    fast_mode: typeof automation?.fast_mode === 'boolean' ? automation.fast_mode : null,
  };
}

export function workspaceConfigWithAutomation(
  config: WorkspaceConfig | null | undefined,
  automation: WorkspaceAutomationConfig = {},
): WorkspaceConfig {
  const merged = {
    ...config?.automation,
    ...automation,
  };
  const nextAutomation: WorkspaceAutomationConfig = {};
  if (merged.agent_provider != null) nextAutomation.agent_provider = merged.agent_provider;
  if (merged.model != null) nextAutomation.model = merged.model;
  if (merged.thinking_level != null) nextAutomation.thinking_level = merged.thinking_level;
  if (typeof merged.goal_mode === 'boolean') nextAutomation.goal_mode = merged.goal_mode;
  if (typeof merged.fast_mode === 'boolean') nextAutomation.fast_mode = merged.fast_mode;

  const { automation: _automation, ...rest } = config ?? {};
  if (Object.keys(nextAutomation).length === 0) return rest;
  return {
    ...rest,
    automation: nextAutomation,
  };
}

export function workspaceConfigWithCapabilities(
  config: WorkspaceConfig | null | undefined,
  capabilities: WorkspaceConfig['capabilities'] = {}
): WorkspaceConfig {
  const mergedCapabilities = {
    ...config?.capabilities,
    ...capabilities,
  };

  return {
    ...config,
    capabilities: {
      ...mergedCapabilities,
      pr_followups: mergedCapabilities.pr_followups === true,
    },
  };
}

export function hasLocalControl(config: WorkspaceConfig | null | undefined, everyWorkspace: boolean | undefined): boolean {
  return everyWorkspace === true || config?.internal?.local_control === true;
}

export function workspaceConfigWithPreferences(
  config: WorkspaceConfig | null | undefined,
  preferences: WorkspaceConfig['preferences'] = {}
): WorkspaceConfig {
  const legacyCapabilities = config?.capabilities as (WorkspaceConfig['capabilities'] & { keep_open_on_pr_merge?: boolean }) | undefined;
  const legacyPreferences = {
    keep_open_on_pr_merge: legacyCapabilities?.keep_open_on_pr_merge === true,
  };
  const mergedPreferences = {
    ...legacyPreferences,
    ...config?.preferences,
    ...preferences,
  };

  return {
    ...config,
    preferences: {
      ...mergedPreferences,
      keep_open_on_pr_merge: mergedPreferences.keep_open_on_pr_merge === true,
      keep_open_on_pr_close: mergedPreferences.keep_open_on_pr_close === true,
    },
  };
}

export function workspaceConfigWithMemoryAccess(
  config: WorkspaceConfig | null | undefined,
  memoryAccess: WorkspaceMemoryAccess,
): WorkspaceConfig {
  return {
    ...config,
    internal: {
      ...config?.internal,
      memory_access: memoryAccess,
    },
  };
}

function normalizeWorkspaceConfigInternal(
  config: WorkspaceConfig | null | undefined
): WorkspaceConfig['internal'] {
  const internal: WorkspaceConfig['internal'] = {};
  if (config?.internal?.bypass_pr_user_attribution === true) internal.bypass_pr_user_attribution = true;
  if (config?.internal?.integration_gateway === true) internal.integration_gateway = true;
  if (typeof config?.internal?.generated_name === 'string') internal.generated_name = config.internal.generated_name;
  if (typeof config?.internal?.credential_user_id === 'string') internal.credential_user_id = config.internal.credential_user_id;
  if (typeof config?.internal?.scout_version === 'number') internal.scout_version = config.internal.scout_version;
  if (config?.internal?.local_control === true) internal.local_control = true;
  if (
    typeof config?.internal?.memory_access?.read === 'boolean'
    && typeof config.internal.memory_access.write === 'boolean'
  ) {
    internal.memory_access = config.internal.memory_access;
  }
  const storedSubagentSettings = config?.internal?.manager_subagent;
  const subagentSettings = storedSubagentSettings && managerSubagentSettingsSchema.safeParse(storedSubagentSettings);
  if (subagentSettings?.success) internal.manager_subagent = subagentSettings.data;
  for (const provider of VALID_AGENT_PROVIDERS) {
    const stored = config?.internal?.credential_selections?.[provider];
    if (!stored) continue;
    const selection = createWorkspaceCredentialSchema.safeParse({ ...stored, provider });
    if (selection.success) {
      internal.credential_selections ??= {};
      internal.credential_selections[provider] = { method: selection.data.method, scope: selection.data.scope };
    }
  }
  return Object.keys(internal).length > 0 ? internal : undefined;
}

function normalizeWorkspaceConfigEnvironmentSetup(
  config: WorkspaceConfig | null | undefined
): WorkspaceConfig['environment_setup'] {
  const runId = config?.environment_setup?.run_id;
  return typeof runId === 'string' && runId.length > 0 ? { run_id: runId } : undefined;
}

/** Trust boundary: a block missing from this destructure is settable by any client. */
export function withoutInternalWorkspaceConfig(config: WorkspaceConfig): WorkspaceConfig {
  const { internal: _internal, environment_setup: _environmentSetup, ...publicConfig } = config;
  return publicConfig;
}

function normalizeWorkspaceConfigBase(config: unknown): WorkspaceConfig {
  // Lenient boundary: stored and request JSON both land here, and unknown shapes are defaulted rather than rejected.
  const record = isRecord(config) ? config : {};
  const memoryRetentionEnabled = typeof record.memoryRetentionEnabled === 'boolean'
    ? record.memoryRetentionEnabled
    : typeof record.memoryEnabled === 'boolean'
      ? record.memoryEnabled
      : undefined;
  const {
    memoryEnabled: _memoryEnabled,
    memoryRetentionEnabled: _memoryRetentionEnabled,
    ...rest
  } = record;
  return workspaceConfigWithPreferences(workspaceConfigWithCapabilities({
    ...rest,
    ...(memoryRetentionEnabled === undefined ? {} : { memoryRetentionEnabled }),
  }));
}

export function normalizeWorkspaceConfig(config: unknown): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfigBase(config);
  return withoutInternalWorkspaceConfig(normalized);
}

export function normalizeWorkspaceRecordConfig(config: unknown): WorkspaceConfig {
  const normalized = normalizeWorkspaceConfigBase(config);
  const internal = normalizeWorkspaceConfigInternal(normalized);
  const environmentSetup = normalizeWorkspaceConfigEnvironmentSetup(normalized);
  // Strip every server-owned block, then re-graft the validated ones. Returning
  // `normalized` directly would let a client-supplied shape through; dropping a block
  // here silently disables the feature that reads it, since records only ever reach
  // callers via this function.
  return {
    ...withoutInternalWorkspaceConfig(normalized),
    ...(internal ? { internal } : {}),
    ...(environmentSetup ? { environment_setup: environmentSetup } : {}),
  };
}

export function workspaceConfigWithPrFollowups(
  config: WorkspaceConfig | null | undefined,
  prFollowups = config?.capabilities?.pr_followups === true
): WorkspaceConfig {
  return workspaceConfigWithCapabilities(config, { pr_followups: prFollowups });
}

export function applyWorkspaceConfigCreationDefaults(
  config: WorkspaceConfig | null | undefined,
  source: WorkspaceSource,
): WorkspaceConfig {
  return {
    ...config,
    memoryRetentionEnabled: isWorkspaceMemoryRetentionEnabled(config, source),
    capabilities: {
      ...config?.capabilities,
      pr_followups: config?.capabilities?.pr_followups ?? source !== 'automation',
    },
  };
}

export function isWorkspaceMemoryRetentionEnabled(
  config: WorkspaceConfig | null | undefined,
  source: WorkspaceSource,
): boolean {
  return typeof config?.memoryRetentionEnabled === 'boolean'
    ? config.memoryRetentionEnabled
    : !AUTOMATED_SOURCES.includes(source);
}

export function isWorkspaceMemoryReadEnabled(config: WorkspaceConfig | null | undefined): boolean {
  return config?.internal?.memory_access?.read !== false;
}

export function isWorkspaceMemoryWriteEnabled(config: WorkspaceConfig | null | undefined): boolean {
  return config?.internal?.memory_access?.write !== false;
}

export interface WorkspaceRecord {
  id: string;
  user_id: string | null;
  seat_id: string | null;
  organization_id: string;
  name: string;
  sandbox_id: string;
  sandbox_provider: SandboxProviderId;
  engine_url: string | null;
  engine_secret: string;
  github_installation_id: number | null;
  /** Lifecycle/billing clock: wake, sleep, keep-alive, idle suspend, retention. */
  last_activity_at: string | null;
  /** User-intended activity (message sends, agent turns); the workspace list ordering key. */
  last_interaction_at: string | null;
  archived_at: string | null;
  created_at: string;
  status: WorkspaceStatus;
  creation_source: WorkspaceSource;
  creator_email: string | null;
  soft_delete: boolean;
  lifecycle_policy: WorkspaceLifecyclePolicy;
  auto_stop_minutes: number | null;
  config: WorkspaceConfig;
  environment_id: string;
  size: WorkspaceSizeOption | null;
  suspended_reason: WorkspaceSuspendedReason | null;
  parent_workspace_id: string | null;
  parent_chat_id: string | null;
  kind: WorkspaceKind;
  icon: ManagerIconPreset | null;
  avatar: ManagerAvatar | null;
  description: string | null;
  source_link?: {
    source: Extract<WorkspaceSource, 'slack' | 'linear'>;
    url: string;
    label: string;
  };
  /** Populated by single-workspace responses; list responses use `creator_names`. */
  creator_name?: string;
  creator_avatar_url?: string | null;
}

/** A Manager is a long-lived orchestrator that runs every chat with the Manager rules; Scout is the Slack and Linear triage agent. */
export const WORKSPACE_KINDS = ['standard', 'manager', 'mothership', 'scout'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
/** `mothership` is the Manager's name from before the rename: app builds installed before it still send it and are sent it back. */
export const MANAGER_KINDS = ['manager', 'mothership'] as const satisfies readonly WorkspaceKind[];
export const MANAGER_KIND: (typeof MANAGER_KINDS)[number] = 'manager';
export const CREATABLE_WORKSPACE_KINDS = ['standard', ...MANAGER_KINDS] as const satisfies readonly WorkspaceKind[];
/** A client lists the workspace kinds it knows, so the server can keep giving an installed app the names it reads. */
export const KNOWN_WORKSPACE_KINDS_HEADER = 'X-Okidoki-Workspace-Kinds';

/** Bump when running Scouts must be replaced to pick up a change; each older one is replaced on its next message. */
export const SCOUT_WORKSPACE_VERSION = 2;

export function isScoutWorkspace(workspace: { kind: string } | undefined): boolean {
  return workspace?.kind === 'scout';
}

export function isManagerWorkspace(workspace: { kind?: string } | null | undefined): boolean {
  return MANAGER_KINDS.some((kind) => kind === workspace?.kind);
}

export function getWorkspaceCredentialUserId(workspace: Pick<WorkspaceRecord, 'user_id' | 'config'>): string | null {
  return workspace.config.internal?.credential_user_id ?? workspace.user_id;
}

export function getEnvironmentSetupRunId(
  workspace: Pick<WorkspaceRecord, 'config'> | null | undefined,
): string | null {
  return workspace?.config?.environment_setup?.run_id ?? null;
}

/**
 * Workspace creation target. Callers pick an environment; the server derives
 * the repository (or set) from the environment's binding.
 */
export interface CreateWorkspaceRequest {
  credential?: CreateWorkspaceCredentialRequest;
  name?: string;
  environment_id: string;
  repository_branches?: Record<string, string>;
  config?: WorkspaceConfig;
  size?: WorkspaceSizeOption;
  kind?: (typeof CREATABLE_WORKSPACE_KINDS)[number];
  /** Queued in the same request so it is sent even if the client closes before the workspace is ready. */
  message?: Omit<SendDeferredChatMessageRequest, 'chatId' | 'generateName'>;
  support_request_id?: string;
}

export interface CreateWorkspaceResponse {
  workspace: WorkspaceRecord;
  message?: SendDeferredChatMessageResponse;
}

export interface ListWorkspacesResponse {
  workspaces: WorkspaceRecord[];
  workspace_turn_completed_at?: Record<string, string>;
  workspace_repositories?: RepositoryRecordWithWorkspaceId[];
  workspace_pull_requests?: Array<Pick<PullRequestRecord, 'workspace_id' | 'status' | 'url' | 'created_at' | 'merged_at' | 'queued_at' | 'provider_pr_number' | 'head_branch'>>;
  /** Map of workspace ID to resolved creator display name. */
  creator_names?: Record<string, string>;
  creator_avatar_urls?: Record<string, string>;
  /** Map of workspace id → list of users it is shared with (owner-side view). */
  shared_with?: Record<string, WorkspaceShareSummary[]>;
  /** IDs of workspaces in the returned list that are shared WITH the current viewer. */
  viewer_share_ids?: string[];
  /** IDs of workspaces everyone in the organization sees through a Manager shared with the organization. */
  org_shared_ids?: string[];
  contributors?: Record<string, WorkspaceShareSummary[]>;
  viewer_contributed_at?: Record<string, string>;
  workspace_attention?: Record<string, WorkspaceAttention>;
  workspace_message_pending_ids?: string[];
  workspace_subagents?: Record<string, ManagerSubagentSummary[]>;
  /** Missing from servers deployed before this field existed. */
  hasMore?: boolean;
  page: number;
  limit: number;
  totalPages: number;
}

export const nextWorkspaceListPage = (page: ListWorkspacesResponse) =>
  (page.hasMore ?? page.page < page.totalPages) ? page.page + 1 : undefined;

export const WORKSPACE_MESSAGE_SEARCH_QUERY_MAX = 200;

export interface WorkspaceMessageSearchMatch {
  workspace_id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  snippet: string;
  created_at: string;
}

export interface WorkspaceMessageSearchResponse {
  matches: WorkspaceMessageSearchMatch[];
}

export function isWorkspaceUnread(
  turnCompletedAt: string | null | undefined,
  lastViewedAt: string | null | undefined,
): boolean {
  if (!turnCompletedAt) return false;
  const completed = Date.parse(turnCompletedAt);
  const viewed = lastViewedAt ? Date.parse(lastViewedAt) : Number.NaN;
  return Number.isFinite(completed) && (!Number.isFinite(viewed) || completed > viewed);
}

export const withoutMarkedUnread = (ids: string[], workspaceId: string): string[] =>
  ids.includes(workspaceId) ? ids.filter((id) => id !== workspaceId) : ids;

// A workspace that needs you stays bold until answered, and the open one would mark itself read again at once.
export function canToggleWorkspaceUnread({ needsYou, unread, open }: { needsYou: boolean; unread: boolean; open: boolean }) {
  return !needsYou && (unread || !open);
}

export const withMarkedUnread = (ids: string[], workspaceId: string): string[] =>
  ids.includes(workspaceId) ? ids : [...ids, workspaceId];

export const withWorkspaceViewed = (viewed: Record<string, string>, workspaceId: string, completedAt: string): Record<string, string> =>
  isWorkspaceUnread(completedAt, viewed[workspaceId]) ? { ...viewed, [workspaceId]: completedAt } : viewed;

export function isWorkspaceTimestampRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(
      (timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
    );
}

export const normalizeWorkspaceTimestampRecord = (value: unknown): Record<string, string> => (isWorkspaceTimestampRecord(value) ? value : {});

export interface GetWorkspaceResponse {
  workspace: WorkspaceRecord;
  /** Display name of the workspace creator, resolved from auth.users or creator_email. */
  creator_name?: string;
  creator_avatar_url?: string | null;
  default_skills?: DefaultSkillsPreferences;
  attention?: WorkspaceAttention;
}

export interface DeleteWorkspaceResponse {
  success: boolean;
}

export interface ArchiveWorkspaceResponse {
  success: boolean;
}

export interface WakeWorkspaceResponse {
  success: boolean;
}

export interface SleepWorkspaceResponse {
  success: boolean;
}

export const AGENT_AVAILABILITY_QUERY_ROOT = 'agent-availability';

export interface WorkspaceAgentAvailabilityResponse {
  claude: AgentAvailability;
  codex: AgentAvailability;
  cursor: AgentAvailability;
  gemini?: AgentAvailability;
  muse?: AgentAvailability;
  opencode: AgentAvailability;
  pi?: AgentAvailability;
  okidoki?: OkidokiAgentAvailability;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  config?: WorkspaceConfig;
  icon?: ManagerIconPreset;
  /** Manager only. Upload an image avatar with `PUT /v1/workspaces/:id/avatar`. */
  avatar?: ManagerChosenAvatar;
  /** Manager only. An empty string clears it. */
  description?: string;
  /** Manager only, dashboard only: the environment new subagents start in. */
  environment_id?: string;
}

export const MANAGER_DESCRIPTION_MAX_LENGTH = 1000;

export interface UpdateWorkspaceResponse {
  workspace: WorkspaceRecord;
}

export interface UploadWorkspaceCanvasItemResponse {
  filePath: string;
  originalName: string;
  sizeBytes: number;
  uploadId?: string;
}

export const createWorkspaceCanvasUploadRequestSchema = z.object({
  sizeBytes: z.number().int().positive(),
  filename: z.string().min(1),
});
export type CreateWorkspaceCanvasUploadRequest = z.infer<typeof createWorkspaceCanvasUploadRequestSchema>;

export interface CreateWorkspaceCanvasUploadResponse {
  stagingId: string;
  uploadUrl: string;
  headers: Record<string, string>;
}

export const completeWorkspaceCanvasUploadRequestSchema = z.object({ filename: z.string().min(1) });

export interface SshTokenResponse {
  token: string;
  host: string;
  proxyCommand?: string;
  transport?: SshWebSocketTransport;
  /** Whether the signed-in user asking is the workspace's owner. Desktop builds before per-workspace local control link any owned workspace their page lists. */
  owned: boolean;
  /** The asking user owns the workspace and let it run commands on their computer, on its own or with local control in every workspace. */
  local_control: boolean;
  /** Always equals `local_control`; kept because shipped desktop builds connect Mac computer use only when it is true. */
  computer_use: boolean;
}

// Deferred workspace naming
export interface GenerateWorkspaceNameRequest {
  prompt: string;
}

export interface GenerateWorkspaceNameResponse {
  name: string;
}

// --- Workspace sidebar view types ---

export type WorkspaceSidebarView =
  | 'owned'
  | 'shared'
  | 'team'
  | 'automated';

export const WORKSPACE_SIDEBAR_VIEWS: readonly WorkspaceSidebarView[] =
  ['owned', 'shared', 'team', 'automated'];

export const DEFAULT_WORKSPACE_SIDEBAR_VIEWS: readonly WorkspaceSidebarView[] =
  ['owned', 'shared'];

export const RESTRICTED_WORKSPACE_VIEWS: readonly WorkspaceSidebarView[] =
  ['team'];

export function applyWorkspaceVisibilityRestriction(
  viewModes: WorkspaceSidebarView[],
): WorkspaceSidebarView[] {
  const filtered = viewModes.filter((m) => !RESTRICTED_WORKSPACE_VIEWS.includes(m));
  return filtered.length > 0 ? filtered : ['owned'];
}

export type WorkspaceArchiveVisibility = 'include' | 'exclude' | 'only';

export const WORKSPACE_ARCHIVE_VISIBILITIES: readonly WorkspaceArchiveVisibility[] =
  ['include', 'exclude', 'only'];

export type WorkspaceStatusFilter = Exclude<WorkspaceStatus, 'error'> | 'failed';

export const WORKSPACE_STATUS_FILTERS: readonly WorkspaceStatusFilter[] =
  WORKSPACE_STATUSES.map((status) => status === 'error' ? 'failed' : status);

export type WorkspaceActivityFilter = 'any' | 'today' | 'week' | 'month';

export const WORKSPACE_ACTIVITY_FILTERS: readonly WorkspaceActivityFilter[] =
  ['any', 'today', 'week', 'month'];

export interface WorkspaceFilters {
  statuses: WorkspaceStatusFilter[];
  /** Use the `unknown` sentinel to match workspaces without a user_id (api / automation creations). */
  ownerIds: string[];
  activity: WorkspaceActivityFilter;
}

export type WorkspaceSortOption = 'manual' | 'activity' | 'created';

function parseTimestampMs(ts: string | null | undefined): number {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function workspaceActivityMs(
  workspace: Pick<WorkspaceRecord, 'last_interaction_at' | 'created_at'>,
): number {
  return parseTimestampMs(workspace.last_interaction_at ?? workspace.created_at);
}

// Creates insert last_activity_at = created_at; only a wake claim moves it past.
export function isWorkspacePreparingWake(workspace: Pick<WorkspaceRecord, 'status' | 'created_at' | 'last_activity_at'>): boolean {
  return workspace.status === 'preparing' && parseTimestampMs(workspace.last_activity_at) > parseTimestampMs(workspace.created_at);
}

export function compareWorkspacesForSort(
  a: WorkspaceRecord,
  b: WorkspaceRecord,
  sort: WorkspaceSortOption,
): number {
  if (sort === 'created') {
    return parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at);
  }
  return workspaceActivityMs(b) - workspaceActivityMs(a);
}

export function workspaceArchivedMs(workspace: Pick<WorkspaceRecord, 'archived_at'>): number {
  return parseTimestampMs(workspace.archived_at);
}

export function compareArchivedWorkspaces(a: WorkspaceRecord, b: WorkspaceRecord): number {
  return workspaceArchivedMs(b) - workspaceArchivedMs(a);
}

export function compareWorkspacesForHomeActivity(
  a: WorkspaceRecord,
  b: WorkspaceRecord,
  ctx: {
    isPersonal: (workspace: WorkspaceRecord) => boolean;
    waitingSinceMs: (workspace: WorkspaceRecord) => number | null;
  },
): number {
  const aPersonal = ctx.isPersonal(a);
  if (aPersonal !== ctx.isPersonal(b)) return aPersonal ? -1 : 1;
  if (aPersonal) {
    const aWait = ctx.waitingSinceMs(a);
    const bWait = ctx.waitingSinceMs(b);
    if ((aWait !== null) !== (bWait !== null)) return aWait !== null ? -1 : 1;
    if (aWait !== null && bWait !== null && aWait !== bWait) return aWait - bWait;
  }
  return workspaceActivityMs(b) - workspaceActivityMs(a);
}

const DEFAULT_STATUS_FILTERS: readonly WorkspaceStatusFilter[] =
  [...WORKSPACE_STATUS_FILTERS];

export const DEFAULT_WORKSPACE_FILTERS: WorkspaceFilters = {
  statuses: [...DEFAULT_STATUS_FILTERS],
  ownerIds: [],
  activity: 'any',
};

export const WORKSPACE_OWNER_NONE_ID = 'unknown';

function arraysSameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const item of a) if (!setB.has(item)) return false;
  return true;
}

export function isDefaultWorkspaceFilters(filters: WorkspaceFilters): boolean {
  return (
    arraysSameSet(filters.statuses, DEFAULT_STATUS_FILTERS) &&
    filters.ownerIds.length === 0 &&
    filters.activity === 'any'
  );
}

/**
 * Maps a workspace's persisted status to the filter status bucket. The richer
 * sidebar status (which mixes in live engine status) is intentionally not used
 * here: filtering would otherwise depend on whether each workspace's status
 * fetch has resolved yet, which would make the list jitter.
 */
function workspaceStatusFilterFor(
  workspace: Pick<WorkspaceRecord, 'status'>,
): WorkspaceStatusFilter {
  switch (workspace.status) {
    case 'preparing':
      return 'preparing';
    case 'sleeping':
      return 'sleeping';
    case 'archived':
      return 'archived';
    case 'error':
      return 'failed';
    case 'active':
    default:
      return 'active';
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function activityWindowMs(activity: WorkspaceActivityFilter): number | null {
  switch (activity) {
    case 'today': return ONE_DAY_MS;
    case 'week': return 7 * ONE_DAY_MS;
    case 'month': return 30 * ONE_DAY_MS;
    case 'any':
    default:
      return null;
  }
}

export function workspaceMatchesFilters(
  workspace: WorkspaceRecord,
  filters: WorkspaceFilters,
  now: number = Date.now(),
): boolean {
  if (filters.statuses.length > 0) {
    const bucket = workspaceStatusFilterFor(workspace);
    if (!filters.statuses.includes(bucket)) return false;
  }

  if (filters.ownerIds.length > 0 && !isUserlessAutomatedWorkspace(workspace.creation_source, workspace.user_id)) {
    const ownerKey = workspace.user_id ?? WORKSPACE_OWNER_NONE_ID;
    if (!filters.ownerIds.includes(ownerKey)) return false;
  }

  const windowMs = activityWindowMs(filters.activity);
  if (windowMs !== null && now - workspaceActivityMs(workspace) > windowMs) return false;

  return true;
}

// --- Workspace sharing types ---

export interface WorkspaceShareRecord {
  id: string;
  workspace_id: string;
  organization_id: string;
  shared_with_user_id: string;
  shared_by_user_id: string | null;
  created_at: string;
  shared_with_email?: string;
  shared_by_email?: string;
}

export interface WorkspaceAttention {
  chatId: string;
  completedAt: string;
  reason: Extract<WorkspaceAttentionReason, 'question' | 'plan' | 'blocked' | 'deploy_failed'>;
  since: string;
  /** Every chat with an unanswered ask, not just the latest one above. Clients can deploy before the monolith that sends it. */
  waitingChatIds?: string[];
}

export const isWorkspaceAttentionDismissed = (attention: Pick<WorkspaceAttention, 'since'>, dismissedAt: string | undefined): boolean =>
  (dismissedAt ?? '') >= attention.since;

export interface ListNeedsYouResponse {
  items: NeedsYouItem[];
  workspaces: Array<Pick<WorkspaceRecord, 'id' | 'name' | 'kind'>>;
}

export interface WorkspaceShareSummary {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

export interface ShareWorkspaceRequest { user_id: string; }
export interface ShareWorkspaceResponse { share: WorkspaceShareRecord; }
export interface UnshareWorkspaceResponse { success: boolean; }
/** A grant or a contribution (someone who wrote in it); both list the workspace for that person. */
export interface WorkspaceAccess extends WorkspaceShareRecord {
  shared_with: WorkspaceShareSummary;
  shared_by_name: string | null;
  contributed_at: string | null;
}
/** `shared_with_org` is only ever true for a Manager: everyone in the organization sees it and its ships. */
export interface ListWorkspaceSharesResponse { owner: WorkspaceShareSummary | null; shares: WorkspaceAccess[]; shared_with_org: boolean; }

/** An organization-owned workspace has no owner, so anyone with access manages who it is shared with. */
export const canManageWorkspaceAccess = (ownerId: string | null, viewerId: string | null | undefined): boolean =>
  ownerId === null || ownerId === viewerId;

export const describeWorkspaceAccess = (access: Pick<WorkspaceAccess, 'shared_by_user_id' | 'shared_with_user_id' | 'shared_by_name' | 'created_at'>): string => {
  const how = access.shared_by_user_id === null ? 'Sent a message here'
    : access.shared_by_user_id === access.shared_with_user_id ? 'Added it themselves'
    : `Shared by ${access.shared_by_name ?? 'a teammate'}`;
  return `${how} · ${new Date(access.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
};
export interface ShareWorkspaceWithOrgRequest { shared: boolean; }
export interface ShareWorkspaceWithOrgResponse { shared_with_org: boolean; }

export const workspaceExecRequestSchema = z.object({
  command: z.string().regex(/\S/, 'command is required'),
  timeout_seconds: z.number().int().min(1).max(50).optional().describe('Default: 30'),
});
export type WorkspaceExecRequest = z.infer<typeof workspaceExecRequestSchema>;

export interface WorkspaceExecResponse {
  output: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
}
export interface AddToSidebarResponse { share: WorkspaceShareRecord; }

export interface TerminalSession {
  id: string;
  title: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
}

export interface ListTerminalSessionsResponse { sessions: TerminalSession[]; }
export interface CreateTerminalSessionRequest { cols: number; rows: number; }
export interface CreateTerminalSessionResponse { session: TerminalSession; }
export interface WriteTerminalSessionRequest { data: string; generation: number; sequence: number; }
export type TerminalSocketCommand = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
/**
 * Client frames on the terminal WebSocket. `rtc-offer` negotiates a direct data channel to the sandbox,
 * bypassing the monolith and sandbox ingress proxy. `rtc-switch` marks the last frame a peer sends on
 * the socket before it moves to the channel, so the receiver can keep both paths in order.
 */
export type TerminalSocketMessage =
  | { type: 'auth'; token: string; organizationId: string }
  | { type: 'rtc-offer'; sdp: string }
  | TerminalRtcCandidate
  | { type: 'rtc-switch' }
  | TerminalSocketCommand;
const terminalRtcCandidateSchema = z.object({ type: z.literal('rtc-candidate'), candidate: z.string(), mid: z.string() });
export type TerminalRtcCandidate = z.infer<typeof terminalRtcCandidateSchema>;
export const terminalSocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('rtc-answer'), sdp: z.string() }),
  terminalRtcCandidateSchema,
  z.object({ type: z.literal('rtc-switch') }),
]);
export type TerminalSocketServerMessage = z.infer<typeof terminalSocketServerMessageSchema>;
/** STUN only: without a relay the data channel is used only when it is a direct path. */
export const TERMINAL_RTC_ICE_SERVER = 'stun:stun.l.google.com:19302';
export const TERMINAL_SOCKET_UNSUPPORTED_CLOSE_CODE = 4404;

export const WORKSPACE_LIST_IDS_MAX = 100;

/** What Okidoki chats' model calls cost at API list prices, in USD; ChatGPT-login calls cost nothing. A Manager's total includes its ships. */
export interface WorkspaceInferenceCostResponse {
  totalUsd: number;
  /** `title` is null for a deleted chat, whose calls still count. */
  chats: Array<{ chatId: string; title: string | null; costUsd: number }>;
  ships: Array<{ workspaceId: string; name: string; costUsd: number }>;
}
