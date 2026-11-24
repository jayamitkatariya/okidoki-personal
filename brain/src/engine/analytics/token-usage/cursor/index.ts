import {
  AGENT,
  isRecord,
  isTokenUsageCounts,
  type TokenUsageCounts,
  type TokenUsageUploadRecord,
} from '@okidoki/shared';
import type {
  AgentTokenUsageService,
  TokenUsageBatch,
  TokenUsageContext,
  TokenUsageEvent,
} from '../types';

function parseCursorTokenUsage(payload: unknown): TokenUsageCounts | undefined {
  if (!isRecord(payload) || payload.type !== 'turn-ended' || !isRecord(payload.usage)) return undefined;
  const usage = {
    inputTokens: payload.usage.inputTokens,
    outputTokens: payload.usage.outputTokens,
    cacheReadInputTokens: payload.usage.cacheReadTokens,
    cacheWriteInputTokens: payload.usage.cacheWriteTokens,
  };
  return isTokenUsageCounts(usage) ? usage : undefined;
}

export class CursorTokenUsageService implements AgentTokenUsageService {
  private readonly turns = new Map<string, {
    context: TokenUsageContext;
    usage: TokenUsageCounts;
    occurredAt: string;
  }>();

  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    if (event.type === 'usage-updated') {
      const usage = parseCursorTokenUsage(event.payload);
      if (!usage) return undefined;
      const turnId = event.turnId ?? event.chatId;
      this.turns.set(`${event.chatId}\u0000${turnId}`, {
        context: event.context,
        usage,
        occurredAt: event.occurredAt,
      });
      return undefined;
    }
    if (event.type !== 'chat-ended') return undefined;

    const turnId = event.turnId ?? event.chatId;
    const key = `${event.chatId}\u0000${turnId}`;
    const turn = this.turns.get(key);
    if (!turn) return undefined;
    this.turns.delete(key);
    const record: TokenUsageUploadRecord = {
      ...turn.context,
      harness: AGENT.CURSOR,
      ...turn.usage,
      occurredAt: turn.occurredAt,
    };
    return { records: [record] };
  }
}
