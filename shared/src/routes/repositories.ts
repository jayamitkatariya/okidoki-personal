import type { CodeHostProvider } from '../code-host';
import type { GitHubRepositoryListItem } from './github';
import type { GitLabCredentialStatusResponse, GitLabRepositoryListItem } from './gitlab';
import type { ParsedCodeHostPrUrl } from '../urls';

export interface RepositoryRecord {
  id: string;
  organization_id: string;
  provider: CodeHostProvider;
  name: string;
  url: string;
  default_branch: string;
  github_installation_id: number | null;
  github_repository_id: number | null;
  gitlab_instance_url: string | null;
  gitlab_project_id: number | null;
  gitlab_path_with_namespace: string | null;
  gitlab_webhook_id: number | null;
  created_at: string;
}

export type RepositoryRecordWithWorkspaceId = RepositoryRecord & { workspace_id: string };

export interface ListRepositoriesResponse {
  repositories: RepositoryRecord[];
}

export interface ListRepositoryBranchesResponse {
  branches: string[];
}

export interface UpsertRepositoryRequest {
  name: string;
  url: string;
  default_branch?: string | null;
}

export interface UpsertRepositoryResponse {
  repository: RepositoryRecord;
}

export interface AddRepositoryRequest {
  provider?: CodeHostProvider | null;
  name: string;
  url: string;
  default_branch?: string | null;
  github_installation_id?: number | null;
  github_repository_id?: number | null;
  gitlab_instance_url?: string | null;
  gitlab_project_id?: number | null;
  gitlab_path_with_namespace?: string | null;
  gitlab_webhook_id?: number | null;
}

export const githubAddRepositoryRequest = (repository: GitHubRepositoryListItem): AddRepositoryRequest => ({
  provider: 'github',
  name: repository.fullName,
  url: repository.cloneUrl,
  default_branch: repository.defaultBranch || 'main',
  github_installation_id: repository.installationId,
  github_repository_id: repository.id,
});

export const gitlabAddRepositoryRequest = (repository: GitLabRepositoryListItem): AddRepositoryRequest => ({
  provider: 'gitlab',
  name: repository.nameWithNamespace,
  url: repository.cloneUrl,
  default_branch: repository.defaultBranch || 'main',
  gitlab_project_id: repository.id,
  gitlab_path_with_namespace: repository.pathWithNamespace,
});

export interface AddRepositoryResponse {
  repository: RepositoryRecord;
}

export interface DeleteRepositoryResponse {
  success: boolean;
}

export interface UpdateRepositoryRequest {
  default_branch: string;
}

export interface UpdateRepositoryResponse {
  repository: RepositoryRecord;
}

export function gitLabHostFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** A PR from a repository Okidoki doesn't track loads through the installation behind another repository from the same GitHub owner. */
export function findGitHubOwnerInstallationId(owner: string, repositories: ReadonlyArray<Pick<RepositoryRecord, 'provider' | 'name' | 'github_installation_id'>>): number | null {
  const ownerPrefix = `${owner.toLowerCase()}/`;
  return repositories.find((repository) => repository.provider === 'github' && repository.github_installation_id != null && repository.name.toLowerCase().startsWith(ownerPrefix))?.github_installation_id ?? null;
}

export function isPullRequestReachable(
  pr: Pick<ParsedCodeHostPrUrl, 'provider' | 'owner' | 'host'>,
  repositories: Parameters<typeof findGitHubOwnerInstallationId>[1] | undefined,
  gitLab: Pick<GitLabCredentialStatusResponse, 'hasCredentials' | 'instanceUrl'> | undefined,
): boolean {
  return pr.provider === 'github'
    ? repositories !== undefined && findGitHubOwnerInstallationId(pr.owner, repositories) !== null
    : gitLab?.hasCredentials === true && gitLabHostFromUrl(gitLab.instanceUrl) === pr.host;
}
