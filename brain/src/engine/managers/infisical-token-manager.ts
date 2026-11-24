import { rm } from 'fs/promises';
import path from 'path';
import { shellQuotePosix, type EngineInfisicalRefreshResponse } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';
import { BaseRefreshManager, refreshDelayMs, type RefreshRuntimeConfig } from './base-refresh-manager';

export class InfisicalTokenManager extends BaseRefreshManager {
  private nextRefreshDelayMs = 5 * 60 * 1000;

  constructor(
    private readonly request: typeof monolithRequest = monolithRequest,
    private readonly paths = {
      homeDir: ENGINE_ENV.HOME_DIR,
      workspaceRoot: ENGINE_ENV.WORKSPACE_ROOT,
    },
    private readonly applyCredentials = applyInfisicalCredentials,
  ) {
    super('InfisicalTokenManager', 5 * 60 * 1000);
  }

  protected async doRefresh(_config: RefreshRuntimeConfig): Promise<void> {
    const response = await this.request('/v1/engine/infisical/refresh-token');
    if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);

    const data = (await response.json()) as EngineInfisicalRefreshResponse;
    await this.applyCredentials(data, this.paths);
    this.nextRefreshDelayMs = refreshDelayMs(data.configured ? Date.parse(data.expiresAt) : Number.NaN);
  }

  protected getNextRefreshDelayMs(): number {
    return this.nextRefreshDelayMs;
  }
}

async function applyInfisicalCredentials(
  data: EngineInfisicalRefreshResponse,
  paths: { homeDir: string; workspaceRoot: string },
): Promise<void> {
  const credentialPath = path.join(paths.homeDir, '.okidoki', 'infisical-env.sh');
  const configPath = path.join(paths.workspaceRoot, '.infisical.json');
  if (!data.configured) {
    delete process.env.INFISICAL_TOKEN;
    delete process.env.INFISICAL_DOMAIN;
    await Promise.all([rm(credentialPath, { force: true }), rm(configPath, { force: true })]);
    return;
  }

  process.env.INFISICAL_TOKEN = data.token;
  process.env.INFISICAL_DOMAIN = data.siteUrl;
  await Promise.all([
    writeSecureCredentialFile(credentialPath, [
      `export INFISICAL_TOKEN=${shellQuotePosix(data.token)}`,
      `export INFISICAL_DOMAIN=${shellQuotePosix(data.siteUrl)}`,
      'export INFISICAL_DISABLE_UPDATE_CHECK=true',
      '',
    ].join('\n'), { ensureParentDir: true }),
    writeSecureCredentialFile(configPath, `${JSON.stringify({
      workspaceId: data.projectId,
      defaultEnvironment: data.environment,
      gitBranchToEnvironmentMapping: null,
      domain: data.siteUrl,
    }, null, 2)}\n`, { ensureParentDir: true }),
  ]);
}

export const infisicalTokenManager = new InfisicalTokenManager();
