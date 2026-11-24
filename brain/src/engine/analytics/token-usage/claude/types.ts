import type { TokenUsageCounts } from '@okidoki/shared';
import type { TokenUsageSnapshot } from '../types';

export type ClaudeModelUsage = TokenUsageCounts & {
  costUsd?: number;
  pricingProvider?: string;
};

export type ClaudeTokenUsageSnapshot = TokenUsageSnapshot<ClaudeModelUsage>;

export type ClaudeResultUsage = {
  sessionId: string;
  snapshot: ClaudeTokenUsageSnapshot;
};
