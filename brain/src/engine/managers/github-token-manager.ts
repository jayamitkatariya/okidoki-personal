import path from 'path';
import { getGitHubAccessToken, githubCredentialLines, type GitHubAccessToken, type EngineGitHubRefreshTokenResponse } from '@okidoki/shared';
import { BaseRefreshManager, type RefreshRuntimeConfig } from './base-refresh-manager';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { removeCredentialFileLines, upsertCredentialFileLines, writeSecureCredentialFile } from '../utils/file';
import { updateGitIdentity } from '../utils/git-identity';

export class GitHubTokenManager extends BaseRefreshManager {
  constructor() {
    super('GitHubTokenManager');
  }

  async refreshCredentials(): Promise<void> {
    const config = this.getRuntimeConfig();
    if (!config) throw new Error('GitHub credential refresh is not configured');
    await this.doRefresh(config);
  }

  protected async doRefresh(_config: RefreshRuntimeConfig): Promise<void> {
    console.log('[GitHubTokenManager] Refreshing GitHub token...');

    const response = await monolithRequest('/v1/engine/github/refresh-token');

    if (!response.ok) {
      if (response.status === 403) {
        await this.clearGitHubCredentials();
      }
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as EngineGitHubRefreshTokenResponse;

    const ghToken = getGitHubAccessToken(data.repositoryTokens) ?? '';
    const ghUsername = data.userToken?.username ?? 'x-access-token';

    await this.updateGitCredentials(data.repositoryTokens);
    await this.updateGhHostsFile(ghToken, ghUsername);
    if (data.gitIdentity) {
      await updateGitIdentity(data.gitIdentity, 'GitHubTokenManager', ['github.com']);
    }

    if (data.userToken) {
      console.log(`[GitHubTokenManager] Token refreshed with user token for PR attribution, user token expires at ${data.userToken.expiresAt}`);
    } else {
      console.log(`[GitHubTokenManager] Token refreshed successfully, expires at ${data.expiresAt}`);
    }
  }

  private async updateGitCredentials(token: GitHubAccessToken): Promise<void> {
    const credentialsPath = path.join(ENGINE_ENV.HOME_DIR, '.git-credentials');

    try {
      // Upsert rather than overwrite — the file also carries other providers'
      // credentials (e.g. the GitLab line written at sandbox provisioning).
      await upsertCredentialFileLines(credentialsPath, ['github.com'], githubCredentialLines(token));
      console.log(`[GitHubTokenManager] Updated ${credentialsPath}`);
    } catch (error) {
      console.error('[GitHubTokenManager] Failed to update git credentials:', error);
    }
  }

  private async updateGhHostsFile(token: string, username: string): Promise<void> {
    const hostsPath = path.join(ENGINE_ENV.HOME_DIR, '.config', 'gh', 'hosts.yml');
    // An empty-token host triggers gh's legacy account migration before it reads GH_TOKEN.
    const content = token ? `github.com:
    oauth_token: ${JSON.stringify(token)}
    user: ${JSON.stringify(username)}
    git_protocol: https
` : '';

    try {
      await writeSecureCredentialFile(hostsPath, content, { ensureParentDir: true });
      console.log(`[GitHubTokenManager] Updated ${hostsPath}`);
    } catch (error) {
      console.error('[GitHubTokenManager] Failed to update gh hosts file:', error);
    }
  }

  private async clearGitHubCredentials(): Promise<void> {
    const credentialsPath = path.join(ENGINE_ENV.HOME_DIR, '.git-credentials');
    await removeCredentialFileLines(
      credentialsPath,
      (line) => /^https:\/\/[^/]+@github\.com(?:\/|$)/.test(line),
    );
    await this.updateGhHostsFile('', 'x-access-token');
  }
}

export const githubTokenManager = new GitHubTokenManager();
