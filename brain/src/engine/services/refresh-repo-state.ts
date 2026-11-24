import type { EngineRepoState } from '@okidoki/shared';
import { gitService } from '../git/service';
import { githubTokenManager } from '../managers/github-token-manager';
import { gitlabTokenManager } from '../managers/gitlab-token-manager';

// Refresh code host tokens first so PR lookups can authenticate. The repo-state
// snapshot is uploaded only by the pre-sleep flush, which includes full diffs.
export async function refreshRepoStatuses(
  observedBranchesByRepo?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<EngineRepoState[]> {
  await Promise.all([
    githubTokenManager.refreshShared().catch(() => {}),
    gitlabTokenManager.refreshShared().catch(() => {}),
  ]);

  return gitService.refreshRepos(observedBranchesByRepo);
}
