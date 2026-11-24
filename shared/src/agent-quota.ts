/**
 * Quota exhaustion is not an auth failure: the credential is valid, it just has
 * nothing left to spend, so refreshing it hands back the same empty account.
 */
export type AgentQuotaLimitKind = 'rate_limit' | 'out_of_credits' | 'credits_required';

/** Why a turn left its credential: a quota limit, or a login the provider still rejects after a refresh. */
/** `credits_required`: the plan serves the selected model only on usage credits, so other models still work on the account. */
export const AGENT_FALLBACK_REASONS = ['rate_limit', 'out_of_credits', 'credits_required', 'auth_failed', 'model_unavailable'] as const;
export type AgentFallbackReason = typeof AGENT_FALLBACK_REASONS[number];

const EXHAUSTED_COOLDOWN_MS = 60 * 60 * 1000;

export function exhaustedUntil(resetsAt?: string): Date {
  return new Date(resetsAt ?? Date.now() + EXHAUSTED_COOLDOWN_MS);
}

export function isAgentFallbackReason(value: unknown): value is AgentFallbackReason {
  return AGENT_FALLBACK_REASONS.some((reason) => reason === value);
}

const OUT_OF_CREDITS_PATTERNS: readonly RegExp[] = [
  /credit balance is too low/,
  /out.of.credits/,
  /credits?.?(?:depleted|exhausted|remaining)/,
  /insufficient credits/,
  /insufficient_quota/,
];

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  // Loose on purpose: providers word this as "rate limit", "rate_limit",
  // "usageLimitExceeded" and so on, and these only ever run against error text.
  /rate.?limit/,
  /usage.?limit/,
  /too many requests/,
  /\bquota\b/,
];

const HTTP_429_PATTERN = /(?:^|[^0-9])429(?:$|[^0-9])/;
const HTTP_CONTEXT_PATTERN = /(api error|request|response|status|http)/;

export function detectAgentQuotaLimit(text: string): AgentQuotaLimitKind | null {
  const normalized = text.toLowerCase();
  if (!normalized) return null;
  if (OUT_OF_CREDITS_PATTERNS.some((pattern) => pattern.test(normalized))) return 'out_of_credits';
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized))) return 'rate_limit';
  // Deliberately not `isTransientErrorText`: that reports true for any network
  // blip, which would move the workspace off a perfectly good credential.
  return HTTP_429_PATTERN.test(normalized) && HTTP_CONTEXT_PATTERN.test(normalized)
    ? 'rate_limit'
    : null;
}
