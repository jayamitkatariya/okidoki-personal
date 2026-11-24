import type {
  AgentEvent,
  ChatHistoryPageParams,
  ChatHistoryResponse,
  ContextUsagePayload,
  InterruptChatResponse,
  LinearThoughtEvent,
  QueuedMessageInfo,
  QueueMutationResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
} from '@okidoki/shared';
import { HISTORY_INDEX_FILENAME, HISTORY_ROOT, LEARNED_SKILLS_MANIFEST_PATH, OKIDOKI_INSTRUCTIONS_TAG, START_HOOKS_RUNNING_PROMPT, SUBAGENT_MCP_HARNESSES, TIMEOUT, buildOkidokiInstructions, isClientMessageSource, raceWithTimeout, splitTurnInstructions, wrapInTag } from '@okidoki/shared';
import type {
  AgentCredentialSnapshot,
  AgentFallbackReason,
  AgentProvider,
  GetSubagentMcpConfigResponse,
} from '@okidoki/shared';
import { AGENT_QUOTA_EXHAUSTED_EVENT_TYPE, CHAT_INTERRUPTED_EVENT_TYPE, CONTEXT_USAGE_EVENT_TYPE, REPLACED_MESSAGE_ID_PAYLOAD_KEY, USER_MESSAGE_ID_PAYLOAD_KEY, type AgentQuotaExhaustedPayload, type ChatInterruptedPayload } from '@okidoki/shared';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CodingAgentProvider } from './coding-agent-provider';
import { AuthFallbackCoordinator, type AuthFallbackResult, type FallbackContext } from './auth-fallback';
import {
  MessageQueueService,
  type MessageAcceptedHandler,
  type MessageStartedHandler,
  type QueuedMessage,
} from '../services/message-queue-service';
import { okidokiConfigService } from '../services/okidoki-config-service';
import { monolithService } from '../services/monolith-service';
import { localControlComputers } from '../services/device-service';
import { ENGINE_ENV } from '../engine-env';
import { AsyncLock } from '../utils/async-lock';
import type { CodexHistoryFile } from './codex-asp/codex-history-file';

const MAX_INTERRUPT_QUEUE_ITEMS = 1000;
const MAX_INTERRUPT_QUEUE_CHARS = 200_000;
// A Stop request arrives well within 10s, so an older stamp means the client misjudged the engine's clock.
const MAX_REQUESTED_STOP_AGE_MS = 10_000;
// A new Claude Code process took up to 4 s to start a prompt in local runs, and the web gives up on a Send now after 60 s.
const PROMPT_START_WAIT_MS = 10_000;

function toQueuedMessageInfo(message: QueuedMessage): QueuedMessageInfo {
  return {
    id: message.id,
    message: message.message,
    queuedAt: message.queuedAt,
    ...(message.senderUserId ? { senderUserId: message.senderUserId } : {}),
    ...(message.senderEmail ? { senderEmail: message.senderEmail } : {}),
    ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
  };
}

let subagentMcpConfigRequest: Promise<GetSubagentMcpConfigResponse | null> | null = null;

export interface CodingAgentManagerOptions {
  workingDirectory?: string;
  initialSessionId: string | null;
  onSaveSessionId: (sessionId: string | null) => Promise<void>;
  /** The chat's log, for reads. Every write goes through `record`. */
  history: CodexHistoryFile;
  record: (event: AgentEvent) => void;
  /** Live only: streaming partials and other events that are never written. */
  onEvent: (event: AgentEvent) => void;
  /** `undeliveredMessageId` is the message of a turn a Stop took before the agent was known to have it; whether it was handed back is settled when that Stop returns. */
  onTurnComplete: (undeliveredMessageId?: string) => Promise<void>;
  onProcessingChanged?: (processing: boolean) => void;
  onMessageStarted?: MessageStartedHandler;
  onMessageRequeued?: (message: QueuedMessage, afterMessageId: string) => void;
  onQueueChanged?: () => void;
  onUsageUpdate?: (payload: unknown, occurredAt: string) => void;
  provider?: AgentProvider;
  /** Null for top-level chats, which may load the subagent MCP; subagents never do, so they cannot nest. */
  parentChatId: string | null;
  fallbackContext?: () => FallbackContext;
  chatId?: string;
  /** Subagents and forks act for the chat they came from, so the monolith scopes their Slack writes the same way. */
  originChatId?: string;
  chatTitle?: () => string;
  onModelSwitched?: (model: string) => Promise<void>;
  onChatCredential?: (credential: AgentCredentialSnapshot | 'workspace') => void;
  lastSenderKey?: string;
  onLastSenderKeyChanged?: (senderKey: string | null) => Promise<void>;
  previousTurnLost?: boolean;
}

export function takesTurnNotes(request: Pick<SendChatMessageRequest, 'goalMode' | 'message'>): boolean {
  return !request.goalMode && !request.message.trimStart().startsWith('/');
}

export abstract class CodingAgentManager implements CodingAgentProvider {
  protected workingDirectory: string;
  protected messageQueue!: MessageQueueService;
  protected initialized!: Promise<void>;
  protected readonly initialSessionId: string | null;
  protected readonly onSaveSessionId: (sessionId: string | null) => Promise<void>;
  protected readonly historyFile: CodexHistoryFile;
  protected readonly record: (event: AgentEvent) => void;
  protected readonly onEvent: (event: AgentEvent) => void;
  protected readonly onUsageUpdate: (payload: unknown, occurredAt: string) => void;
  private readonly topLevel: boolean;
  protected readonly chatId?: string;
  protected readonly originChatId?: string;
  protected readonly chatTitle?: () => string;
  private readonly hostOnTurnComplete: (undeliveredMessageId?: string) => Promise<void>;
  protected readonly onProcessingChanged: (processing: boolean) => void;
  private readonly onMessageStarted: MessageStartedHandler;
  private readonly onMessageRequeued: (message: QueuedMessage, afterMessageId: string) => void;
  private readonly onQueueChanged: () => void;
  private readonly onModelSwitched: (model: string) => Promise<void>;
  private readonly authFallback: AuthFallbackCoordinator | null;
  private readonly subagentMcpChatId?: string;
  private readonly checksSubagentConfig: boolean;
  private subagentMcpEnabledForTurn = false;
  private nativeSubagentsDisabledForTurn = false;
  private readonly autoCompactProvider: AgentProvider | null;
  protected autoCompactTokens: number | null = null;
  private readonly unreadSteers = new Map<string, { message: QueuedMessage; delivered: QueuedMessage; steeredAt: string }>();
  // A harness can read a steer before steerRequest returns, so a read is noted here until the steer settles.
  private readonly steersInFlight = new Map<string, { message: QueuedMessage; delivered: QueuedMessage; read: boolean }>();
  private readonly steerSettlements = new Set<Promise<unknown>>();
  private readonly earlySteers: QueuedMessage[] = [];
  private readonly withdrawnSteers = new WeakSet<QueuedMessage>();
  // The agent can still read a steer while a Stop that took it waits on the agent.
  private readonly steersBeingStopped = new Map<string, QueuedMessage>();
  private readonly earlySteerDelivery = new AsyncLock();
  protected turnMessage: QueuedMessage | null = null;
  // The chat places a message and times its turn by the harness's record of it, which is written only once the agent has the message, so that record keeps this time.
  protected turnBeganAt: string | undefined;
  // As it was sent, for a harness that keeps the message for its next turn: a Stop before then hands this back.
  protected turnRequest: QueuedMessage | undefined;
  private readonly harnessTurns = new WeakSet<AbortSignal>();
  // What a message's notes took as read, so they are owed again when the agent never got the message.
  private readonly turnNotes = new WeakMap<QueuedMessage, { turnLost: boolean; sentTurn: boolean; customInstructions: string | undefined }>();
  protected readonly reportsPromptStart: boolean = false;
  // A Send now waits for the turn's prompt to start, as an earlier cut cuts nothing; a command's turn has none, so it is never cut as it begins.
  private promptStart: PromiseWithResolvers<void> | null = null;
  private lastSenderKey: string | null;
  // Unset until this process sends a turn, so a restart can't mistake the first one for a change.
  private sentTurn = false;
  private lastCustomInstructions: string | undefined;
  private previousTurnLost: boolean;
  private readonly restoredMessages = new WeakSet<QueuedMessage>();
  private readonly onLastSenderKeyChanged: (senderKey: string | null) => Promise<void>;

  constructor(options: CodingAgentManagerOptions) {
    this.workingDirectory = options.workingDirectory ?? ENGINE_ENV.WORKSPACE_ROOT;
    this.initialSessionId = options.initialSessionId;
    this.onSaveSessionId = async (sessionId) => {
      if (!sessionId) await this.saveLastSenderKey(null);
      await options.onSaveSessionId(sessionId);
    };
    this.historyFile = options.history;
    this.record = options.record;
    this.onEvent = options.onEvent;
    this.onUsageUpdate = options.onUsageUpdate ?? (() => {});
    this.subagentMcpChatId = options.parentChatId === null && options.provider && SUBAGENT_MCP_HARNESSES.includes(options.provider)
      ? options.chatId
      : undefined;
    this.checksSubagentConfig = Boolean(this.subagentMcpChatId) || (options.parentChatId === null && options.provider === 'opencode');
    this.autoCompactProvider = options.provider === 'claude' || options.provider === 'codex' ? options.provider : null;
    this.topLevel = options.parentChatId === null;
    this.chatId = options.chatId;
    this.originChatId = options.originChatId;
    this.chatTitle = options.chatTitle;
    this.hostOnTurnComplete = options.onTurnComplete;
    this.onProcessingChanged = options.onProcessingChanged ?? (() => {});
    this.onMessageStarted = options.onMessageStarted ?? (async () => {});
    this.onMessageRequeued = options.onMessageRequeued ?? (() => {});
    this.onQueueChanged = options.onQueueChanged ?? (() => {});
    this.onModelSwitched = options.onModelSwitched ?? (async () => {});
    this.lastSenderKey = options.lastSenderKey ?? null;
    this.previousTurnLost = options.previousTurnLost ?? false;
    this.onLastSenderKeyChanged = options.onLastSenderKeyChanged ?? (async () => {});
    this.authFallback = options.provider
      ? new AuthFallbackCoordinator(options.provider, this.record, options.fallbackContext ?? (() => ({ excludeProviders: [], forkable: false })))
      : null;
  }

  protected async fallBackCredential(
    reason: AgentFallbackReason,
    detail: string,
    attempted?: AgentCredentialSnapshot,
    resetsAt?: string,
    afterLimit = false,
  ): Promise<AuthFallbackResult> {
    if (!this.authFallback) return { outcome: 'unavailable' };
    const result = await this.authFallback.fallBack(reason, detail, attempted, resetsAt, afterLimit);
    if (result.outcome === 'switched' && result.model) await this.onModelSwitched(result.model);
    return result;
  }

  protected readonly onTurnComplete = async (undeliveredMessageId?: string): Promise<void> => {
    const stopped = this.messageQueue.stoppedTurn();
    this.requeueUnreadSteers();
    await this.hostOnTurnComplete(undeliveredMessageId ?? (stopped?.delivered === false ? stopped.message.id : undefined));
  };

  protected emitSyntheticEvent(type: string, payload: Record<string, unknown>): void {
    this.onEvent({
      timestamp: new Date().toISOString(),
      type,
      payload,
    });
  }

  protected emitQuotaExhausted(payload: AgentQuotaExhaustedPayload): void {
    this.emitSyntheticEvent(AGENT_QUOTA_EXHAUSTED_EVENT_TYPE, { ...payload });
  }

  protected recordHistoryEvent(type: string, payload: unknown, timestamp = new Date().toISOString()): void {
    const eventPayload: Record<string, unknown> = {};
    if (payload && typeof payload === 'object') {
      Object.assign(eventPayload, payload);
    } else {
      eventPayload.value = payload;
    }
    const event: AgentEvent = {
      timestamp,
      type,
      payload: eventPayload,
    };
    this.record(event);
  }

  protected recordUserMessageHistoryEvent(request: SendChatMessageRequest, extraPayload: Record<string, unknown> = {}, timestamp?: string): void {
    this.recordHistoryEvent('event_msg', this.createUserMessageHistoryPayload(request, extraPayload), timestamp);
  }

  protected createUserMessageHistoryPayload(
    request: SendChatMessageRequest,
    extraPayload: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: 'user_message',
      message: request.message,
      ...extraPayload,
      ...(request.messageId ? { [USER_MESSAGE_ID_PAYLOAD_KEY]: request.messageId } : {}),
      ...(request.replacesMessageId ? { [REPLACED_MESSAGE_ID_PAYLOAD_KEY]: request.replacesMessageId } : {}),
    };
  }

  protected initializeManager(processMessage: (request: QueuedMessage, signal: AbortSignal) => Promise<void>): void {
    this.messageQueue = new MessageQueueService(
      async (request, signal) => {
        this.openTurn(request);
        this.turnRequest = request;
        try {
          await Promise.all([this.refreshSubagentMcp(), this.refreshAutoCompactTokens()]);
          const { request: delivered, senderKey } = this.withSenderLine(request);
          const stopped = signal.aborted;
          if (!stopped) this.harnessTurns.add(signal);
          if (stopped && (request.engineTurn || this.isStopped(signal) || this.isRequeued(signal) || !await this.keepStoppedRequest(delivered, signal))) return;
          await this.saveLastSenderKey(senderKey);
          if (stopped) return;
          const takesNotes = takesTurnNotes(request);
          const { customInstructions: standardInstructions, turnInstructions } = splitTurnInstructions(request.customInstructions);
          // What holds for this turn alone rides in its message: in the system prompt it would change the prompt between turns and rewrite the chat's prompt cache.
          const turnFacts = [
            ...(okidokiConfigService.areHooksRunning() && (okidokiConfigService.getStartHookConfig()?.commands.length ?? 0) > 0 ? [START_HOOKS_RUNNING_PROMPT] : []),
            ...(turnInstructions ? [turnInstructions] : []),
          ];
          const turnLost = takesNotes && this.previousTurnLost;
          this.turnNotes.set(request, { turnLost, sentTurn: this.sentTurn, customInstructions: this.lastCustomInstructions });
          // Earlier turns that followed the old instructions read as mistakes, so without this the agent goes back to redo them.
          const instructionsChanged = takesNotes && this.sentTurn && this.lastCustomInstructions !== standardInstructions;
          this.sentTurn = true;
          this.lastCustomInstructions = standardInstructions;
          if (turnLost) this.previousTurnLost = false;
          const notes = takesNotes ? [
            ...(turnLost ? [`A workspace restart cut your previous turn off, and it was not retried. The working tree may hold partial work from it.${this.restoredMessages.has(request) ? ' This message was sent before the restart.' : ''}`] : []),
            ...(instructionsChanged ? ['Your instructions changed since your previous turn. Earlier turns followed the old version: follow the current instructions from here on, and leave earlier replies as they are.'] : []),
            ...turnFacts,
          ].map((note) => wrapInTag(note, OKIDOKI_INSTRUCTIONS_TAG)) : [];
          this.turnBeganAt = new Date().toISOString();
          await processMessage({
            ...delivered,
            // A goal or a slash command is sent as written, so what its turn needs to know goes in the system prompt.
            customInstructions: takesNotes ? standardInstructions : [standardInstructions, ...turnFacts].filter(Boolean).join('\n\n') || undefined,
            message: [delivered.message, ...notes].join('\n\n'),
          }, signal);
        } finally {
          // A steer still being sent goes back to the front of the queue if its turn ends first, so nothing behind it starts until it settles, unless a Stop or a send-now takes over.
          const cut = new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          while (!signal.aborted && this.steerSettlements.size > 0) await Promise.race([Promise.allSettled(this.steerSettlements), cut]);
          this.closeTurn();
        }
      },
      this.onProcessingChanged,
      // Opened before the turn-start event persists, since a follow-up can arrive while it does.
      async (message) => {
        this.openTurn(message);
        try {
          await this.onMessageStarted(message);
        } catch (error) {
          this.closeTurn();
          throw error;
        }
      },
      this.onQueueChanged,
    );
    this.initialized = this.initialize();
  }

  protected async initialize(): Promise<void> {}

  protected async keepStoppedRequest(_request: SendChatMessageRequest, _signal: AbortSignal): Promise<boolean> {
    return false;
  }

  protected takeKeptRequests(): { sent: Promise<QueuedMessage[]>; putBack: () => void } {
    return { sent: Promise.resolve([]), putBack: () => {} };
  }

  /** Whether this message's turn takes along a message the agent was not given. When it cannot, that message runs again after it. */
  protected carriesKeptRequests(_request: Pick<SendChatMessageRequest, 'goalMode' | 'message'>): boolean {
    return false;
  }

  private oweNotes(message: QueuedMessage): void {
    const notes = this.turnNotes.get(message);
    if (!notes) return;
    if (notes.turnLost) this.previousTurnLost = true;
    this.sentTurn = notes.sentTurn;
    this.lastCustomInstructions = notes.customInstructions;
  }

  protected isStopped(signal?: AbortSignal): boolean {
    return !!signal && this.messageQueue.isStopped(signal);
  }

  /** Its message runs again after the one that cut it, so nothing of this turn is kept or written to the chat. */
  protected isRequeued(signal?: AbortSignal): boolean {
    return !!signal && this.messageQueue.isRequeued(signal);
  }

  // A harness calls this with nothing awaited before it hands the message over, or a Stop in between would still send a withdrawn message.
  protected deliver(signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    this.messageQueue.markDelivered();
    return true;
  }

  /** For a harness that only learns afterwards whether it read a message sent just before a Stop. */
  protected async readStoppedMessage(_signal: AbortSignal): Promise<boolean> {
    return false;
  }

  // Integration turns (Slack, GitHub, Linear) carry no sender fields and name their sender in the text, so they reset the key.
  private withSenderLine<T extends SendChatMessageRequest>(request: T): { request: T; senderKey: string | null } {
    if (!takesTurnNotes(request)) return { request, senderKey: this.lastSenderKey };
    if (!request.senderUserId || !request.senderEmail) return { request, senderKey: null };
    const via = request.source && !isClientMessageSource(request.source) ? request.source : undefined;
    const senderKey = `${request.senderUserId}:${via ?? ''}`;
    if (senderKey === this.lastSenderKey) return { request, senderKey };
    const name = request.senderDisplayName && request.senderDisplayName !== request.senderEmail
      ? `${request.senderDisplayName} (${request.senderEmail})`
      : request.senderEmail;
    const line = wrapInTag(`From ${name}${via ? ` via ${via}` : ''}.`, OKIDOKI_INSTRUCTIONS_TAG);
    return { request: { ...request, message: `${line}\n\n${request.message}` }, senderKey };
  }

  private async saveLastSenderKey(senderKey: string | null): Promise<void> {
    if (senderKey === this.lastSenderKey) return;
    this.lastSenderKey = senderKey;
    await this.onLastSenderKeyChanged(senderKey);
  }

  /** The workspace preference is resolved per turn so a change applies to the next turn; failures keep the last value. */
  private async refreshSubagentMcp(): Promise<void> {
    if (!this.checksSubagentConfig || !ENGINE_ENV.OKIDOKI_WORKSPACE_ID) return;
    subagentMcpConfigRequest ??= monolithService.getSubagentMcpConfig().finally(() => {
      subagentMcpConfigRequest = null;
    });
    const config = await subagentMcpConfigRequest;
    if (config) {
      this.subagentMcpEnabledForTurn = this.subagentMcpChatId && !config.disable_native
        ? await this.subagentMcpForTurn(config.enabled)
        : false;
      this.nativeSubagentsDisabledForTurn = Boolean(config.disable_native);
    }
  }

  private async refreshAutoCompactTokens(): Promise<void> {
    if (!this.autoCompactProvider) return;
    const config = await monolithService.getAutoCompactConfig(this.autoCompactProvider);
    if (config) this.autoCompactTokens = config.tokens;
  }

  /** Harnesses that fix their tool set per session override this to keep a session's original mode. */
  protected async subagentMcpForTurn(enabled: boolean): Promise<boolean> {
    return enabled;
  }

  protected subagentMcpParentChatId(): string | undefined {
    return this.subagentMcpEnabledForTurn ? this.subagentMcpChatId : undefined;
  }

  protected nativeSubagentsDisabled(): boolean {
    return this.nativeSubagentsDisabledForTurn || Boolean(this.subagentMcpParentChatId());
  }

  protected abstract interruptActiveTurn(stoppedAt?: string): Promise<void>;

  async interrupt(persistRemoval: (messageIds: string[]) => Promise<void>, requestedStoppedAt?: string): Promise<InterruptChatResponse> {
    // Tearing the turn down can take seconds; "You stopped after" reports when Stop was pressed, as the client saw it when it says.
    const now = Date.now();
    const requested = requestedStoppedAt ? Date.parse(requestedStoppedAt) : NaN;
    const stoppedAt = new Date(requested <= now && requested > now - MAX_REQUESTED_STOP_AGE_MS ? requested : now).toISOString();
    const queuedMessages = this.messageQueue.drainQueue();
    let unreadSteers = [...this.unreadSteers.values()];
    // A steer still being sent is in neither list, so it is taken here or it would run as a new turn after the stop.
    let steersInFlight = [...this.steersInFlight.values()].filter(({ read }) => !read);
    for (const { message } of steersInFlight) this.steersInFlight.delete(message.id);
    const earlySteers = this.earlySteers.splice(0);
    for (const steer of [...earlySteers, ...steersInFlight.map(({ delivered }) => delivered)]) this.withdrawnSteers.add(steer);
    this.unreadSteers.clear();
    this.onQueueChanged();
    // A turn an earlier Stop took before the agent had its message is still unwinding, with nothing running for this Stop to interrupt.
    const alreadyWithdrawn = this.messageQueue.stoppedTurn()?.delivered === false;
    const turn = this.messageQueue.cancelActiveTurn(true);
    // Taken before anything is awaited, so no later turn sends them as well.
    const kept = this.takeKeptRequests();
    // Provider-specific activity (Claude wake-up turns, background tasks) is stopped even when no queued turn is running.
    const isProcessing = this.isProcessing() || (this.hasActiveBackgroundTasks?.() ?? false);

    for (const { message, delivered } of [...unreadSteers, ...steersInFlight]) this.steersBeingStopped.set(message.id, delivered);
    let failure: { error: unknown } | null = null;
    if (isProcessing) {
      try {
        await this.interruptActiveTurn(stoppedAt);
      } catch (error) {
        failure = { error };
      }
    }

    let keptRequests: QueuedMessage[];
    let withdrawn: QueuedMessage[];
    try {
      keptRequests = await kept.sent;
      withdrawn = turn && !turn.message.engineTurn && !turn.delivered && !await this.readStoppedMessage(turn.controller.signal) ? [turn.message] : [];
    } finally {
      // Also when this Stop throws: one left behind would answer a later read in place of the queue.
      unreadSteers = unreadSteers.filter(({ message }) => this.steersBeingStopped.delete(message.id));
      steersInFlight = steersInFlight.filter(({ message }) => this.steersBeingStopped.delete(message.id));
    }
    if (failure && withdrawn.length === 0) {
      kept.putBack();
      for (const steer of unreadSteers) this.unreadSteers.set(steer.message.id, steer);
      // A steer still being sent can reach the agent yet, so it waits as an unread one: read, or run again when the turn ends.
      for (const { message, delivered } of steersInFlight) {
        this.withdrawnSteers.delete(delivered);
        this.unreadSteers.set(message.id, { message, delivered, steeredAt: stoppedAt });
      }
      for (const steer of earlySteers) this.withdrawnSteers.delete(steer);
      this.earlySteers.push(...earlySteers);
      this.onQueueChanged();
      this.restoreQueuedMessages(queuedMessages.map((message) => ({ message, index: 0 })));
      throw failure.error;
    }
    // The agent never had the turn's message, so it can no longer run and goes back even though the interrupt failed.
    if (failure) console.error('[CodingAgentManager] Interrupt failed for a message the agent never received:', failure.error);

    // What a withdrawn message carried goes back with it; a message the agent did get took them along.
    const handedBack = [...(withdrawn.length > 0 || !turn ? keptRequests : []), ...withdrawn];
    const removed = [...handedBack, ...[...unreadSteers, ...steersInFlight].map(({ message }) => message), ...queuedMessages];
    if (removed.length > 0) await persistRemoval(removed.map(({ id }) => id));
    if (handedBack.length > 0) {
      // The agent never read these messages' sender line or notes, so the next message carries them again.
      await this.saveLastSenderKey(null);
      for (const message of [...handedBack].reverse()) this.oweNotes(message);
    }
    // A turn stopped before its harness code ran has nobody to report its end, and the monolith would go on showing the chat as working.
    if (turn && withdrawn.length > 0 && !this.harnessTurns.has(turn.controller.signal)) await this.onTurnComplete(turn.message.id);
    const interrupted = isProcessing && withdrawn.length === 0 && !alreadyWithdrawn;
    if (interrupted) this.recordInterrupted(stoppedAt);

    const queue: string[] = [];
    const queueSenderUserIds: (string | null)[] = [];
    let queueChars = 0;
    for (const { message, senderUserId } of removed) {
      if (queue.length >= MAX_INTERRUPT_QUEUE_ITEMS || queueChars + message.length > MAX_INTERRUPT_QUEUE_CHARS) break;
      queue.push(message);
      queueSenderUserIds.push(senderUserId ?? null);
      queueChars += message.length;
    }
    this.emitInterruptedQueueEvent(queue);

    return {
      interrupted: interrupted || (withdrawn.length === 0 && removed.length > 0),
      queue,
      queueSenderUserIds,
      removedMessageIds: removed.map(({ id }) => id),
    };
  }

  protected recordInterrupted(timestamp: string, steered = false): void {
    const event: AgentEvent = {
      timestamp,
      type: CHAT_INTERRUPTED_EVENT_TYPE,
      payload: (steered ? { steered: true } : {}) satisfies ChatInterruptedPayload,
    };
    this.record(event);
  }

  abstract getHistory(page?: ChatHistoryPageParams): Promise<ChatHistoryResponse>;

  isProcessing(): boolean {
    return this.messageQueue.isProcessing();
  }

  hasActiveBackgroundTasks?(): boolean;

  // A steer still in flight either reaches the agent or goes back on the queue, so it is read once it settles.
  private async steersSettled(): Promise<void> {
    while (this.steerSettlements.size > 0) await Promise.allSettled(this.steerSettlements);
  }

  async queuedRequests(): Promise<QueuedMessage[]> {
    await this.steersSettled();
    return [...[...this.unreadSteers.values()].map(({ message }) => message), ...this.messageQueue.getQueue()];
  }

  getQueue(): QueuedMessageInfo[] {
    return [
      ...[...this.unreadSteers.values()].map(({ message, steeredAt }) => ({ ...toQueuedMessageInfo(message), steeredAt })),
      ...[...this.steersInFlight.values()].filter(({ read }) => !read).map(({ message }) => toQueuedMessageInfo(message)),
      ...this.messageQueue.getQueue().map(toQueuedMessageInfo),
    ];
  }

  async removeFromQueue(messageId: string, persistRemoval: () => Promise<void>): Promise<boolean> {
    return this.removeQueuedMessages([messageId], persistRemoval);
  }

  async clearQueue(persistRemoval: (messageIds: string[]) => Promise<void>): Promise<boolean> {
    const messageIds = this.messageQueue.getQueue().map(({ id }) => id);
    return this.removeQueuedMessages(messageIds, () => persistRemoval(messageIds));
  }

  private async removeQueuedMessages(messageIds: string[], persistRemoval: () => Promise<void>): Promise<boolean> {
    const taken = messageIds.flatMap((messageId) => {
      const item = this.messageQueue.takeFromQueue(messageId);
      return item ? [item] : [];
    });
    if (taken.length === 0) return false;
    try {
      await persistRemoval();
      return true;
    } catch (error) {
      this.restoreQueuedMessages(taken);
      throw error;
    }
  }

  private restoreQueuedMessages(taken: Array<{ message: QueuedMessage; index: number }>): void {
    for (let index = taken.length - 1; index >= 0; index--) {
      this.messageQueue.restoreToQueue(taken[index].message, taken[index].index);
    }
    this.messageQueue.resumeIfIdle();
  }

  updateQueuedMessage(messageId: string, message: string): boolean {
    return this.messageQueue.updateQueuedMessage(messageId, message);
  }

  reorderQueue(messageId: string, newPosition: number): boolean {
    return this.messageQueue.reorderQueue(messageId, newPosition);
  }

  restoreQueue(messages: QueuedMessage[]): void {
    for (const message of messages) this.restoredMessages.add(message);
    this.messageQueue.restore(messages);
    void this.initialized.then(() => this.messageQueue.resumeIfIdle());
  }

  async enqueueMessage(
    request: SendChatMessageRequest,
    onAccepted?: MessageAcceptedHandler,
  ): Promise<SendChatMessageResponse> {
    await this.initialized;
    return this.messageQueue.enqueue(request, onAccepted);
  }

  // Take the message off the queue before steering: a turn completing mid-steer could otherwise pop it too.
  async steerFromQueue(messageId: string): Promise<QueueMutationResponse> {
    const steer = this.steerQueued(messageId);
    this.steerSettlements.add(steer);
    try {
      return await steer;
    } finally {
      this.steerSettlements.delete(steer);
    }
  }

  private async steerQueued(messageId: string): Promise<QueueMutationResponse> {
    await this.initialized;
    const taken = this.messageQueue.takeFromQueue(messageId);
    if (!taken) {
      return { success: false, queue: this.getQueue() };
    }
    let steered = false;
    const { request: withSender, senderKey } = this.withSenderLine(taken.message);
    // The chat folds a turn's work, so a reply to a steer is hidden unless the agent's last message repeats it.
    const note = wrapInTag('You received this message while working. The chat folds everything before your last message of this turn, so that message must answer it too, even if you already did earlier.', OKIDOKI_INSTRUCTIONS_TAG);
    const command = !takesTurnNotes(withSender);
    const { turnInstructions } = splitTurnInstructions(withSender.customInstructions);
    const delivered = command ? withSender : { ...withSender, message: [withSender.message, note, ...(turnInstructions ? [wrapInTag(turnInstructions, OKIDOKI_INSTRUCTIONS_TAG)] : [])].join('\n\n') };
    const inFlight = { message: taken.message, delivered, read: false };
    this.steersInFlight.set(messageId, inFlight);
    try {
      steered = this.earlySteers.length === 0 && await this.steerRequest(delivered);
      if (!steered && !inFlight.read && this.turnMessage && !command && this.steersInFlight.has(messageId) && this.steerRequest !== CodingAgentManager.prototype.steerRequest) {
        this.earlySteers.push(delivered);
        steered = true;
        void this.deliverEarlySteers();
      }
      if (steered || inFlight.read) await this.saveLastSenderKey(senderKey);
    } catch (error) {
      // An unexpected throw (e.g. image I/O) must not lose the already-dequeued message.
      console.error('[CodingAgentManager] steerRequest threw, keeping message queued:', error);
    }
    // A stop that arrived while the steer was being sent took the message and hands it back itself.
    if (!this.steersInFlight.delete(messageId)) return { success: false, queue: this.getQueue() };
    if (inFlight.read) return { success: true, queue: this.getQueue() };
    if (steered) {
      this.unreadSteers.set(messageId, { message: taken.message, delivered, steeredAt: new Date().toISOString() });
      this.onQueueChanged();
    } else {
      this.restoreQueuedMessages([{ message: taken.message, index: 0 }]);
    }
    return { success: steered, queue: this.getQueue() };
  }

  async sendNow(messageId: string): Promise<QueueMutationResponse> {
    await this.initialized;
    await this.steersSettled();
    const queued = this.messageQueue.getQueue().some(({ id }) => id === messageId);
    if (!queued && !this.unreadSteers.has(messageId)) return { success: false, queue: this.getQueue() };

    // A steer reaches the agent at its next step, so stopping the step would only cut off the tool call in flight.
    if (this.messageQueue.isProcessing() && (!queued || (await this.steerFromQueue(messageId)).success)) {
      const start = this.unreadSteers.has(messageId) && !this.canDeliverSteersNow() ? this.promptStart : null;
      if (start && await raceWithTimeout(start.promise, PROMPT_START_WAIT_MS) === TIMEOUT) return { success: false, queue: this.getQueue() };
      const delivered = !this.unreadSteers.has(messageId) || !this.canDeliverSteersNow() || await this.deliverSteersNow();
      return { success: delivered, queue: this.getQueue() };
    }

    this.requeueUnreadSteers();
    // A turn that ended mid-steer can already have started this message.
    const taken = this.messageQueue.takeFromQueue(messageId);
    if (!taken) return { success: true, queue: this.getQueue() };
    this.messageQueue.restoreToQueue(taken.message, 0);
    // A turn a Stop took is already ending: there is nothing left to cut, and this message starts once it has.
    const cut = !this.messageQueue.isProcessing() || !!this.messageQueue.stoppedTurn() || await this.cutTurnForMessage(taken.message);
    return { success: cut, queue: this.getQueue() };
  }

  protected async cutTurnForMessage(message: QueuedMessage): Promise<boolean> {
    // A message the agent has not been given runs again after this one when this one cannot carry it: nothing was stopped, and its sender line was never read.
    const requeued = this.carriesKeptRequests(message) ? null : this.messageQueue.requeueActiveTurnAfter(message.id);
    if (requeued) {
      this.oweNotes(requeued.message);
      this.onMessageRequeued(requeued.message, requeued.afterId);
    } else {
      this.recordInterrupted(new Date().toISOString(), true);
    }
    this.messageQueue.cancelActiveTurn();
    // The interrupt goes out before anything is awaited, or the turn could end and it would stop the next one.
    await Promise.all([this.interruptActiveTurn(), requeued && this.saveLastSenderKey(null)]);
    return true;
  }

  private openTurn(message: QueuedMessage): void {
    this.turnMessage = message;
    if (this.reportsPromptStart && takesTurnNotes(message)) this.promptStart ??= Promise.withResolvers();
  }

  private closeTurn(): void {
    this.turnMessage = null;
    this.settlePromptStart();
    if (this.earlySteers.length > 0) this.requeueUnreadSteers();
  }

  private requeueUnreadSteers(): void {
    const steers = [...this.unreadSteers.values()].map(({ message }) => message);
    this.unreadSteers.clear();
    for (const steer of this.earlySteers.splice(0)) this.withdrawnSteers.add(steer);
    this.onQueueChanged();
    this.restoreQueuedMessages(steers.map((message) => ({ message, index: 0 })));
    // The agent never read these steers' sender lines.
    if (steers.length > 0) {
      this.saveLastSenderKey(null).catch((error) => {
        console.error('[CodingAgentManager] Failed to reset last sender:', error);
      });
    }
  }

  protected markSteerRead(messageId: string): QueuedMessage | undefined {
    const steer = this.unreadSteers.get(messageId);
    if (this.unreadSteers.delete(messageId)) this.onQueueChanged();
    const inFlight = this.steersInFlight.get(messageId);
    if (inFlight && !inFlight.read) {
      inFlight.read = true;
      this.onQueueChanged();
    }
    const beingStopped = this.steersBeingStopped.get(messageId);
    this.steersBeingStopped.delete(messageId);
    return steer?.delivered ?? inFlight?.delivered ?? beingStopped ?? this.messageQueue.takeFromQueue(messageId)?.message;
  }

  protected settlePromptStart(): void {
    this.promptStart?.resolve();
    this.promptStart = null;
  }

  protected canDeliverSteersNow(): boolean {
    return false;
  }

  protected deliverSteersNow(): Promise<boolean> {
    return Promise.resolve(true);
  }

  protected steerRequest(_request: QueuedMessage): Promise<boolean> {
    return Promise.resolve(false);
  }

  // A held steer withdrawn by a stop or a turn ending must not reach a later turn, even mid-request.
  protected isSteerWithdrawn(request: QueuedMessage): boolean {
    return this.withdrawnSteers.has(request);
  }

  protected deliverEarlySteers(): Promise<void> {
    return this.earlySteerDelivery.run(async () => {
      for (let next = this.earlySteers[0]; next && await this.steerRequest(next).catch(() => false); next = this.earlySteers[0]) {
        // A stop clears the held steers mid-delivery, and a later turn's must not be dropped in their place.
        if (this.earlySteers[0] !== next) return;
        this.earlySteers.shift();
      }
    });
  }

  protected recordContextUsage(payload: ContextUsagePayload): void {
    this.record({
      timestamp: new Date().toISOString(),
      type: CONTEXT_USAGE_EVENT_TYPE,
      payload: { ...payload } as unknown as Record<string, unknown>,
    });
  }

  protected buildCombinedInstructions(customInstructions?: string, includeMemory = false): string {
    return buildOkidokiInstructions({
      enginePort: ENGINE_ENV.OKIDOKI_ENGINE_PORT,
      workspaceRoot: ENGINE_ENV.WORKSPACE_ROOT,
      environmentSystemPrompt: ENGINE_ENV.OKIDOKI_ENV_SYSTEM_PROMPT,
      devices: ENGINE_ENV.OKIDOKI_ENV_DEVICES.map((device) => ({ ...device, screen: device.screen_password !== undefined })),
      tailnet: Boolean(ENGINE_ENV.TS_AUTHKEY),
      localControlComputers: localControlComputers(),
      repositorySystemPrompts: okidokiConfigService.getSystemPrompts(),
      memory: includeMemory ? { historyIndex: existsSync(join(HISTORY_ROOT, HISTORY_INDEX_FILENAME)), learnedSkills: existsSync(LEARNED_SKILLS_MANIFEST_PATH) } : undefined,
      subagentMcp: Boolean(this.subagentMcpParentChatId()),
      customInstructions,
    });
  }

  // Read per turn, since an agent can attach its workspace to a Linear issue mid-chat.
  protected get linearSessionId(): string | undefined {
    return this.topLevel ? ENGINE_ENV.OKIDOKI_LINEAR_SESSION_ID : undefined;
  }

  protected emitInterruptedQueueEvent(queue: string[]): void {
    const linearSessionId = this.linearSessionId;
    if (!linearSessionId || queue.length === 0) {
      return;
    }

    const body = ['Interrupted. Cleared queue:', ...queue].join('\n');
    const thoughtEvent: LinearThoughtEvent = {
      linearSessionId,
      content: {
        type: 'thought',
        body,
      },
    };
    monolithService.sendEvent({ type: 'agent_update', payload: thoughtEvent }).catch(() => {});
  }
}
