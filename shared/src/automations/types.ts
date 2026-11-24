import type { ResourceAccess } from '../access';
import type { AgentProvider, ThinkingLevel } from '../agent';
import type { WorkspaceConfig, WorkspaceLifecyclePolicy } from '../routes/workspaces';
import type { AutomationAlertLevel } from '../routes/preferences';
import type { WorkspaceSizeOption } from '../sandbox';
import type { LinearIssueFilters, LinearStateType } from './linear';
import { defineStateMachine } from '../state-machine';

// Shared types for the Automations feature.
//
// Two layers:
//   1. Registry types — define WHAT triggers exist (the schema).
//      Used by the trigger registry to describe available integrations,
//      events, and their configurable parameters. The frontend reads
//      these to render the trigger picker UI.
//
//   2. API types — define the ACTUAL trigger values stored in the DB
//      and passed between frontend/backend. These are the concrete
//      configs users create (e.g. a cron schedule, a GitHub PR event
//      with a repo filter).

// --- Registry types (trigger definitions / schema) ---

/** A parameter definition for a trigger event. */
export interface TriggerParameterDefinition {
  id: string;
  label: string;
  type: string;       // rendering hint — refined per-integration (e.g. GitHubTriggerParameterDefinition)
  required?: boolean;
}

/** A discrete event within an integration. */
export interface TriggerEventDefinition {
  id: string;
  label: string;
  parameters?: TriggerParameterDefinition[];
}

export type TriggerIconName = 'clock' | 'github' | 'gitlab' | 'slack' | 'sentry' | 'linear' | 'webhook';

/** An integration that provides trigger events. */
export interface TriggerDefinition {
  type: AutomationTriggerType;
  label: string;
  description: string;
  icon: TriggerIconName;
  events?: TriggerEventDefinition[];
}

// --- API types (concrete trigger values / data) ---

export type AutomationTriggerType = 'cron' | 'github' | 'gitlab' | 'slack' | 'sentry' | 'linear' | 'custom';
export type EventTriggerType = Exclude<AutomationTriggerType, 'cron' | 'custom'>;

export const AUTOMATION_DEBOUNCE_MAX_SECONDS = 24 * 60 * 60;
export const AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MIN = 3;
export const AUTOMATION_WORKSPACE_AUTO_STOP_MINUTES_MAX = 1440;
export const AUTOMATION_GITHUB_CHECK_NAMES_MAX = 10;
export const AUTOMATION_GITHUB_CHECK_NAME_MAX_LENGTH = 100;

/**
 * `delete_after_inactivity` reaped a run's workspace on a timer, out from under links in the run history.
 * Legacy automations still stored with that policy are coerced to `archive_when_done`.
 */
export const AUTOMATION_LIFECYCLE_POLICIES = ['default', 'archive_when_done', 'sleep_when_done', 'delete_when_done'] as const;
export type AutomationLifecyclePolicy = (typeof AUTOMATION_LIFECYCLE_POLICIES)[number];
export const DEFAULT_AUTOMATION_LIFECYCLE_POLICY: AutomationLifecyclePolicy = 'delete_when_done';

export function toAutomationLifecyclePolicy(policy: WorkspaceLifecyclePolicy | null | undefined): AutomationLifecyclePolicy {
  if (!policy) return 'default';
  if (policy === 'delete_after_inactivity') return 'archive_when_done';
  return policy;
}

export function lifecyclePolicySupportsAutoStop(policy: WorkspaceLifecyclePolicy): boolean {
  return policy === 'default';
}

export const AUTOMATION_EXECUTION_STATUSES = ['pending', 'creating', 'running', 'completed', 'failed'] as const;
export const AUTOMATION_EXECUTION_MACHINE = defineStateMachine(AUTOMATION_EXECUTION_STATUSES, {
  pending: ['creating', 'running', 'failed'],
  creating: ['running', 'failed'],
  // A redelivered message records its new chat on a run that is already running.
  running: ['running', 'completed', 'failed'],
  // An agent can report an error after its turn ended.
  completed: ['failed'],
  failed: [],
});
export const AUTOMATION_EXECUTION_IN_PROGRESS_STATUSES: readonly AutomationExecutionStatus[] = ['pending', 'creating', 'running'];
export const AUTOMATION_AUTO_PAUSE_DAYS = 7;
export const AUTOMATION_AUTO_PAUSE_LABEL = `Paused after failing every run for ${AUTOMATION_AUTO_PAUSE_DAYS} days`;
export type AutomationExecutionStatus = (typeof AUTOMATION_EXECUTION_STATUSES)[number];

export type ResourceScope = 'org' | 'user';

export type AutomationScope = ResourceScope;

export interface CronTriggerConfig {
  schedule?: string;
  run_at?: string;
  timezone?: string;
}

export function hasCronTrigger(triggers: AutomationTrigger[]): boolean {
  return triggers.some((trigger) => trigger.type === 'cron');
}

export function isOneTimeSchedule(triggers: AutomationTrigger[]): boolean {
  return triggers.length === 1 && triggers[0].type === 'cron' && !!triggers[0].config.run_at;
}

/** GitHub trigger configuration — one event per trigger. */
export interface GitHubTriggerConfig {
  event: string;
  /** Optional filter: only fire for events from these repos (internal UUIDs). */
  repository_ids?: string[];
  /**
   * When true, opened/sync events for a PR that already has a workspace from a
   * prior run of this automation flow to that workspace as a follow-up message
   * instead of spawning a new one. Only applies to `pull_request.opened` and
   * `pull_request.synchronize` events.
   */
  group_pr_events?: boolean;
  excluded_actors?: string[];
  reviewer_logins?: string[];
}

export type GitLabTriggerConfig = GitHubTriggerConfig;

/** Slack trigger configuration — one event per trigger. */
export interface SlackTriggerConfig {
  event: string;
  /** Optional filter: only fire for messages in these Slack channels. */
  channel_ids?: string[];
  /** When true, thread replies flow to the same workspace as the root message instead of spawning new ones. Defaults to true. */
  group_thread_replies?: boolean;
}

/** Sentry trigger configuration — one event per trigger. */
export interface SentryTriggerConfig {
  event: string;
  /** Optional filter: only fire for events from these Sentry project slugs. */
  project_slugs?: string[];
  /** Optional minimum severity level (debug, info, warning, error, fatal). */
  min_level?: string;
}

interface LinearTriggerConfig extends LinearIssueFilters {
  event: string;
  team_ids?: string[];
  state_types?: LinearStateType[];
}

/**
 * Custom webhook trigger configuration. The automation gets a unique webhook
 * URL (keyed by the auto-generated webhook token on the automation record);
 * anyone who knows the URL can POST an arbitrary JSON body to fire a run.
 * Config is intentionally empty — the URL itself is the entire interface.
 */
export interface CustomTriggerConfig {
  // no fields — token lives on the automation record.
}

export type AutomationTriggerConfig =
  | CronTriggerConfig
  | GitHubTriggerConfig
  | GitLabTriggerConfig
  | SlackTriggerConfig
  | SentryTriggerConfig
  | LinearTriggerConfig
  | CustomTriggerConfig;

/** A single trigger (one element in the triggers array). */
export type AutomationTrigger =
  | { type: 'cron'; config: CronTriggerConfig }
  | { type: 'github'; config: GitHubTriggerConfig }
  | { type: 'gitlab'; config: GitLabTriggerConfig }
  | { type: 'slack'; config: SlackTriggerConfig }
  | { type: 'sentry'; config: SentryTriggerConfig }
  | { type: 'linear'; config: LinearTriggerConfig }
  | { type: 'custom'; config: CustomTriggerConfig };

/** Automation record as returned by the API. */
export interface AutomationRecord {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  triggers: AutomationTrigger[];
  prompt: string;
  debounce_seconds: number | null;
  github_check_names: string[];
  /** Environment that drives this automation. Repos derive from the env's binding. */
  environment_id: string;
  enabled: boolean;
  auto_paused_at: string | null;
  failing_cause: string | null;
  /**
   * Unique token used to build the webhook URL for automations that have a
   * `custom` trigger. Null when no custom trigger is configured. The URL is
   * `${api_base}/v1/automations/webhook/${webhook_token}` — the token itself
   * is the secret (anyone with the URL can fire the automation).
   */
  webhook_token: string | null;
  cron_next_fire_at: string | null;
  created_by: string | null;
  workspace_lifecycle_policy: WorkspaceLifecyclePolicy;
  workspace_auto_stop_minutes: number | null;
  workspace_size: WorkspaceSizeOption | null;
  config: WorkspaceConfig;
  agent_provider: AgentProvider | null;
  model: string | null;
  thinking_level: ThinkingLevel | null;
  goal_mode: boolean | null;
  fast_mode: boolean | null;
  /** Null means unlimited. The automation deletes itself after its last successful run. */
  max_runs: number | null;
  run_count: number;
  /** When true, every run goes to `target_workspace_id`; the first run creates it if unset. */
  reuse_workspace: boolean;
  target_workspace_id: string | null;
  background: boolean;
  credential_user_id: string | null;
  access?: ResourceAccess;
  /** The signed-in person's alerts for this automation, defaults worked out. Absent when no person is signed in, as with an organization API key. */
  my_alert_level?: AutomationAlertLevel;
  created_at: string;
  updated_at: string;
}

/** Automation execution record as returned by the API. */
export interface AutomationExecutionRecord {
  id: string;
  automation_id: string;
  organization_id: string;
  workspace_id: string | null;
  /** True when the run's workspace has since been reaped (e.g. `delete_after_inactivity`), making it unreachable. */
  workspace_deleted: boolean;
  workspace_name: string | null;
  triggered_at: string;
  trigger_payload: unknown;
  status: AutomationExecutionStatus;
  config: WorkspaceConfig;
  error: string | null;
  completed_at: string | null;
  can_retry: boolean;
}

export interface AutomationExecutionListItem extends AutomationExecutionRecord {
  automation_name: string;
}

// --- Request / Response types ---

export interface CreateAutomationRequest {
  scope?: AutomationScope;
  name: string;
  description?: string;
  triggers: AutomationTrigger[];
  prompt: string;
  debounce_seconds?: number | null;
  github_check_names?: string[];
  /** Defaults to the target workspace's environment when `target_workspace_id` is set. */
  environment_id?: string;
  enabled?: boolean;
  workspace_lifecycle_policy?: WorkspaceLifecyclePolicy;
  workspace_auto_stop_minutes?: number;
  workspace_size?: WorkspaceSizeOption;
  config?: WorkspaceConfig;
  agent_provider?: AgentProvider | null;
  model?: string | null;
  thinking_level?: ThinkingLevel | null;
  goal_mode?: boolean | null;
  fast_mode?: boolean | null;
  max_runs?: number | null;
  reuse_workspace?: boolean;
  target_workspace_id?: string | null;
  background?: boolean;
  credential_user_id?: string;
}

export interface UpdateAutomationRequest {
  name?: string;
  description?: string;
  triggers?: AutomationTrigger[];
  prompt?: string;
  debounce_seconds?: number | null;
  github_check_names?: string[];
  environment_id?: string;
  enabled?: boolean;
  workspace_lifecycle_policy?: WorkspaceLifecyclePolicy;
  workspace_auto_stop_minutes?: number | null;
  workspace_size?: WorkspaceSizeOption;
  config?: WorkspaceConfig;
  agent_provider?: AgentProvider | null;
  model?: string | null;
  thinking_level?: ThinkingLevel | null;
  goal_mode?: boolean | null;
  fast_mode?: boolean | null;
  max_runs?: number | null;
  reuse_workspace?: boolean;
  target_workspace_id?: string | null;
  background?: boolean;
  credential_user_id?: string | null;
  scope?: 'org';
}

export interface ListAutomationsResponse {
  automations: (AutomationRecord & { environment_name: string | null })[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AutomationResponse {
  automation: AutomationRecord;
}

export interface TriggerAutomationRequest {
  payload?: unknown;
  pr?: { repository_id: string; number: number };
}

export interface TriggerAutomationResponse {
  execution_id: string;
  workspace_id: string | null;
}

export interface ListAutomationExecutionsResponse {
  executions: AutomationExecutionRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ListOrganizationAutomationExecutionsResponse {
  executions: AutomationExecutionListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ListOrganizationAutomationExecutionRowsResponse {
  executions: AutomationExecutionListItem[];
  page: number;
  limit: number;
  hasNextPage: boolean;
}

export interface OrganizationAutomationExecutionCountResponse {
  total: number;
}
