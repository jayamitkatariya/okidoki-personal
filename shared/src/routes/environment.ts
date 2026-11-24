import { SUBAGENT_MCP_SERVER_NAME } from '../subagent-mcp';
import { z } from 'zod';
import { mcpAuthSchema, type McpAuth } from '../workspace-identity';
import type { ResourceAccess } from '../access';
import type { RepositoryRecord } from './repositories';
import type { ResourceScope } from '../automations/types';
import type { HookFailureCause } from '../hook-failure';
import type { DefaultSkillsOverrides } from './preferences';
import { VARIABLE_KEY_RE } from './environment-setups';
import { createErrorResult, createSuccessResult, type Result } from '../result';
import type { CodeHostProvider } from '../code-host';
import { WEB_APP_PATHS } from '../urls';
import type { EnvironmentHookRunStep } from './environment-hook-runs';

export function getEnvironmentBindingLabel(
  env: EnvironmentRecord,
  repositories: RepositoryRecord[],
  labelStyle: 'binding' | 'repository_scope' = 'binding',
): string {
  if (env.repository_ids.length === 0) return 'No repositories';
  const names = env.repository_ids.map((id) => repositories.find((r) => r.id === id)?.name ?? 'unknown');
  if (labelStyle === 'repository_scope') return names.join(', ');
  return names.length === 1 ? `Repository ${names[0]}` : `${names.length} repositories`;
}

export const ENVIRONMENT_SETUP_SOURCE_MODES = ['app_and_repo', 'repo_only', 'app_only'] as const;
export type EnvironmentSetupSourceMode = (typeof ENVIRONMENT_SETUP_SOURCE_MODES)[number];

export function isEnvironmentSetupSourceMode(value: unknown): value is EnvironmentSetupSourceMode {
  return ENVIRONMENT_SETUP_SOURCE_MODES.some((mode) => mode === value);
}

export interface EnvironmentRecord {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string;
  description: string | null;
  /** A `MANAGER_ICON_PRESETS` key; null derives a stable preset from the id. */
  icon: string | null;
  /** Hidden from lists and pickers; still resolvable by id. */
  archived: boolean;
  /** Effective repositories in checkout order, inherited from the source when `inherit_repositories`. */
  repository_ids: string[];
  inherit_repositories: boolean;
  system_prompt: string | null;
  memory_read_enabled: boolean;
  memory_write_enabled: boolean;
  gpu_enabled: boolean;
  mobile_testing_enabled: boolean;
  /** Which hooks workspaces of this environment run: app hooks, repository `okidoki.json` hooks, or both. Not inherited by forks. */
  setup_source_mode: EnvironmentSetupSourceMode;
  personal_preferences: string | null;
  source_environment_id: string | null;
  variable_count?: number;
  file_count?: number;
  skill_count?: number;
  mcp_count?: number;
  /** Workspaces built on this environment that aren't archived; only on list responses. */
  workspace_count?: number;
  /** When the newest workspace in this environment was created; only on list responses. */
  last_used_at?: string;
  /** Whether any active environment, including members' personal ones, forks this one; only on list responses. */
  has_forks?: boolean;
  access?: EnvironmentAccess;
  status?: EnvironmentStatus;
  created_at: string;
  updated_at: string;
}

export type EnvironmentAccess = ResourceAccess;

export interface ListEnvironmentsResponse {
  environments: EnvironmentRecord[];
}

export interface GetEnvironmentResponse {
  environment: EnvironmentRecord;
}

export interface CreateEnvironmentRequest {
  name: string;
  description?: string | null;
  scope?: ResourceScope;
  source_environment_id?: string | null;
  repository_ids?: string[];
  system_prompt?: string | null;
  memory_read_enabled?: boolean;
  memory_write_enabled?: boolean;
}

export interface CreateEnvironmentResponse {
  environment: EnvironmentRecord;
}

export interface UpdateEnvironmentRequest {
  name?: string;
  description?: string | null;
  repository_ids?: string[];
  system_prompt?: string | null;
  memory_read_enabled?: boolean;
  memory_write_enabled?: boolean;
  gpu_enabled?: boolean;
  mobile_testing_enabled?: boolean;
  setup_source_mode?: EnvironmentSetupSourceMode;
  default_skills?: DefaultSkillsOverrides;
  personal_preferences?: string | null;
  archived?: boolean;
  /** A `MANAGER_ICON_PRESETS` key. */
  icon?: string;
}

export interface UpdateEnvironmentResponse {
  environment: EnvironmentRecord;
}

export interface DeleteEnvironmentResponse {
  success: boolean;
}

export interface WorkloadIdentityResponse {
  configured: boolean;
  issuer: string | null;
  discovery_url: string | null;
  jwks_url: string | null;
}

// --- Environment Variables ---

export interface EnvironmentVariableRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  key: string;
  /** Empty for sensitive variables: their values are write-only. */
  value: string;
  locked: boolean;
  sensitive: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListEnvironmentVariablesResponse {
  environment_variables: EnvironmentVariableRecord[];
}

export interface CreateEnvironmentVariableRequest {
  environment_id: string;
  key: string;
  value: string;
  locked?: boolean;
  sensitive?: boolean;
}

export interface CreateEnvironmentVariableResponse {
  environment_variable: EnvironmentVariableRecord;
}

export const MAX_BULK_ENVIRONMENT_VARIABLES = 200;

export interface CreateEnvironmentVariablesRequest {
  variables: Array<{ key: string; value: string; sensitive?: boolean }>;
}

export interface CreateEnvironmentVariablesResponse {
  environment_variables: EnvironmentVariableRecord[];
}

export interface UpdateEnvironmentVariableRequest {
  key?: string;
  value?: string;
  locked?: boolean;
  /** Only turns sensitivity on; a sensitive value can't be made readable again. */
  sensitive?: true;
}

export interface UpdateEnvironmentVariableResponse {
  environment_variable: EnvironmentVariableRecord;
}

export interface DeleteEnvironmentVariableResponse {
  success: boolean;
}

// --- Environment Files ---

export interface EnvironmentFileRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  name: string;
  path: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface ListEnvironmentFilesResponse {
  environment_files: EnvironmentFileRecord[];
}

export interface CreateEnvironmentFileRequest {
  environment_id: string;
  name: string;
  path: string;
  content: string;
}

export interface CreateEnvironmentFileResponse {
  environment_file: EnvironmentFileRecord;
}

export interface UpdateEnvironmentFileRequest {
  name?: string;
  path?: string;
  content?: string;
}

export interface UpdateEnvironmentFileResponse {
  environment_file: EnvironmentFileRecord;
}

export interface DeleteEnvironmentFileResponse {
  success: boolean;
}

// --- Skills ---

export interface EnvironmentSkillRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  name: string;
  slug: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

export interface ListEnvironmentSkillsResponse {
  environment_skills: EnvironmentSkillRecord[];
}

export interface SearchEnvironmentSkillsResponse {
  skills: SearchSkill[];
}

export interface CreateEnvironmentSkillRequest {
  environment_id: string;
  name: string;
  slug: string;
  source: string;
}

export interface CreateEnvironmentSkillResponse {
  environment_skill: EnvironmentSkillRecord;
}

export interface DeleteEnvironmentSkillResponse {
  success: boolean;
}

export interface EnvironmentSkillsRegistryRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  name: string;
  url: string;
  repository_full_name: string;
  default_branch: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnvironmentSkillsRegistryWithContents extends EnvironmentSkillsRegistryRecord {
  repo_skills: RepoSkillRecord[];
  error: string | null;
}

export const REPO_SKILL_FRAMEWORKS = ['claude', 'codex', 'agents'] as const;
export type RepoSkillFramework = typeof REPO_SKILL_FRAMEWORKS[number];

/**
 * Inferred from the repo's checked-in contents — read-only and not stored
 * in the DB. Distinct from `EnvironmentSkillRecord`, which represents a
 * skills.sh entry the user explicitly enabled.
 */
export interface RepoSkillRecord {
  /** Stable id, computed as `${repository_id}:${path}`. */
  id: string;
  repository_id: string;
  /** Denormalized `owner/name` so the UI doesn't need a separate fetch. */
  repository_full_name: string;
  branch: string;
  path: string;
  /** Human-friendly name (from frontmatter, filename, or directory). */
  name: string;
  description: string | null;
  framework: RepoSkillFramework;
  kind: 'skill' | 'agent' | 'command' | 'prompt' | 'plugin';
  html_url: string;
}

export interface RepoSkillsError {
  repository_id: string;
  repository_full_name: string;
  error: string;
}

export interface ListRepoSkillsResponse {
  repo_skills: RepoSkillRecord[];
  repo_errors: RepoSkillsError[];
  /** Set when discovery couldn't run at all (e.g. bound repository deleted). */
  error: string | null;
}

export interface ListEnvironmentSkillsRegistriesResponse {
  registries: EnvironmentSkillsRegistryWithContents[];
}

export interface CreateEnvironmentSkillsRegistryRequest {
  environment_id: string;
  url: string;
}

export interface CreateEnvironmentSkillsRegistryResponse {
  registry: EnvironmentSkillsRegistryRecord;
  repo_skills: RepoSkillRecord[];
  error: string | null;
}

export interface DeleteEnvironmentSkillsRegistryResponse {
  success: boolean;
}

// --- MCPs (Model Context Protocol servers) ---

export const ENVIRONMENT_MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type EnvironmentMcpTransport = (typeof ENVIRONMENT_MCP_TRANSPORTS)[number];
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const environmentMcpVariableReferenceSchema = z.strictObject({
  env: z.string().regex(VARIABLE_KEY_RE, 'must be a valid environment variable name'),
  prefix: z.string().optional(),
});
export type EnvironmentMcpVariableReference = z.infer<typeof environmentMcpVariableReferenceSchema>;

export interface EnvironmentMcpStdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  envFrom?: Record<string, EnvironmentMcpVariableReference>;
}

export interface EnvironmentMcpHttpConfig {
  url: string;
  headers: Record<string, string>;
  headersFrom?: Record<string, EnvironmentMcpVariableReference>;
  auth?: McpAuth;
}

export type EnvironmentMcpConfig = EnvironmentMcpStdioConfig | EnvironmentMcpHttpConfig;

export const getMcpProxyDroppedHeader = (headers: Record<string, unknown>) =>
  Object.keys(headers).find((name) => ['authorization', 'proxy-authorization', 'cookie'].includes(name.toLowerCase()));

export function validateEnvironmentMcpAuthentication(
  transport: EnvironmentMcpTransport,
  config: { url: string; auth?: McpAuth; headers: Record<string, unknown>; headersFrom?: Record<string, unknown> },
): Result<void, 'url' | 'headers' | 'transport'> {
  if (!config.auth) return createSuccessResult();
  const url = new URL(config.url);
  if (url.search || url.protocol !== 'https:') {
    return createErrorResult({ code: 'url', message: 'OAuth and workspace identity authentication require an HTTPS MCP URL without query parameters' });
  }
  const dropped = getMcpProxyDroppedHeader({ ...config.headers, ...config.headersFrom });
  if (dropped) {
    return createErrorResult({ code: 'headers', message: `Remove the ${dropped} header: OAuth and workspace identity MCPs don't send it` });
  }
  // Legacy SSE endpoint events bypass the engine's authentication proxy.
  if (config.auth.type === 'oauth' && transport === 'sse') {
    return createErrorResult({ code: 'transport', message: 'OAuth requires the HTTP transport' });
  }
  return createSuccessResult();
}

export type EnvironmentMcpOAuthStatus = 'disconnected' | 'connected' | 'reconnect_required';

export interface EnvironmentMcpRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  name: string;
  transport: EnvironmentMcpTransport;
  config: EnvironmentMcpConfig;
  oauth?: { status: EnvironmentMcpOAuthStatus; reason: string | null };
  created_at: string;
  updated_at: string;
}

export type EnvironmentMcpConnectionStatus = 'connected' | 'unauthorized' | 'unknown';

export interface GetEnvironmentMcpStatusResponse {
  status: EnvironmentMcpConnectionStatus;
}

/** An MCP without a token or headers. Okidoki signs in with OAuth only if the server asks for it. */
export interface StartEnvironmentMcpOAuthRequest {
  id?: string;
  name: string;
  transport: EnvironmentMcpTransport;
  config: EnvironmentMcpConfig;
}

export type StartEnvironmentMcpOAuthResponse = { authorizationUrl: string } | { environment_mcp: EnvironmentMcpRecord };

export interface ListEnvironmentMcpsResponse {
  environment_mcps: EnvironmentMcpRecord[];
}

export interface CreateEnvironmentMcpRequest {
  environment_id: string;
  name: string;
  transport: EnvironmentMcpTransport;
  config: EnvironmentMcpConfig;
}

export interface CreateEnvironmentMcpResponse {
  environment_mcp: EnvironmentMcpRecord;
}

export interface UpdateEnvironmentMcpRequest {
  name?: string;
  transport?: EnvironmentMcpTransport;
  config?: EnvironmentMcpConfig;
}

const stringMap = z.record(z.string(), z.string());
export const environmentMcpStdioConfigSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: stringMap.optional(), envFrom: z.record(z.string().regex(VARIABLE_KEY_RE), environmentMcpVariableReferenceSchema).optional() });
export const environmentMcpHttpConfigSchema = z.object({ url: z.url(), headers: stringMap.optional(), headersFrom: z.record(z.string(), environmentMcpVariableReferenceSchema).optional(), auth: mcpAuthSchema.optional() });
export const createEnvironmentMcpRequestSchema = z.object({
  name: z.string(),
  transport: z.enum(ENVIRONMENT_MCP_TRANSPORTS),
  config: z.union([
    environmentMcpStdioConfigSchema,
    environmentMcpHttpConfigSchema,
  ]).describe('stdio: `{ command, args, env }`. http/sse: `{ url, headers }`.'),
});
export const updateEnvironmentMcpRequestSchema = createEnvironmentMcpRequestSchema.partial();

export interface UpdateEnvironmentMcpResponse {
  environment_mcp: EnvironmentMcpRecord;
}

export interface DeleteEnvironmentMcpResponse {
  success: boolean;
}

/**
 * Reserved name prefixes for system-managed MCPs (e.g. the subagent MCP).
 * Enforced at the API layer when users create MCPs and applied again in the
 * monolith provisioning filter as defense-in-depth, so a row that pre-dates
 * the API guard cannot override internal tool surfaces.
 */
export const RESERVED_MCP_NAME_PREFIXES = ['okidoki-', SUBAGENT_MCP_SERVER_NAME] as const;

export function isReservedMcpName(name: string): boolean {
  return RESERVED_MCP_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export interface ProvisionedMcpEntry {
  transport: EnvironmentMcpTransport;
  config: EnvironmentMcpConfig;
  toolTimeoutMs?: number;
}

export interface EnvironmentDeviceRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  name: string;
  /** Null when the device connects to Okidoki itself, so it needs no address or tailnet. */
  host: string | null;
  port: number;
  username: string;
  /** Authorize this on the device (`~/.ssh/authorized_keys`); the private half never leaves Okidoki and its workspaces. */
  public_key: string;
  has_screen_password: boolean;
  created_at: string;
  updated_at: string;
}

const screenPasswordSchema = z.string().min(1, 'Enter the screen password').max(256)
  .describe('Screen Sharing password, for `okidoki computer screen`. On a Mac, the "VNC viewers may control screen with password" password. Never returned.');

const hostSchema = z.string().max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:]+)$/, 'Enter a hostname or IP address');

// Each field lands in a generated ssh_config, so none may carry whitespace or option syntax.
export const createEnvironmentDeviceRequestSchema = z.object({
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Use lowercase letters, numbers and dashes')
    .describe('SSH alias in workspaces, e.g. `mac-mini` for `ssh mac-mini`.'),
  host: hostSchema.optional()
    .describe('Hostname or IP, such as a Tailscale MagicDNS name (`mac-mini`) or a public address. Leave it out when the device connects to Okidoki itself with `okidoki device connect`.'),
  port: z.number().int().min(1).max(65535).optional().describe('SSH port on the device. Defaults to 22.'),
  username: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/, 'Enter the account name on the device')
    .describe('Account the agent signs in as.'),
  screen_password: screenPasswordSchema.optional(),
});
export const updateEnvironmentDeviceRequestSchema = createEnvironmentDeviceRequestSchema.partial().extend({
  host: z.union([hostSchema, z.literal('')]).optional().describe('New hostname or IP, or an empty string for a device that connects to Okidoki itself.'),
  screen_password: z.union([screenPasswordSchema, z.literal('')]).optional().describe('New Screen Sharing password, or an empty string to remove it.'),
});
export type CreateEnvironmentDeviceRequest = z.infer<typeof createEnvironmentDeviceRequestSchema>;
export type UpdateEnvironmentDeviceRequest = z.infer<typeof updateEnvironmentDeviceRequestSchema>;

// Spans a few check-ins, so one missed poll does not mark a connected device offline.
export const DEVICE_ONLINE_WINDOW_MS = 30_000;

export const isDeviceOnline = (lastSeenAt: string | null, now = Date.now()) => lastSeenAt !== null && now - Date.parse(lastSeenAt) < DEVICE_ONLINE_WINDOW_MS;

export interface ListedEnvironmentDevice extends EnvironmentDeviceRecord {
  last_seen_at: string | null;
}

export interface ListEnvironmentDevicesResponse {
  environment_devices: ListedEnvironmentDevice[];
}

export interface EnvironmentDeviceResponse {
  environment_device: EnvironmentDeviceRecord;
}

export interface EnvironmentDeviceConnectTokenResponse {
  /** Anyone holding it can stand in for the device until it first connects, so only environment editors see it. */
  token: string;
}

export const deviceConnectionResponseSchema = z.object({
  name: z.string(),
  port: z.number(),
  workspace_ids: z.array(z.string()),
});
export type DeviceConnectionResponse = z.infer<typeof deviceConnectionResponseSchema>;

// Each key becomes a known_hosts line in workspaces and travels comma-joined in one header, so only `<type> <base64>` is allowed.
export const deviceHostKeysRequestSchema = z.object({
  host_keys: z.array(z.string().max(2048).regex(/^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}$/, 'Each host key must be `<type> <base64>`'))
    .min(1).max(8)
    .transform((keys) => [...new Set(keys)].sort()),
});
export type DeviceHostKeysRequest = z.input<typeof deviceHostKeysRequestSchema>;

export const DEVICE_HOST_KEYS_HEADER = 'x-okidoki-device-host-keys';

export const DEVICE_CONNECT_COMMAND = 'npx -y okidoki-cli device connect';

export const provisionedDeviceSchema = z.object({
  name: z.string(),
  host: z.string().nullable(),
  port: z.number(),
  username: z.string(),
  private_key: z.string(),
  screen_password: z.string().optional(),
});
export type ProvisionedDevice = z.infer<typeof provisionedDeviceSchema>;

// --- Warm Hooks (per-env) ---

export type EnvironmentHookKind = 'start' | 'warm';

export interface WarmHookRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  version: number;
  content: string;
  is_active: boolean;
  created_at: string;
}

export const WARM_POOL_WORKSPACE_STATUSES = ['warming', 'snapshotting', 'ready', 'assigned', 'expired', 'failed'] as const;
export type WarmPoolWorkspaceStatus = (typeof WARM_POOL_WORKSPACE_STATUSES)[number];

export interface WarmPoolConfigRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  enabled: boolean;
  target_size: number;
  /**
   * Monotonic counter bumped on every invalidation. Workspaces and snapshots
   * carry the generation they were built for; anything older is stale.
   */
  generation: number;
  error_count: number;
  next_retry_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  /**
   * True when a base snapshot is installed for the current generation. For
   * Distinguishes the initial seed-build phase (`false` + warming > 0)
   * from the clone-refill phase (`true` + warming > 0).
   */
  has_base_snapshot: boolean;
  updated_at: string;
}

export interface WarmPoolConfigWithStats extends WarmPoolConfigRecord {
  /** Ready workspaces at the current generation. */
  ready_count: number;
  /** Ready workspaces at older generations — still claimable but trimmed when over target. */
  stale_count: number;
  /** Warming workspaces at the current generation (warm hooks running). */
  warming_count: number;
  snapshotting_count: number;
  last_failure_at: string | null;
  last_failure_reason: string | null;
}

export interface WarmPoolSnapshotRecord {
  id: string;
  warm_pool_config_id: string;
  generation: number;
  is_current: boolean;
  is_fallback: boolean;
  created_at: string;
}

export const WARM_POOL_BUILD_STATUSES = ['queued', 'building', 'succeeded', 'failed', 'superseded', 'cancelled'] as const;
export type WarmPoolBuildStatus = (typeof WARM_POOL_BUILD_STATUSES)[number];

export const ENVIRONMENT_CHANGE_KINDS = [
  'repositories',
  'warm_hook',
  'variable',
  'file',
  'skill',
  'skills_registry',
  'default_skills',
  'gpu',
  'mobile_testing',
  'setup_source_mode',
  'agent_auth',
  'workspace_size',
  'agent_setup',
  'restore',
  'system',
] as const;
export type EnvironmentChangeKind = (typeof ENVIRONMENT_CHANGE_KINDS)[number];
export const ENVIRONMENT_CHANGE_OPS = ['created', 'updated', 'deleted'] as const;
export type EnvironmentChangeOp = (typeof ENVIRONMENT_CHANGE_OPS)[number];

export interface EnvironmentChange {
  kind: EnvironmentChangeKind;
  key: string | null;
  op: EnvironmentChangeOp;
  user_id: string | null;
}

/** `user_id` of changes Okidoki makes itself (admin actions, rollouts, maintenance), shown to customers as "Okidoki". */
export const OKIDOKI_USER_ID = '00000000-0000-0000-0000-000000000000';

const CHANGE_LABELS: Record<EnvironmentChangeKind, string> = {
  repositories: 'Repositories',
  warm_hook: 'Warm hook',
  variable: 'Variable',
  file: 'File',
  skill: 'Skill',
  skills_registry: 'Skills registry',
  default_skills: 'Default skills',
  gpu: 'GPU sandboxes',
  mobile_testing: 'Mobile testing',
  setup_source_mode: 'Setup source',
  agent_auth: 'Agent sign-in',
  workspace_size: 'Default workspace size',
  agent_setup: 'Agent-led setup',
  restore: 'Restored setup',
  system: 'Maintenance',
};

/** `op` is null for kinds that read as a whole event (a restore, maintenance) rather than an edit. */
export function describeEnvironmentChange(change: Pick<EnvironmentChange, 'kind' | 'key' | 'op'>): { label: string; key: string | null; op: EnvironmentChangeOp | null } {
  if (change.kind === 'system' && change.key) return { label: change.key, key: null, op: null };
  if (change.kind === 'workspace_size' && change.key) return { label: `${CHANGE_LABELS.workspace_size} set to`, key: change.key, op: null };
  const silent = change.kind === 'restore' || change.kind === 'system' || change.kind === 'agent_setup';
  return { label: CHANGE_LABELS[change.kind], key: change.key, op: silent ? null : change.op };
}

export function formatEnvironmentChange(change: Pick<EnvironmentChange, 'kind' | 'key' | 'op'>): string {
  const { label, key, op } = describeEnvironmentChange(change);
  return [label, key, op].filter(Boolean).join(' ');
}

/** A failed first setup with `live_since` still left a snapshot with the repositories cloned, so workspaces start without the warm hook's setup. */
export function getFirstSetupState(environment: Pick<EnvironmentRecord, 'status'> | undefined): 'setting_up' | 'repos_only' | 'blocked' | null {
  const status = environment?.status;
  if (!status?.first_setup) return null;
  if (status.state === 'needs_attention') return status.live_since ? 'repos_only' : 'blocked';
  return status.state === 'applying' && !status.live_since ? 'setting_up' : null;
}

export function getEnvironmentFailureCopy(environment: Pick<EnvironmentRecord, 'status'>): { title: string; cause: string } | null {
  const failure = environment.status?.failure;
  if (environment.status?.state !== 'needs_attention' || !failure) return null;
  const firstSetup = getFirstSetupState(environment);
  const hookFailed = failure.kind === 'hook';
  const title = firstSetup === 'blocked'
    ? `${hookFailed ? 'The warm hook failed' : 'Setup failed'}, so workspaces can't start yet`
    : firstSetup === 'repos_only'
      ? 'The warm hook failed, so workspaces start without its setup'
      : hookFailed
      ? "The warm hook failed, so your changes aren't live yet"
      : "We couldn't apply your changes";
  const cause = failure.cause
    ? `${failure.cause.summary} ${failure.cause.fix}`
    : 'Setting up a workspace failed on our side a few times in a row. Trying again usually fixes it.';
  return { title, cause };
}

export function getCodeHostAccessProvider(environment: Pick<EnvironmentRecord, 'status'> | undefined): CodeHostProvider | null {
  const failure = environment?.status?.failure;
  // A warm hook's rejected credentials are a registry token in Variables, not the code host.
  if (getFirstSetupState(environment) !== 'blocked' || failure?.kind === 'hook' || failure?.cause?.kind !== 'missing_secret') return null;
  return /gitlab/i.test(failure.message ?? '') ? 'gitlab' : 'github';
}

export function getCodeHostAccessLink(provider: CodeHostProvider, installUrl?: string): { label: string; href: string; external: boolean } {
  if (provider === 'gitlab') return { label: 'GitLab settings', href: WEB_APP_PATHS.integrationsGitlab, external: false };
  return installUrl
    ? { label: 'Grant access on GitHub', href: installUrl, external: true }
    : { label: 'Connect GitHub', href: WEB_APP_PATHS.integrationsGithub, external: false };
}

export const WARM_POOL_FAILURE_KINDS = ['hook', 'infra'] as const;
/** `hook`: a warm hook exited non-zero or timed out; rerunning the same setup fails the same way, so it is not retried. */
export type WarmPoolFailureKind = (typeof WARM_POOL_FAILURE_KINDS)[number];

export type EnvironmentState = 'ready' | 'applying' | 'needs_attention';

export interface EnvironmentStatusFailure {
  build_id: string;
  kind: WarmPoolFailureKind;
  message: string | null;
  failed_at: string | null;
  run_id: string | null;
  exit_code: number | null;
  cause: HookFailureCause | null;
  log_tail: string[];
}

export interface EnvironmentStatus {
  state: EnvironmentState;
  /** `idle`: the environment is unused, so its saved changes build the next time someone starts or selects it. */
  phase: 'waiting' | 'running' | 'idle' | null;
  apply_after: string | null;
  live_since: string | null;
  first_setup: boolean;
  changes: EnvironmentChange[];
  failure: EnvironmentStatusFailure | null;
  skipped_skill_sources: string[];
}

export interface WarmPoolBuildRecord {
  id: string;
  generation: number;
  status: WarmPoolBuildStatus;
  reasons: string[];
  changes: EnvironmentChange[];
  failure_kind: WarmPoolFailureKind | null;
  restorable: boolean;
  attempts: number;
  queued_at: string;
  build_after: string;
  started_at: string | null;
  finished_at: string | null;
  superseded_by: string | null;
  error_message: string | null;
  builder_warm_pool_workspace_id: string | null;
  run_id: string | null;
}

export interface WarmPoolServingState {
  serving_build: WarmPoolBuildRecord | null;
  serving_generation: number | null;
  serving_is_current: boolean;
  ready_count: number;
  current_ready_count: number;
  pending_build: WarmPoolBuildRecord | null;
}

export interface GetWarmHooksResponse {
  warm_hook: WarmHookRecord | null;
  warm_pool: WarmPoolConfigWithStats | null;
  snapshots: WarmPoolSnapshotRecord[];
  builds: WarmPoolBuildRecord[];
  serving: WarmPoolServingState | null;
  build_estimate: WarmPoolBuildEstimate | null;
}

/** `remaining_seconds` goes negative once the current build runs past the typical time. */
export interface WarmPoolBuildEstimate {
  typical_seconds: number;
  remaining_seconds: number;
}

export interface RestoreEnvironmentSetupRequest {
  build_id: string;
}

export interface RestoreEnvironmentSetupResponse {
  rebuilding: boolean;
}

export interface BuildWarmPoolNowResponse {
  build: WarmPoolBuildRecord;
}

export interface SaveWarmHookRequest {
  environment_id: string;
  content: string;
}

export interface SaveWarmHookResponse {
  warm_hook: WarmHookRecord | null;
}

export interface HookTestResult {
  exit_code: number;
  output: string;
  timed_out: boolean;
}

export interface SaveAndTestWarmHookRequest {
  environment_id: string;
  content: string;
}

export interface SaveAndTestWarmHookResponse {
  warm_hook: WarmHookRecord;
  test: HookTestResult;
}

export interface TestWarmHookRequest {
  content: string;
}

export interface TestWarmHookResponse {
  test: HookTestResult;
}

export type HookTestEventType = 'progress' | 'output' | 'complete' | 'error';

export interface BaseHookTestEvent {
  type: HookTestEventType;
  message?: string;
  output?: string;
  exit_code?: number;
  timed_out?: boolean;
}

export interface WarmHookTestEvent extends BaseHookTestEvent {
  warm_hook?: WarmHookRecord;
}

export interface HookEngineStreamEvent {
  type: 'output' | 'complete' | 'error';
  data?: string;
  exitCode?: number;
  timedOut?: boolean;
  label?: string;
  /** Sent with `complete`. */
  steps?: EnvironmentHookRunStep[];
}

export type WarmHookStreamEvent = HookEngineStreamEvent;

export interface UpsertWarmPoolConfigRequest {
  environment_id: string;
  enabled: boolean;
}

export interface UpsertWarmPoolConfigResponse {
  warm_pool: WarmPoolConfigWithStats;
}

export interface RestoreWarmPoolSnapshotResponse {
  warm_pool: WarmPoolConfigWithStats;
  restored_generation: number;
}

/**
 * Per-repository warm hook entry resolved from `okidoki.{json,yaml,yml}` on
 * the repo's default branch. Each entry is independent — a fetch or parse
 * failure on one repo is reported via `error` while others still resolve.
 */
export interface RepositoryWarmHookSummary {
  repository_id: string;
  repository_name: string;
  default_branch: string;
  filename: string | null;
  warm_hook: {
    commands: string[];
    timeout_ms: number | null;
    separate: boolean;
  } | null;
  error: string | null;
}

export interface ListEnvironmentRepositoryWarmHooksResponse {
  repositories: RepositoryWarmHookSummary[];
}

export interface StartHookRecord {
  id: string;
  organization_id: string;
  environment_id: string;
  version: number;
  content: string;
  is_active: boolean;
  created_at: string;
}

export interface GetStartHooksResponse {
  start_hook: StartHookRecord | null;
}

export interface SaveStartHookRequest {
  content: string;
}

export interface SaveStartHookResponse {
  start_hook: StartHookRecord | null;
}

export interface TestStartHookRequest {
  content: string;
}

export interface TestStartHookResponse {
  test: HookTestResult;
}


export type StartHookTestEvent = BaseHookTestEvent;

export type StartHookStreamEvent = HookEngineStreamEvent;

export interface RepositoryStartHookSummary {
  repository_id: string;
  repository_name: string;
  default_branch: string;
  filename: string | null;
  start_hook: {
    commands: string[];
    timeout_ms: number | null;
    separate: boolean;
  } | null;
  error: string | null;
}

export interface ListEnvironmentRepositoryStartHooksResponse {
  repositories: RepositoryStartHookSummary[];
}

// --- Warm Pool Workspaces (for log listing) ---

export interface WarmPoolWorkspaceRecord {
  id: string;
  organization_id: string;
  warm_pool_config_id: string;
  sandbox_id: string;
  status: WarmPoolWorkspaceStatus;
  /** Config generation this workspace was built for. < config.generation → stale. */
  generation: number;
  error_message: string | null;
  created_at: string;
}

export interface ListWarmPoolWorkspacesResponse {
  workspaces: WarmPoolWorkspaceRecord[];
}

/** Live warm-hook output proxied from the warming sandbox's engine. */
export type WarmPoolWorkspaceStreamEventType = 'output' | 'status' | 'complete' | 'error';

export interface WarmPoolWorkspaceStreamEvent {
  type: WarmPoolWorkspaceStreamEventType;
  output?: string;
  status?: WarmPoolWorkspaceStatus;
  workspace?: WarmPoolWorkspaceRecord;
  message?: string;
}

// --- Workspace environment options (Slack/Linear intake + dashboard) ---

export interface WorkspaceEnvironmentOption {
  id: string;
  label: string;
  description: string | null;
  repository_ids: string[];
}

export interface BuildWorkspaceEnvironmentsOptions {
  environments: EnvironmentRecord[];
  repositories: RepositoryRecord[];
}

/**
 * Lives in shared so the monolith intake handlers and the web settings page
 * cannot drift on which envs are considered selectable.
 */
export function buildWorkspaceEnvironmentOptions(
  params: BuildWorkspaceEnvironmentsOptions,
): WorkspaceEnvironmentOption[] {
  const repositoryIds = new Set(params.repositories.map((repository) => repository.id));
  return params.environments.flatMap((env) => {
    // Web can deploy before the API that adds repository_ids.
    const envRepositoryIds = env.repository_ids ?? [];
    return envRepositoryIds.every((id) => repositoryIds.has(id))
      ? [{ id: env.id, label: env.name, description: env.description, repository_ids: envRepositoryIds }]
      : [];
  });
}
