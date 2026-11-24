import type { v2 } from '@okidoki/shared/codex-asp-types';
import type { TokenUsageCounts } from '@okidoki/shared';
import type { TokenUsageContext } from '../types';

export type CodexUsage = Pick<
  v2.TokenUsageBreakdown,
  'inputTokens' | 'cachedInputTokens' | 'outputTokens'
> & Partial<Pick<v2.TokenUsageBreakdown, 'cacheWriteInputTokens'>>;

export type CodexTurn = {
  threadId: string;
  turnId: string;
};

export type CodexUsageUpdate = CodexTurn & { total: CodexUsage; last: CodexUsage };

export type TrackedCodexTurn = CodexTurn & {
  context: TokenUsageContext;
  baselineTotal?: TokenUsageCounts;
  latestTotal?: TokenUsageCounts;
  occurredAt?: string;
};
