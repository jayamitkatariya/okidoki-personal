import {
  AGENT,
  isRecord,
  isTokenUsageCounts,
  type TokenUsageCounts,
} from '@okidoki/shared';
import {
  recordParsedTokenUsage,
  type AgentTokenUsageService,
  type TokenUsageBatch,
  type TokenUsageEvent,
} from '../types';

function parseOpencodeTokenUsage(payload: unknown): TokenUsageCounts | undefined {
  if (!isRecord(payload)
    || payload.type !== 'step-finish'
    || !isRecord(payload.tokens)
    || !isRecord(payload.tokens.cache)) return undefined;
  const usage = {
    inputTokens: payload.tokens.input,
    outputTokens: payload.tokens.output,
    cacheReadInputTokens: payload.tokens.cache.read,
    cacheWriteInputTokens: payload.tokens.cache.write,
  };
  return isTokenUsageCounts(usage) ? usage : undefined;
}

export class OpencodeTokenUsageService implements AgentTokenUsageService {
  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    return recordParsedTokenUsage(event, AGENT.OPENCODE, parseOpencodeTokenUsage);
  }
}
