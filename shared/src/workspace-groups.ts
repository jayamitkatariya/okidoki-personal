import type { WorkspaceRecord, ListWorkspacesResponse } from './routes/workspaces';
import type { EnvironmentRecord } from './routes/environment';
import type { WorkspaceListSectionId, WorkspaceSectionOrder, WorkspaceStagePlacement } from './workspace-sidebar-state';

function findMissingPinnedWorkspaceIds(
  pages: ListWorkspacesResponse[] | undefined,
  pinnedWorkspaceIds: Iterable<unknown>,
): string[] {
  if (!pages?.length) return [];
  const loadedWorkspaceIds = new Set(
    pages.flatMap((page) => page.workspaces.map((workspace) => workspace.id)),
  );
  return Array.from(pinnedWorkspaceIds).filter((id): id is string =>
    typeof id === 'string' && id.length > 0 && !loadedWorkspaceIds.has(id)
  );
}

export function findMissingHeldWorkspaceIds(
  pages: ListWorkspacesResponse[] | undefined,
  sectionOrder: WorkspaceSectionOrder,
  placements: Record<string, WorkspaceStagePlacement>,
): string[] {
  return [...new Set(findMissingPinnedWorkspaceIds(pages, [
    ...Object.values(sectionOrder).flat(),
    ...Object.keys(placements).sort((a, b) => placements[b].at - placements[a].at),
  ]))].slice(0, 100);
}

// --- Types ---

/**
 * Sidebar groups are keyed by workspace-capable environments, including
 * repo-less environments.
 */
export interface WorkspaceSidebarGroup {
  type: 'env';
  id: string;
  name: string;
  environmentId: string;
  section?: Extract<WorkspaceListSectionId, 'managers' | 'pinned'>;
  workspaces: WorkspaceRecord[];
}

// --- Grouping ---

/**
 * Builds sidebar folder groups from environments. Each env becomes one folder.
 * Workspaces are placed by their `environment_id`; anything left lands in the
 * synthetic "Other" group — defensive only, fires when an env has been
 * deleted out from under a workspace.
 */
export function buildGroups(
  workspaces: WorkspaceRecord[],
  _workspacesData: ListWorkspacesResponse | undefined,
  environments: EnvironmentRecord[],
): WorkspaceSidebarGroup[] {
  const groupMap = new Map<string, WorkspaceSidebarGroup>();

  for (const env of environments) {
    groupMap.set(env.id, {
      type: 'env',
      id: env.id,
      name: env.name,
      environmentId: env.id,
      workspaces: [],
    });
  }

  const placeUngrouped = (workspace: WorkspaceRecord) => {
    const key = '__ungrouped__';
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        type: 'env',
        id: key,
        name: 'Other',
        environmentId: key,
        workspaces: [],
      });
    }
    groupMap.get(key)!.workspaces.push(workspace);
  };

  for (const workspace of workspaces) {
    if (workspace.environment_id && groupMap.has(workspace.environment_id)) {
      groupMap.get(workspace.environment_id)!.workspaces.push(workspace);
      continue;
    }
    placeUngrouped(workspace);
  }

  return Array.from(groupMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}
