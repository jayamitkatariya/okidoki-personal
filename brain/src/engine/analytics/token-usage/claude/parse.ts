import {
  isNonEmptyString,
  isRecord,
  isTokenUsageCounts,
  type TokenUsageCounts,
} from '@okidoki/shared';
import type { ClaudeModelUsage, ClaudeResultUsage } from './types';

export function isClaudeModelUsage(value: unknown): value is ClaudeModelUsage {
  if (!isRecord(value) || !isTokenUsageCounts(value)) return false;
  return (value.costUsd === undefined || (
    typeof value.costUsd === 'number'
    && Number.isFinite(value.costUsd)
    && value.costUsd >= 0
  ))
    && (value.pricingProvider === undefined || isNonEmptyString(value.pricingProvider));
}

const withoutDate = (model: string): string => model.replace(/-\d{8}$/, '');

// A cut request never reports its final usage, so its first event is all there is: the whole input, and the output only as far as it was known then.
export function parseClaudeRequestStart(payload: unknown): { model: string; usage: TokenUsageCounts } | null {
  if (!isRecord(payload) || payload.type !== 'message' || !isNonEmptyString(payload.model) || !isRecord(payload.usage)) return null;

  const usage = {
    inputTokens: payload.usage.input_tokens,
    outputTokens: payload.usage.output_tokens,
    cacheReadInputTokens: payload.usage.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: payload.usage.cache_creation_input_tokens ?? 0,
  };
  return isTokenUsageCounts(usage) ? { model: withoutDate(payload.model), usage } : null;
}

export function parseClaudeResult(payload: unknown): ClaudeResultUsage | null {
  if (!isRecord(payload) || payload.type !== 'result') return null;
  if (!isNonEmptyString(payload.session_id) || !isRecord(payload.modelUsage)) return null;

  const snapshot: Record<string, ClaudeModelUsage> = {};
  for (const [rawModel, rawUsage] of Object.entries(payload.modelUsage)) {
    if (!isNonEmptyString(rawModel) || !isRecord(rawUsage)) continue;

    const usage = {
      inputTokens: rawUsage.inputTokens,
      outputTokens: rawUsage.outputTokens,
      cacheReadInputTokens: rawUsage.cacheReadInputTokens,
      cacheWriteInputTokens: rawUsage.cacheCreationInputTokens,
      ...(typeof rawUsage.costUSD === 'number'
        && Number.isFinite(rawUsage.costUSD)
        && rawUsage.costUSD >= 0
        ? { costUsd: rawUsage.costUSD }
        : {}),
      ...(isNonEmptyString(rawUsage.provider) ? { pricingProvider: rawUsage.provider } : {}),
    };
    if (!isClaudeModelUsage(usage)) continue;

    const model = isNonEmptyString(rawUsage.canonicalModel)
      ? rawUsage.canonicalModel
      : withoutDate(rawModel);
    const previous = snapshot[model];
    snapshot[model] = previous ? {
      inputTokens: previous.inputTokens + usage.inputTokens,
      outputTokens: previous.outputTokens + usage.outputTokens,
      cacheReadInputTokens: previous.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheWriteInputTokens: previous.cacheWriteInputTokens + usage.cacheWriteInputTokens,
      ...(previous.costUsd !== undefined || usage.costUsd !== undefined
        ? { costUsd: (previous.costUsd ?? 0) + (usage.costUsd ?? 0) }
        : {}),
      ...(usage.pricingProvider ?? previous.pricingProvider
        ? { pricingProvider: usage.pricingProvider ?? previous.pricingProvider }
        : {}),
    } : usage;
  }

  if (Object.keys(snapshot).length === 0) return null;

  return {
    sessionId: payload.session_id,
    snapshot,
  };
}
