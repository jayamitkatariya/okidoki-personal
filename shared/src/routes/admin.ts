import type { OrganizationSeat } from './organization';
import type { PlanType } from '../pricing';
import type { SandboxProviderId, WorkspaceSize, WorkspaceSizeOption } from '../sandbox';
import type {
  EngineHealthProbeResult,
  EngineLogReadResponse,
  EngineLogsListResponse,
  WorkspaceEngineHeartbeatSnapshot,
} from '../engine/types';
import type { WarmPoolConfigWithStats } from './environment';
import type { WorkspaceStatus } from './workspaces';
import type { EmailTemplatePreview } from '../onboarding-emails';
import type { BillingUsage, GetBillingPeriodsResponse, UsageAmount } from './billing';
import type { UserSignupSource } from '../signup-source';

// Admin Dashboard Types

export type TimeGranularity = 'day' | 'week' | 'month';
export type DateRange = '3d' | '7d' | '30d' | '90d' | '1y';
export type TopOrganizationsRange = DateRange | 'today';

export interface AdminSessionUsagePoint {
  period_start: string;
  minutes_spent: number;
  projected_minutes_spent: number | null;
}

export interface GetAdminSessionUsageResponse {
  data: AdminSessionUsagePoint[];
}

export interface GetAdminSignupsResponse {
  data: { period_start: string; signups: number; banned: number }[];
}

export interface AdminLimrunUsageTotals {
  runtimeMinutes: number;
  billedMinutes: number;
  cost: number;
}

export interface AdminLimrunOrganizationUsage extends AdminLimrunUsageTotals {
  organizationId: string | null;
  name: string;
}

export interface GetAdminLimrunUsageResponse {
  from: string;
  to: string;
  oldestFetchedAt: string;
  totals: AdminLimrunUsageTotals;
  days: (AdminLimrunUsageTotals & { date: string })[];
  organizations: AdminLimrunOrganizationUsage[];
}

// Top Organizations by Spend
export interface TopOrganization {
  organization_id: string;
  name: string;
  plan: string;
  total_spend: number;
  previous_total_spend: number;
  projected_total_spend: number;
  change_percent: number | null;
}

export interface GetTopOrganizationsRequest {
  range: TopOrganizationsRange;
  limit?: number;
}

export interface GetTopOrganizationsResponse {
  organizations: TopOrganization[];
}

export interface TopOrganizationPullRequests {
  organization_id: string;
  name: string;
  plan: string;
  pull_requests_count: number;
  previous_pull_requests_count: number;
  projected_pull_requests_count: number;
  change_percent: number | null;
}

export interface GetTopOrganizationsPullRequestsResponse {
  organizations: TopOrganizationPullRequests[];
}

// Organization Inspector
export interface OrganizationMember {
  id: string;
  user_id: string;
  email: string;
  role: string;
  created_at: string;
}

export interface AdminOrganizationMember extends OrganizationMember {
  signup_source: UserSignupSource | null;
}

export interface OrganizationMinutesHistory {
  period_start: string;
  minutes_spent: number;
}

export interface OrganizationUsageStats {
  totalMinutesSpent: number;
  usageHistory: OrganizationMinutesHistory[];
  linearSessionsCount: number;
  pullRequestsCount: number;
  repositoriesCount: number;
  totalSessionsCount: number;
  avgSpendPerSession: number;
}

export interface WorkspaceSessionItem {
  id: string;
  workspace_id: string;
  started_at: string;
  ended_at: string | null;
  minutes_charged: number;
}

export interface OrganizationDetails {
  id: string;
  name: string;
  plan: string;
  seat_count?: number;
  default_workspace_size?: WorkspaceSizeOption;
  manual_workspace_concurrency_limit: number | null;
  automated_workspace_concurrency_limit: number | null;
  workspace_creations_per_hour_per_user_limit: number | null;
  workspace_creations_per_hour_limit: number | null;
  credentials_count: number;
  credential_types: string[];
  members: OrganizationMember[];
  recentSessions: WorkspaceSessionItem[];
  usageStats: OrganizationUsageStats;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string | null;
}

export interface GetOrganizationInspectorRequest {
  organizationId: string;
  granularity?: TimeGranularity;
  range?: DateRange;
}

export interface GetOrganizationInspectorResponse {
  organization: OrganizationDetails;
}

// Admin RBAC Roles
//   admin       - access to everything
//   sales       - access to everything except webhooks
//   engineering - access to everything except revenue
export type AdminRole = 'admin' | 'sales' | 'engineering';

export const ADMIN_ROLES: readonly AdminRole[] = ['admin', 'sales', 'engineering'];

// Admin Check
export interface CheckAdminResponse {
  isAdmin: boolean;
  role?: AdminRole;
}

// Admin Workspace Management
export interface AdminWorkspaceListItem {
  id: string;
  user_id: string | null;
  organization_id: string;
  name: string;
  status: WorkspaceStatus;
  created_at: string;
}

export interface GetAdminWorkspacesRequest {
  search?: string;
  page?: number;
  limit?: number;
}

export interface GetAdminWorkspacesResponse {
  workspaces: AdminWorkspaceListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminUserMessageListItem {
  id: string;
  organization_id: string;
  organization_name: string;
  user_id: string;
  user_email: string | null;
  from_text: string | null;
  subject: string | null;
  message_preview: string;
  created_at: string;
}

export interface GetAdminMessagesResponse {
  messages: AdminUserMessageListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminUserMessageDetails {
  id: string;
  organization_id: string;
  organization_name: string;
  user_id: string;
  user_email: string | null;
  from_text: string | null;
  subject: string | null;
  message: string;
  created_at: string;
}

export interface AdminUserMessageReply {
  id: string;
  message_id: string;
  admin_user_id: string | null;
  admin_email: string | null;
  to_email: string;
  from_email: string;
  cc_emails: string[] | null;
  subject: string;
  body: string;
  resend_id: string | null;
  send_error: string | null;
  created_at: string;
}

export interface GetAdminMessageResponse {
  message: AdminUserMessageDetails;
  replies: AdminUserMessageReply[];
}

export const ADMIN_MESSAGE_REPLY_BODY_MAX_LENGTH = 10000;
export const ADMIN_MESSAGE_REPLY_SUBJECT_MAX_LENGTH = 200;

export interface SendAdminMessageReplyRequest {
  to: string;
  subject: string;
  body: string;
  html?: string;
  from?: string;
  cc?: string[];
}

export interface SendAdminMessageReplyResponse {
  reply: AdminUserMessageReply;
}

export interface DeleteAdminWorkspaceResponse {
  success: boolean;
}

export interface SleepAdminWorkspaceResponse {
  success: boolean;
  previousStatus: string;
}

export interface ForceWakeAdminWorkspaceResponse {
  success: boolean;
  previousStatus: string;
  providerState: 'running' | 'sleeping' | 'missing' | 'unknown';
}

export interface DeleteAllAdminWorkspacesRequest {
  confirmText: string;
}

export interface DeleteAllAdminWorkspaceFailure {
  workspaceId: string;
  organizationId: string;
  error: string;
}

export interface DeleteAllAdminWorkspacesResponse {
  totalFound: number;
  deletedCount: number;
  failedCount: number;
  failures: DeleteAllAdminWorkspaceFailure[];
}

export interface StaleWorkspaceListItem {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string | null;
  status: WorkspaceStatus;
  last_retention_activity_at: string;
  last_activity_at: string | null;
  created_at: string;
  days_since_last_activity: number | null;
}

export interface GetStaleWorkspacesResponse {
  days: number;
  total: number;
  workspaces: StaleWorkspaceListItem[];
}

export interface DeleteStaleWorkspacesRequest {
  days: number;
  confirmText: string;
}

export interface DeleteStaleWorkspacesResponse {
  days: number;
  totalFound: number;
  deletedCount: number;
  failedCount: number;
  failures: DeleteAllAdminWorkspaceFailure[];
}

export interface OrphanedSandboxListItem {
  sandboxId: string;
  sandboxProvider: SandboxProviderId;
  name: string | null;
  state: string | null;
  createdAt: string | null;
  organizationIdLabel: string | null;
  workspaceIdLabel: string | null;
  reason: 'no_workspace_row' | 'workspace_soft_deleted';
}

export interface GetOrphanedSandboxesResponse {
  minAgeMinutes: number;
  scannedCount: number;
  total: number;
  sandboxes: OrphanedSandboxListItem[];
  truncated: boolean;
}

export interface DeleteOrphanedSandboxesRequest {
  minAgeMinutes?: number;
  confirmText: string;
}

export interface DeleteOrphanedSandboxFailure {
  sandboxId: string;
  sandboxProvider: SandboxProviderId;
  error: string;
}

export interface DeleteOrphanedSandboxesResponse {
  minAgeMinutes: number;
  scannedCount: number;
  totalFound: number;
  deletedCount: number;
  failedCount: number;
  failures: DeleteOrphanedSandboxFailure[];
}

// Consistency check: live workspace rows whose provider sandbox no longer exists.
export interface OrphanWorkspaceRowListItem {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string | null;
  sandbox_id: string;
  sandbox_provider: SandboxProviderId;
  status: string;
  created_at: string;
}

export interface GetOrphanWorkspaceRowsResponse {
  scannedCount: number;
  sandboxCount: number;
  total: number;
  workspaces: OrphanWorkspaceRowListItem[];
  truncated: boolean;
}

export interface FixOrphanWorkspaceRowsRequest {
  confirmText: string;
}

export interface FixOrphanWorkspaceRowFailure {
  workspaceId: string;
  organizationId: string;
  error: string;
}

export interface FixOrphanWorkspaceRowsResponse {
  scannedCount: number;
  sandboxCount: number;
  totalFound: number;
  fixedCount: number;
  failedCount: number;
  failures: FixOrphanWorkspaceRowFailure[];
}

// Consistency check: unclaimed warm-pool rows whose provider sandbox no longer exists.
export interface OrphanWarmPoolRowListItem {
  id: string;
  organization_id: string;
  warm_pool_config_id: string;
  sandbox_id: string;
  sandbox_provider: SandboxProviderId;
  status: string;
  created_at: string;
}

export interface GetOrphanWarmPoolRowsResponse {
  scannedCount: number;
  sandboxCount: number;
  total: number;
  rows: OrphanWarmPoolRowListItem[];
  truncated: boolean;
}

export interface FixOrphanWarmPoolRowsRequest {
  confirmText: string;
}

export interface FixOrphanWarmPoolRowFailure {
  warmPoolRowId: string;
  error: string;
}

export interface FixOrphanWarmPoolRowsResponse {
  scannedCount: number;
  sandboxCount: number;
  totalFound: number;
  fixedCount: number;
  failedCount: number;
  failures: FixOrphanWarmPoolRowFailure[];
}

// List Organizations for search/autocomplete
export interface OrganizationListItem {
  id: string;
  name: string;
  plan: string;
}

export interface SearchOrganizationsResponse {
  organizations: OrganizationListItem[];
}

// Add Admin as Organization Member
export interface AddAdminToOrganizationRequest {
  role?: 'member' | 'admin';
}

export interface AddAdminToOrganizationResponse {
  success: boolean;
  member: OrganizationMember;
}

// Remove Organization Member (admin)
export interface RemoveOrganizationMemberResponse {
  success: boolean;
}

// Search Users
export interface UserListItem {
  id: string;
  email: string;
}

export interface SearchUsersResponse {
  users: UserListItem[];
}

// User Inspector
export interface UserOrganization {
  id: string;
  name: string;
  plan: string;
  role: string;
}

export interface UserDetails {
  id: string;
  email: string;
  created_at: string;
  credentials_count: number;
  credential_types: string[];
  organizations: UserOrganization[];
}

export interface GetUserDetailsResponse {
  user: UserDetails;
}

export interface GrantCreditRequest {
  amountCents: number;
  reason: string;
}

export interface GrantCreditResponse {
  periodStart: string;
}

// Update Organization Plan
export interface UpdateOrganizationPlanRequest {
  plan: PlanType;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
}

export interface UpdateOrganizationPlanResponse {
  organization: {
    id: string;
    plan: PlanType;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    subscription_status: string | null;
  };
}

export interface UpdateOrganizationDefaultWorkspaceSizeRequest {
  size: WorkspaceSizeOption;
}

export interface UpdateOrganizationDefaultWorkspaceSizeResponse {
  organization: {
    id: string;
    default_workspace_size: WorkspaceSizeOption;
  };
  rebuilding_environments: number;
}

export interface UpdateAdminWorkspaceSizeRequest {
  size: WorkspaceSizeOption;
}

export interface UpdateAdminWorkspaceSizeResponse {
  resizedLive: boolean;
}

export interface UpdateOrganizationWorkspacesSizeRequest {
  size: WorkspaceSizeOption;
  /** Only workspaces whose requested size is this; null matches workspaces following the org default. */
  fromSize?: WorkspaceSizeOption | null;
  onlyAwake?: boolean;
}

export interface UpdateOrganizationWorkspacesSizeResponse {
  changed: number;
  resizedLive: number;
  failed: number;
}

export interface UpdateOrganizationWorkspaceLimitsRequest {
  manual_workspace_concurrency_limit: number | null;
  automated_workspace_concurrency_limit: number | null;
  workspace_creations_per_hour_per_user_limit: number | null;
  workspace_creations_per_hour_limit: number | null;
}

export interface UpdateOrganizationWorkspaceLimitsResponse {
  organization: { id: string } & UpdateOrganizationWorkspaceLimitsRequest;
}

export interface UpdateOrganizationBaaRequest {
  signed: boolean;
}

export interface UpdateOrganizationBaaResponse {
  organization: { id: string; baa_signed_at: string | null };
}

export const WEBHOOK_PROVIDERS = ['linear', 'github', 'gitlab', 'slack', 'stripe', 'sentry'] as const;

export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

const WEBHOOK_PROVIDER_SET: ReadonlySet<string> = new Set(WEBHOOK_PROVIDERS);

export function isWebhookProvider(value: unknown): value is WebhookProvider {
  return typeof value === 'string' && WEBHOOK_PROVIDER_SET.has(value);
}

export type WebhookMetadata = Record<string, unknown>;

export interface WebhookEventRaw {
  headers: Record<string, string>;
  body: string;
  method: string;
  path: string;
  query: Record<string, string>;
  content_type?: string;
}

export interface WebhookEvent {
  id: string;
  provider: string;
  received_at: string;
  metadata: WebhookMetadata;
  raw: WebhookEventRaw;
}

export interface WebhookEventListItem {
  id: WebhookEvent['id'];
  provider: WebhookEvent['provider'];
  received_at: WebhookEvent['received_at'];
  metadata: WebhookEvent['metadata'];
}

export interface GetWebhookEventsRequest {
  provider?: WebhookProvider;
  metadata?: WebhookMetadata;
  limit?: number;
}

export interface GetWebhookEventsResponse {
  events: WebhookEventListItem[];
}

export interface GetWebhookEventResponse {
  event: WebhookEvent;
}

export interface ReplayWebhookEventRequest {
  endpoint: string;
  headerOverrides?: Record<string, string>;
}

export interface ReplayWebhookEventResponse {
  status: number;
  body: string;
}

export interface DeleteWebhookEventResponse {
  success: boolean;
}

// Global Search
export interface GlobalSearchResult {
  users: UserListItem[];
  organizations: OrganizationListItem[];
  workspaces: { id: string; name: string; organization_id: string; status: string }[];
}

export interface GlobalSearchResponse {
  results: GlobalSearchResult;
}

// Admin Summary Stats
export interface AdminSummaryStats {
  totalUsers: number;
  totalOrganizations: number;
  totalWorkspaces: number;
  activeWorkspaces: number;
  totalMinutesSpent: number;
  totalPullRequests: number;
  totalPullRequestsMerged: number;
  totalLinearSessions: number;
  totalSlackThreads: number;
  totalGithubIssues: number;
}

export interface GetAdminSummaryResponse {
  stats: AdminSummaryStats;
}

// Workspace Details
export interface WorkspaceDetails {
  id: string;
  name: string;
  status: string;
  sandbox_id: string | null;
  sandbox_provider: SandboxProviderId;
  /** Requested size; null follows the organization default. */
  size: WorkspaceSizeOption | null;
  sandbox_size: WorkspaceSize | null;
  engine_url: string | null;
  creation_source: string | null;
  last_activity_at: string | null;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
  organization_id: string;
  organization_name: string;
  repository_id: string | null;
  repository_name: string | null;
  repository_url: string | null;
  sessions: WorkspaceSessionItem[];
  pull_requests: {
    id: string;
    pr_number: number;
    status: string;
    created_at: string;
    repository_id: string | null;
    repository_name: string | null;
  }[];
  linear_sessions: { id: string; linear_session_id: string; status: string; issue_id: string | null; created_at: string }[];
  slack_threads: { id: string; channel_id: string; thread_ts: string; status: string; created_at: string }[];
  github_issues: { id: string; github_issue_number: number; status: string; created_at: string }[];
  status_write_events: WorkspaceStatusWriteEvent[];
  total_minutes_charged: number;
}

export interface WorkspaceStatusWriteEvent {
  id: string;
  workspace_id: string;
  previous_status: WorkspaceStatus | null;
  target_status: WorkspaceStatus | null;
  caller: string;
  reason: string | null;
  sandbox_id: string | null;
  sandbox_provider: string | null;
  has_open_session: boolean | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface GetWorkspaceDetailsResponse {
  workspace: WorkspaceDetails;
}

// Admin Workspace Logs
export type GetAdminWorkspaceLogsResponse = EngineLogsListResponse;
export type GetAdminWorkspaceLogContentResponse = EngineLogReadResponse;

// Admin Workspace Terminal
export interface GetAdminWorkspaceTerminalResponse {
  url: string;
}

export type WorkspaceDiagnosticCheckStatus = 'ok' | 'failed' | 'skipped';

export interface WorkspaceDiagnosticCheck {
  status: WorkspaceDiagnosticCheckStatus;
  elapsedMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface WorkspaceDiagnosticSnapshot {
  workspace: {
    id: string;
    name: string;
    status: string;
    organizationId: string;
    sandboxId: string | null;
    sandboxProvider: string | null;
    engineUrl: string | null;
    createdAt: string;
    lastActivityAt: string | null;
    size: string | null;
  };
  heartbeat: WorkspaceEngineHeartbeatSnapshot;
  externalHealth: EngineHealthProbeResult | null;
  providerInfo: WorkspaceDiagnosticCheck;
  sandboxCommand: WorkspaceDiagnosticCheck;
  warmPool: {
    configId: string | null;
    generation: number | null;
    status: string | null;
    createdAt: string | null;
  };
}

export interface WorkspaceDiagnosticRecord {
  id: string;
  workspace_id: string;
  organization_id: string;
  requested_by: string | null;
  status: string;
  summary: WorkspaceDiagnosticSnapshot;
  created_at: string;
}

export interface RunAdminWorkspaceDiagnosticResponse {
  diagnostic: WorkspaceDiagnosticRecord;
}

export interface ListAdminWorkspaceDiagnosticsResponse {
  diagnostics: WorkspaceDiagnosticRecord[];
}

export const YC_DEAL_MONTHS = { alumni: 1, in_batch: 3 } as const;
export const YC_DEAL_MONTHLY_CREDIT_CENTS = 100_000;
export type YcDealKind = keyof typeof YC_DEAL_MONTHS;
export const isYcDealKind = (value: unknown): value is YcDealKind =>
  typeof value === 'string' && Object.hasOwn(YC_DEAL_MONTHS, value);

// Paginated Organizations
export interface AdminYcDealClaim {
  email: string;
  claimed_at: string;
}

export interface PaginatedOrganizationListItem {
  id: string;
  name: string;
  plan: string;
  created_at: string;
  member_count: number;
  yc_deal_claims: AdminYcDealClaim[];
}

export interface GetPaginatedOrganizationsResponse {
  organizations: PaginatedOrganizationListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Paginated Users
export interface PaginatedUserListItem {
  id: string;
  email: string;
  created_at: string;
  organization_count: number;
  credential_count: number;
}

export interface GetPaginatedUsersResponse {
  users: PaginatedUserListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Enhanced User Details (with workspaces)
export interface UserWorkspace {
  id: string;
  name: string;
  status: string;
  organization_id: string;
  organization_name: string;
  created_at: string;
}

export interface EnhancedUserDetails extends UserDetails {
  workspaces: UserWorkspace[];
  total_minutes_spent: number;
  pull_requests_count: number;
  linear_sessions_count: number;
  slack_threads_count: number;
  github_issues_count: number;
  signup_source: UserSignupSource | null;
}

export interface GetEnhancedUserDetailsResponse {
  user: EnhancedUserDetails;
}

// Observability Metrics
export interface MetricsTimeSeriesDataPoint {
  period_start: string;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
  count: number;
  error_count: number;
}

export interface GetMetricsTimeSeriesRequest {
  granularity: TimeGranularity;
  range: DateRange;
  operation?: string;
  step?: string;
  organizationId?: string;
}

export interface GetMetricsTimeSeriesResponse {
  data: MetricsTimeSeriesDataPoint[];
  steps: string[];
}

export interface MetricsStepBreakdown {
  step: string;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p95_duration_ms: number;
  count: number;
  error_rate: number;
  has_children?: boolean;
}

export interface GetMetricsBreakdownResponse {
  steps: MetricsStepBreakdown[];
  operations: string[];
}

export interface GetMetricsVersionsResponse {
  versions: number[];
}

export interface WorkspaceTraceStep {
  step: string;
  sequence: number;
  started_at_ms: number;
  duration_ms: number;
  success: boolean;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface WorkspaceTrace {
  trace_id: string;
  operation: string;
  version: number;
  started_at: string;
  total_duration_ms: number;
  success: boolean;
  step_count: number;
  steps: WorkspaceTraceStep[];
}

export interface GetWorkspaceTracesResponse {
  traces: WorkspaceTrace[];
}

// Enhanced Organization Details (with more session types)
export interface OrgLinearSession {
  id: string;
  linear_session_id: string;
  status: string;
  issue_id: string | null;
  created_at: string;
}

export interface OrgSlackThread {
  id: string;
  channel_id: string;
  thread_ts: string;
  status: string;
  created_at: string;
}

export interface OrgGithubIssue {
  id: string;
  github_issue_number: number;
  status: string;
  repository_id: string | null;
  created_at: string;
}

export interface OrgRepository {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  created_at: string;
}

export interface OrgWorkspace {
  id: string;
  name: string;
  status: string;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
}

export interface OrgApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export interface OrgCreditGrant {
  id: string;
  amount_cents: number;
  reason: string;
  created_at: string;
}

export interface EnhancedOrganizationDetails extends OrganizationDetails {
  members: AdminOrganizationMember[];
  yc_deal: { kind: YcDealKind; expires_at: string; ended_at: string | null; canceled_at: string | null } | null;
  created_at: string;
  baa_signed_at: string | null;
  banned_at: string | null;
  /** Null for trials and managed plans. */
  monthly_credit_cents: number | null;
  yc_deal_claims: AdminYcDealClaim[];
  seats: Pick<OrganizationSeat, 'id' | 'email' | 'first_seen_at' | 'last_workspace_created_at'>[];
  linearSessions: OrgLinearSession[];
  slackThreads: OrgSlackThread[];
  githubIssues: OrgGithubIssue[];
  repositories: OrgRepository[];
  workspaces: OrgWorkspace[];
  apiKeys: OrgApiKey[];
  recentGrants: OrgCreditGrant[];
  pullRequests: { id: string; pr_number: number; workspace_id: string | null; repository_id: string | null; created_at: string }[];
}

export interface AdminYcDealRequest {
  kind: YcDealKind;
}

export interface EnableYcDealResponse {
  kind: YcDealKind;
  expires_at: string;
}

export interface GetEnhancedOrganizationDetailsResponse {
  organization: EnhancedOrganizationDetails;
}

export interface UnbanOrganizationResponse {
  restoredUsers: number;
}

export interface BanOrganizationForAbuseRequest {
  confirmText: string;
  purgeRecords: boolean;
}

export const ABUSE_CLEANUP_STORES = ['auth', 'tensorlake', 'modal', 'limrun', 's3', 'clickhouse', 'postgres'] as const;
export type AbuseCleanupStore = typeof ABUSE_CLEANUP_STORES[number];

export interface AbuseCleanupDeletion {
  store: AbuseCleanupStore;
  resource: string;
  count: number;
}

export interface BanOrganizationForAbuseResponse {
  success: true;
  bannedUsers: number;
  revokedApiKeys: number;
  deletedSandboxes: number;
  deletedStorageObjects: number;
  deletedClickHouseRows: number;
  deletedPostgresRows: number;
  deletions: AbuseCleanupDeletion[];
}

export type BanOrganizationForAbuseEvent =
  | { type: 'progress'; store: AbuseCleanupStore; message: string }
  | { type: 'deleted'; deletion: AbuseCleanupDeletion }
  | { type: 'complete'; result: BanOrganizationForAbuseResponse }
  | { type: 'error'; message: string };

// Warm Pool Admin Management

export interface AdminWarmPoolTtlStats {
  enabled: boolean;
  max_ready_age_seconds: number;
  oldest_ready_age_seconds: number | null;
  ready_over_ttl_count: number;
  next_replacement_count: number;
  ttl_expired_total: number;
  last_rotation_at: string | null;
  last_rotation_expired_count: number | null;
  last_rotation_replacements_succeeded: number | null;
  last_rotation_eligible_before: number | null;
}

interface AdminWarmPoolLeaseState {
  reconcile_lease_until: string | null;
}

export interface AdminWarmPoolEnvironmentOwnership {
  is_personal: boolean;
  owner_id: string | null;
  owner_email: string | null;
}

export interface AdminWarmPoolConfigItem extends WarmPoolConfigWithStats, AdminWarmPoolLeaseState {
  organization_name: string;
  organization_plan: string;
  environment_name: string;
  environment_ownership: AdminWarmPoolEnvironmentOwnership[];
  ttl_stats: AdminWarmPoolTtlStats;
}

export interface AdminWarmPoolGlobalStats {
  totalPools: number;
  enabledPools: number;
  totalReady: number;
  totalWarming: number;
}

export const ADMIN_WARM_POOL_WORKSPACE_STATES = ['ready', 'warming', 'snapshotting', 'stale'] as const;
export type AdminWarmPoolWorkspaceState = (typeof ADMIN_WARM_POOL_WORKSPACE_STATES)[number];

export interface AdminWarmPoolProviderStateDistributionItem {
  sandbox_provider: SandboxProviderId;
  state: AdminWarmPoolWorkspaceState;
  count: number;
}

export type AdminWarmPoolStatusFilter = AdminWarmPoolWorkspaceState | 'errored';

export interface GetAdminWarmPoolsResponse {
  pools: AdminWarmPoolConfigItem[];
  stats: AdminWarmPoolGlobalStats;
  providerStateDistribution: AdminWarmPoolProviderStateDistributionItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminOrgWarmPoolConfig extends WarmPoolConfigWithStats, AdminWarmPoolLeaseState {
  environment_name: string;
  environment_ownership: AdminWarmPoolEnvironmentOwnership[];
  ttl_stats: AdminWarmPoolTtlStats;
}

export interface GetAdminOrgWarmPoolsResponse {
  pools: AdminOrgWarmPoolConfig[];
}

export interface UpdateWarmPoolEnabledRequest {
  enabled: boolean;
}

export interface UpdateWarmPoolEnabledResponse {
  success: boolean;
  config: AdminOrgWarmPoolConfig;
}

export interface RefreshAllWarmPoolsResponse {
  success: boolean;
  message: string;
  totalConfigs: number;
  batches: number;
  batchDelayMs: number;
}

export interface RefreshWarmPoolResponse {
  success: boolean;
  message: string;
}

export type BulkWarmPoolAction = 'enable' | 'disable' | 'reconcile' | 'invalidate' | 'hard-reset';

export interface BulkWarmPoolActionRequest {
  action: BulkWarmPoolAction;
  /** Explicit list of warm pool config IDs. Ignored when `applyToAll` is true. */
  configIds?: string[];
  /** When true, apply to all configs matching `search` (or all configs if absent). */
  applyToAll?: boolean;
  /** Search filter applied when `applyToAll` is true (same semantics as the list endpoint). */
  search?: string;
  status?: AdminWarmPoolStatusFilter;
}

export interface BulkWarmPoolActionFailure {
  configId: string;
  error: string;
}

export interface BulkWarmPoolActionResponse {
  success: boolean;
  action: BulkWarmPoolAction;
  message: string;
  totalRequested: number;
  succeeded: string[];
  skipped: BulkWarmPoolActionFailure[];
  failed: BulkWarmPoolActionFailure[];
  batches: number;
  batchDelayMs: number;
}

// Top Organizations by API + Automation Minutes
export interface TopOrganizationApiMinutes {
  organization_id: string;
  name: string;
  plan: string;
  total_minutes: number;
  api_minutes: number;
  automation_minutes: number;
  previous_total_minutes: number;
  previous_api_minutes: number;
  previous_automation_minutes: number;
  projected_total_minutes: number;
  projected_api_minutes: number;
  projected_automation_minutes: number;
  change_percent: number | null;
}

export interface GetTopOrganizationsApiMinutesResponse {
  organizations: TopOrganizationApiMinutes[];
}

// Admin Organization API Usage

export interface AdminApiUsageDataPoint {
  date: string;
  minutes: number;
  sessions: number;
}

export interface AdminApiUsageBySource {
  source: string;
  total_minutes: number;
  total_sessions: number;
}

export interface AdminApiUsageSummary {
  totalMinutes: number;
  totalSessions: number;
  avgMinutesPerSession: number;
  bySource: AdminApiUsageBySource[];
}

export interface GetAdminOrgApiUsageResponse {
  timeSeries: AdminApiUsageDataPoint[];
  summary: AdminApiUsageSummary;
}

export interface GetAdminOrgBillingUsageResponse extends GetBillingPeriodsResponse {
  current: boolean;
  /** Null when the period had no included credit (managed or seat billing). */
  creditCents: number | null;
  usedCents: number;
  overageCents: number;
  /** Usage at the period's average rate so far, carried to its end. Current non-trial periods only. */
  projectedCents: number | null;
  usage: BillingUsage;
  /** Keyed by seat email, falling back to the workspace creator's; null when neither exists. */
  members: (UsageAmount & { email: string | null; workspaces: number; bySource: Record<string, UsageAmount> })[];
  sizes: (UsageAmount & { size: string; auto: boolean })[];
  workspaces: (UsageAmount & { id: string; name: string; creatorEmail: string | null; source: string; sizes: string[] })[];
}

export interface AdminRevenueCustomer {
  subscriptionId: string;
  organizationId: string | null;
  name: string;
  plan: PlanType | null;
  status: string;
  mrrCents: number;
  startedAt: string;
}

export interface GetAdminRevenueResponse {
  mrrCents: number;
  monthly: { month: string; collectedCents: number }[];
  customers: AdminRevenueCustomer[];
  generatedAt: string;
}

export interface GetAdminEmailTemplatesResponse {
  templates: EmailTemplatePreview[];
}

export interface AdminBlogAsset {
  key: string;
  url: string;
  size: number;
  lastModified: string | null;
}

export const BLOG_ASSET_EXTENSIONS = ['mp4', 'webm', 'mov', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif'];

export interface GetAdminBlogAssetsResponse {
  assets: AdminBlogAsset[];
}

export interface CreateAdminBlogAssetUploadRequest {
  key: string;
}

export interface CreateAdminBlogAssetUploadResponse {
  uploadUrl: string;
  headers: Record<string, string>;
}

export interface RenameAdminBlogAssetRequest {
  key: string;
  newKey: string;
}

export interface GetAdminBlogAssetDownloadResponse {
  downloadUrl: string;
}
