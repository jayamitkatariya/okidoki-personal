import type { AuthMethod } from '@okidoki/shared';
import { mkdirSync, promises as fs, watch, type FSWatcher } from 'fs';
import path from 'path';
import type { AgentCredentialSnapshot, CredentialFailureKind, EngineClaudeRefreshRequest, EngineClaudeRefreshResponse, Result } from '@okidoki/shared';
import {
  CLAUDE_AUTH_ENV_KEYS,
  CLAUDE_AUTH_ENV_KEYS_BY_METHOD,
  claudeAuthEnvFromResponse,
  isRecord,
  safeJsonParse,
} from '@okidoki/shared';
import { applyAuthEnvTransition } from './auth-env-transition';
import { BaseRefreshManager, refreshRevocation, type CredentialSwapFailure, type RefreshRuntimeConfig } from './base-refresh-manager';
import { ENGINE_ENV, setAgentCredentialSnapshot } from '../engine-env';
import { withdrawAgentLogin } from '../services/agent-logins';
import { routineRefreshRequest } from '../services/credential-fallbacks';
import { monolithRequest } from '../services/monolith-service';
import { writeSecureCredentialFile } from '../utils/file';

const credentialsPath = () => path.join(ENGINE_ENV.HOME_DIR, '.claude', '.credentials.json');

async function requestClaudeCredentials(request?: EngineClaudeRefreshRequest): Promise<EngineClaudeRefreshResponse> {
  const response = await monolithRequest('/v1/engine/claude/refresh-credentials', {
    body: request,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Credentials refresh failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as EngineClaudeRefreshResponse;
}

export class ClaudeTokenManager extends BaseRefreshManager {
  private credentialsWatcher: FSWatcher | null = null;
  private wipeCheckRunning = false;
  private wipeCheckPending = false;
  private refreshQueue: Promise<unknown> = Promise.resolve();
  private fellBack = false;

  constructor() {
    super('ClaudeTokenManager');
  }

  async start(skipInitialRefresh = false): Promise<void> {
    await super.start(skipInitialRefresh);
    this.watchCredentialsFile();
  }

  async stop(): Promise<void> {
    this.credentialsWatcher?.close();
    this.credentialsWatcher = null;
    await super.stop();
  }

  protected getSkipReason(): string | null {
    const method = ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD;
    // After a fallback the refresh keeps running, so the workspace returns to the primary credential once it works again.
    if ((method === 'ollama' || method === 'api_key' || method === 'anthropic-compatible' || method === 'bedrock' || method === 'foundry') && !this.fellBack) {
      return `auth method is ${method}`;
    }

    return null;
  }

  protected async doRefresh(_config: RefreshRuntimeConfig): Promise<void> {
    await this.refreshWithRequest(() => routineRefreshRequest('claude'));
  }

  async switchCredentials(data: EngineClaudeRefreshResponse): Promise<void> {
    this.fellBack = false;
    await this.applyCredentialUpdate(++this.credentialGeneration, () => this.applyCredentialsResponse(data));
    await this.start(true);
  }

  // Pushed, scheduled and wipe-triggered refreshes can overlap; serialize them so a
  // response fetched before a rotation can't overwrite the rotated pair. The request is
  // built when the job runs so it names the credential the previous job left live.
  private refreshWithRequest(buildRequest: () => EngineClaudeRefreshRequest): Promise<void> {
    const generation = this.credentialGeneration;
    const refresh = this.refreshQueue.then(() => this.requestAndApplyCredentials(generation, buildRequest()));
    this.refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  private async requestAndApplyCredentials(generation: number, request?: EngineClaudeRefreshRequest): Promise<void> {
    console.log('[ClaudeTokenManager] Refreshing Claude credentials...');

    const data = await requestClaudeCredentials(request).catch(async (error: unknown) => {
      const revocation = refreshRevocation(error);
      if (revocation) await this.applyCredentialUpdate(generation, async () => { await withdrawAgentLogin('claude', revocation); });
      throw error;
    });
    await this.applyCredentialUpdate(generation, () => this.applyCredentialsResponse(data));

    console.log(`[ClaudeTokenManager] Credentials refreshed (method=${data.type})`);
  }

  async fetchFreshCredentials(
    failureReason?: string,
    failureKind: CredentialFailureKind = 'rejected',
    failedCredential: AgentCredentialSnapshot | undefined = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.claude,
    allowedMethods?: readonly AuthMethod[],
    resetsAt?: string,
  ): Promise<Result<void, CredentialSwapFailure>> {
    const configuredMethod = ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD;
    const failedMethod = failedCredential?.method === 'ollama'
      || failedCredential?.method === 'oauth'
      || failedCredential?.method === 'api_key'
      || failedCredential?.method === 'anthropic-compatible'
      || failedCredential?.method === 'bedrock'
      || failedCredential?.method === 'foundry'
      ? failedCredential.method
      : configuredMethod === 'ollama' || configuredMethod === 'oauth' || configuredMethod === 'api_key'
        || configuredMethod === 'anthropic-compatible' || configuredMethod === 'bedrock' || configuredMethod === 'foundry'
        ? configuredMethod
        : undefined;
    this.fellBack = true;
    return this.swapCredentials({
      provider: 'claude',
      failureKind,
      allowedMethods,
      refresh: (exclusions) => this.refreshWithRequest(() => failedMethod
        ? {
          failedMethod,
          ...(failedCredential?.method === failedMethod ? { failedCredential } : {}),
          failureReason,
          failureKind,
          ...(resetsAt ? { resetsAt } : {}),
          ...exclusions,
        }
        : exclusions),
      keepRefreshing: () => !this.getSkipReason(),
    });
  }

  // A one-year token goes in CLAUDE_CODE_OAUTH_TOKEN, and a leftover file login would otherwise be refreshed and wiped.
  private async applyCredentialsResponse(response: EngineClaudeRefreshResponse): Promise<void> {
    if (response.type === 'oauth' && response.refreshToken) {
      await this.writeOauthCredentialsFile({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresAt: response.expiresAt,
        scopes: response.scopes,
        subscriptionType: response.subscriptionType,
      });
    } else {
      await this.removeOauthCredentialsFile();
    }

    const envVars = claudeAuthEnvFromResponse(response);
    applyAuthEnvTransition({
      prevMethod: ENGINE_ENV.OKIDOKI_CLAUDE_AUTH_METHOD ?? 'none',
      authKeys: CLAUDE_AUTH_ENV_KEYS,
      authKeysByMethod: CLAUDE_AUTH_ENV_KEYS_BY_METHOD,
      newEnvVars: envVars,
      envs: [ENGINE_ENV, process.env],
    });
    setAgentCredentialSnapshot('claude', response);
  }

  // Claude Code replaces the file atomically, so watch its directory rather than the file itself.
  private watchCredentialsFile(): void {
    if (this.credentialsWatcher) return;
    try {
      const directory = path.dirname(credentialsPath());
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.credentialsWatcher = watch(directory, (_event, filename) => {
        if (filename !== '.credentials.json') return;
        this.wipeCheckPending = true;
        void this.drainWipeChecks();
      });
      this.credentialsWatcher.on('error', (error) => {
        console.warn('[ClaudeTokenManager] Stopped watching the credentials file:', error);
        this.credentialsWatcher?.close();
        this.credentialsWatcher = null;
      });
    } catch (error) {
      console.warn('[ClaudeTokenManager] Could not watch the credentials file:', error);
    }
  }

  private async drainWipeChecks(): Promise<void> {
    if (this.wipeCheckRunning) return;
    this.wipeCheckRunning = true;
    try {
      while (this.wipeCheckPending) {
        this.wipeCheckPending = false;
        await this.resyncIfWiped();
      }
    } finally {
      this.wipeCheckRunning = false;
    }
  }

  // When Anthropic rejects its refresh token, Claude Code blanks the login in this
  // file and every agent in the process fails until the engine's next sync.
  private async resyncIfWiped(): Promise<void> {
    const content = await fs.readFile(credentialsPath(), 'utf8').catch(() => '');
    const file = safeJsonParse<unknown>(content, null);
    if (!isRecord(file) || !isRecord(file.claudeAiOauth) || file.claudeAiOauth.refreshToken !== '') return;
    console.warn('[ClaudeTokenManager] Claude Code cleared its OAuth login; fetching fresh credentials');
    await this.refreshOnce();
  }

  private async writeOauthCredentialsFile(credentials: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes: string[];
    subscriptionType: string;
  }): Promise<void> {
    const claudeCliConfig = {
      claudeAiOauth: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: new Date(credentials.expiresAt).getTime(),
        scopes: credentials.scopes,
        subscriptionType: credentials.subscriptionType,
      },
    };

    try {
      await writeSecureCredentialFile(
        credentialsPath(),
        JSON.stringify(claudeCliConfig, null, 2),
        { ensureParentDir: true },
      );
      console.log(`[ClaudeTokenManager] Updated ${credentialsPath()}`);
    } catch (error) {
      console.error('[ClaudeTokenManager] Failed to update credentials file:', error);
      throw error;
    }
  }

  private async removeOauthCredentialsFile(): Promise<void> {
    await fs.rm(credentialsPath(), { force: true });
  }
}

export const claudeTokenManager = new ClaudeTokenManager();
