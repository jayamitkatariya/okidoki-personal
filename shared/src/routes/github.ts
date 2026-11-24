import type { CodeHostStartOAuthResponse } from '../code-host';
import type { GitIdentity } from '../git';

export type GitHubStartOAuthResponse = CodeHostStartOAuthResponse;

export type GitHubAccessToken = Record<string, string>;

export interface EngineGitHubRefreshTokenResponse {
  repositoryTokens: GitHubAccessToken;
  // Retained on the wire for older engines; current clients use repositoryTokens.
  token: string;
  expiresAt: string;
  userToken?: {
    token: string;
    expiresAt: string;
    username: string | null;
  } | null;
  gitIdentity?: GitIdentity | null;
}

export interface GitHubCredentialDeleteResponse {
  success: boolean;
}

// User-scoped credentials (personal GitHub OAuth). The user variant has no
// `installUrl` because there's no App-installation flow to bounce to.
export interface GitHubUserCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  login?: string;
  lastFetchedAt?: string;
  /** GitHub rejected the stored refresh token or the user revoked the app; only reconnecting fixes it. */
  reconnectRequired?: boolean;
}

export interface GitHubCommitEmailsResponse {
  defaultIdentity: GitIdentity;
  /** Verified emails on the user's GitHub account, plus their GitHub noreply address. */
  emails: string[];
}

// Organization-scoped credentials (GitHub App installation). Extends the
// user shape with an optional `installUrl` so callers can deep-link to the
// App install screen when no installation exists yet.
export interface GitHubCredentialStatusResponse extends GitHubUserCredentialStatusResponse {
  installUrl?: string;
}

export interface GitHubRepositoryListItem {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string | null;
  ownerLogin: string;
  installationId: number;
}

export interface GitHubRepositoriesResponse {
  repositories: GitHubRepositoryListItem[];
  hasInstallations: boolean;
  installUrl?: string;
}

// Type aliases for user-scoped types that match org types
export type GitHubUserStartOAuthResponse = GitHubStartOAuthResponse;
export type GitHubUserCredentialDeleteResponse = GitHubCredentialDeleteResponse;
