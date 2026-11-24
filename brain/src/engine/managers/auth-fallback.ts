import {
  AUTH_FALLBACK_EVENT_TYPE,
  CREDENTIAL_SCOPE,
  DEFAULT_WEB_APP_URL,
  MODEL_LABELS,
  WEB_APP_PATHS,
  describeCredential,
  describeQuotaLimit,
  engineCredentialRefreshFailureSchema,
  extractJsonObject,
  getProviderDisplayName,
  isSameCredential,
  type AgentCredentialSnapshot,
  type AgentEvent,
  type AgentProvider,
  type AgentFallbackReason,
  type AgentQuotaLimitKind,
  type AuthFallbackPayload,
  type AuthFallbackStatus,
  type AuthMethod,
  type CredentialFailureKind,
  type EngineAuthMethod,
  type FallbackHarnessStep,
  type FallbackPlanStep,
  type RestingCredentials,
  type Result,
} from '@okidoki/shared';
import { formatUsageTime } from '@okidoki/shared/routes/subscription-usage';
import { ENGINE_ENV } from '../engine-env';
import { AsyncLock } from '../utils/async-lock';
import { isAgentAvailable } from './agent-auth-detection';
import { claudeTokenManager } from './claude-token-manager';
import { codexTokenManager } from './codex-token-manager';
import { museTokenManager } from './muse-token-manager';
import { geminiTokenManager } from './gemini-token-manager';
import { opencodeTokenManager, piTokenManager } from './api-key-token-manager';
import type { CredentialSwapFailure } from './base-refresh-manager';
import { recordCredentialFallback, recordExhaustedCredential, recordFallbackModel } from '../services/credential-fallbacks';
import { monolithService } from '../services/monolith-service';

const SWAPPABLE_AGENTS: Partial<Record<AgentProvider, {
  fetchFreshCredentials(
    failureReason: string,
    failureKind: CredentialFailureKind,
    failedCredential?: AgentCredentialSnapshot,
    allowedMethods?: readonly AuthMethod[],
    resetsAt?: string,
  ): Promise<Result<void, CredentialSwapFailure>>;
}>> = {
  claude: claudeTokenManager,
  codex: codexTokenManager,
  gemini: geminiTokenManager,
  muse: museTokenManager,
  opencode: opencodeTokenManager,
  pi: piTokenManager,
};

export interface FallbackContext {
  userId?: string;
  /** Harnesses already in the chat's fork ancestry; a chain never forks back to one. */
  excludeProviders: readonly AgentProvider[];
  /** False for chats whose lifecycle a parent owns, such as subagent threads. */
  forkable: boolean;
}

type StoppedFallbackOutcome = 'not_configured' | 'unavailable' | 'failed';

export type QuotaStopFallbackResult =
  | { outcome: StoppedFallbackOutcome; resting?: RestingCredentials }
  | { outcome: 'fork'; target: FallbackHarnessStep };

/** `model` is the one chosen for the new credential's step, whose endpoint may not serve the chat's. */
export type AuthFallbackResult = QuotaStopFallbackResult | { outcome: 'switched'; model?: string };

export const SWITCHED_CREDENTIAL_PROMPT =
  'Your previous turn stopped at a usage limit or a rejected credential. Continue from where you left off: '
  + 'first check what is already done, and do not repeat commands, edits, or messages you already completed.';

const QUOTA_STOP_NEXT_STEP: Record<StoppedFallbackOutcome, string> = {
  failed: 'The next credential in the fallback chain could not be used. Check it in Settings → Fallbacks and try again.',
  not_configured: 'Nothing further is configured in the fallback chain. Add a credential or harness in Settings → Fallbacks, or try again once the limit resets.',
  unavailable: 'No other credential is available for this workspace. Check Settings → Fallbacks, or try again once the limit resets.',
};

export function describeQuotaExhaustion(
  provider: AgentProvider,
  reason: AgentQuotaLimitKind,
  credential: AgentCredentialSnapshot | undefined,
  fallback: QuotaStopFallbackResult,
): string {
  const agent = getProviderDisplayName(provider);
  const account = credential ? describeCredential(provider, credential) : 'the credential this workspace is using';
  const limit = reason === 'credits_required'
    ? `The selected model needs usage credits on ${account}.`
    : reason === 'out_of_credits'
      ? `${agent} ran out of credits on ${account}.`
      : `${agent} hit the usage limit on ${account}.`;
  const resting = fallback.outcome === 'not_configured' && reason === 'rate_limit' ? fallback.resting : undefined;
  if (resting && resting.count > 1) {
    const owner = resting.scope === CREDENTIAL_SCOPE.ORG ? "the organization's" : resting.scope === CREDENTIAL_SCOPE.USER ? 'the personal' : 'the';
    // A stored limit can be our one-hour guess rather than the provider's reset, so this names when Okidoki retries.
    const retryAt = formatUsageTime(resting.resetsAt, { month: 'short', day: 'numeric', timeZone: 'UTC', timeZoneName: 'short' });
    return `${limit} All ${resting.count} of ${owner} ${agent} credentials in the fallback chain are at their usage limit,`
      + ` and Okidoki can use the first of them again ${retryAt}. Add a credential or harness in Settings → Fallbacks, or try again then.`;
  }
  const next = fallback.outcome === 'fork'
    ? `Continuing in ${getProviderDisplayName(fallback.target.provider, 'long')}.`
    : reason === 'credits_required'
      ? 'Pick a different model, or turn on usage credits for this account.'
      : QUOTA_STOP_NEXT_STEP[fallback.outcome];
  return `${limit} ${next}`;
}

export function describeLoginFailure(
  provider: AgentProvider,
  login: AgentCredentialSnapshot | undefined,
  configuredMethod: EngineAuthMethod | 'unknown' | undefined,
  revoked: boolean,
): string {
  const agent = getProviderDisplayName(provider);
  const method = login?.method ?? configuredMethod;
  const name = login ? describeCredential(provider, login) : `the ${agent} credential this workspace uses`;
  const orgLogin = login?.scope === CREDENTIAL_SCOPE.ORG;
  const agentsPage = orgLogin
    ? `Organization → Coding Agents: ${DEFAULT_WEB_APP_URL}${WEB_APP_PATHS.agents}`
    : `Personal → Coding Agents: ${DEFAULT_WEB_APP_URL}${WEB_APP_PATHS.accountAgents}`;
  // 30-day logins saved by CLIs older than 0.3.47 are expiring, and only the CLI can connect a one-year login.
  if (provider === 'claude' && (method === 'oauth' || revoked)) {
    const fixer = orgLogin ? 'an organization admin' : login?.account?.ownerName ?? 'you';
    return `${agent} could not sign in with ${name}. The login expired or was revoked.`
      + ` Okidoki recently switched to one-year Claude logins, so ${fixer} should update the Okidoki CLI`
      + ` (\`npm install -g okidoki-cli@latest\`) and reconnect with \`okidoki claude-auth${orgLogin ? ' --org' : ''}\`.`
      + ` Claude logins are listed in ${agentsPage}`;
  }
  if (!login && (!method || method === 'unknown')) {
    return `No ${agent} credential is available to this workspace. Connect your own ${agent} account in ${agentsPage}`;
  }
  const why = revoked
    ? 'It was signed out, revoked, or expired.'
    : method === 'api_key'
      ? 'The key may be invalid, revoked, out of credits, or missing access to the selected model.'
      : method === 'bedrock'
        ? 'Check its credentials, region, IAM permissions, and Claude model access.'
        : method === 'foundry'
          ? `Check its API key, resource, and ${agent} deployment names.`
          : method === 'anthropic-compatible'
            ? 'Check its endpoint URL, API key, and that it serves the selected model.'
            : 'It was rejected even after a refresh.';
  const reconnect = orgLogin ? `An organization admin can reconnect it in ${agentsPage}` : `Reconnect it in ${agentsPage}`;
  return `${agent} could not sign in with ${name}. ${why} ${reconnect}`;
}

export function describeModelUnavailable(provider: AgentProvider, models: string[], credential: AgentCredentialSnapshot | undefined): string {
  const bedrock = credential?.method === 'bedrock';
  const where = credential ? describeCredential(provider, credential) : `the ${getProviderDisplayName(provider)} credential this workspace uses`;
  return `${models.map((model) => MODEL_LABELS[model] ?? model).join(' and ')} ${models.length > 1 ? 'are' : 'is'} not available on ${where}${bedrock && ENGINE_ENV.AWS_REGION ? ` in ${ENGINE_ENV.AWS_REGION}` : ''}.`
    + (bedrock ? ' Turn on access for that region in the Amazon Bedrock console (Model access),' : '')
    + ' pick a different model in the chat\'s model picker, or add a credential that serves it in Settings → Fallbacks.';
}

// Chats in one workspace share a live credential, so their fallbacks run one at a time.
const fallbackLocks = new Map<AgentProvider, AsyncLock>();

export class AuthFallbackCoordinator {
  constructor(
    private readonly provider: AgentProvider,
    private readonly record: (event: AgentEvent) => void,
    private readonly context: () => FallbackContext,
  ) {}

  /** `attempted` is the credential the failed turn ran on, which another chat may already have replaced. */
  fallBack(reason: AgentFallbackReason, detail: string, attempted?: AgentCredentialSnapshot, resetsAt?: string, afterLimit = false): Promise<AuthFallbackResult> {
    let lock = fallbackLocks.get(this.provider);
    if (!lock) fallbackLocks.set(this.provider, lock = new AsyncLock());
    return lock.run(() => this.fallBackNow(reason, detail, attempted, resetsAt, afterLimit));
  }

  private async fallBackNow(
    reason: AgentFallbackReason,
    detail: string,
    attempted: AgentCredentialSnapshot | undefined,
    resetsAt: string | undefined,
    afterLimit: boolean,
  ): Promise<AuthFallbackResult> {
    const tokenManager = SWAPPABLE_AGENTS[this.provider];
    const live = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[this.provider];
    const exhausted = attempted ?? live;
    // Blaming the live credential here would mark an account another chat just moved to as spent.
    const alreadyReplaced = !!exhausted && !!live && !isSameCredential(live, exhausted);
    if (exhausted) recordExhaustedCredential(this.provider, exhausted, resetsAt);

    const { userId, excludeProviders, forkable } = this.context();
    const plan = await monolithService.getFallbackPlan({
      provider: this.provider,
      exhaustedMethod: exhausted?.method,
      exclude: excludeProviders,
      userId,
    });
    // A chain we could not read is not a chain without steps: an unrestricted swap
    // could bill a method the user deliberately put behind a fork point.
    if (!plan.ok && plan.error.code === 'unavailable') {
      console.error(`[AuthFallback] ${this.provider} fallback stopped; plan unavailable:`, plan.error.message);
      return { outcome: 'unavailable' };
    }
    const steps: FallbackPlanStep[] = plan.ok
      ? plan.data.steps
      : tokenManager && exhausted ? [{ kind: 'credentials', methods: [] }] : [];

    let failed = false;
    let resting: RestingCredentials | undefined;
    for (const step of steps) {
      if (step.kind === 'harness') {
        // Skipped rather than terminal: the credentials behind it are still worth trying.
        if (!forkable || !isAgentAvailable(step.provider)) continue;
        // A broken login must not move the chat onto another harness's billing, but one reached after a usage limit is part of the walk the user ordered.
        if ((reason === 'auth_failed' || reason === 'model_unavailable') && !afterLimit) continue;
        return { outcome: 'fork', target: step };
      }
      // Another chat already moved off the spent credential; reuse it only where this chat's own chain allows.
      if (alreadyReplaced && live) {
        if (step.methods.length > 0 && !step.methods.includes(live.method)) continue;
        return this.switched(reason, exhausted, live, step, detail);
      }
      if (!tokenManager || !exhausted) continue;
      const swap = await tokenManager.fetchFreshCredentials(
        `${this.provider} ${describeQuotaLimit(reason)}: ${detail}`,
        // Skipped via the exclusion above, not rested, so Settings doesn't show a usage limit.
        reason === 'auth_failed' || reason === 'credits_required' || reason === 'model_unavailable' ? 'rejected' : 'exhausted',
        exhausted,
        step.methods.length > 0 ? step.methods : undefined,
        resetsAt,
      );
      // Nothing configured in this run is not a failed switch: the walk moves on.
      if (!swap.ok) {
        failed ||= swap.error.code !== 'no_credentials';
        const skipped = engineCredentialRefreshFailureSchema.safeParse(extractJsonObject(swap.error.message)).data?.resting;
        // Each step resolves its own methods, so the accounts each one skipped add up.
        if (skipped) {
          resting = resting
            ? {
              count: resting.count + skipped.count,
              ...(resting.scope === skipped.scope ? { scope: skipped.scope } : {}),
              resetsAt: resting.resetsAt < skipped.resetsAt ? resting.resetsAt : skipped.resetsAt,
            }
            : skipped;
        }
        continue;
      }
      // What the refresh actually loaded is the only credential worth reporting;
      // landing back on the exhausted one is not a switch.
      const applied = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[this.provider] ?? exhausted;
      if (isSameCredential(applied, exhausted)) {
        failed = true;
        continue;
      }
      return this.switched(reason, exhausted, applied, step, detail);
    }

    if (!tokenManager || !exhausted) return { outcome: 'unavailable' };
    if (!failed) return { outcome: 'not_configured', ...(resting ? { resting } : {}) };
    this.recordNotice(reason, exhausted, exhausted, 'failed', 'Okidoki could not load an alternate credential.');
    return { outcome: 'failed' };
  }

  private switched(
    reason: AgentFallbackReason,
    exhausted: AgentCredentialSnapshot,
    applied: AgentCredentialSnapshot,
    step: Extract<FallbackPlanStep, { kind: 'credentials' }>,
    detail: string,
  ): AuthFallbackResult {
    this.recordNotice(reason, exhausted, applied, 'switched', detail);
    const model = step.models?.[applied.method];
    // Remembered for the workspace, so later turns and other chats keep a model this credential serves.
    if (model) recordFallbackModel(this.provider, applied, model);
    return { outcome: 'switched', ...(model ? { model } : {}) };
  }

  private recordNotice(
    reason: AgentFallbackReason,
    exhausted: AgentCredentialSnapshot,
    applied: AgentCredentialSnapshot,
    status: AuthFallbackStatus,
    detail: string,
  ): void {
    const payload: AuthFallbackPayload = {
      provider: this.provider,
      reason,
      exhaustedMethod: exhausted.method,
      exhaustedScope: exhausted.scope,
      ...(exhausted.account ? { exhaustedAccount: exhausted.account } : {}),
      candidateMethod: applied.method,
      candidateScope: applied.scope,
      ...(applied.account ? { candidateAccount: applied.account } : {}),
      status,
      detail,
    };
    const at = new Date().toISOString();
    this.record({ timestamp: at, type: AUTH_FALLBACK_EVENT_TYPE, payload: { ...payload } });
    // Kept out of chat history too: the workspace panel shows which credential is
    // live now, which outlives the chat the switch happened to occur in.
    recordCredentialFallback({ ...payload, at });
  }
}
