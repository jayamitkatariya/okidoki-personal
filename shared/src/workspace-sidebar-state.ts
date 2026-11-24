import { isWorkspaceStatusAwaitingInput, isWorkspaceStatusProcessing, type EngineUnavailableReason, type WorkspaceStatusResponse } from './engine/types';
import type { PullRequestRecord, PullRequestStatus } from './routes/pull-requests';
import { isManagerWorkspace, isWorkspacePreparingWake, isWorkspaceSuspendedStatus, STALE_PREPARING_MS, WORKSPACE_RESUME_FAILED_MESSAGE, workspaceActivityMs, type WorkspaceAttention, type WorkspaceKind, type WorkspaceRecord, type WorkspaceShareSummary } from './routes/workspaces';
import { SCOUT_SOURCE } from './pricing';
import { pullRequestListState } from './pull-request-presentation';
import { isRecord } from './type-guards';
import { orderBySavedIds } from './saved-order';

const WORKSPACE_SIDEBAR_STATES = ['input', 'failed', 'review', 'working', 'fork', 'starting', 'waking', 'unread', 'pr', 'sleeping', 'idle'] as const;
type WorkspaceSidebarStateKind = (typeof WORKSPACE_SIDEBAR_STATES)[number];

export interface WorkspaceSidebarState {
  kind: WorkspaceSidebarStateKind;
  since: number | null;
  detail: string | null;
}

export const WORKSPACE_LIST_VIEWS = ['inbox', 'environments', 'all'] as const;
export type WorkspaceListView = (typeof WORKSPACE_LIST_VIEWS)[number];
export const WORKSPACE_LIST_VIEW_LABELS: Record<WorkspaceListView, string> = {
  inbox: 'Inbox',
  environments: 'By environment',
  all: 'All workspaces',
};

export const WORKSPACE_SIDEBAR_STATE_LABELS: Record<WorkspaceSidebarStateKind, string> = {
  input: 'Waiting',
  failed: 'Failed',
  review: 'Ready for review',
  working: 'Working',
  fork: 'Working on PR feedback',
  starting: 'Starting',
  waking: 'Waking',
  unread: 'Unread',
  pr: 'Idle',
  idle: 'Idle',
  sleeping: 'Sleeping',
};

export const WORKSPACE_SOURCE_LABELS: Partial<Record<WorkspaceRecord['creation_source'], string>> = {
  slack: 'Slack',
  linear: 'Linear',
  github: 'GitHub',
  gitlab: 'GitLab',
  automation: 'an automation',
  api: 'the API',
  [SCOUT_SOURCE]: 'Scout',
};

export type WorkspaceSourceIcon = 'slack' | 'linear' | 'github' | 'gitlab' | 'zap' | 'codeXml' | 'binoculars';

export const WORKSPACE_SOURCE_ICONS: Partial<Record<WorkspaceRecord['creation_source'], WorkspaceSourceIcon>> = {
  slack: 'slack',
  linear: 'linear',
  github: 'github',
  gitlab: 'gitlab',
  automation: 'zap',
  api: 'codeXml',
  [SCOUT_SOURCE]: 'binoculars',
};

export function describeWorkspaceOrigin(workspace: Pick<WorkspaceRecord, 'creation_source' | 'source_link'>, ownerName: string | null) {
  const source = WORKSPACE_SOURCE_LABELS[workspace.creation_source];
  if (ownerName) return `Started by ${ownerName}${source ? ` via ${source}` : ''}`;
  if (!source) return 'Started by you';
  return `From ${source}${workspace.source_link?.label ? ` · ${workspace.source_link.label}` : ''}`;
}

const PRIORITY_RANK: Record<WorkspaceSidebarStateKind, number> = {
  input: 0, failed: 1, review: 2, working: 2, fork: 2, starting: 3, unread: 4, pr: 5, waking: 5, idle: 5, sleeping: 6,
};

const FIRST_BOOT_GRACE_MS = 15 * 60_000;
const SLOW_ENGINE_GRACE_MS = 10 * 60_000;

function timestampMs(value: string | null): number | null {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export interface WorkspaceLiveState {
  processing: boolean;
  awaitingInput: boolean;
  pendingDelivery: boolean;
  pullRequestFeedbackOnly: boolean;
  pullRequestFeedbackChatTitle: string | null;
  engineUnavailableReason: EngineUnavailableReason | null;
  engineHeartbeatFresh: boolean;
  hasMessage: boolean;
}

export function toWorkspaceLiveState(status: WorkspaceStatusResponse): WorkspaceLiveState | undefined {
  // No pendingDelivery means a cached preparing status flipped to active before the real status loaded.
  if (status.status !== 'active' || status.pendingDelivery === undefined) return undefined;
  return {
    processing: isWorkspaceStatusProcessing(status),
    awaitingInput: isWorkspaceStatusAwaitingInput(status),
    pendingDelivery: status.pendingDelivery === true,
    pullRequestFeedbackOnly: status.isOnlyPullRequestFeedbackProcessing === true,
    pullRequestFeedbackChatTitle: status.pullRequestFeedbackChatTitle ?? null,
    engineUnavailableReason: status.engineUnavailableReason ?? null,
    engineHeartbeatFresh: status.engineHeartbeat?.fresh === true,
    hasMessage: Boolean(status.lastChatMessage),
  };
}

export function deriveWorkspaceSidebarState({
  workspace,
  status,
  unread,
  attention,
  hasCompletedTurn,
  pullRequests,
  wakePending = false,
  messagePending = false,
  now = Date.now(),
}: {
  workspace: Pick<WorkspaceRecord, 'status' | 'created_at' | 'last_interaction_at' | 'last_activity_at' | 'config'>;
  status?: WorkspaceLiveState;
  unread: boolean;
  attention?: WorkspaceAttention;
  hasCompletedTurn: boolean;
  pullRequests: ReadonlyArray<{ status: PullRequestStatus }>;
  wakePending?: boolean;
  messagePending?: boolean;
  now?: number;
}): WorkspaceSidebarState {
  const live = workspace.status === 'active' ? status : undefined;
  const activity = workspaceActivityMs(workspace) || null;
  const createdMs = timestampMs(workspace.created_at) ?? 0;
  const lastActivityMs = timestampMs(workspace.last_activity_at);
  if (live?.awaitingInput) return { kind: 'input', since: activity, detail: null };
  const engineBusy = live?.engineUnavailableReason === 'overloaded'
    || (live?.engineUnavailableReason === 'unreachable' && live.engineHeartbeatFresh && now - (lastActivityMs ?? createdMs) < SLOW_ENGINE_GRACE_MS);
  if (workspace.status === 'error') {
    const provisioningError = workspace.config?.provisioning_error;
    const resumeFailed = provisioningError?.message?.startsWith(WORKSPACE_RESUME_FAILED_MESSAGE) === true;
    return { kind: 'failed', since: lastActivityMs ?? activity, detail: provisioningError?.sandbox_lost ? 'Sandbox lost' : resumeFailed ? 'Couldn’t wake up' : 'Couldn’t start' };
  }
  if (live?.engineUnavailableReason && !engineBusy) return { kind: 'failed', since: lastActivityMs ?? activity, detail: 'Not responding' };
  const waking = wakePending || isWorkspacePreparingWake(workspace);
  if (workspace.status === 'preparing' && now - ((waking ? lastActivityMs : createdMs) ?? now) > STALE_PREPARING_MS) {
    return { kind: 'failed', since: (waking ? lastActivityMs : createdMs) || null, detail: waking ? 'Couldn’t wake up' : 'Couldn’t start' };
  }
  // Only an answer clears an ask, so a sibling chat's work, or a machine message to the asking chat, never hides it.
  if (attention) return { kind: 'input', since: timestampMs(attention.since) ?? activity, detail: attention.reason === 'blocked' ? 'Stuck' : attention.reason === 'deploy_failed' ? 'Deploy failed' : null };
  const processing = Boolean(live && (live.processing || live.pendingDelivery));
  if (engineBusy) {
    return { kind: 'working', since: activity, detail: live?.engineUnavailableReason === 'overloaded' ? 'Under heavy load' : 'Slow to respond' };
  }
  if (live && processing) {
    return live.pullRequestFeedbackOnly && !live.pendingDelivery
      ? { kind: 'fork', since: activity, detail: live.pullRequestFeedbackChatTitle }
      : { kind: 'working', since: activity, detail: null };
  }
  // Opening a sleeping workspace wakes it, so only a waiting message counts as work.
  if (waking) return messagePending ? { kind: 'working', since: activity, detail: 'Waking up' } : { kind: 'waking', since: activity, detail: null };
  const firstTurnPending = !hasCompletedTurn && now - createdMs < FIRST_BOOT_GRACE_MS && (!status || status.hasMessage);
  if (workspace.status === 'preparing' || (workspace.status === 'active' && firstTurnPending)) {
    return { kind: 'starting', since: createdMs || null, detail: null };
  }
  if (unread) return { kind: 'unread', since: activity, detail: null };
  if (pullRequests.length > 0) return { kind: 'pr', since: activity, detail: null };
  if (isWorkspaceSuspendedStatus(workspace.status)) return { kind: 'sleeping', since: activity, detail: null };
  return { kind: 'idle', since: activity, detail: null };
}

export function isWorkspaceSidebarStateNeedingAttention(kind: WorkspaceSidebarStateKind): boolean {
  return kind === 'input' || kind === 'failed';
}

export function isWorkspaceSidebarStateAwaitingAnswer(state: Pick<WorkspaceSidebarState, 'kind' | 'detail'>): boolean {
  return state.kind === 'input' && state.detail === null;
}

export function isWorkspaceSidebarStateBusy(kind: WorkspaceSidebarStateKind): boolean {
  return kind === 'working' || kind === 'fork' || kind === 'starting';
}

export function compareWorkspaceSidebarPriority(a: WorkspaceSidebarState, b: WorkspaceSidebarState): number {
  return PRIORITY_RANK[a.kind] - PRIORITY_RANK[b.kind];
}

export const WORKSPACE_STAGES = ['progress', 'review', 'settled'] as const;
export type WorkspaceStage = (typeof WORKSPACE_STAGES)[number];
export const WORKSPACE_STAGE_LABELS: Record<WorkspaceStage, string> = {
  progress: 'In progress',
  review: 'In review',
  settled: 'Settled',
};

export function isWorkspaceStage(value: unknown): value is WorkspaceStage {
  return WORKSPACE_STAGES.some((stage) => stage === value);
}

export type WorkspaceStagePlacement = {
  stage: WorkspaceStage;
  at: number;
};

function isWorkspaceStagePlacement(value: unknown): value is WorkspaceStagePlacement {
  return typeof value === 'object' && value !== null && 'stage' in value && 'at' in value
    && isWorkspaceStage(value.stage) && typeof value.at === 'number' && Number.isFinite(value.at);
}

const isRetiredSettledStage = (stage: unknown) => stage === 'backlog' || stage === 'done';

const NO_STAGE_PLACEMENTS: Record<string, WorkspaceStagePlacement> = {};

export function normalizeWorkspaceStagePlacements(value: unknown): Record<string, WorkspaceStagePlacement> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NO_STAGE_PLACEMENTS;
  return Object.fromEntries(Object.entries(value).flatMap(([workspaceId, saved]: [string, unknown]) => {
    const placement = isRecord(saved) && isRetiredSettledStage(saved.stage) ? { ...saved, stage: 'settled' } : saved;
    return isWorkspaceStagePlacement(placement) ? [[workspaceId, { stage: placement.stage, at: placement.at }]] : [];
  }));
}

export function withWorkspaceStagePlacement(
  placements: Record<string, WorkspaceStagePlacement>,
  workspaceId: string,
  placement: WorkspaceStagePlacement | null,
): Record<string, WorkspaceStagePlacement> {
  const rest = Object.fromEntries(Object.entries(placements).filter(([id]) => id !== workspaceId));
  return placement ? { ...rest, [workspaceId]: placement } : rest;
}

export function restoreWorkspacePin(pinned: readonly string[], pinnedBefore: readonly string[], workspaceId: string): string[] {
  if (pinned.includes(workspaceId)) return [...pinned];
  const after = pinnedBefore.slice(pinnedBefore.indexOf(workspaceId) + 1).find((id) => pinned.includes(id));
  const index = after === undefined ? pinned.length : pinned.indexOf(after);
  return pinned.toSpliced(index, 0, workspaceId);
}

export const WORKSPACE_SETTLED_REASON_LABELS = {
  merged: 'Merged',
  queued: 'Queued to merge',
  closed: 'Closed',
  finished: 'Finished',
  quiet: 'Quiet',
};
type WorkspaceSettledReason = keyof typeof WORKSPACE_SETTLED_REASON_LABELS;

export interface WorkspaceStageInfo extends WorkspaceStagePlacement {
  auto: WorkspaceStage;
  manual: boolean;
  settledReason: WorkspaceSettledReason | null;
}

const QUIET_SETTLED_MS = 3 * 24 * 60 * 60_000;

export function deriveWorkspaceAutoPlacement({
  workspace,
  pullRequests,
  state,
  finished,
  now,
}: {
  workspace: Pick<WorkspaceRecord, 'created_at' | 'last_interaction_at' | 'creation_source'>;
  pullRequests: ReadonlyArray<Pick<PullRequestRecord, 'status' | 'queued_at'>>;
  state: WorkspaceSidebarStateKind;
  finished: boolean;
  now: number;
}): { stage: WorkspaceStage; settledReason: WorkspaceSettledReason | null } {
  const unsettled = (stage: WorkspaceStage) => ({ stage, settledReason: null });
  // A reply puts the agent back to work, so the PR's stage only holds while the agent is idle or fixing PR feedback.
  if (state === 'working' || state === 'starting') return unsettled('progress');
  const states = pullRequests.map(pullRequestListState);
  if (states.includes('open')) return unsettled('review');
  // Settled is collapsed, so a stuck or failed workspace stays in view until someone deals with it.
  if (isWorkspaceSidebarStateNeedingAttention(state)) return unsettled('progress');
  const drafting = states.includes('draft');
  // A queued PR merges on its own, so it waits with the merged ones.
  const outcome = drafting ? undefined : (['merged', 'queued', 'closed'] as const).find((candidate) => states.includes(candidate));
  if (outcome) return { stage: 'settled', settledReason: outcome };
  if (isWorkspaceSidebarStateBusy(state)) return unsettled('progress');
  if (workspace.creation_source === 'automation' && finished && !drafting) return { stage: 'settled', settledReason: 'finished' };
  return now - workspaceActivityMs(workspace) >= QUIET_SETTLED_MS ? { stage: 'settled', settledReason: 'quiet' } : unsettled('progress');
}

// The viewer's own last message, so agent turns never reorder their list; a workspace they never messaged uses its last activity.
export function workspaceViewerActivityMs(
  workspace: Pick<WorkspaceRecord, 'created_at' | 'last_interaction_at'>,
  viewerMessagedAt: string | undefined,
): number {
  return timestampMs(viewerMessagedAt ?? null) ?? workspaceActivityMs(workspace);
}

export function deriveWorkspaceStageInfo({
  placement,
  viewerActivityAt,
  ...input
}: Parameters<typeof deriveWorkspaceAutoPlacement>[0] & { placement: WorkspaceStagePlacement | undefined; viewerActivityAt: number }): WorkspaceStageInfo {
  const auto = deriveWorkspaceAutoPlacement(input);
  const held = placement?.stage === 'settled' && isWorkspaceSidebarStateNeedingAttention(input.state) ? undefined : placement;
  const stage = held?.stage ?? auto.stage;
  return { stage, at: held?.at ?? viewerActivityAt, auto: auto.stage, manual: Boolean(held), settledReason: stage === 'settled' ? auto.settledReason : null };
}

// Section IDs are persisted across web and installed mobile clients.
const WORKSPACE_LIST_SECTIONS = ['managers', 'needs', 'pinned', 'review', 'progress', 'settled'] as const;
export type WorkspaceListSectionId = (typeof WORKSPACE_LIST_SECTIONS)[number];
export const WORKSPACE_LIST_ORDERED_SECTIONS: readonly WorkspaceListSectionId[] = ['managers', 'pinned'];
export type WorkspaceSectionOrder = Partial<Record<WorkspaceListSectionId, string[]>>;
const EMPTY_SECTION_ORDER: WorkspaceSectionOrder = {};
export function normalizeWorkspaceSectionOrder(value: unknown): WorkspaceSectionOrder {
  if (!isRecord(value)) return EMPTY_SECTION_ORDER;
  return Object.fromEntries(WORKSPACE_LIST_ORDERED_SECTIONS.flatMap((section) => {
    const ids = value[section];
    return Array.isArray(ids) ? [[section, ids.filter((id) => typeof id === 'string')]] : [];
  }));
}
export type WorkspaceShipOrder = Record<string, string[]>;
const EMPTY_SHIP_ORDER: WorkspaceShipOrder = {};
export function normalizeWorkspaceShipOrder(value: unknown): WorkspaceShipOrder {
  if (!isRecord(value)) return EMPTY_SHIP_ORDER;
  return Object.fromEntries(Object.entries(value).flatMap(([managerId, ids]) =>
    Array.isArray(ids) ? [[managerId, ids.filter((id) => typeof id === 'string')]] : []));
}
export function orderManagerShips<T extends Pick<WorkspaceRecord, 'id' | 'created_at'>>(ships: readonly T[], savedIds: readonly string[] = []): T[] {
  return orderBySavedIds([...ships].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), savedIds, (ship) => ship.id, { newItemsFirst: true });
}
// A workspace whose kind has its own section always lists there: it can be reordered in it, but not pinned or moved out.
export const workspaceKindSection = (kind: WorkspaceKind): WorkspaceListSectionId | null => isManagerWorkspace({ kind }) ? 'managers' : null;

// Ships list under their manager, so a stage has no row to move them to.
export function canMoveWorkspaceToStage(workspace: Pick<WorkspaceRecord, 'status' | 'kind' | 'parent_workspace_id'>, state: Pick<WorkspaceSidebarState, 'kind' | 'detail'>): boolean {
  return workspace.status !== 'archived' && workspace.parent_workspace_id === null && workspaceKindSection(workspace.kind) === null && !isWorkspaceSidebarStateAwaitingAnswer(state);
}
// Collapse state is stored under these keys by both web and mobile so the two clients agree.
export const WORKSPACE_LIST_SECTION_OPEN_STATE: Record<WorkspaceListSectionId, { key: string; defaultOpen: boolean }> = {
  managers: { key: 'ws-managers-open', defaultOpen: true },
  needs: { key: 'ws-folder-inbox-needs', defaultOpen: true },
  pinned: { key: 'ws-folder-inbox-pinned', defaultOpen: true },
  progress: { key: 'ws-folder-stage-progress', defaultOpen: true },
  review: { key: 'ws-folder-stage-review', defaultOpen: true },
  settled: { key: 'ws-folder-stage-settled', defaultOpen: false },
};
type WorkspaceSectionTone = 'attention' | 'active' | 'ready' | 'idle' | 'done';
export const WORKSPACE_SECTION_ICON_TONES: Record<WorkspaceListSectionId, WorkspaceSectionTone> = {
  managers: 'active',
  needs: 'attention',
  pinned: 'idle',
  progress: 'active',
  review: 'ready',
  settled: 'done',
};
export const WORKSPACE_SECTION_ICON_RING = { cx: 7, cy: 7, r: 5.5 };
export const WORKSPACE_SECTION_ICON_SHAPES: Record<
  Exclude<WorkspaceListSectionId, 'managers' | 'pinned'>,
  { ring?: { dash?: string }; fill?: string; stroke?: string }
> = {
  needs: { fill: 'M3.5 1.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM6.2 4.6a.8.8 0 0 1 1.6 0v2.8a.8.8 0 0 1-1.6 0ZM7 9.1a.95.95 0 1 0 0 1.9a.95.95 0 1 0 0-1.9Z' },
  progress: { ring: {}, fill: 'M7 7V4A3 3 0 0 1 7 10Z' },
  review: { ring: {}, fill: 'M7 7V4A3 3 0 1 1 4 7Z' },
  settled: { ring: {}, stroke: 'M4.6 7.1l1.7 1.7 3.1-3.3' },
};
export const WORKSPACE_MANAGER_ICON = {
  viewBox: '0 0 18 18',
  lead: 'M6 1h6a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1Z',
  reports: 'M2 12h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Zm6 0h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Zm6 0h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z',
  links: 'M8 6h2v2h5a1 1 0 0 1 1 1v3h-2v-2h-4v2H8v-2H4v2H2V9a1 1 0 0 1 1-1h5Z',
};
export const WORKSPACE_LIST_SECTION_LABELS: Record<WorkspaceListSectionId, string> = {
  managers: 'Managers',
  needs: 'Needs you',
  pinned: 'Pinned',
  ...WORKSPACE_STAGE_LABELS,
};

export function mergeHeldWorkspaceSections<S extends { key: string; ids: string[] }>(held: readonly S[], fresh: readonly S[], releases: (section: S, id: string) => boolean): S[] {
  const freshSectionById = new Map(fresh.flatMap((section) => section.ids.map((id) => [id, section.key] as const)));
  const placed = new Set<string>();
  const sections = held.map((section) => {
    const ids = section.ids.filter((id) => freshSectionById.has(id) && (freshSectionById.get(id) === section.key || !releases(section, id)));
    for (const id of ids) placed.add(id);
    return { ...section, ids };
  });
  for (const section of fresh) {
    const extra = section.ids.filter((id) => !placed.has(id));
    if (extra.length === 0) continue;
    const target = sections.find((candidate) => candidate.key === section.key);
    if (target) target.ids.push(...extra);
    else sections.push({ ...section, ids: extra });
  }
  return sections;
}

export function buildWorkspaceListSections<T>(
  workspaces: readonly T[],
  { kindOf, stateOf, stageOf, rankOf, inSplit }: {
    kindOf: (workspace: T) => WorkspaceKind;
    stateOf: (workspace: T) => WorkspaceSidebarState;
    stageOf: (workspace: T) => WorkspaceStagePlacement;
    rankOf: (workspace: T, section: WorkspaceListSectionId) => number;
    inSplit?: (workspace: T) => boolean;
  },
): Array<{ id: WorkspaceListSectionId; workspaces: T[] }> {
  const buckets: Record<WorkspaceListSectionId, T[]> = { managers: [], needs: [], pinned: [], progress: [], review: [], settled: [] };
  for (const workspace of workspaces) {
    const section = workspaceKindSection(kindOf(workspace))
      ?? (rankOf(workspace, 'pinned') >= 0 ? 'pinned'
        : isWorkspaceSidebarStateAwaitingAnswer(stateOf(workspace)) && !inSplit?.(workspace) ? 'needs'
          : stageOf(workspace).stage);
    buckets[section].push(workspace);
  }
  const since = (workspace: T) => stateOf(workspace).since ?? Number.MAX_SAFE_INTEGER;
  buckets.needs.sort((a, b) => since(a) - since(b));
  for (const section of ['managers', 'pinned', ...WORKSPACE_STAGES] as const) {
    const rank = (workspace: T) => rankOf(workspace, section) < 0 ? Infinity : rankOf(workspace, section);
    buckets[section].sort((a, b) => rank(a) - rank(b) || stageOf(b).at - stageOf(a).at);
  }
  return WORKSPACE_LIST_SECTIONS.map((id) => ({ id, workspaces: buckets[id] }));
}

// An organization-shared Manager stays listed for everyone, so deleting the viewer's own share row wouldn't remove it.
export const canLeaveWorkspace = (workspace: Pick<WorkspaceRecord, 'user_id'>, viewerId: string | null | undefined, memberLists: Array<WorkspaceShareSummary[] | undefined>, orgShared: boolean) =>
  !!viewerId && !orgShared && workspace.user_id !== null && workspace.user_id !== viewerId && memberLists.some((members) => members?.some((member) => member.user_id === viewerId));
