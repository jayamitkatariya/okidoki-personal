import { isNonEmptyString, isRecord } from '@okidoki/shared';
import type {
  CodexTurn,
  CodexUsage,
  CodexUsageUpdate,
} from './types';

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseCodexTurn(value: unknown): CodexTurn | undefined {
  if (!isRecord(value)
    || !isNonEmptyString(value.threadId)
    || !isNonEmptyString(value.turnId)) return undefined;
  return { threadId: value.threadId, turnId: value.turnId };
}

function parseCodexUsage(value: unknown): CodexUsage | undefined {
  if (!isRecord(value)
    || !isTokenCount(value.inputTokens)
    || !isTokenCount(value.cachedInputTokens)
    || !isTokenCount(value.outputTokens)) {
    return undefined;
  }

  const cacheWriteInputTokens = value.cacheWriteInputTokens;
  if (cacheWriteInputTokens !== undefined && !isTokenCount(cacheWriteInputTokens)) return undefined;
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  };
}

export function parseCodexUsageUpdate(value: unknown): CodexUsageUpdate | undefined {
  if (!isRecord(value)) return undefined;
  const turn = parseCodexTurn(value);
  if (!turn || !isRecord(value.tokenUsage)) return undefined;
  const total = parseCodexUsage(value.tokenUsage.total);
  const last = parseCodexUsage(value.tokenUsage.last);
  return total && last ? { ...turn, total, last } : undefined;
}

export function parseCodexModelReroute(
  value: unknown,
): (CodexTurn & { model: string }) | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.toModel)) return undefined;
  const turn = parseCodexTurn(value);
  return turn ? { ...turn, model: value.toModel } : undefined;
}
