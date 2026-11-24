import type { CreateWorkspaceRequest, WorkspaceConfig, WorkspaceKind, WorkspaceLifecyclePolicy, WorkspaceRecord, WorkspaceStatus, WorkspaceWebhookConfig } from './workspaces';
import type { AgentProvider, ThinkingLevel } from '../agent';
import type { GitDiff, ImageContent } from '../engine/types';
import type { ChatHistoryResponse, ChatMessageSender } from '../engine/v1';
import type { WarmHookLogsResponse, StartHookLogsResponse } from '../engine/environment';
import type { WorkspaceSource } from '../pricing';
import type { WorkspaceSizeOption } from '../sandbox';
import type { NativeIntegrationStatus } from './integrations';

// ---------------------------------------------------------------------------
// Core Replica types
// ---------------------------------------------------------------------------

/** Lightweight replica representation returned on creation */
export type ReplicaWorkspace = Pick<
  WorkspaceRecord,
  'id' | 'name' | 'created_at' | 'status'
> & {
  source: WorkspaceSource;
  repositories: ReplicaRepository[];
};

/** Repository associated with a replica */
export interface ReplicaRepository {
  id: string;
  name: string;
  url: string;
}

/** PR info associated with a replica */
export interface ReplicaPullRequest {
  repository: string;
  number: number;
  url: string;
}

// ---------------------------------------------------------------------------
// Repository status
// ---------------------------------------------------------------------------

/** Per-repository git status for a replica */
export interface ReplicaRepositoryStatus {
  repository: string;
  branch?: string;
  default_branch?: string;
  /** All pull request URLs the workspace has opened in this repository. */
  pr_urls?: string[];
  start_hooks_completed?: boolean;
  git_diff?: GitDiff;
}

// ---------------------------------------------------------------------------
// Environment & integrations
// ---------------------------------------------------------------------------

/** Environment and integration summary for a replica */
export interface ReplicaEnvironment {
  engine_version: string;
  files_uploaded: string[];
  env_vars_set: string[];
  skills_installed: string[];
  integrations: NativeIntegrationStatus;
  coding_agents: {
    claude: { available: boolean; auth_method: string };
    codex: { available: boolean; auth_method: string };
    cursor: { available: boolean; auth_method: string };
    gemini?: { available: boolean; auth_method: string };
    muse: { available: boolean; auth_method: string };
    opencode: { available: boolean; auth_method: string };
    pi?: { available: boolean; auth_method: string };
  };
  hooks: {
    environment_warm_hook: { status: string; details: string | null };
    repositories: Array<{
      repository_name: string;
      warm_hook: string;
      start_hook: string;
    }>;
  };
  last_updated_at: string;
}

// ---------------------------------------------------------------------------
// Chat types
// ---------------------------------------------------------------------------

/** Chat summary for the Replica API */
export interface ReplicaChat {
  id: string;
  provider: AgentProvider;
  title: string;
  created_at: string;
  updated_at: string;
  processing: boolean;
}

// ---------------------------------------------------------------------------
// List endpoint
// ---------------------------------------------------------------------------

/** Extended replica info for list endpoint */
export interface ReplicaListItem extends ReplicaWorkspace {
  kind: WorkspaceKind;
  pull_requests?: ReplicaPullRequest[];
  last_activity_at?: string | null;
}

export interface ListOkidokiResponse {
  okidoki: ReplicaListItem[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// ---------------------------------------------------------------------------
// Get endpoint
// ---------------------------------------------------------------------------

/** Full replica details for get endpoint */
export interface ReplicaDetails extends ReplicaListItem {
  /** Currently active coding agent */
  coding_agent?: AgentProvider;
  /** Current git status by repository */
  repository_statuses?: ReplicaRepositoryStatus[];
  /** Chats in this workspace */
  chats?: ReplicaChat[];
  /** Environment and integration details (when include=environment) */
  environment?: ReplicaEnvironment;
  activity?: ReplicaActivity;
}

export interface GetReplicaResponse {
  replica: ReplicaDetails;
}

// ---------------------------------------------------------------------------
// Create endpoint
// ---------------------------------------------------------------------------

export interface CreateReplicaRequest {
  name: string;
  /** Initial message to send to the coding agent */
  message: string;
  environment_id: string;
  /** Coding agent to use (default: claude) */
  coding_agent?: AgentProvider;
  /** Model to use for the coding agent */
  model?: string;
  /** Images to include with the initial message */
  images?: ImageContent[];
  /** Lifecycle policy for the workspace */
  lifecycle_policy?: WorkspaceLifecyclePolicy;
  /** Per-workspace behavior config, such as PR follow-up capabilities. */
  config?: WorkspaceConfig;
  goal_mode?: boolean;
  fast_mode?: boolean;
  thinking_level?: ThinkingLevel;
  webhook_url?: string | WorkspaceWebhookConfig;
  size?: WorkspaceSizeOption;
  /** `manager` (or its old name `mothership`) needs a personal API key and defaults `lifecycle_policy` to `default`. */
  kind?: CreateWorkspaceRequest['kind'];
}

export interface CreateReplicaResponse {
  replica: ReplicaWorkspace;
}

// ---------------------------------------------------------------------------
// Send message endpoint
// ---------------------------------------------------------------------------

export interface SendReplicaMessageRequest {
  /** Message to send */
  message: string;
  /** Coding agent to use */
  coding_agent?: AgentProvider;
  /** Chat ID to send the message to (uses default chat if omitted) */
  chat_id?: string;
  /** Model to use */
  model?: string;
  /** Images to include with the message */
  images?: ImageContent[];
  goal_mode?: boolean;
  fast_mode?: boolean;
  thinking_level?: ThinkingLevel;
  /** From a workspace: return the recipient's final response for this message to the sending chat. Default true. */
  expect_reply?: boolean;
}

export interface SendReplicaMessageResponse {
  status: 'sent' | 'steered' | 'queued' | 'waking';
  message_id?: string;
  position?: number;
  chat_id?: string;
}

// ---------------------------------------------------------------------------
// Delete endpoint
// ---------------------------------------------------------------------------

export interface DeleteReplicaResponse {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Chat management endpoints
// ---------------------------------------------------------------------------

export interface CreateReplicaChatRequest {
  provider: AgentProvider;
  title?: string;
}

export interface CreateReplicaChatResponse {
  chat: ReplicaChat;
}

export interface DeleteReplicaChatResponse {
  success: boolean;
}

export interface ListReplicaChatsResponse {
  chats: ReplicaChat[];
}

/** What the workspace's agent is doing, as the chat shows it. Background tasks the agent will wake for count as working. */
export interface ReplicaActivity {
  state: 'working' | 'waiting_for_input' | 'idle';
  chat_id: string | null;
  current_step: string | null;
  last_agent_message: string | null;
}

export interface WaitReplicaResponse {
  done: boolean;
  status: WorkspaceStatus;
  chats: ReplicaChat[];
  activity: ReplicaActivity;
  /** The workspace was deleted once its agents finished (`delete_when_done`). */
  deleted?: boolean;
}

// ---------------------------------------------------------------------------
// History endpoint
// ---------------------------------------------------------------------------

/** Response for reading replica history */
export interface ReadReplicaHistoryResponse extends ChatHistoryResponse {
  total: number;
  has_more: boolean;
  /** Currently active coding agent */
  coding_agent?: AgentProvider;
}

export interface OrganizationConversation {
  chat_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_status: WorkspaceStatus;
  workspace_source: WorkspaceSource;
  workspace_created_at: string;
  workspace_user_id: string | null;
  workspace_creator_email: string | null;
  environment_id: string | null;
  provider: AgentProvider | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  parent_chat_id: string | null;
  senders: ChatMessageSender[];
}

export interface ListOrganizationConversationsResponse {
  conversations: OrganizationConversation[];
  total: number;
  limit: number;
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Hooks endpoints
// ---------------------------------------------------------------------------

export interface ReplicaHooksResponse {
  warm_hooks: WarmHookLogsResponse;
  start_hooks: StartHookLogsResponse;
}

// ---------------------------------------------------------------------------
// Repository listing for organization
// ---------------------------------------------------------------------------

export interface ReplicaOrgRepository {
  id: string;
  name: string;
  url: string;
  default_branch: string;
}

export interface ListReplicaRepositoriesResponse {
  repositories: ReplicaOrgRepository[];
}

export type ReplicaWebhookEventType =
  | 'replica.ready'
  | 'replica.turn_completed'
  | 'replica.deleted'
  | 'replica.error';

export type ReplicaWebhookSnapshot = Omit<ReplicaWorkspace, 'repositories'>;

export type ReplicaWebhookRepoStatus = Pick<
  ReplicaRepositoryStatus,
  'repository' | 'branch' | 'default_branch' | 'pr_urls'
>;

interface ReplicaWebhookBase<TType extends ReplicaWebhookEventType, TData> {
  /** Stable per-delivery event ID. Reuse this for idempotent processing. */
  id: string;
  type: TType;
  created_at: string;
  replica: ReplicaWebhookSnapshot;
  data: TData;
}

export type ReplicaWebhookEvent =
  | ReplicaWebhookBase<'replica.ready', Record<string, never>>
  | ReplicaWebhookBase<
      'replica.turn_completed',
      {
        repository_statuses: ReplicaWebhookRepoStatus[];
        pr_urls: string[];
      }
    >
  | ReplicaWebhookBase<'replica.deleted', Record<string, never>>
  | ReplicaWebhookBase<'replica.error', { message: string }>;
