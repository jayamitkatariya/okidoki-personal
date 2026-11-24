import { z } from 'zod';
import type { CodeHostProvider } from '../code-host';
import type { EngineRepoState } from '../engine/v1';
import { defineStateMachine } from '../state-machine';
import { getCodeHostRequestNoun } from '../urls';

export interface PullRequestToolResult {
  toolName: string;
  toolInput: unknown;
  output: unknown;
  success: boolean;
}

const PULL_REQUEST_STATUSES = ['open', 'draft', 'closed', 'merged'] as const;

export const PULL_REQUEST_STATUS_MACHINE = defineStateMachine(PULL_REQUEST_STATUSES, {
  open: ['draft', 'closed', 'merged'],
  draft: ['open', 'closed', 'merged'],
  closed: ['open', 'draft', 'merged'],
  merged: [],
});

export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number];

export interface PullRequestRecord {
  id: string;
  organization_id: string;
  workspace_id: string;
  repository_id: string | null;
  provider: CodeHostProvider;
  provider_pr_number: number;
  github_pr_number: number | null;
  gitlab_merge_request_id: number | null;
  status: PullRequestStatus;
  closed_at: string | null;
  merged_at: string | null;
  queued_at: string | null;
  created_at: string;
  updated_at: string;
  url: string | null;
  head_branch: string | null;
}

/** Aggregated CI status derived from combined statuses + check runs on the PR head SHA. */
export type PullRequestCiStatus = 'success' | 'failure' | 'pending' | 'none';

/**
 * Aggregated check counts across the PR head commit, mirroring how GitHub
 * displays "N / M checks have passed". Counts span both legacy commit
 * statuses (the `combined-status` endpoint) and modern check runs.
 *
 * `total` is the number of distinct checks/statuses on the head commit.
 * `passing` / `failing` / `pending` partition that total — `none` is
 * implied when `total === 0`.
 */
export interface PullRequestChecksSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface PullRequestCheck {
  name: string;
  status: Exclude<PullRequestCiStatus, 'none'>;
  statusLabel?: string;
  description?: string;
  url?: string;
  required?: true;
  githubActions?: true;
}

export const PULL_REQUEST_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type PullRequestMergeMethod = (typeof PULL_REQUEST_MERGE_METHODS)[number];
export const DEFAULT_PULL_REQUEST_MERGE_METHOD: PullRequestMergeMethod = 'squash';

export interface PullRequestMergeRules {
  requiredApprovals: number;
  /** Current approvals from people with write access, the ones GitHub counts. */
  approvals: number;
  codeOwnerReview: boolean;
  /** Only rulesets report this; classic protection hides it from Okidoki. */
  dismissStaleReviews: boolean;
  mergeMethods: PullRequestMergeMethod[];
  defaultMergeMethod: PullRequestMergeMethod;
  autoMerge: 'available' | 'enabled' | null;
  viewerCanBypass: boolean;
}

export type PullRequestMergeBlocker =
  | 'review_required'
  | 'changes_requested'
  | 'unresolved_conversations'
  | 'required_checks'
  | 'merge_policy'
  | 'jira_association'
  | 'branch_protection';

export type PullRequestReviewDecision = 'approved' | 'changes_requested' | 'review_required';

type PullRequestDeploymentState = 'unknown' | 'none' | 'running' | 'blocked' | 'failed' | 'succeeded';

/** Deploy workflows start within minutes of a merge, so a merge commit with nothing running after this has no deploy. */
export const DEPLOY_START_WINDOW_MS = 30 * 60_000;

export function isPullRequestDeploymentSettled(details: Pick<PullRequestDetails, 'state' | 'mergedAt' | 'deployment'>, now = Date.now()): boolean {
  if (details.state !== 'merged' || !details.deployment) return true;
  return details.deployment.state === 'succeeded'
    || (details.deployment.state === 'none' && now - Date.parse(details.mergedAt ?? '') > DEPLOY_START_WINDOW_MS);
}

export interface PullRequestDeployment {
  state: PullRequestDeploymentState;
  url: string | null;
}

export interface PullRequestStack {
  number: number;
  size: number;
  /** 1-based order from the stack's base branch to its top pull request. */
  position: number;
  baseBranch: string;
}

export interface PullRequestStackGroup<T> {
  key: string;
  stack: PullRequestStack;
  pullRequests: Array<{ repoPr: T; details: PullRequestDetails }>;
}

export function getPullRequestStackGroups<T extends { prUrl: string }>(
  repoPullRequests: readonly T[],
  prDetailsByUrl: Map<string, PullRequestDetails>,
): PullRequestStackGroup<T>[] {
  const groups = new Map<string, PullRequestStackGroup<T>>();

  for (const repoPr of repoPullRequests) {
    const details = prDetailsByUrl.get(repoPr.prUrl);
    if (!details?.stack) continue;

    const key = `${details.owner}/${details.repo}#${details.stack.number}`;
    const group = groups.get(key) ?? {
      key,
      stack: details.stack,
      pullRequests: [],
    };
    group.pullRequests.push({ repoPr, details });
    groups.set(key, group);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    pullRequests: [...group.pullRequests].sort(
      (a, b) => (b.details.stack?.position ?? 0) - (a.details.stack?.position ?? 0),
    ),
  }));
}

export interface WorkspaceRepoPullRequest {
  name: string;
  path: string;
  currentBranch: string;
  prUrl: string;
}

// Every checkout of a repository under ~/workspaces (e.g. a git worktree) reports the same PR.
export function getWorkspaceRepoPullRequests(repoStatuses: readonly EngineRepoState[]): WorkspaceRepoPullRequest[] {
  const seen = new Set<string>();
  return repoStatuses.flatMap((repo) => (repo.prUrls ?? []).filter((prUrl) => !seen.has(prUrl) && seen.add(prUrl)).map((prUrl) => ({ name: repo.name, path: repo.path, currentBranch: repo.currentBranch, prUrl })));
}

export function orderWorkspacePullRequests<T extends { prUrl: string }>(pullRequests: readonly T[], stackGroups: readonly PullRequestStackGroup<T>[]): T[] {
  const stacked = stackGroups.flatMap((group) => group.pullRequests.map(({ repoPr }) => repoPr));
  return [...stacked, ...pullRequests.filter((pullRequest) => !stacked.includes(pullRequest))];
}

/**
 * Whether the code host will accept a merge right now. Distinct from `state` +
 * `ciStatus`, which stay green for a PR blocked on branch protection.
 *
 * `unknown` means the host hasn't finished computing yet, not that lookup
 * failed — treat it as not-yet-safe and retry.
 */
export type PullRequestMergeability =
  | 'mergeable'
  | 'blocked'
  | 'behind'
  | 'conflicts'
  | 'draft'
  | 'unknown';

export interface PullRequestDetails {
  url: string;
  /** Repository display name sourced from the workspace repo, not the PR slug. */
  repoName: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  /** Combined PR state, prioritising merged > closed > draft > open. */
  state: PullRequestStatus;
  authorLogin: string | null;
  headBranch: string;
  baseBranch: string;
  stack: PullRequestStack | null;
  mergeability: PullRequestMergeability;
  mergeQueue: 'enabled' | 'queued' | null;
  ciStatus: PullRequestCiStatus;
  additions: number | null;
  deletions: number | null;
  changedFiles: number;
  /** Sum of review comments + issue comments on the PR. */
  commentCount: number;
  checks: PullRequestChecksSummary;
  checkItems?: PullRequestCheck[];
  checksUnavailable?: true;
  mergeBlockers?: PullRequestMergeBlocker[];
  /** GitHub's decision, or the latest reviews when the branch requires none. */
  reviewDecision: PullRequestReviewDecision | null;
  /** GitHub only, for merged pull requests: the deploy runs on the merge commit. */
  deployment?: PullRequestDeployment;
  /** GitHub only. Absent when GitHub won't show Okidoki the branch's rules, so `mergeability` and the merge's own error explain a block. */
  mergeRules?: PullRequestMergeRules;
  canApprove: boolean;
  readOnly?: true;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export function canBypassMergeRules(details: PullRequestDetails): boolean {
  return details.mergeability === 'blocked' && details.mergeQueue !== 'queued' && details.mergeRules?.viewerCanBypass === true;
}

/**
 * Client-side gate for the workspace merge action; the monolith re-checks
 * authoritatively. Requires exactly one tracked PR because with several in
 * flight there is no unambiguous "the" PR to merge.
 */
export function isWorkspacePullRequestMergeable(
  details: PullRequestDetails | undefined,
  workspacePullRequestCount: number,
): boolean {
  return workspacePullRequestCount === 1
    && details?.state === 'open'
    && details.stack === null
    && details.mergeability === 'mergeable'
    && details.mergeQueue !== 'queued';
}

/**
 * One entry per PR URL on a workspace, with either enriched details or
 * an error string explaining why enrichment failed (so the UI can
 * gracefully fall back to a plain external link).
 */
export interface WorkspacePullRequestDetailsEntry {
  url: string;
  details: PullRequestDetails | null;
  error: string | null;
}

export interface WorkspacePullRequestDetailsResponse {
  pullRequests: WorkspacePullRequestDetailsEntry[];
}

export interface WorkspacePullRequestDetailsRequest {
  prUrls: string[];
}

export const WORKSPACE_PR_DETAILS_QUERY_ROOT = 'workspace-pr-details';

export function getPullRequestActionAvailability(
  prUrl: string | null,
  details: PullRequestDetails | undefined,
  pullRequestCount: number,
  mergeBlockedByPolicy: boolean,
  allowGitLabActions = false,
) {
  const actionState = details?.state === 'open' || details?.state === 'draft' ? details.state : null;
  const canUpdate = prUrl !== null && (allowGitLabActions || getCodeHostRequestNoun(prUrl) === 'PR') && actionState !== null && !details?.readOnly;
  const canMerge = canUpdate
    && actionState === 'open'
    && details?.stack === null
    && pullRequestCount === 1
    && !mergeBlockedByPolicy;
  const readyToMerge = isWorkspacePullRequestMergeable(details, pullRequestCount);
  return { actionState, canUpdate, canChange: canUpdate && !mergeBlockedByPolicy, canMerge, readyToMerge };
}

export function createWorkspacePullRequestDetailsQuery(
  organizationId: string | null | undefined,
  workspaceId: string | null | undefined,
  prUrls: string[],
) {
  const sortedPrUrls = [...prUrls].sort();
  return {
    body: { prUrls: sortedPrUrls } satisfies WorkspacePullRequestDetailsRequest,
    path: `/v1/workspaces/${workspaceId}/pull-requests/details`,
    queryKey: [WORKSPACE_PR_DETAILS_QUERY_ROOT, organizationId, workspaceId, sortedPrUrls] as const,
    refetchInterval: 60_000,
    retry: 1,
    sortedPrUrls,
    staleTime: 30_000,
  };
}

// Done PRs only change through a reopen or their deploy, so poll them only while a deploy is unsettled, and slowly once it waits on a person.
export function workspacePullRequestDetailsRefetchInterval(response: WorkspacePullRequestDetailsResponse | undefined, interval: number): number | false {
  const entries = response?.pullRequests;
  // GitHub computes mergeability after the request that asks for it, so check back soon.
  if (entries?.some((entry) => entry.details?.state === 'open' && entry.details.mergeability === 'unknown')) return 5_000;
  if (!entries || entries.some((entry) => !entry.details || entry.details.state === 'open' || entry.details.state === 'draft')) return interval;
  const unsettled = entries.flatMap((entry) => entry.details && !isPullRequestDeploymentSettled(entry.details) ? [entry.details.deployment?.state] : []);
  if (unsettled.length === 0) return false;
  return unsettled.every((state) => state === 'failed' || state === 'blocked') ? interval * 5 : interval;
}

export const mergePullRequestRequestSchema = z.object({
  mergeMethod: z.enum(PULL_REQUEST_MERGE_METHODS).optional(),
  bypassRules: z.boolean().optional(),
});
export type MergePullRequestRequest = z.infer<typeof mergePullRequestRequestSchema>;

export type MergeWorkspacePullRequestRequest = MergePullRequestRequest & { prUrl: string };

export interface MergeWorkspacePullRequestResponse {
  success: true;
  queued: boolean;
}

export type WorkspacePullRequestAction =
  | 'merge'
  | 'approve'
  | 'close'
  | 'convert_to_draft'
  | 'mark_ready_for_review';

export type UpdateWorkspacePullRequestAction = Exclude<WorkspacePullRequestAction, 'merge'>;

export interface UpdateWorkspacePullRequestRequest {
  prUrl: string;
  action: UpdateWorkspacePullRequestAction;
}

export interface UpdateWorkspacePullRequestResponse {
  success: true;
}

export const WORKSPACE_PR_DETAILS_MAX_URLS = 20;
