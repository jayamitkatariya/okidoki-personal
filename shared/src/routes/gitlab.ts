import type { CodeHostStartOAuthResponse } from '../code-host';
import type { GitIdentity } from '../git';

export type GitLabCredentialConnectionType = 'oauth' | 'service_account';

export type GitLabStartOAuthResponse = CodeHostStartOAuthResponse;

export interface GitLabCredentialDeleteResponse {
  success: boolean;
}

export interface GitLabUserCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  login?: string;
  lastFetchedAt?: string;
  instanceUrl?: string;
  connectionType?: GitLabCredentialConnectionType;
  expiresAt?: string | null;
}

export type GitLabCredentialStatusResponse = GitLabUserCredentialStatusResponse;

export interface GitLabServiceAccountCredentialRequest {
  personal_access_token: string;
}

export interface GitLabServiceAccountCredentialResponse {
  success: boolean;
  credentialId: string;
  login: string;
}

export interface GitLabRepositoryListItem {
  id: number;
  name: string;
  nameWithNamespace: string;
  pathWithNamespace: string;
  cloneUrl: string;
  webUrl: string;
  defaultBranch: string | null;
  namespaceFullPath: string | null;
  visibility: string | null;
  accessLevel: number | null;
  instanceUrl: string;
}

export interface GitLabRepositoriesResponse {
  repositories: GitLabRepositoryListItem[];
  /** True when listing stopped at the page cap before exhausting the instance's results. */
  hasMore: boolean;
}

export type GitLabUserStartOAuthResponse = GitLabStartOAuthResponse;
export type GitLabUserCredentialDeleteResponse = GitLabCredentialDeleteResponse;

export interface EngineGitLabRefreshTokenResponse {
  token: string | null;
  hosts: string[];
  gitIdentity?: GitIdentity | null;
  reason: 'ok' | 'no_gitlab_repositories' | 'missing_credential';
}
