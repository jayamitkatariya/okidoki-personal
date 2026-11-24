import type { AuthMethod } from '@okidoki/shared';
import {
  CREDENTIAL_METHOD,
  serializeMuseAuthFile,
  type AgentCredentialSnapshot,
  type CredentialFailureKind,
  type EngineMuseRefreshRequest,
  type EngineMuseRefreshResponse,
  type Result,
} from '@okidoki/shared';
import { ENGINE_ENV, setAgentCredentialSnapshot } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';
import { MUSE_AUTH_PATH } from './agent-auth-paths';
import { BaseRefreshManager, refreshRevocation, type CredentialSwapFailure } from './base-refresh-manager';
import { withdrawAgentLogin } from '../services/agent-logins';

export class MuseTokenManager extends BaseRefreshManager {
  constructor() {
    super('MuseTokenManager');
  }

  protected doRefresh(): Promise<void> {
    return Promise.resolve();
  }

  async fetchFreshCredentials(
    failureReason?: string,
    failureKind: CredentialFailureKind = 'exhausted',
    failedCredential: AgentCredentialSnapshot | undefined = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.muse,
    allowedMethods?: readonly AuthMethod[],
  ): Promise<Result<void, CredentialSwapFailure>> {
    return this.swapCredentials({
      provider: 'muse',
      failureKind,
      allowedMethods,
      refresh: async (exclusions) => {
        const request: EngineMuseRefreshRequest = {
          failedMethod: failedCredential?.method === CREDENTIAL_METHOD.API_KEY
            ? CREDENTIAL_METHOD.API_KEY
            : CREDENTIAL_METHOD.MUSE_OAUTH,
          ...(failedCredential ? { failedCredential } : {}),
          failureReason,
          failureKind,
          ...exclusions,
        };
        const response = await monolithRequest('/v1/engine/muse/refresh-credentials', { body: request, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          const error = new Error(`Credentials refresh failed: ${response.status} ${await response.text()}`);
          const revocation = refreshRevocation(error);
          if (revocation) await withdrawAgentLogin('muse', revocation);
          throw error;
        }
        const data = (await response.json()) as EngineMuseRefreshResponse;
        await writeSecureCredentialFile(MUSE_AUTH_PATH, serializeMuseAuthFile(data), { ensureParentDir: true });
        setAgentCredentialSnapshot('muse', data);
      },
      keepRefreshing: () => false,
    });
  }
}

export const museTokenManager = new MuseTokenManager();
