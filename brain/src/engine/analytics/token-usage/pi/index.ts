import {
  AGENT,
  isNonEmptyString,
  isRecord,
  isTokenUsageCounts,
  type TokenUsageCounts,
  type TokenUsageUploadRecord,
} from '@okidoki/shared';
import type {
  AgentTokenUsageService,
  TokenUsageBatch,
  TokenUsageEvent,
} from '../types';

function parsePiTokenUsage(payload: unknown): {
  model?: string;
  usage: TokenUsageCounts;
} | undefined {
  if (!isRecord(payload)
    || payload.type !== 'message_end'
    || !isRecord(payload.message)
    || payload.message.role !== 'assistant'
    || !isRecord(payload.message.usage)) return undefined;

  const usage = {
    inputTokens: payload.message.usage.input,
    outputTokens: payload.message.usage.output,
    cacheReadInputTokens: payload.message.usage.cacheRead,
    cacheWriteInputTokens: payload.message.usage.cacheWrite,
  };
  if (!isTokenUsageCounts(usage)) return undefined;

  const model = isNonEmptyString(payload.message.responseModel)
    ? payload.message.responseModel
    : isNonEmptyString(payload.message.model)
      ? payload.message.model
      : undefined;
  return { model, usage };
}

export class PiTokenUsageService implements AgentTokenUsageService {
  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    if (event.type !== 'usage-updated') return undefined;
    const result = parsePiTokenUsage(event.payload);
    if (!result) return undefined;

    const record: TokenUsageUploadRecord = {
      ...event.context,
      harness: AGENT.PI,
      model: result.model ?? event.context.model,
      ...result.usage,
      occurredAt: event.occurredAt,
    };
    return { records: [record] };
  }
}
