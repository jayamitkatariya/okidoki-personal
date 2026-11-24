import { exhaustedUntil, isSameCredential, type AgentProvider, type CredentialFallbackNotice, type AgentCredentialSnapshot } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';

// In-memory on purpose: this describes the credentials the current engine
// process is running with, not durable state.
const fallbacksByAgent = new Map<string, CredentialFallbackNotice>();
const exhaustedByAgent = new Map<AgentProvider, Map<string, { credential: AgentCredentialSnapshot; until: number }>>();
const fallbackModels = new Map<AgentProvider, { credential: AgentCredentialSnapshot; model: string }>();

export function clearCredentialFallbacks(provider: AgentProvider): void {
  fallbacksByAgent.delete(provider);
  exhaustedByAgent.delete(provider);
  fallbackModels.delete(provider);
}

export function recordFallbackModel(provider: AgentProvider, credential: AgentCredentialSnapshot, model: string): void {
  fallbackModels.set(provider, { credential, model });
}

/** The model the fallback chain chose for the live credential, whose endpoint may not serve the chat's. */
export function getFallbackModel(provider: AgentProvider): string | undefined {
  const chosen = fallbackModels.get(provider);
  const live = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[provider];
  return chosen && live && isSameCredential(chosen.credential, live) ? chosen.model : undefined;
}

export function recordCredentialFallback(notice: CredentialFallbackNotice): void {
  fallbacksByAgent.set(notice.provider, notice);
}

/**
 * A later refresh can move the workspace again without any fallback, so a
 * notice is only current while the credential it describes is still live:
 * the one it switched to, or the exhausted one it failed to leave.
 */
export function listCredentialFallbacks(): CredentialFallbackNotice[] {
  return [...fallbacksByAgent.values()].filter((notice) => {
    const live = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[notice.provider];
    if (!live) return false;
    return notice.status === 'switched'
      ? live.method === notice.candidateMethod && live.scope === notice.candidateScope
      : live.method === notice.exhaustedMethod && live.scope === notice.exhaustedScope;
  });
}

export function listExhaustedCredentials(provider: AgentProvider): AgentCredentialSnapshot[] {
  const now = Date.now();
  return [...(exhaustedByAgent.get(provider)?.values() ?? [])]
    .filter((spent) => spent.until > now)
    .map((spent) => spent.credential);
}

// A routine refresh re-resolves from scratch, so without these it lands straight back on a spent
// credential, or hops to another account of the live credential's pool.
export function routineRefreshRequest(provider: AgentProvider): {
  excludeCredentials?: AgentCredentialSnapshot[];
  currentCredential?: AgentCredentialSnapshot;
} {
  const live = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[provider];
  // Excluding the live credential would let its token go stale when it is the only one configured.
  const excludeCredentials = listExhaustedCredentials(provider)
    .filter((spent) => !live || !isSameCredential(spent, live));
  return {
    ...(excludeCredentials.length > 0 ? { excludeCredentials } : {}),
    ...(live ? { currentCredential: live } : {}),
  };
}

// The same method in the other scope, or another account in the same pool, has its own quota.
const exhaustedKey = (credential: AgentCredentialSnapshot) => `${credential.method}|${credential.scope}|${credential.credentialId ?? ''}`;

export function forgetExhaustedCredentials(provider: AgentProvider, credentials: AgentCredentialSnapshot[]): void {
  for (const credential of credentials) exhaustedByAgent.get(provider)?.delete(exhaustedKey(credential));
}

export function recordExhaustedCredential(provider: AgentProvider, credential: AgentCredentialSnapshot, resetsAt?: string): void {
  const spent = exhaustedByAgent.get(provider) ?? new Map<string, { credential: AgentCredentialSnapshot; until: number }>();
  spent.set(exhaustedKey(credential), {
    credential,
    until: exhaustedUntil(resetsAt).getTime(),
  });
  exhaustedByAgent.set(provider, spent);
}
