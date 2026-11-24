import type { PullRequestRecord, PullRequestStatus } from './routes/pull-requests';

export type PullRequestListState = PullRequestStatus | 'queued';

export const PULL_REQUEST_PRESENTATION: Record<PullRequestListState, {
  icon: 'pull-request' | 'pull-request-draft' | 'pull-request-closed' | 'merge';
  label: string;
  color: string | null;
}> = {
  open: { icon: 'pull-request', label: 'Open', color: null },
  draft: { icon: 'pull-request-draft', label: 'Draft', color: '#9ca3af' },
  queued: { icon: 'merge', label: 'Queued', color: '#9ca3af' },
  merged: { icon: 'merge', label: 'Merged', color: '#c084fc' },
  closed: { icon: 'pull-request-closed', label: 'Closed', color: '#f87171' },
};

export const PULL_REQUEST_STATE_ORDER: readonly PullRequestStatus[] = ['open', 'draft', 'merged', 'closed'];
export const PULL_REQUEST_LIST_STATE_ORDER: readonly PullRequestListState[] = ['open', 'draft', 'queued', 'merged', 'closed'];

export function pullRequestListState(pullRequest: Pick<PullRequestRecord, 'status' | 'queued_at'>): PullRequestListState {
  return pullRequest.status === 'open' && pullRequest.queued_at ? 'queued' : pullRequest.status;
}

export function getPullRequestStatePresentation(
  pullRequests: ReadonlyArray<Pick<PullRequestRecord, 'status' | 'queued_at'>>,
) {
  const counts = pullRequests.reduce<Record<PullRequestListState, number>>(
    (result, pullRequest) => {
      result[pullRequestListState(pullRequest)] += 1;
      return result;
    },
    { open: 0, draft: 0, queued: 0, merged: 0, closed: 0 },
  );
  const states = PULL_REQUEST_LIST_STATE_ORDER.filter((state) => counts[state] > 0);
  const stateLabel = states.map((state) => `${counts[state]} ${state}`).join(', ');
  return {
    counts,
    states,
    accessibilityLabel: stateLabel
      ? `${stateLabel} pull request${pullRequests.length === 1 ? '' : 's'}`
      : null,
  };
}
