import type { SearchOpens, SearchSubject } from './palette-search';
import { isScoutWorkspace, WORKSPACE_SIDEBAR_VIEWS, type ListWorkspacesResponse, type WorkspaceRecord } from './routes/workspaces';

export const WORKSPACE_SEARCH_INDEX_PARAMS = {
  viewModes: [...WORKSPACE_SIDEBAR_VIEWS].sort().join(','),
  archived: 'include',
  excludeScout: 'true',
  excludeManagerShips: 'true',
  excludeAutomationRuns: 'true',
  page: 1,
  limit: 1000,
};

export function workspaceSearchSubjects({
  workspaces,
  responses,
  currentUserId,
  opens = {},
}: {
  workspaces: Iterable<WorkspaceRecord>;
  responses: ListWorkspacesResponse[];
  currentUserId: string | null;
  opens?: Record<string, SearchOpens>;
}): Array<{ workspace: WorkspaceRecord; subject: SearchSubject }> {
  const repositoriesById = new Map<string, string[]>();
  const pullRequestsById = new Map<string, SearchSubject['pullRequests']>();
  const contributedAtById = new Map<string, string>();
  for (const response of responses) {
    for (const repository of response.workspace_repositories ?? []) {
      const names = repositoriesById.get(repository.workspace_id) ?? [];
      if (!names.includes(repository.name)) repositoriesById.set(repository.workspace_id, [...names, repository.name]);
    }
    for (const pullRequest of response.workspace_pull_requests ?? []) {
      const pullRequests = pullRequestsById.get(pullRequest.workspace_id) ?? [];
      if (pullRequest.provider_pr_number !== undefined && !pullRequests.some((existing) => existing.url === pullRequest.url)) {
        pullRequestsById.set(pullRequest.workspace_id, [...pullRequests, { number: pullRequest.provider_pr_number, branch: pullRequest.head_branch ?? null, url: pullRequest.url }]);
      }
    }
    for (const [workspaceId, contributedAt] of Object.entries(response.viewer_contributed_at ?? {})) contributedAtById.set(workspaceId, contributedAt);
  }
  return [...workspaces]
    .filter((workspace) => workspace.creation_source !== 'automation' && !isScoutWorkspace(workspace))
    .map((workspace) => {
      const activityAt = contributedAtById.get(workspace.id) ?? (workspace.user_id === currentUserId ? workspace.last_interaction_at ?? workspace.created_at : null);
      return {
        workspace,
        subject: {
          id: workspace.id,
          title: workspace.name,
          pullRequests: pullRequestsById.get(workspace.id) ?? [],
          repositories: repositoriesById.get(workspace.id) ?? [],
          activityAt: activityAt ? Date.parse(activityAt) : null,
          opens: opens[workspace.id],
        },
      };
    });
}
