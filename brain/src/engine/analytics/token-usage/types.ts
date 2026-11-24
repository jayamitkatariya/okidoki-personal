import type {
  TokenUsageCounts,
  TokenUsageUploadRecord,
} from '@okidoki/shared';

export interface AgentTokenUsageService {
  record(event: TokenUsageEvent): TokenUsageBatch | undefined;
  restoreCheckpoint?(checkpoint: unknown): void;
}

export type TokenUsageBatch = {
  records: TokenUsageUploadRecord[];
  checkpoint?: unknown;
};

export type HarnessId = string;

export type StoredTokenUsageBatch = {
  harness: HarnessId;
  records: TokenUsageUploadRecord[];
  checkpoint?: unknown;
};

export type TokenUsageSnapshot<
  Metrics extends TokenUsageCounts = TokenUsageCounts,
> = Readonly<Record<string, Metrics>>;

export function calculateCumulativeTokenUsageDelta(
  current: TokenUsageCounts,
  previous?: TokenUsageCounts,
): TokenUsageCounts {
  if (!previous
    || current.inputTokens < previous.inputTokens
    || current.outputTokens < previous.outputTokens
    || current.cacheReadInputTokens < previous.cacheReadInputTokens
    || current.cacheWriteInputTokens < previous.cacheWriteInputTokens) return current;

  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens - previous.cacheReadInputTokens,
    cacheWriteInputTokens: current.cacheWriteInputTokens - previous.cacheWriteInputTokens,
  };
}

export function recordParsedTokenUsage(
  event: TokenUsageEvent,
  harness: TokenUsageUploadRecord['harness'],
  parse: (payload: unknown) => TokenUsageCounts | undefined,
): TokenUsageBatch | undefined {
  if (event.type !== 'usage-updated') return undefined;
  const usage = parse(event.payload);
  if (!usage) return undefined;
  return {
    records: [{
      ...event.context,
      harness,
      ...usage,
      occurredAt: event.occurredAt,
    }],
  };
}

export type TokenUsageContext = Pick<
  TokenUsageUploadRecord,
  | 'chatId'
  | 'model'
  | 'credentialMethod'
  | 'credentialScope'
  | 'senderUserId'
  | 'automationId'
  | 'environmentId'
>;

type TokenUsageEventBase = {
  harness: HarnessId;
  chatId: string;
  turnId?: string;
};

export type TokenUsageEvent =
  | TokenUsageEventBase & {
    type: 'turn-started';
    payload: unknown;
    context: TokenUsageContext;
  }
  | TokenUsageEventBase & {
    type: 'usage-updated';
    payload: unknown;
    context: TokenUsageContext;
    occurredAt: string;
  }
  | TokenUsageEventBase & {
    type: 'model-rerouted' | 'turn-completed';
    payload: unknown;
  }
  | TokenUsageEventBase & {
    type: 'chat-ended';
  };
