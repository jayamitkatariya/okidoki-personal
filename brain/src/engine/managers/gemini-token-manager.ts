import type { AuthMethod } from '@okidoki/shared';
import {
  CREDENTIAL_METHOD,
  serializeGeminiAuthFile,
  type AgentCredentialSnapshot,
  type CredentialFailureKind,
  type EngineGeminiRefreshRequest,
  type EngineGeminiRefreshResponse,
  type Result,
} from '@okidoki/shared';
import { ENGINE_ENV, setAgentCredentialSnapshot } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';
import { GEMINI_AUTH_PATH } from './agent-auth-paths';
import { BaseRefreshManager, type CredentialSwapFailure } from './base-refresh-manager';

/** Antigravity refreshes its own access token, so this only swaps the Google login when one runs out. */
class GeminiTokenManager extends BaseRefreshManager {
  constructor() {
    super('GeminiTokenManager');
  }

  protected doRefresh(): Promise<void> {
    return Promise.resolve();
  }

  async fetchFreshCredentials(
    failureReason?: string,
    failureKind: CredentialFailureKind = 'exhausted',
    failedCredential: AgentCredentialSnapshot | undefined = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.gemini,
    allowedMethods?: readonly AuthMethod[],
  ): Promise<Result<void, CredentialSwapFailure>> {
    return this.swapCredentials({
      provider: 'gemini',
      failureKind,
      allowedMethods,
      refresh: async (exclusions) => {
        const request: EngineGeminiRefreshRequest = {
          failedMethod: CREDENTIAL_METHOD.GEMINI_OAUTH,
          ...(failedCredential ? { failedCredential } : {}),
          failureReason,
          failureKind,
          ...exclusions,
        };
        const response = await monolithRequest('/v1/engine/gemini/refresh-credentials', { body: request, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          throw new Error(`Credentials refresh failed: ${response.status} ${await response.text()}`);
        }
        const data = (await response.json()) as EngineGeminiRefreshResponse;
        await writeSecureCredentialFile(GEMINI_AUTH_PATH, serializeGeminiAuthFile(data), { ensureParentDir: true });
        setAgentCredentialSnapshot('gemini', data);
      },
      keepRefreshing: () => false,
    });
  }
}

export const geminiTokenManager = new GeminiTokenManager();
