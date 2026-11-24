import {
  CONTEXT_USAGE_EVENT_TYPE,
  type AgentEvent,
  type ContextUsageCategory,
  type ContextUsagePayload,
} from './event';
import { isValidAgentProvider, type AgentProvider } from './agent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Clamp a percentage value to [0, 100]. Non-finite inputs become 0.
 * Exported so engine and web consumers can apply the same clamp without
 * re-implementing it.
 */
export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Compute `(tokens / maxTokens) * 100` and clamp to [0, 100]. Returns 0
 * when `maxTokens` is null or non-positive (denominator unavailable).
 */
export function percentage(tokens: number, maxTokens: number | null): number {
  if (!maxTokens || maxTokens <= 0) return 0;
  return clampPercentage((tokens / maxTokens) * 100);
}

export function providerContextUsage(
  usage: Pick<ContextUsagePayload, 'provider' | 'model' | 'totalTokens' | 'compactsAutomatically'> & { maxTokens: number },
): ContextUsagePayload {
  return { ...usage, source: 'provider_usage', percentage: percentage(usage.totalTokens, usage.maxTokens), categories: [], updatedAt: new Date().toISOString() };
}

export function autoCompactThresholdField(
  autoCompactThreshold: number | null | undefined,
): Pick<ContextUsagePayload, 'autoCompactThreshold'> | Record<string, never> {
  return typeof autoCompactThreshold === 'number' && Number.isFinite(autoCompactThreshold)
    ? { autoCompactThreshold }
    : {};
}

export function normalizeAutoCompactThreshold(
  threshold: unknown,
  maxTokens: number | null,
): number | null {
  const value = numberOrNull(threshold);
  if (value === null) return null;
  if (value <= 0) return null;
  if (value > 100) {
    return maxTokens && maxTokens > 0 ? percentage(value, maxTokens) : null;
  }
  if (value > 0 && value <= 1) return clampPercentage(value * 100);
  return clampPercentage(value);
}

export function getCompactionProgress(
  usage: Pick<ContextUsagePayload, 'percentage' | 'compactsAutomatically' | 'autoCompactThreshold'>,
): number {
  const compactsAt = usage.compactsAutomatically && usage.autoCompactThreshold ? usage.autoCompactThreshold : 100;
  return clampPercentage((usage.percentage / compactsAt) * 100);
}

export function clampTokensToWindow(rawTokens: number, maxTokens: number | null): number {
  return maxTokens && maxTokens > 0 ? Math.min(rawTokens, maxTokens) : rawTokens;
}

function compactCategories(
  categories: Array<ContextUsageCategory | null>,
): ContextUsageCategory[] {
  return categories
    .filter((category): category is ContextUsageCategory => Boolean(category && category.tokens > 0))
    .map((category) => ({
      ...category,
      percentage: clampPercentage(category.percentage),
    }));
}

export interface CodexContextUsageTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CodexContextUsageInput {
  last: CodexContextUsageTokenUsage;
  modelContextWindow: number | null;
  autoCompactTokens: number | null;
  model?: string | null;
  updatedAt: string;
}

export function buildCodexTokenUsageContextUsagePayload(
  usage: CodexContextUsageInput,
): ContextUsagePayload {
  const maxTokens = usage.modelContextWindow;
  const inputTokens = usage.last.inputTokens;
  const outputTokens = usage.last.outputTokens;
  const totalTokens = clampTokensToWindow(usage.last.totalTokens, maxTokens);

  return {
    provider: 'codex',
    source: 'codex_token_count',
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: percentage(totalTokens, maxTokens),
    compactsAutomatically: true,
    ...autoCompactThresholdField(usage.autoCompactTokens && maxTokens && usage.autoCompactTokens < maxTokens
      ? percentage(usage.autoCompactTokens, maxTokens)
      : null),
    categories: compactCategories([
      {
        name: 'Input context',
        tokens: inputTokens,
        percentage: percentage(inputTokens, maxTokens),
      },
      {
        name: 'Generated output',
        tokens: outputTokens,
        percentage: percentage(outputTokens, maxTokens),
      },
    ]),
    updatedAt: usage.updatedAt,
  };
}

function coerceContextUsagePayload(
  payload: Record<string, unknown>,
  timestamp: string,
): ContextUsagePayload | null {
  const provider = payload.provider;
  if (typeof provider !== 'string' || !isValidAgentProvider(provider)) return null;

  const rawTotalTokens = numberOrNull(payload.totalTokens);
  const percentageValue = numberOrNull(payload.percentage);
  if (rawTotalTokens === null || percentageValue === null) {
    return null;
  }

  const model = typeof payload.model === 'string' ? payload.model : null;
  const maxTokens = numberOrNull(payload.maxTokens);
  const rawMaxTokens = numberOrNull(payload.rawMaxTokens);
  const totalTokens = clampTokensToWindow(rawTotalTokens, maxTokens);
  const source = (
    payload.source === 'codex_token_count' ||
    payload.source === 'claude_usage' ||
    payload.source === 'provider_usage'
  )
    ? payload.source
    : 'claude_context';

  const categories = Array.isArray(payload.categories)
    ? compactCategories(payload.categories.map((item): ContextUsageCategory | null => {
        if (!isRecord(item)) return null;
        const name = typeof item.name === 'string' ? item.name : null;
        const tokens = numberOrNull(item.tokens);
        const categoryPercentage = numberOrNull(item.percentage);
        if (!name || tokens === null || categoryPercentage === null) return null;
        if (item.isDeferred === true || name === 'Free space' || name === 'Autocompact buffer') return null;
        return {
          name,
          tokens,
          percentage: categoryPercentage,
        };
      }))
    : [];

  const compactsAutomatically = typeof payload.compactsAutomatically === 'boolean'
    ? payload.compactsAutomatically
    : undefined;
  const autoCompactThreshold = normalizeAutoCompactThreshold(payload.autoCompactThreshold, maxTokens);

  return {
    provider,
    source,
    ...(model ? { model } : {}),
    totalTokens,
    maxTokens,
    rawMaxTokens,
    percentage: clampPercentage(percentageValue),
    ...(compactsAutomatically !== undefined ? { compactsAutomatically } : {}),
    ...(autoCompactThreshold !== null ? { autoCompactThreshold } : {}),
    categories,
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : timestamp,
  };
}

function codexTokenCountToContextUsage(
  event: AgentEvent,
): ContextUsagePayload | null {
  const payload = event.payload;
  if (payload.type !== 'token_count') return null;

  const info = isRecord(payload.info) ? payload.info : null;
  if (!info) return null;

  // Only use `last_token_usage` for the pill: that's the size of the most
  // recent turn. `total_token_usage` accumulates across the entire session
  // (it is unbounded by the context window) and produces >100% pills.
  const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : null;
  if (!lastUsage) return null;

  const maxTokens = numberOrNull(info.model_context_window);
  const inputTokens = numberOrNull(lastUsage.input_tokens) ?? 0;
  const outputTokens = numberOrNull(lastUsage.output_tokens) ?? 0;
  // For Codex/OpenAI the context-window numerator is the per-turn
  // `total_tokens` (input + output) — this mirrors `codex-rs`'s own
  // `TokenUsage::tokens_in_context_window`. Intentionally different from the
  // Claude path above, where output_tokens is excluded because Anthropic
  // reports input/cache buckets as the loaded window separately from output.
  return buildCodexTokenUsageContextUsagePayload({
    last: {
      inputTokens,
      outputTokens,
      totalTokens: numberOrNull(lastUsage.total_tokens) ?? inputTokens + outputTokens,
    },
    modelContextWindow: maxTokens,
    autoCompactTokens: null,
    updatedAt: event.timestamp,
  });
}

export function extractLatestContextUsage(
  events: AgentEvent[] | undefined,
  provider: AgentProvider,
): ContextUsagePayload | null {
  if (!events || events.length === 0) return null;

  let latest: ContextUsagePayload | null = null;
  for (const event of events) {
    if (event.type === CONTEXT_USAGE_EVENT_TYPE) {
      const usage = coerceContextUsagePayload(event.payload, event.timestamp);
      if (usage && usage.provider === provider) {
        latest = usage;
      }
      continue;
    }

    if (provider === 'codex') {
      const usage = codexTokenCountToContextUsage(event);
      if (usage) {
        latest = usage;
      }
      continue;
    }
  }

  return latest;
}
