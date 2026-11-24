import { createHash } from 'node:crypto';
import {
  createUuidFromHex,
  isNonEmptyString,
  isRecord,
  isTokenUsageUploadRecord,
  type AgentEvent,
  TOKEN_USAGE_PATH,
} from '@okidoki/shared';
import type { AgentChatTurnContext } from '../agent/types';
import {
  AnalyticsRecordBuffer,
  type AnalyticsRecordBufferFlushResult,
} from '../analytics-record-buffer';
import { createAgentTokenUsageService } from './agent-token-usage-factory';
import type {
  AgentTokenUsageService,
  HarnessId,
  StoredTokenUsageBatch,
  TokenUsageContext,
  TokenUsageEvent,
} from './types';

export class AgentTokenUsageTracker {
  private readonly activeTurns = new Map<string, AgentChatTurnContext>();
  private readonly services = new Map<HarnessId, AgentTokenUsageService>();
  private readonly buffer: AnalyticsRecordBuffer<StoredTokenUsageBatch>;

  constructor(
    uploadAnalytics: (endpoint: string, body: unknown) => Promise<void>,
  ) {
    this.buffer = new AnalyticsRecordBuffer({
      storageName: 'chat-token-usage',
      validate: (value): value is StoredTokenUsageBatch => isRecord(value)
        && isNonEmptyString(value.harness)
        && Array.isArray(value.records)
        && value.records.every(isTokenUsageUploadRecord),
      upload: (batches) => uploadAnalytics(TOKEN_USAGE_PATH, {
        records: batches.flatMap(({ records }) => records),
      }),
      getRecordId: ({ harness, records }) => {
        const eventIds = records.flatMap((record) => (
          record.eventId ? [record.eventId] : []
        ));
        if (eventIds.length === 0 || eventIds.length !== records.length) return undefined;
        return [harness, ...eventIds].join('\u0000');
      },
      retainUploadedSegments: true,
    });

    for (const batch of this.buffer.readStoredRecords()) {
      if (batch.checkpoint !== undefined) {
        this.getService(batch.harness)?.restoreCheckpoint?.(batch.checkpoint);
      }
    }
  }

  startTurn(context: AgentChatTurnContext): void {
    this.activeTurns.set(context.chatId, context);
  }

  getTokenUsageContext(chatId: string): TokenUsageContext | undefined {
    const context = this.activeTurns.get(chatId);
    if (!context?.environmentId) return undefined;

    return {
      chatId: context.chatId,
      model: context.model,
      credentialMethod: context.credentialMethod,
      credentialScope: context.credentialScope,
      senderUserId: context.senderUserId,
      automationId: context.automationId,
      environmentId: context.environmentId,
    };
  }

  noteAgentEvent(chatId: string, event: AgentEvent): void {
    if (event.type !== 'claude-result') return;
    this.noteUsage(chatId, event.payload, event.timestamp);
  }

  noteUsage(chatId: string, payload: unknown, occurredAt: string): void {
    const context = this.activeTurns.get(chatId);
    const tokenUsageContext = this.getTokenUsageContext(chatId);
    if (!context || !tokenUsageContext) return;

    this.recordEvent({
      harness: context.provider,
      type: 'usage-updated',
      chatId,
      turnId: context.turnId,
      payload,
      context: tokenUsageContext,
      occurredAt,
    });
  }

  endTurn(chatId: string): void {
    const context = this.activeTurns.get(chatId);
    if (!context) return;

    this.recordEvent({
      harness: context.provider,
      type: 'chat-ended',
      chatId,
      turnId: context.turnId,
    });
    this.activeTurns.delete(chatId);
  }

  flush(finalizeInFlight = true): Promise<AnalyticsRecordBufferFlushResult> {
    if (finalizeInFlight) {
      for (const chatId of [...this.activeTurns.keys()]) this.endTurn(chatId);
    }
    return this.buffer.flush();
  }

  recordEvent(event: TokenUsageEvent): void {
    const batch = this.getService(event.harness)?.record(event);
    if (!batch) return;

    this.buffer.append({
      harness: event.harness,
      records: batch.records.map((record) => ({
        ...record,
        eventId: record.eventId ?? createUuidFromHex(createHash('sha256')
          .update(JSON.stringify([
            event.harness,
            event.type,
            event.chatId,
            event.turnId ?? '',
            record,
          ]))
          .digest('hex')),
      })),
      checkpoint: batch.checkpoint,
    });
    this.buffer.scheduleFlush();
  }

  private getService(harness: HarnessId): AgentTokenUsageService | undefined {
    const service = this.services.get(harness) ?? createAgentTokenUsageService(harness);
    if (service) this.services.set(harness, service);
    return service;
  }
}
