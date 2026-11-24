import type { AuthMethod } from '@okidoki/shared';
import { promises as fs } from 'fs';
import path from 'path';
import type { v2 } from '@okidoki/shared/codex-asp-types';
import type { AgentCredentialSnapshot, CredentialFailureKind, EngineCodexRefreshRequest, EngineCodexRefreshResponse, Result } from '@okidoki/shared';
import {
  CODEX_AUTH_ENV_KEYS,
  CODEX_AUTH_ENV_KEYS_BY_METHOD,
  codexAuthEnvFromResponse,
  codexCliAuthFile,
  createErrorResult,
  createSuccessResult,
} from '@okidoki/shared';
import { applyAuthEnvTransition } from './auth-env-transition';
import { BaseRefreshManager, credentialSwapError, refreshRevocation, type CredentialSwapFailure, type RefreshRuntimeConfig } from './base-refresh-manager';
import { ENGINE_ENV, setAgentCredentialSnapshot } from '../engine-env';
import { withdrawAgentLogin } from '../services/agent-logins';
import { routineRefreshRequest } from '../services/credential-fallbacks';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';
import { rememberSecret } from '../utils/transcript-secrets';

export type CodexAspOauthTokens = v2.ChatgptAuthTokensRefreshResponse;

export interface CodexAspOauthLogin {
  tokens: CodexAspOauthTokens;
  credential?: AgentCredentialSnapshot;
}

export interface CodexAspOauthOptions {
  chatgptAuthTokens?: CodexAspOauthTokens;
  refreshChatgptAuthTokens?: (params: v2.ChatgptAuthTokensRefreshParams) => Promise<CodexAspOauthTokens>;
}

export class CodexAspAuthMethodChangedError extends Error {
  override name = 'CodexAspAuthMethodChangedError';
}

type CodexAspOauthRefreshFailure = CredentialSwapFailure | 'method_changed';

const cliAuthPath = () => path.join(ENGINE_ENV.HOME_DIR, '.codex', 'auth.json');
// The monolith renews a ChatGPT access token in its last minute (REFRESH_THRESHOLD_MS in its Codex credential store).
const RENEWAL_LEAD_MS = 30_000;
const RENEWAL_RETRY_MS = 60_000;

export class CodexTokenManager extends BaseRefreshManager {
  private oauthExpiresAtMs = Number.NaN;

  constructor() {
    super('CodexTokenManager');
  }

  // The codex CLI cannot refresh the token in its auth file, so the renewed one has to land before this one expires.
  protected getNextRefreshDelayMs(): number {
    const untilRenewalMs = this.oauthExpiresAtMs - Date.now() - RENEWAL_LEAD_MS;
    if (!(untilRenewalMs < this.intervalMs)) return this.intervalMs;
    return untilRenewalMs > 0 ? untilRenewalMs : RENEWAL_RETRY_MS;
  }

  protected getSkipReason(): string | null {
    if (!ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD && ENGINE_ENV.OPENAI_API_KEY) {
      return 'OPENAI_API_KEY is set';
    }

    return null;
  }

  protected async doRefresh(_config: RefreshRuntimeConfig): Promise<void> {
    await this.refreshWithRequest(routineRefreshRequest('codex'), true);
  }

  async switchCredentials(data: EngineCodexRefreshResponse): Promise<void> {
    await this.applyCredentialUpdate(++this.credentialGeneration, async () => {
      await this.applyCredentialsResponse(data);
      setAgentCredentialSnapshot('codex', data);
      const { restartCodexAspHostIfRunning } = await import('./codex-asp/asp-host');
      await restartCodexAspHostIfRunning();
    });
    await this.start(true);
  }

  private async refreshWithRequest(
    request?: EngineCodexRefreshRequest,
    restartOnChange = false,
  ): Promise<EngineCodexRefreshResponse> {
    const generation = this.credentialGeneration;
    const previousEnv = CODEX_AUTH_ENV_KEYS.map((key) => process.env[key]);
    console.log('[CodexTokenManager] Refreshing Codex credentials...');

    const response = await monolithRequest('/v1/engine/codex/refresh-credentials', {
      body: { supportsOpenAICompatibleAuth: true, ...request },
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      // The login is gone, so there is no renewal left to retry for.
      if (response.status === 401) this.oauthExpiresAtMs = Number.NaN;
      const error = new Error(`Credentials refresh failed: ${response.status} ${await response.text()}`);
      const revocation = refreshRevocation(error);
      if (revocation) await this.applyCredentialUpdate(generation, async () => { await withdrawAgentLogin('codex', revocation); });
      throw error;
    }

    const data = (await response.json()) as EngineCodexRefreshResponse;

    await this.applyCredentialUpdate(generation, async () => {
      // Another pooled account changes no env var, but the app server would keep running on the old one's tokens.
      const accountChanged = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex?.credentialId !== data.credentialId;
      await this.applyCredentialsResponse(data);
      if (restartOnChange && (accountChanged || CODEX_AUTH_ENV_KEYS.some((key, index) => process.env[key] !== previousEnv[index]))) {
        const { restartCodexAspHostIfRunning } = await import('./codex-asp/asp-host');
        await restartCodexAspHostIfRunning();
      }
      setAgentCredentialSnapshot('codex', data);
    });

    console.log(`[CodexTokenManager] Credentials refreshed (method=${data.type})`);
    return data;
  }

  async prepareAspOauthOptions(): Promise<CodexAspOauthOptions> {
    if (ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD !== 'oauth') return {};

    // Kept on the live account: a host restarting after a quota switch must not land back on the spent one.
    const response = await this.refreshWithRequest(routineRefreshRequest('codex'));
    if (response.type !== 'oauth') return {};

    const login = this.buildAspOauthLogin(response);
    let credential = login.credential;
    return {
      chatgptAuthTokens: login.tokens,
      refreshChatgptAuthTokens: async (params) => {
        const refreshed = await this.refreshAspOauthCredentials(
          credential,
          `Codex ASP requested an external token refresh (${params.reason})`,
        );
        if (!refreshed.ok) {
          if (refreshed.error.code === 'method_changed') {
            throw new CodexAspAuthMethodChangedError(refreshed.error.message);
          }
          throw new Error(refreshed.error.message);
        }
        credential = refreshed.data.credential;
        return refreshed.data.tokens;
      },
    };
  }

  private async refreshAspOauthCredentials(
    failedCredential: AgentCredentialSnapshot | undefined,
    failureReason: string,
  ): Promise<Result<CodexAspOauthLogin, CodexAspOauthRefreshFailure>> {
    try {
      const response = await this.refreshWithRequest({
        failedMethod: 'oauth',
        ...(failedCredential?.method === 'oauth' ? { failedCredential } : {}),
        failureKind: 'rejected',
        failureReason,
      });
      if (response.type !== 'oauth') {
        return createErrorResult({
          message: `${failureReason}; credentials changed to ${response.type}, so the app server must restart`,
          code: 'method_changed',
        });
      }
      return createSuccessResult(this.buildAspOauthLogin(response));
    } catch (error) {
      return credentialSwapError(error);
    }
  }

  async fetchFreshCredentials(
    failureReason?: string,
    failureKind: CredentialFailureKind = 'rejected',
    failedCredential: AgentCredentialSnapshot | undefined = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex,
    allowedMethods?: readonly AuthMethod[],
  ): Promise<Result<void, CredentialSwapFailure>> {
    const failedMethod = failedCredential?.method === 'ollama'
      || failedCredential?.method === 'oauth'
      || failedCredential?.method === 'api_key'
      || failedCredential?.method === 'openai-compatible'
      || failedCredential?.method === 'foundry'
      ? failedCredential.method
      : ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD;
    return this.swapCredentials({
      provider: 'codex',
      failureKind,
      allowedMethods,
      refresh: async (exclusions) => {
        await this.refreshWithRequest(
          failedMethod === 'ollama' || failedMethod === 'oauth' || failedMethod === 'api_key' || failedMethod === 'openai-compatible' || failedMethod === 'foundry'
            ? {
              failedMethod,
              ...(failedCredential?.method === failedMethod ? { failedCredential } : {}),
              failureReason,
              failureKind,
              ...exclusions,
            }
            : exclusions,
        );
      },
      keepRefreshing: () => ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD === 'oauth',
    });
  }

  private async applyCredentialsResponse(response: EngineCodexRefreshResponse): Promise<void> {
    this.oauthExpiresAtMs = response.type === 'oauth' ? Date.parse(response.expiresAt) : Number.NaN;
    this.rescheduleRefresh();
    const cliLogin = response.type === 'oauth'
      ? response
      : response.type === 'api_key' && response.apiKey && !response.baseUrl ? { apiKey: response.apiKey } : null;
    // Codex reads this file before any auth env var, so a login the CLI cannot use from it must not leave an older one behind.
    if (cliLogin) await writeSecureCredentialFile(cliAuthPath(), codexCliAuthFile(cliLogin), { ensureParentDir: true });
    else await fs.rm(cliAuthPath(), { force: true });

    const envVars = codexAuthEnvFromResponse(response);
    applyAuthEnvTransition({
      prevMethod: ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD ?? 'none',
      authKeys: CODEX_AUTH_ENV_KEYS,
      authKeysByMethod: CODEX_AUTH_ENV_KEYS_BY_METHOD,
      newEnvVars: envVars,
      envs: [ENGINE_ENV, process.env],
    });
    if (response.type === 'api_key') {
      for (const key of CODEX_AUTH_ENV_KEYS_BY_METHOD.api_key) {
        if (envVars[key] !== undefined) continue;
        delete ENGINE_ENV[key];
        delete process.env[key];
      }
    }
  }

  private buildAspOauthLogin(
    response: Extract<EngineCodexRefreshResponse, { type: 'oauth' }>,
  ): CodexAspOauthLogin {
    const credential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex;
    // Handed to the app server in memory, so no credential file records it.
    rememberSecret('codex', response.accessToken);
    return {
      tokens: {
        accessToken: response.accessToken,
        chatgptAccountId: response.accountId,
        chatgptPlanType: null,
      },
      ...(credential?.method === 'oauth' ? { credential } : {}),
    };
  }
}

export const codexTokenManager = new CodexTokenManager();
