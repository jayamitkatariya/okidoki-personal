import type { v2 } from '@okidoki/shared/codex-asp-types';
import { AGENT, type TokenUsageCounts, type TokenUsageUploadRecord } from '@okidoki/shared';
import {
  calculateCumulativeTokenUsageDelta,
  type AgentTokenUsageService,
  type TokenUsageBatch,
  type TokenUsageContext,
  type TokenUsageEvent,
} from '../types';
import {
  parseCodexModelReroute,
  parseCodexTurn,
  parseCodexUsageUpdate,
} from './parse';
import {
  type CodexTurn,
  type CodexUsage,
  type TrackedCodexTurn,
} from './types';

export class CodexTokenUsageAdapter {
  constructor(
    private readonly chatId: string,
    private readonly getContext: () => TokenUsageContext | undefined,
    private readonly recordEvent: (event: TokenUsageEvent) => void,
  ) {}

  readonly onTurnStarted = (threadId: string, turnId: string): void => {
    const context = this.getContext();
    if (!context) return;

    this.recordEvent({
      harness: AGENT.CODEX,
      type: 'turn-started',
      chatId: this.chatId,
      payload: { threadId, turnId },
      context,
    });
  };

  readonly onTokenUsage = (
    notification: v2.ThreadTokenUsageUpdatedNotification,
    occurredAt: string,
  ): void => {
    const context = this.getContext();
    if (!context) return;

    this.recordEvent({
      harness: AGENT.CODEX,
      type: 'usage-updated',
      chatId: this.chatId,
      payload: notification,
      context,
      occurredAt,
    });
  };

  readonly onModelRerouted = (notification: v2.ModelReroutedNotification): void => {
    if (!this.getContext()) return;

    this.recordEvent({
      harness: AGENT.CODEX,
      type: 'model-rerouted',
      chatId: this.chatId,
      payload: notification,
    });
  };

  readonly onTurnCompleted = (threadId: string, turnId: string): void => {
    this.recordEvent({
      harness: AGENT.CODEX,
      type: 'turn-completed',
      chatId: this.chatId,
      payload: { threadId, turnId },
    });
  };
}

// Codex input counts include cached and cache-write tokens; keep them inclusive until the delta is taken.
function toCumulativeCounts(usage: CodexUsage): TokenUsageCounts {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
  };
}

function getTurnKey({ threadId, turnId }: CodexTurn): string {
  return `${threadId}\u0000${turnId}`;
}

export class CodexTokenUsageService implements AgentTokenUsageService {
  private readonly turns = new Map<string, TrackedCodexTurn>();
  private readonly threadTotals = new Map<string, TokenUsageCounts>();

  record(event: TokenUsageEvent): TokenUsageBatch | undefined {
    switch (event.type) {
      case 'turn-started': {
        const turn = parseCodexTurn(event.payload);
        if (!turn) return undefined;
        const key = getTurnKey(turn);
        if (!this.turns.has(key)) {
          this.turns.set(key, { ...turn, context: event.context });
        }
        return undefined;
      }
      case 'usage-updated': {
        const update = parseCodexUsageUpdate(event.payload);
        if (!update) return undefined;
        const key = getTurnKey(update);
        const turn = this.turns.get(key) ?? {
          threadId: update.threadId,
          turnId: update.turnId,
          context: event.context,
        };
        const total = toCumulativeCounts(update.total);
        // `last` is only the latest model request, so a turn is the growth of the thread total.
        // Without a prior total (e.g. a thread resumed after an engine restart), back out this request.
        turn.baselineTotal ??= this.threadTotals.get(update.threadId)
          ?? calculateCumulativeTokenUsageDelta(total, toCumulativeCounts(update.last));
        turn.latestTotal = total;
        turn.occurredAt = event.occurredAt;
        this.threadTotals.set(update.threadId, total);
        this.turns.set(key, turn);
        return undefined;
      }
      case 'model-rerouted': {
        const reroute = parseCodexModelReroute(event.payload);
        if (!reroute) return undefined;
        const tracked = this.turns.get(getTurnKey(reroute));
        if (tracked) tracked.context = { ...tracked.context, model: reroute.model };
        return undefined;
      }
      case 'turn-completed': {
        const turn = parseCodexTurn(event.payload);
        return turn ? this.finishTurn(event.chatId, turn) : undefined;
      }
      case 'chat-ended': {
        const records: TokenUsageUploadRecord[] = [];
        for (const turn of this.turns.values()) {
          if (turn.context.chatId !== event.chatId) continue;
          const batch = this.finishTurn(event.chatId, turn);
          if (batch) records.push(...batch.records);
        }
        return records.length > 0 ? { records } : undefined;
      }
    }
  }

  private finishTurn(chatId: string, turn: CodexTurn): TokenUsageBatch | undefined {
    const key = getTurnKey(turn);
    const tracked = this.turns.get(key);
    if (!tracked || tracked.context.chatId !== chatId) return undefined;
    this.turns.delete(key);
    if (!tracked.baselineTotal || !tracked.latestTotal || !tracked.occurredAt) return undefined;

    const delta = calculateCumulativeTokenUsageDelta(tracked.latestTotal, tracked.baselineTotal);
    if (!Object.values(delta).some((count) => count > 0)) return undefined;
    return {
      records: [{
        ...tracked.context,
        harness: AGENT.CODEX,
        inputTokens: Math.max(0, delta.inputTokens - delta.cacheReadInputTokens - delta.cacheWriteInputTokens),
        outputTokens: delta.outputTokens,
        cacheReadInputTokens: delta.cacheReadInputTokens,
        cacheWriteInputTokens: delta.cacheWriteInputTokens,
        occurredAt: tracked.occurredAt,
      }],
    };
  }
}
