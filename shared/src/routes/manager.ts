import { z } from 'zod';
import { VALID_AGENT_PROVIDERS, VALID_THINKING_LEVELS } from '../agent';
import { DEPLOY_START_WINDOW_MS, type PullRequestCheck, type PullRequestDeployment, type PullRequestDetails, type WorkspacePullRequestDetailsEntry } from './pull-requests';
import type { ManagerFollowThroughVerdict } from '../prompts';
import type { LinearTeam } from './linear';
import { linearIssueFiltersSchema } from '../automations/linear';
import { isRecord } from '../type-guards';
import { ACCENT_COLORS, DESIGN_COLORS, PALETTE_COLORS } from '../design-tokens';
import { PIXEL_CREW_ROLE_NAMES, stableIndex } from '../pixel-crew';
import { parseCodeHostPrUrl } from '../urls';
import type { WorkspaceSidebarState } from '../workspace-sidebar-state';
import type { RespondToolInputRequest, SendChatMessageRequest } from '../engine/v1';
import type { PushQuestion } from './push';

export type ManagerBoardTone = 'neutral' | 'needs_you' | 'warning' | 'success' | 'danger' | 'working' | 'done';

// Never the rocket: that marks the Managers section itself.
export const MANAGER_ICON_PRESETS = [
  'compass', 'atom', 'mountain', 'anchor', 'flame', 'gem', 'leaf', 'moon',
  'orbit', 'satellite', 'shield', 'sun', 'zap', 'crown', 'cloud', 'globe', 'chef-hat',
] as const;
// Icons derived from an id pick from this original set, so adding a preset never reshuffles existing ones.
const DERIVED_ICON_PRESET_COUNT = 16;
export type ManagerIconPreset = (typeof MANAGER_ICON_PRESETS)[number];

export function isManagerIconPreset(value: unknown): value is ManagerIconPreset {
  return MANAGER_ICON_PRESETS.some((preset) => preset === value);
}

/** Managers created before presets were stored derive a stable one from their id. */
export function resolveManagerIconPreset(workspace: { id: string; icon: string | null }): ManagerIconPreset {
  if (isManagerIconPreset(workspace.icon)) return workspace.icon;
  return MANAGER_ICON_PRESETS[stableIndex(workspace.id, DERIVED_ICON_PRESET_COUNT)];
}

/** `'theme'` follows the user's accent and surface tokens; anything else is a custom `#rrggbb`. */
export const avatarColorSchema = z.union([z.literal('theme'), z.string().regex(/^#[0-9a-f]{6}$/i)]);
export type AvatarColor = z.infer<typeof avatarColorSchema>;

export const MANAGER_AVATAR_BACKGROUNDS = [
  ['Forest', PALETTE_COLORS.light.default.foreground], ['Black', PALETTE_COLORS.dark.default.background], ['Graphite', PALETTE_COLORS.dark.default.selected],
  ['Deep green', ACCENT_COLORS.green.light.primaryText], ['Deep blue', ACCENT_COLORS.blue.light.primaryText], ['Deep purple', ACCENT_COLORS.purple.light.primaryText],
  ['Deep pink', ACCENT_COLORS.pink.light.primaryText], ['Brown', DESIGN_COLORS.light.warningText], ['Sage', PALETTE_COLORS.light.default.muted], ['White', DESIGN_COLORS.light.white],
] as const;

export const MANAGER_AVATAR_PRIMARIES = [
  ['Green', ACCENT_COLORS.green.dark.primary], ['Blue', ACCENT_COLORS.blue.dark.primary], ['Purple', ACCENT_COLORS.purple.dark.primary],
  ['Pink', ACCENT_COLORS.pink.dark.primary], ['Coral', DESIGN_COLORS.dark.destructiveText], ['Amber', DESIGN_COLORS.dark.warning],
  ['White', PALETTE_COLORS.dark.default.foreground], ['Deep green', ACCENT_COLORS.green.light.primaryText], ['Deep blue', ACCENT_COLORS.blue.light.primaryText],
  ['Deep purple', ACCENT_COLORS.purple.light.primaryText], ['Deep pink', ACCENT_COLORS.pink.light.primaryText], ['Ink', PALETTE_COLORS.light.default.foreground],
] as const;

export const managerPresetAvatarSchema = z.object({
  kind: z.literal('preset'),
  role: z.enum(PIXEL_CREW_ROLE_NAMES),
  primary: avatarColorSchema,
  background: avatarColorSchema,
});
export type ManagerPresetAvatar = z.infer<typeof managerPresetAvatarSchema>;

export const managerEmojiAvatarSchema = z.object({
  kind: z.literal('emoji'),
  emoji: z.string().trim().min(1).max(32),
  background: avatarColorSchema,
});

export const managerChosenAvatarSchema = z.discriminatedUnion('kind', [managerPresetAvatarSchema, managerEmojiAvatarSchema]);
export type ManagerChosenAvatar = z.infer<typeof managerChosenAvatarSchema>;

/** Uploads are stored by object key and served from a public URL, so Slack can show them too. */
export const managerAvatarSchema = z.union([managerChosenAvatarSchema, z.object({ kind: z.literal('image'), url: z.string() })]);
export type ManagerAvatar = z.infer<typeof managerAvatarSchema>;

export interface ManagerSlackChannel {
  id: string;
  /** Null when Slack can no longer read the channel, for example after it was deleted. */
  name: string | null;
  url: string;
  /** Archived in Slack. Bot tokens can't unarchive, so a restored Manager's channel stays archived. */
  archived: boolean;
  /** Okidoki created it for this Manager, so it's archived with the Manager. */
  created: boolean;
}

export type ManagerSlackChannelState = { status: 'unavailable' } | { status: 'none' } | { status: 'linked'; channel: Pick<ManagerSlackChannel, 'id' | 'name' | 'archived'> };

export interface ManagerSlackChannelResponse {
  channel: ManagerSlackChannel | null;
}

export interface LinkManagerSlackChannelRequest {
  channel_id?: string;
}

export interface ManagerTexting {
  line: string;
  phone: string | null;
  code: string | null;
  mine: boolean;
}

export interface ManagerTextingLine {
  line: string;
  usedBy: string | null;
}

export const setUpManagerTextingRequestSchema = z.object({ line: z.string().optional() });
export type SetUpManagerTextingRequest = z.infer<typeof setUpManagerTextingRequestSchema>;

export interface ManagerTextingResponse {
  available: boolean;
  texting: ManagerTexting | null;
  lines?: ManagerTextingLine[];
  movedFrom?: string;
}

// Slack channel names are lowercase letters, numbers, hyphens and underscores, up to 80 characters.
export function getManagerSlackChannelName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `manager-${slug}`.slice(0, 76).replace(/-+$/, '') : 'manager';
}

const linearRuleFields = linearIssueFiltersSchema.extend({ team_id: z.string().min(1) }).strict();
export type ManagerLinearRule = z.infer<typeof linearRuleFields>;

// Rules saved before a rule could hold several labels have one label_id.
const withLabelIds = (value: unknown) => {
  if (!isRecord(value) || typeof value.label_id !== 'string') return value;
  const { label_id, ...rest } = value;
  return { ...rest, label_ids: [label_id] };
};
export const managerLinearRuleSchema = z.preprocess(withLabelIds, linearRuleFields);

export interface LinearRuleOption {
  id: string;
  name: string;
}

export interface LinearRuleOptionsResponse {
  teams: LinearTeam[];
  labels: LinearRuleOption[];
  projects: LinearRuleOption[];
  members: Array<LinearRuleOption & { email: string }>;
}

/** Names are read from Linear, and are null when it no longer has the team, label, project or person. */
export interface ManagerLinearLink {
  rule: ManagerLinearRule;
  team: string | null;
  labels: Array<string | null>;
  project: string | null;
  assignee: string | null;
}

export interface ManagerLinearLinkResponse {
  link: ManagerLinearLink | null;
  automation_id: string | null;
}

export function describeManagerLinearRule(link: ManagerLinearLink): string {
  const { rule } = link;
  return [
    link.team ?? 'Unknown team',
    rule.current_cycle && 'current cycle',
    rule.label_ids && `label: ${link.labels.map((label) => label ?? 'deleted label').join(' or ')}`,
    rule.project_id && `project: ${link.project ?? 'deleted project'}`,
    rule.assignee_id && `assignee: ${link.assignee ?? 'unknown person'}`,
  ].filter(Boolean).join(' · ');
}

export interface ManagerPullRequest {
  url: PullRequestDetails['url'];
  status: PullRequestDetails['state'];
  ci_status: PullRequestDetails['ciStatus'] | null;
  mergeability: PullRequestDetails['mergeability'] | null;
  merge_blockers: NonNullable<PullRequestDetails['mergeBlockers']>;
  review_decision: PullRequestDetails['reviewDecision'];
  merged_at: string | null;
  error: string | null;
  label: string | null;
}

export const SUBAGENT_SERVICE_TIERS = ['default', 'fast', 'ultrafast'] as const;
type SubagentServiceTier = (typeof SUBAGENT_SERVICE_TIERS)[number];

export function serviceTierRequestFields(tier: SubagentServiceTier): { fastMode: boolean; ultrafastMode?: true } {
  return { fastMode: tier !== 'default', ...(tier === 'ultrafast' ? { ultrafastMode: true } : {}) };
}

export const managerSubagentSettingsSchema = z.object({
  coding_agent: z.enum(VALID_AGENT_PROVIDERS),
  model: z.string().nullable(),
  thinking_level: z.enum(VALID_THINKING_LEVELS).nullable(),
  service_tier: z.enum(SUBAGENT_SERVICE_TIERS),
  goal_mode: z.boolean(),
});

/** How the Manager runs a subagent; null model or thinking level means the agent's default. */
export type ManagerSubagentSettings = z.infer<typeof managerSubagentSettingsSchema>;

export interface ManagerSubagent {
  id: string;
  name: string;
  state: 'working' | 'idle' | 'asleep' | 'archived' | 'error';
  pull_requests: ManagerPullRequest[];
  fixes_in_progress: boolean;
  follow_through: ManagerFollowThroughVerdict | null;
  status: ManagerSubagentStatus;
  blocked_reason: string | null;
  open_ask: ManagerOpenAsk | null;
  /** Null for subagents spawned before settings were recorded. */
  settings: ManagerSubagentSettings | null;
  /** Null once the environment is deleted. */
  environment: { id: string; name: string } | null;
}

export interface ManagerOpenAsk {
  chat_id: string;
  question: string;
  options: string[];
  tool_request: { id: string; question: PushQuestion } | null;
}

export const MANAGER_SUBAGENT_STATE_LABELS: Record<ManagerSubagent['state'], string> = {
  working: 'Working',
  idle: 'Finished',
  asleep: 'Asleep',
  archived: 'Archived',
  error: 'Failed',
};

export function managerPullRequestStatus(agent: ManagerSubagent, pr: ManagerSubagent['pull_requests'][number]): string {
  if (pr.status === 'merged' || pr.status === 'closed') return pr.status;
  if (agent.fixes_in_progress) return 'fixing';
  if (pr.ci_status === 'pending') return 'CI running';
  if (pr.ci_status === 'failure') return 'CI failing';
  return agent.follow_through === 'ready' ? isManagerPullRequestMergeable(pr) ? 'ready to merge' : 'ready for review' : agent.follow_through === 'needs_attention' ? 'needs attention' : 'open';
}

const CONVENTIONAL_PREFIX = /^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s*(?=\S)/i;

export function formatPullRequestTitle(title: string): string {
  const subject = title.trim().replace(CONVENTIONAL_PREFIX, '');
  // A first word that already has a capital ("iPad", "macOS") is a name, and capitalizing it would misspell it.
  return /^\S*[A-Z]/.test(subject) ? subject : subject.charAt(0).toUpperCase() + subject.slice(1);
}

export function isManagerSubagentBusy(agent: ManagerSubagent): boolean {
  return agent.state === 'working' || agent.fixes_in_progress || agent.follow_through === 'pending';
}

export function formatManagerSubagentState(agent: ManagerSubagent): string {
  return agent.state === 'archived' ? 'Archived' : formatManagerSubagentStatus(agent);
}

export interface ListWorkspaceSubagentsResponse {
  subagents: ManagerSubagent[];
}

export type ManagerSubagentStatus = 'blocked' | 'ready' | 'working' | 'idle' | 'done';

export const MANAGER_SUBAGENT_STATUS_LABELS: Record<ManagerSubagentStatus, string> = {
  blocked: 'Blocked',
  ready: 'Ready for review',
  working: 'Working',
  idle: 'Idle',
  done: 'Done',
};

export const MANAGER_SUBAGENT_SIDEBAR_STATES: Partial<Record<ManagerSubagentStatus, WorkspaceSidebarState['kind']>> = { blocked: 'input', ready: 'review', working: 'working' };

export const MANAGER_SUBAGENT_STATUS_TONES: Record<ManagerSubagentStatus, ManagerBoardTone> = {
  blocked: 'warning',
  ready: 'success',
  working: 'working',
  idle: 'neutral',
  done: 'neutral',
};

export function isManagerPullRequestMergeable(pr: Pick<ManagerPullRequest, 'status' | 'mergeability' | 'ci_status'>): boolean {
  return pr.status === 'open' && pr.mergeability === 'mergeable' && pr.ci_status !== 'failure' && pr.ci_status !== 'pending';
}

export function formatManagerSubagentStatus(agent: Pick<ManagerSubagent, 'status' | 'pull_requests'>): string {
  return agent.status === 'ready' && agent.pull_requests.filter(isManagerPullRequestOpen).every(isManagerPullRequestMergeable)
    ? 'Ready to merge'
    : MANAGER_SUBAGENT_STATUS_LABELS[agent.status];
}

export interface ManagerSubagentSummary {
  id: string;
  name: string;
  status: ManagerSubagentStatus;
  blocked_reason: string | null;
  follow_through: ManagerFollowThroughVerdict | null;
  fixes_in_progress: boolean;
  pull_requests: Array<Pick<ManagerPullRequest, 'url' | 'status' | 'label' | 'merged_at'>>;
}

const OPEN_PULL_REQUEST_STATUSES: ReadonlyArray<ManagerPullRequest['status']> = ['open', 'draft'];

export function isManagerPullRequestOpen(pr: Pick<ManagerPullRequest, 'status'>): boolean {
  return OPEN_PULL_REQUEST_STATUSES.includes(pr.status);
}

export function isManagerPullRequestReady(agent: { status: ManagerSubagentStatus }, pr: Pick<ManagerPullRequest, 'status'>): boolean {
  return agent.status === 'ready' && pr.status === 'open';
}

// Reviewable once the subagent's own turn is over: CI and automatic PR fixes only change how it is shown, not whether.
export function deriveManagerSubagentStatus({ failed, running, archived, waitingOn, followThrough, pullRequests }: {
  failed: boolean;
  running: boolean;
  archived: boolean;
  waitingOn: string | null;
  followThrough: ManagerFollowThroughVerdict | null;
  pullRequests: ReadonlyArray<Pick<ManagerPullRequest, 'status'>>;
}): Pick<ManagerSubagent, 'status' | 'blocked_reason'> {
  const status = (value: ManagerSubagentStatus, blocked_reason: string | null = null) => ({ status: value, blocked_reason });
  if (archived) return status('done');
  if (failed) return status('blocked', 'Stopped with an error');
  if (running) return status('working');
  if (waitingOn) return status('blocked', waitingOn);
  if (pullRequests.some((pr) => pr.status === 'open')) return status('ready');
  if (followThrough === 'needs_attention') return status('blocked', 'Needs attention');
  return status(pullRequests.some(isManagerPullRequestOpen) ? 'idle' : 'done');
}

const QUEUE_SECTIONS = [
  { label: 'Open PRs', groups: ['needs_you', 'ready_to_merge', 'ready_to_review'] },
  { label: 'Working', groups: ['working'] },
  { label: 'Shipping', groups: ['shipping'] },
] as const;
const MANAGER_QUEUE_GROUPS = QUEUE_SECTIONS.flatMap((section) => section.groups);
export type ManagerQueueGroup = (typeof MANAGER_QUEUE_GROUPS)[number] | 'done';
export const MANAGER_QUEUE_SECTIONS: ReadonlyArray<{ label: string; groups: readonly ManagerQueueGroup[] }> = QUEUE_SECTIONS;

export const MANAGER_QUEUE_GROUP_LABELS: Record<ManagerQueueGroup, string> = {
  needs_you: 'Needs attention',
  ready_to_merge: 'Ready to merge',
  ready_to_review: 'Ready for review',
  working: 'Working',
  shipping: 'Shipping',
  done: 'Done',
};

export const MANAGER_SHIPPING_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

export function isManagerPullRequestShipping(pr: Pick<ManagerPullRequest, 'status' | 'merged_at'>, now = Date.now()): boolean {
  return pr.status === 'merged' && now - Date.parse(pr.merged_at ?? '') < MANAGER_SHIPPING_LOOKBACK_MS;
}

// Preview deploys never finish on some pull requests, so CI is the checks GitHub requires plus the repository's own GitHub Actions runs.
export function isManagerCiCheck(check: PullRequestCheck): boolean {
  return check.required === true || check.githubActions === true;
}

export function getManagerCiStatus(details: Pick<PullRequestDetails, 'url' | 'ciStatus' | 'checkItems' | 'checks'>): PullRequestDetails['ciStatus'] {
  // Without check items, ciStatus is the guess made while a fresh push's checks register, or none. GitLab's pipeline status already is its CI.
  if (!details.checkItems?.length || parseCodeHostPrUrl(details.url)?.provider !== 'github') return details.ciStatus;
  const ci = details.checkItems.filter(isManagerCiCheck);
  if (ci.some((check) => check.status === 'failure')) return 'failure';
  // GitHub lists only the first 100 check runs, so an unlisted one could still be running or failing.
  return ci.some((check) => check.status === 'pending') || details.checks.total > details.checkItems.length ? 'pending' : ci.length > 0 ? 'success' : 'none';
}

export function withLivePullRequestDetails(pr: ManagerPullRequest, details: PullRequestDetails | undefined): ManagerPullRequest & { deployment?: PullRequestDeployment } {
  // A merge is final, so details cached from before it can't take it back.
  return details && !(pr.status === 'merged' && details.state !== 'merged')
    ? { ...pr, status: details.state, ci_status: getManagerCiStatus(details), mergeability: details.mergeability, merge_blockers: details.mergeBlockers ?? pr.merge_blockers, review_decision: details.reviewDecision, merged_at: details.mergedAt ?? pr.merged_at, deployment: details.deployment }
    : pr;
}

export const MANAGER_QUEUE_LABEL_TONES: Partial<Record<string, ManagerBoardTone>> = { 'CI failing': 'danger', 'Deploy failed': 'danger', 'Deploy blocked': 'warning', Conflicts: 'warning', 'Changes requested': 'warning', 'Behind base': 'warning', 'CI running': 'working', Working: 'working', Deploying: 'working', Updating: 'working', 'Fixing CI': 'working', 'Addressing review': 'working', 'Resolving conflicts': 'working', Approved: 'success', Merged: 'success', Deployed: 'success' };

export function getManagerQueueSidebarState(group: ManagerQueueGroup, label: string | null): WorkspaceSidebarState['kind'] | null {
  if (group === 'needs_you' || label === 'Deploy blocked') return 'input';
  if (label === 'Deploy failed') return 'failed';
  if (group === 'ready_to_merge' || group === 'ready_to_review') return 'review';
  return label && MANAGER_QUEUE_LABEL_TONES[label] === 'working' ? 'working' : null;
}

export type ManagerGlyph = 'alert' | 'failed' | 'deployed' | 'merge' | 'ready' | 'working' | 'pr' | 'archive';

const SIDEBAR_STATE_GLYPHS: Partial<Record<WorkspaceSidebarState['kind'], ManagerGlyph>> = { input: 'alert', failed: 'failed', review: 'ready', working: 'working' };

export function managerQueueGlyph(group: ManagerQueueGroup, label: string | null, prStatus?: ManagerPullRequest['status']): ManagerGlyph {
  if (group === 'ready_to_merge') return 'merge';
  const kind = getManagerQueueSidebarState(group, label);
  return (kind && SIDEBAR_STATE_GLYPHS[kind]) || (label === 'Deployed' ? 'deployed' : prStatus ? 'pr' : 'archive');
}

export type ManagerTone = 'warning' | 'danger' | 'primary' | 'muted';

const MANAGER_LABEL_TONES: Record<string, ManagerTone> = { 'CI failing': 'danger', 'Deploy failed': 'danger', 'Deploy blocked': 'warning', Deployed: 'primary' };
const MANAGER_GROUP_TONES: Partial<Record<ManagerQueueGroup, ManagerTone>> = { needs_you: 'warning', ready_to_merge: 'primary' };

export const managerLabelTone = (label: string, group?: ManagerQueueGroup): ManagerTone =>
  MANAGER_LABEL_TONES[label] ?? (group && MANAGER_GROUP_TONES[group]) ?? 'muted';

type ManagerQueueState = { group: ManagerQueueGroup; label: string | null; alert?: true; url?: string };

export function getMergedPullRequestQueueState(pr: Pick<ManagerPullRequest, 'status' | 'merged_at'> & { deployment?: PullRequestDeployment }, options: { dismissed?: boolean; now?: number } = {}): ManagerQueueState {
  const state = (group: ManagerQueueGroup, label: string) => ({ group, label });
  const now = options.now ?? Date.now();
  const deployment = pr.deployment;
  if (!isManagerPullRequestShipping(pr, now)) return state('done', deployment?.state === 'succeeded' ? 'Deployed' : 'Merged');
  if (deployment?.state === 'running') return state('shipping', 'Deploying');
  if (deployment?.state === 'failed' || deployment?.state === 'blocked') {
    const label = deployment.state === 'failed' ? 'Deploy failed' : 'Deploy blocked';
    return options.dismissed ? state('done', label) : { group: 'shipping', label, alert: true, ...(deployment.url && { url: deployment.url }) };
  }
  if (deployment?.state === 'succeeded') return state('done', 'Deployed');
  return state(now - Date.parse(pr.merged_at ?? '') < DEPLOY_START_WINDOW_MS ? 'shipping' : 'done', 'Merged');
}

export function getManagerPullRequestQueueState(
  ship: Pick<ManagerSubagent, 'status' | 'follow_through'> & { fixes_in_progress?: boolean },
  pr: Pick<ManagerPullRequest, 'status' | 'ci_status' | 'mergeability' | 'review_decision' | 'merged_at'> & { deployment?: PullRequestDeployment },
  options: { dismissed?: boolean; now?: number } = {},
): ManagerQueueState {
  const state = (group: ManagerQueueGroup, label: string | null = null) => ({ group, label });
  if (pr.status === 'merged') return getMergedPullRequestQueueState(pr, options);
  if (pr.status === 'closed' || ship.status === 'done') return state('done', 'Closed');
  if (ship.status === 'working') return state('working', 'Working');
  if (pr.status === 'draft') return state('working', 'Draft');
  const fixing = ship.fixes_in_progress === true;
  if (pr.mergeability === 'conflicts') return fixing ? state('working', 'Resolving conflicts') : state('needs_you', 'Conflicts');
  if (pr.review_decision === 'changes_requested') {
    return fixing ? state('working', 'Addressing review') : ship.follow_through === 'ready' ? state('ready_to_review', 'Re-review') : state('needs_you', 'Changes requested');
  }
  if (pr.ci_status === 'failure' && fixing) return state('working', 'Fixing CI');
  if (isManagerPullRequestMergeable(pr)) return state('ready_to_merge', pr.review_decision === 'approved' ? 'Approved' : null);
  return state('ready_to_review', pr.ci_status === 'failure' ? 'CI failing'
    : pr.ci_status === 'pending' ? 'CI running'
      : pr.review_decision === 'approved' ? 'Approved'
        : pr.mergeability === 'behind' ? 'Behind base' : null);
}

type StackDetails = Pick<PullRequestDetails, 'owner' | 'repo' | 'number' | 'headBranch' | 'baseBranch'>;

export function orderPullRequestsByStack<T>(items: readonly T[], detailsOf: (item: T) => StackDetails | undefined): T[] {
  const byHead = new Map(items.flatMap((item) => {
    const details = detailsOf(item);
    return details ? [[`${details.owner}/${details.repo}:${details.headBranch}`, details] as const] : [];
  }));
  const position = (details: StackDetails | undefined) => {
    let root = details;
    let depth = 0;
    while (root && byHead.has(`${root.owner}/${root.repo}:${root.baseBranch}`) && depth < byHead.size) {
      root = byHead.get(`${root.owner}/${root.repo}:${root.baseBranch}`);
      depth += 1;
    }
    return { root: root?.number ?? Number.MAX_SAFE_INTEGER, repo: root ? `${root.owner}/${root.repo}` : '', depth, number: details?.number ?? Number.MAX_SAFE_INTEGER };
  };
  return [...items].sort((a, b) => {
    const [pa, pb] = [position(detailsOf(a)), position(detailsOf(b))];
    return pa.root - pb.root || pa.repo.localeCompare(pb.repo) || pa.depth - pb.depth || pa.number - pb.number;
  });
}

export type ManagerPullRequestEntry = WorkspacePullRequestDetailsEntry | undefined;

export type ManagerQueueItem = { key: string; agent: ManagerSubagent; group: ManagerQueueGroup; label: string | null; alert?: true; url?: string } & (
  | { kind: 'ship' }
  | { kind: 'pr'; pr: ManagerPullRequest; entry: ManagerPullRequestEntry }
);

const SHIPPING_ORDER = ['Deploy failed', 'Deploy blocked', 'Deploying', 'Merged'];

export function managerPullRequestItems(agent: ManagerSubagent, entryOf: (agent: ManagerSubagent, url: string) => ManagerPullRequestEntry, dismissed: readonly string[]): Array<ManagerQueueItem & { kind: 'pr' }> {
  return agent.pull_requests.map((pr) => {
    const entry = entryOf(agent, pr.url);
    const live = withLivePullRequestDetails(pr, entry?.details ?? undefined);
    const state = getManagerPullRequestQueueState(agent, live, { dismissed: dismissed.includes(pr.url) });
    return { kind: 'pr', key: pr.url, agent, pr: live, entry, ...state, label: state.label === 'Working' ? 'Updating' : state.label };
  });
}

/** `settling` ships stay under Working, since a Manager often nudges a ship within seconds of its turn ending. */
export function buildManagerQueue(subagents: ManagerSubagent[], entryOf: (agent: ManagerSubagent, url: string) => ManagerPullRequestEntry, dismissed: readonly string[], settling: readonly ManagerSubagent[] = []): ManagerQueueItem[] {
  const items = subagents.flatMap((agent): ManagerQueueItem[] => {
    const pullRequests = managerPullRequestItems(agent, entryOf, dismissed);
    const open = pullRequests.filter((item) => item.group !== 'done');
    if (agent.status === 'blocked') return [{ kind: 'ship', key: agent.id, agent, group: 'working', label: agent.blocked_reason }, ...pullRequests];
    if (open.length > 0 || (agent.status === 'done' && pullRequests.length > 0)) return pullRequests;
    const working = agent.status === 'working' || settling.includes(agent);
    return [{ kind: 'ship', key: agent.id, agent, group: working ? 'working' : 'done', label: working ? 'Working' : null }, ...pullRequests];
  });
  const ships = items.filter((item) => item.kind === 'ship');
  // Not toSorted: Hermes on the phone doesn't have it.
  const pullRequests = orderPullRequestsByStack(items.filter((item) => item.kind === 'pr'), (item) => item.entry?.details ?? undefined)
    .sort((a, b) => SHIPPING_ORDER.indexOf(a.label ?? '') - SHIPPING_ORDER.indexOf(b.label ?? ''));
  const groups: ManagerQueueGroup[] = [...MANAGER_QUEUE_GROUPS, 'done'];
  return groups.flatMap((group) => [...ships, ...pullRequests].filter((item) => item.group === group));
}
