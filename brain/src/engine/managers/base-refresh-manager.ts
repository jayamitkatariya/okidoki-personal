import type { AuthMethod } from '@okidoki/shared';
import { createErrorResult, createSuccessResult, engineCredentialRefreshFailureSchema, extractJsonObject, type AgentCredentialSnapshot, type AgentLoginWithdrawal, type AgentProvider, type Result } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { listExhaustedCredentials } from '../services/credential-fallbacks';

export type CredentialSwapFailure = 'not_configured' | 'no_credentials' | 'refresh_failed';

export function credentialSwapError(error: unknown): Result<never, CredentialSwapFailure> {
  const message = error instanceof Error ? error.message : String(error);
  // The monolith reports "nothing else is configured" as a refusal to
  // resolve, which is worth telling the user apart from a failed swap. The
  // thrown message carries the response body, so match the field, not the
  // word: the human-readable half of that body also names credentials.
  return createErrorResult({
    message,
    code: message.includes('"code":"no_credentials"') ? 'no_credentials' : 'refresh_failed',
  });
}

export function refreshRevocation(error: unknown): AgentLoginWithdrawal | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return engineCredentialRefreshFailureSchema.safeParse(extractJsonObject(message)).data?.revoke;
}

export interface RefreshRuntimeConfig {
  monolithUrl: string;
  workspaceId: string;
  engineSecret: string;
}

export interface RefreshHealthStatus {
  isRunning: boolean;
  intervalMs: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export function refreshDelayMs(expiresAtMs: number, maxMs = 5 * 60 * 1000): number {
  const ttlMs = expiresAtMs - Date.now();
  return Number.isFinite(ttlMs) ? Math.max(1_000, Math.min(maxMs, Math.floor(ttlMs * 0.8))) : maxMs;
}

const SHARED_REFRESH_MS = 10_000;

export abstract class BaseRefreshManager {
  protected credentialGeneration = 0;
  private credentialUpdate: Promise<void> = Promise.resolve();
  private intervalHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingRefresh: Promise<Result<void>> | null = null;
  private recentRefresh: { startedAt: number; result: Promise<Result<void>> } | null = null;
  private readonly health: RefreshHealthStatus;

  constructor(
    private readonly managerName: string,
    protected readonly intervalMs: number = 15 * 60 * 1000
  ) {
    this.health = {
      isRunning: false,
      intervalMs: this.intervalMs,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };
  }

  async start(skipInitialRefresh = false): Promise<void> {
    if (this.intervalHandle) {
      return;
    }

    const skipReason = this.getSkipReason();
    if (skipReason) {
      console.log(`[${this.managerName}] Skipping: ${skipReason}`);
      return;
    }

    console.log(`[${this.managerName}] Starting token refresh service`);
    this.health.isRunning = true;

    // Retry initial refresh — the monolith may not have registered the workspace yet
    const config = this.getRuntimeConfig();
    if (config && !skipInitialRefresh) {
      this.health.lastAttemptAt = new Date().toISOString();
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.doRefresh(config);
          this.health.lastSuccessAt = new Date().toISOString();
          this.health.lastErrorAt = null;
          this.health.lastErrorMessage = null;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          this.health.lastErrorAt = new Date().toISOString();
          this.health.lastErrorMessage = message;
          if (attempt < 3) {
            console.warn(`[${this.managerName}] Initial refresh attempt ${attempt} failed, retrying in 2s...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.error(`[${this.managerName}] Initial refresh failed after 3 attempts:`, error);
          }
        }
      }
    }

    this.scheduleNextRefresh();
  }

  protected async swapCredentials(params: {
    provider: AgentProvider;
    failureKind: string;
    allowedMethods?: readonly AuthMethod[];
    refresh: (constraints: { excludeCredentials?: AgentCredentialSnapshot[]; allowedMethods?: AuthMethod[] }) => Promise<void>;
    keepRefreshing: () => boolean;
  }): Promise<Result<void, CredentialSwapFailure>> {
    if (!this.getRuntimeConfig()) {
      return createErrorResult({ message: `${this.managerName} has no runtime config`, code: 'not_configured' });
    }

    try {
      console.log(`[${this.managerName}] Fetching fresh credentials from monolith (${params.failureKind})...`);
      const excludeCredentials = listExhaustedCredentials(params.provider);
      await params.refresh({
        ...(excludeCredentials.length > 0 ? { excludeCredentials } : {}),
        ...(params.allowedMethods ? { allowedMethods: [...params.allowedMethods] } : {}),
      });

      if (params.keepRefreshing()) {
        this.start().catch((error) => {
          console.error(`[${this.managerName}] Failed to restart the refresh service after fallback:`, error);
        });
      }
      return createSuccessResult();
    } catch (error) {
      console.error(`[${this.managerName}] Failed to fetch fresh credentials:`, error);
      return credentialSwapError(error);
    }
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) clearTimeout(this.intervalHandle);
    this.intervalHandle = null;
    this.health.isRunning = false;
    await this.pendingRefresh;
    console.log(`[${this.managerName}] Stopped`);
  }

  getHealthStatus(): RefreshHealthStatus {
    return { ...this.health };
  }

  protected getSkipReason(): string | null {
    return null;
  }

  protected getNextRefreshDelayMs(): number {
    return this.intervalMs;
  }

  protected abstract doRefresh(config: RefreshRuntimeConfig): Promise<void>;

  protected applyCredentialUpdate(generation: number, apply: () => Promise<void>): Promise<void> {
    const update = this.credentialUpdate.then(async () => {
      // A refresh started before a manual switch must not restore the old account.
      if (generation !== this.credentialGeneration) throw new Error('Credential changed during refresh; retry with the current credential.');
      await apply();
    });
    this.credentialUpdate = update.catch(() => {});
    return update;
  }

  protected getRuntimeConfig(): RefreshRuntimeConfig | null {
    if (!ENGINE_ENV.OKIDOKI_WORKSPACE_ID) {
      return null;
    }

    return {
      monolithUrl: ENGINE_ENV.OKIDOKI_MONOLITH_URL,
      workspaceId: ENGINE_ENV.OKIDOKI_WORKSPACE_ID,
      engineSecret: ENGINE_ENV.OKIDOKI_ENGINE_SECRET,
    };
  }

  protected rescheduleRefresh(): void {
    if (this.intervalHandle) this.scheduleNextRefresh();
  }

  private scheduleNextRefresh(): void {
    if (this.intervalHandle) clearTimeout(this.intervalHandle);
    const delayMs = this.getNextRefreshDelayMs();
    this.health.intervalMs = delayMs;
    this.intervalHandle = setTimeout(async () => {
      this.pendingRefresh = this.refreshOnce();
      await this.pendingRefresh;
      if (this.intervalHandle) this.scheduleNextRefresh();
    }, delayMs);
    console.log(`[${this.managerName}] Token refresh scheduled in ${Math.round(delayMs / 1000)} seconds`);
  }

  refreshShared(rejected = false): Promise<Result<void>> {
    if (!rejected && this.recentRefresh && Date.now() - this.recentRefresh.startedAt < SHARED_REFRESH_MS) {
      return this.recentRefresh.result;
    }
    const recent = { startedAt: Date.now(), result: this.refreshOnce() };
    this.recentRefresh = recent;
    void recent.result.then((result) => {
      if (!result.ok && this.recentRefresh === recent) this.recentRefresh = null;
    });
    return recent.result;
  }

  async refreshOnce(force = false): Promise<Result<void>> {
    if (!force && this.getSkipReason()) {
      return createSuccessResult();
    }

    const config = this.getRuntimeConfig();
    if (!config) return createSuccessResult();

    this.health.lastAttemptAt = new Date().toISOString();

    try {
      await this.doRefresh(config);
      this.health.lastSuccessAt = new Date().toISOString();
      this.health.lastErrorAt = null;
      this.health.lastErrorMessage = null;
      return createSuccessResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.health.lastErrorAt = new Date().toISOString();
      this.health.lastErrorMessage = message;
      console.error(`[${this.managerName}] Failed to refresh credentials:`, error);
      return createErrorResult({ message });
    }
  }
}
