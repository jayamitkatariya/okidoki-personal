import { randomUUID } from 'crypto';
import {
  getDefaultAgentModel,
  isAgentChatTurnActivityRecord,
  isAgentChatMcpActivityRecord,
  isAgentChatSkillActivityRecord,
  LEARNED_SKILL_DIR_PREFIX,
  type AgentProvider,
  type AgentChatMcpActivityRecord,
  type AgentChatSkillActivityRecord,
  type AgentChatTurnActivityRecord,
  type DisplayMessage,
  type SendChatMessageRequest,
} from '@okidoki/shared';
import { ENGINE_ENV } from '../../../engine-env';
import { uploadAnalytics } from '../../analytics-upload';
import type { AgentChatTurnContext } from '../types';
import {
  AnalyticsRecordBuffer,
  type AnalyticsRecordBufferFlushResult,
  type AnalyticsRecordBufferOptions,
} from '../../analytics-record-buffer';
import { extractSkillMcpCalls } from './skill-mcp-call-extractor';

export interface AgentChatActivityFlushResult {
  turnActivity: AnalyticsRecordBufferFlushResult;
  skillActivity: AnalyticsRecordBufferFlushResult;
  mcpActivity: AnalyticsRecordBufferFlushResult;
}

interface PendingMessageAttributes {
  model?: string;
  senderUserId?: string;
  automationId?: string;
  environmentId?: string;
  source?: SendChatMessageRequest['source'];
}

interface ActiveAgentChatTurn extends AgentChatTurnContext {
  startedAtMs: number;
  seenCallIds: Set<string>;
}

const MAX_TRACKED_MESSAGES = 500;

class AgentChatActivityRecordTracker<T> {
  private readonly pendingRecords = new Map<string, T[]>();
  private readonly buffer: AnalyticsRecordBuffer<T>;

  constructor(options: AnalyticsRecordBufferOptions<T>) {
    this.buffer = new AnalyticsRecordBuffer(options);
  }

  track(chatId: string, record: T): void {
    const records = this.pendingRecords.get(chatId) ?? [];
    records.push(record);
    this.pendingRecords.set(chatId, records);
  }

  noteTurnEnded(chatId: string): void {
    const records = this.pendingRecords.get(chatId);
    if (!records) return;
    this.pendingRecords.delete(chatId);
    for (const record of records) this.buffer.append(record);
    this.buffer.scheduleFlush();
  }

  flush(): Promise<AnalyticsRecordBufferFlushResult> {
    return this.buffer.flush();
  }
}

class AgentChatTurnActivityTracker {
  private readonly pendingMessages = new Map<
    string,
    PendingMessageAttributes
  >();
  private readonly activeTurns = new Map<string, ActiveAgentChatTurn>();
  private readonly turnBuffer: AnalyticsRecordBuffer<AgentChatTurnActivityRecord>;

  constructor(uploadTurns: (turns: AgentChatTurnActivityRecord[]) => Promise<void>) {
    this.turnBuffer = new AnalyticsRecordBuffer({
      storageName: 'chat-turn-activity',
      legacyStorageNames: ['turn-usage'],
      validate: isAgentChatTurnActivityRecord,
      upload: uploadTurns,
      getRecordId: (turn) => turn.turnId,
    });
  }

  noteMessageAccepted(
    messageId: string,
    request: SendChatMessageRequest,
  ): void {
    this.pendingMessages.set(messageId, {
      model: request.model,
      senderUserId: request.senderUserId,
      automationId: request.automationId,
      environmentId: request.environmentId,
      source: request.source,
    });
    for (const key of this.pendingMessages.keys()) {
      if (this.pendingMessages.size <= MAX_TRACKED_MESSAGES) break;
      this.pendingMessages.delete(key);
    }
  }

  noteTurnStarted(
    chatId: string,
    messageId: string,
    provider: AgentProvider,
  ): AgentChatTurnContext {
    const attributes = this.pendingMessages.get(messageId) ?? {};
    const credential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[provider];
    this.pendingMessages.delete(messageId);
    const context: AgentChatTurnContext = {
      chatId,
      turnId: randomUUID(),
      provider,
      model: attributes.model ?? getDefaultAgentModel(provider),
      senderUserId: attributes.senderUserId,
      automationId: attributes.automationId,
      environmentId: attributes.environmentId,
      source: attributes.source,
      credentialMethod: credential?.method,
      credentialScope: credential?.scope,
    };
    this.activeTurns.set(chatId, {
      ...context,
      startedAtMs: Date.now(),
      seenCallIds: new Set(),
    });
    return context;
  }

  getActiveTurn(chatId: string): ActiveAgentChatTurn | undefined {
    return this.activeTurns.get(chatId);
  }

  getActiveChatIds(): string[] {
    return [...this.activeTurns.keys()];
  }

  noteTurnEnded(chatId: string): void {
    const turn = this.activeTurns.get(chatId);
    if (!turn) return;

    this.activeTurns.delete(chatId);
    this.turnBuffer.append({
      turnId: turn.turnId,
      chatId,
      provider: turn.provider,
      model: turn.model,
      senderUserId: turn.senderUserId,
      source: turn.source,
      credentialMethod: turn.credentialMethod,
      credentialScope: turn.credentialScope,
      occurredAt: new Date().toISOString(),
      seconds: Math.round((Date.now() - turn.startedAtMs) / 1000),
    });
    this.turnBuffer.scheduleFlush();
  }

  flush(): Promise<AnalyticsRecordBufferFlushResult> {
    return this.turnBuffer.flush();
  }
}

export class AgentChatActivityTrackerService {
  private readonly turnActivityTracker: AgentChatTurnActivityTracker;
  private readonly skillActivityTracker: AgentChatActivityRecordTracker<AgentChatSkillActivityRecord>;
  private readonly mcpActivityTracker: AgentChatActivityRecordTracker<AgentChatMcpActivityRecord>;

  constructor() {
    this.turnActivityTracker = new AgentChatTurnActivityTracker(
      (turns) => uploadAnalytics('/v1/engine/chat-turn-activity', { turns }),
    );
    this.skillActivityTracker = new AgentChatActivityRecordTracker({
      storageName: 'skill-activity',
      legacyStorageNames: ['skill-usage'],
      validate: isAgentChatSkillActivityRecord,
      upload: (skills) =>
        uploadAnalytics('/v1/engine/skill-activity', { skills }),
    });
    this.mcpActivityTracker = new AgentChatActivityRecordTracker({
      storageName: 'mcp-activity',
      legacyStorageNames: ['mcp-usage'],
      validate: isAgentChatMcpActivityRecord,
      upload: (mcps) =>
        uploadAnalytics('/v1/engine/mcp-activity', { mcps }),
    });
  }

  noteMessageAccepted(
    messageId: string,
    request: SendChatMessageRequest,
  ): void {
    this.turnActivityTracker.noteMessageAccepted(messageId, request);
  }

  noteTurnStarted(
    chatId: string,
    messageId: string,
    provider: AgentProvider,
  ): AgentChatTurnContext {
    return this.turnActivityTracker.noteTurnStarted(chatId, messageId, provider);
  }

  noteSkillMcpCalls(chatId: string, messages: readonly DisplayMessage[]): void {
    const turn = this.turnActivityTracker.getActiveTurn(chatId);
    if (!turn) return;

    for (const call of extractSkillMcpCalls(messages)) {
      // Harnesses invoke learnings by their bare frontmatter name, but read them through the prefixed directory.
      const key = call.kind !== 'skill' ? call.id
        : `skill:${call.useKind === 'invoke' && !call.skillName.startsWith(LEARNED_SKILL_DIR_PREFIX) ? LEARNED_SKILL_DIR_PREFIX : ''}${call.skillName}`;
      if (turn.seenCallIds.has(key)) continue;
      turn.seenCallIds.add(key);
      const activityRecord = {
        callId: call.id,
        chatId,
        provider: turn.provider,
        model: turn.model,
        senderUserId: turn.senderUserId,
        occurredAt: call.occurredAt,
        credentialMethod: turn.credentialMethod,
        credentialScope: turn.credentialScope,
      };
      if (call.kind === 'skill') {
        this.skillActivityTracker.track(chatId, {
          ...activityRecord,
          skillName: call.skillName,
          useKind: call.useKind,
        });
      } else {
        this.mcpActivityTracker.track(chatId, {
          ...activityRecord,
          mcpName: call.mcpName,
        });
      }
    }
  }

  noteTurnEnded(chatId: string): void {
    this.skillActivityTracker.noteTurnEnded(chatId);
    this.mcpActivityTracker.noteTurnEnded(chatId);
    this.turnActivityTracker.noteTurnEnded(chatId);
  }

  async flush(finalizeInFlight = true): Promise<AgentChatActivityFlushResult> {
    if (finalizeInFlight) {
      for (const chatId of this.turnActivityTracker.getActiveChatIds())
        this.noteTurnEnded(chatId);
    }
    const [turnActivity, skillActivity, mcpActivity] = await Promise.all([
      this.turnActivityTracker.flush(),
      this.skillActivityTracker.flush(),
      this.mcpActivityTracker.flush(),
    ]);
    return { turnActivity, skillActivity, mcpActivity };
  }
}
