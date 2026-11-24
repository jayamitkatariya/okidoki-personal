import path from 'path';
import {
  type EngineGitLabRefreshTokenResponse,
} from '@okidoki/shared';
import { BaseRefreshManager, type RefreshRuntimeConfig } from './base-refresh-manager';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { removeCredentialFileLines, upsertCredentialFileLines } from '../utils/file';
import { updateGitIdentity } from '../utils/git-identity';

export class GitLabTokenManager extends BaseRefreshManager {
  constructor() {
    super('GitLabTokenManager');
  }

  protected async doRefresh(_config: RefreshRuntimeConfig): Promise<void> {
    const response = await monolithRequest('/v1/engine/gitlab/refresh-token');
    if (!response.ok) {
      if (response.status === 403) {
        await this.clearGitLabCredentials();
      }
      throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as EngineGitLabRefreshTokenResponse;
    if (!data.token) {
      await this.clearGitLabCredentials(data.hosts);
      console.log(`[GitLabTokenManager] No GitLab token to install: ${data.reason}`);
      return;
    }

    const hosts = data.hosts.length > 0 ? data.hosts : ['gitlab.com'];
    const credentialsPath = path.join(ENGINE_ENV.HOME_DIR, '.git-credentials');
    await upsertCredentialFileLines(
      credentialsPath,
      hosts,
      hosts.map((host) => `https://oauth2:${data.token}@${host}`),
    );
    console.log(`[GitLabTokenManager] Updated ${credentialsPath} for ${hosts.join(', ')}`);

    if (data.gitIdentity) {
      await updateGitIdentity(data.gitIdentity, 'GitLabTokenManager', hosts);
    }
  }

  private async clearGitLabCredentials(hosts: string[] = []): Promise<void> {
    const credentialsPath = path.join(ENGINE_ENV.HOME_DIR, '.git-credentials');
    await removeCredentialFileLines(
      credentialsPath,
      (line) => line.startsWith('https://oauth2:') && (
        hosts.length === 0 || hosts.some((host) => line.endsWith(`@${host}`))
      ),
    );
  }
}

export const gitlabTokenManager = new GitLabTokenManager();
