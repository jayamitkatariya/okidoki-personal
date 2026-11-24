import {
  AGENT,
  isRecord,
  isTokenUsageCounts,
  type TokenUsageUploadRecord,
} from '@okidoki/shared';
import type { AgentTokenUsageService, TokenUsageBatch, TokenUsageEvent } from '../types';

export class MuseTokenUsageService implements AgentTokenUsageService {
  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    if (event.type !== 'usage-updated' || !isRecord(event.payload) || !isRecord(event.payload.usage)) return undefined;
    const usage = {
      inputTokens: event.payload.promptTokens,
      outputTokens: event.payload.usage.outputTokens,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    };
    if (!isTokenUsageCounts(usage)) return undefined;
    const record: TokenUsageUploadRecord = {
      ...event.context,
      harness: AGENT.MUSE,
      model: typeof event.payload.modelId === 'string' ? event.payload.modelId : event.context.model,
      ...usage,
      occurredAt: event.occurredAt,
    };
    return { records: [record] };
  }
}
