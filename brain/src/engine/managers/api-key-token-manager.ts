import {
  AGENT_CREDENTIAL_METHODS_IN_ORDER,
  createErrorResult,
  getProviderDisplayName,
  ollamaAuthEnvKeys,
  openAICompatibleAuthEnvKeys,
  type AgentCredentialSnapshot,
  type ApiKeyAgent,
  type AuthMethod,
  type CredentialFailureKind,
  type EngineApiKeyRefreshRequest,
  type EngineApiKeyRefreshResponse,
  type Result,
} from '@okidoki/shared';
import { ENGINE_ENV, setAgentCredentialSnapshot } from '../engine-env';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';
import { BaseRefreshManager, refreshRevocation, type CredentialSwapFailure } from './base-refresh-manager';
import { withdrawAgentLogin } from '../services/agent-logins';

class ApiKeyTokenManager<TAgent extends ApiKeyAgent> extends BaseRefreshManager {
  constructor(private readonly agent: TAgent) {
    super(`${getProviderDisplayName(agent)}TokenManager`);
  }

  protected doRefresh(): Promise<void> {
    return Promise.resolve();
  }

  async fetchFreshCredentials(
    failureReason?: string,
    failureKind: CredentialFailureKind = 'exhausted',
    failedCredential: AgentCredentialSnapshot | undefined = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[this.agent],
    allowedMethods?: readonly AuthMethod[],
    resetsAt?: string,
  ): Promise<Result<void, CredentialSwapFailure>> {
    const failedMethod = AGENT_CREDENTIAL_METHODS_IN_ORDER[this.agent]
      .find(({ method }) => method === failedCredential?.method)?.method;
    // Each provider names its models differently, so a running chat only moves to another key of the same provider.
    if (!failedMethod || (allowedMethods && !allowedMethods.includes(failedMethod))) {
      return createErrorResult({ message: `${getProviderDisplayName(this.agent)} only switches between keys of the same provider`, code: 'no_credentials' });
    }
    return this.swapCredentials({
      provider: this.agent,
      failureKind,
      allowedMethods: [failedMethod],
      refresh: async (exclusions) => {
        const request: EngineApiKeyRefreshRequest<TAgent> = {
          failedMethod,
          ...(failedCredential ? { failedCredential } : {}),
          failureReason,
          failureKind,
          ...(resetsAt ? { resetsAt } : {}),
          ...exclusions,
        };
        const response = await monolithRequest(`/v1/engine/${this.agent}/refresh-credentials`, { body: request, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) {
          const error = new Error(`Credentials refresh failed: ${response.status} ${await response.text()}`);
          const revocation = refreshRevocation(error);
          if (revocation) await withdrawAgentLogin(this.agent, revocation);
          throw error;
        }
        const data = (await response.json()) as EngineApiKeyRefreshResponse<TAgent>;
        for (const file of data.auth.files ?? []) {
          await writeSecureCredentialFile(file.path, file.contents, { ensureParentDir: true });
        }
        for (const key of [...ollamaAuthEnvKeys(this.agent), ...openAICompatibleAuthEnvKeys(this.agent)]) delete process.env[key];
        Object.assign(process.env, data.auth.env);
        setAgentCredentialSnapshot(this.agent, data);
      },
      keepRefreshing: () => false,
    });
  }
}

export const opencodeTokenManager = new ApiKeyTokenManager('opencode');
export const piTokenManager = new ApiKeyTokenManager('pi');
