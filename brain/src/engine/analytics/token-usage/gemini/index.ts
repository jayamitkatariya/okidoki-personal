import { AGENT, isRecord } from '@okidoki/shared';
import { recordParsedTokenUsage, type AgentTokenUsageService, type TokenUsageBatch, type TokenUsageEvent } from '../types';

/** ACP's per-prompt `usage`, which counts only that prompt's turn. */
export class GeminiTokenUsageService implements AgentTokenUsageService {
  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    return recordParsedTokenUsage(event, AGENT.GEMINI, (usage) => {
      if (!isRecord(usage) || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return undefined;
      return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens + (typeof usage.thoughtTokens === 'number' ? usage.thoughtTokens : 0),
        cacheReadInputTokens: typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : 0,
        cacheWriteInputTokens: typeof usage.cachedWriteTokens === 'number' ? usage.cachedWriteTokens : 0,
      };
    });
  }
}
