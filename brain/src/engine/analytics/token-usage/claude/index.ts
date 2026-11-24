import {
  AGENT,
  isNonEmptyString,
  isRecord,
  type TokenUsageUploadRecord,
} from '@okidoki/shared';
import {
  calculateCumulativeTokenUsageDelta,
  type AgentTokenUsageService,
  type TokenUsageBatch,
  type TokenUsageContext,
  type TokenUsageEvent,
} from '../types';
import { isClaudeModelUsage, parseClaudeRequestStart, parseClaudeResult } from './parse';
import type { ClaudeResultUsage, ClaudeTokenUsageSnapshot } from './types';

interface ClaudeTokenUsageCheckpoint {
  chatId: string;
  sessionId: string;
  snapshot: ClaudeTokenUsageSnapshot;
}

function isClaudeTokenUsageCheckpoint(
  value: unknown,
): value is ClaudeTokenUsageCheckpoint {
  return isRecord(value)
    && isNonEmptyString(value.chatId)
    && isNonEmptyString(value.sessionId)
    && isRecord(value.snapshot)
    && Object.values(value.snapshot).every(isClaudeModelUsage);
}

function normalizeClaudeTokenUsage(
  result: ClaudeResultUsage,
  previous: ClaudeTokenUsageSnapshot | undefined,
  context: TokenUsageContext,
  occurredAt: string,
): TokenUsageUploadRecord[] {
  return Object.entries(result.snapshot).flatMap(([model, currentMetrics]) => {
    const previousMetrics = previous?.[model];
    const tokenCounts = calculateCumulativeTokenUsageDelta(currentMetrics, previousMetrics);
    const providerCostUsd = currentMetrics.costUsd === undefined
      ? undefined
      : previousMetrics?.costUsd === undefined || currentMetrics.costUsd < previousMetrics.costUsd
        ? currentMetrics.costUsd
        : currentMetrics.costUsd - previousMetrics.costUsd;
    const pricingProvider = currentMetrics.pricingProvider ?? previousMetrics?.pricingProvider;

    return Object.values(tokenCounts).some((count) => count > 0)
      ? [{
          ...context,
          model,
          ...tokenCounts,
          harness: AGENT.CLAUDE,
          occurredAt,
          ...(pricingProvider ? { pricingProvider } : {}),
          ...(providerCostUsd !== undefined ? { reportedCostUsd: providerCostUsd } : {}),
        }]
      : [];
  });
}

export class ClaudeTokenUsageService implements AgentTokenUsageService {
  private readonly snapshots = new Map<string, Map<string, ClaudeTokenUsageSnapshot>>();

  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    if (event.type !== 'usage-updated') return undefined;

    const cut = parseClaudeRequestStart(event.payload);
    if (cut) {
      return { records: [{ ...event.context, model: cut.model, ...cut.usage, harness: AGENT.CLAUDE, occurredAt: event.occurredAt }] };
    }

    const result = parseClaudeResult(event.payload);
    if (!result) return undefined;

    const snapshotsBySession = this.snapshots.get(event.chatId) ?? new Map();
    this.snapshots.set(event.chatId, snapshotsBySession);
    const previous = snapshotsBySession.get(result.sessionId);
    const records = normalizeClaudeTokenUsage(
      result,
      previous,
      event.context,
      event.occurredAt,
    );
    snapshotsBySession.set(result.sessionId, result.snapshot);
    return {
      records,
      checkpoint: {
        chatId: event.chatId,
        sessionId: result.sessionId,
        snapshot: result.snapshot,
      },
    };
  }

  restoreCheckpoint(value: unknown): void {
    if (!isClaudeTokenUsageCheckpoint(value)) return;

    const snapshotsBySession = this.snapshots.get(value.chatId) ?? new Map();
    snapshotsBySession.set(value.sessionId, value.snapshot);
    this.snapshots.set(value.chatId, snapshotsBySession);
  }
}
