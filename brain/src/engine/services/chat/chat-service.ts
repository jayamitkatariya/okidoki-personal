import { appendFile, copyFile, mkdir, readFile, rename, rm } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type {
  AgentCredentialSnapshot,
  AgentEvent,
  AgentProvider,
  AgentQuotaExhaustedPayload,
  AgentFallbackReason,
  ChatForkHandoff,
  ChatForkInfo,
  ChatKind,
  ChatForkTrigger,
  ChatHistoryPageParams,
  ChatHistoryRecordRange,
  ChatHistoryResponse,
  ChatMessageSender,
  ChatQueueResponse,
  ChatSummary,
  ChatTranscriptArtifact,
  ClearChatGoalResponse,
  CreateChatRequest,
  EngineEvent,
  EngineWorkspaceArtifactsFlushRequest,
  EngineWorkspaceArtifactsFlushResponse,
  EngineRepoState,
  ForkChatRequest,
  GetSubagentMcpConfigResponse,
  InterruptChatResponse,
  TurnStopped,
  IntegrationErrorNotificationTarget,
  ListSlashCommandsResponse,
  MessageSubagentRequest,
  QueueMutationResponse,
  SubagentResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
  SlashCommand,
  SpawnSubagentRequest,
  ThinkingLevel,
  UpdateChatGoalRequest,
  UpdateChatGoalResponse,
} from '@okidoki/shared';
import { canSteerMessage, mergeWorkspaceChatHistoryEvents } from '@okidoki/shared/workspace-chat';
import {
  AGENT_MODELS,
  getChatContinuation,
  getCurrentChat,
  getChatThreadSources,
  requestForContinuation,
  AGENT_QUOTA_EXHAUSTED_EVENT_TYPE,
  areSameUserMessageEvents,
  AUTH_FALLBACK_EVENT_TYPE,
  coerceAuthFallbackPayload,
  coerceModelRefusalFallback,
  describeAuthFallback,
  describeModelRefusalFallback,
  agentQuotaExhaustedPayloadSchema,
  agentCredentialSnapshotSchema,
  integrationErrorNotificationTargetSchema,
  sendChatMessageResponseSchema,
  CHAT_FORK_EXCERPT_OMITTED_NOTICE,
  getChatKind,
  coerceChatForkInfo,
  defaultForkChatTitle,
  getContinuedChatName,
  formatChatForkHandoffMessage,
  OKIDOKI_INSTRUCTIONS_TAG,
  wrapInTag,
  formatChatForkUpdateMessage,
  AUTH_RETRY_STATUS_EVENT_TYPE,
  CHAT_GOAL_EVENT_TYPE,
  CHAT_TURN_LOST_EVENT_TYPE,
  ACCEPTED_USER_MESSAGE_SOURCE,
  CHAT_TURN_LOST_MESSAGE,
  CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE,
  CODEX_ITEM_PARTIAL_EVENT_TYPE,
  CODEX_QUOTA_STATUS_EVENT_TYPE,
  CODEX_TURN_RETRY_EVENT_TYPE,
  codexTurnFromEvent,
  CURSOR_CONNECTION_STATUS_EVENT_TYPE,
  coerceBackgroundTaskPayload,
  createAcceptedUserMessageEvent,
  createChatHistoryCursor,
  excludeQueuedAcceptedEvents,
  extractFinalResponse,
  formatManagerEvents,
  MANAGER_EVENT_MESSAGE_TYPE,
  MANAGER_TURN_ERROR_SUMMARY,
  SUBAGENT_MCP_TOOLS,
  truncateManagerEventResponse,
  extractLatestContextUsage,
  areUserMessagesWithinMatchWindow,
  getChatHistoryPageSenders,
  getEventTimestampMs,
  hasChatStarted,
  hasGeneratedChatTitle,
  isDefaultChat,
  isPullRequestFeedbackChat,
  PR_FIXES_NEEDS_DECISION,
  isLatestChatHistoryPage,
  getSlashCommandsForProvider,
  getRemovedMessageIds,
  getUserMessage,
  getUserMessageId,
  coerceClaudeResultPayload,
  isClaudeResultError,
  isEngineAgentProvider,
  type EngineAgentProvider,
  isValidThinkingLevel,
  LEARNED_SKILL_DIR_PREFIX,
  LEARNED_SKILLS_MANIFEST_PATH,
  learnedSkillsManifestSchema,
  mergeSlashCommands,
  canUseGoalMode,
  getGoalCommand,
  isCompactCommand,
  normalizeCodexAspTranscriptStatus,
  parseAgentEvents,
  parseDisplayMessages,
  type DisplayMessage,
  isToolInputQuestion,
  type ToolInputQuestion,
  currentStepLabel,
  lastPlainStepLabel,
  parseChatHistoryCursor,
  paginateChatHistory,
  QUEUED_MESSAGE_REMOVED_EVENT_TYPE,
  REMOVED_MESSAGE_IDS_PAYLOAD_KEY,
  steerQueuedInOrder,
  stripAgentDiagnosticErrors,
  USER_MESSAGE_ID_PAYLOAD_KEY,
} from '@okidoki/shared';
import { eventService } from '../event-service';
import { takesTurnNotes } from '../../managers/coding-agent-manager';
import { ClaudeManager } from '../../managers/claude-manager';
import { CodexAspManager } from '../../managers/codex-asp/codex-asp-manager';
import { CodexHistoryFile } from '../../managers/codex-asp/codex-history-file';
import { AsyncLock } from '../../utils/async-lock';
import { CursorManager } from '../../managers/cursor-manager';
import { MuseManager } from '../../managers/muse-manager';
import { GeminiManager } from '../../managers/gemini-manager';
import { OpencodeManager } from '../../managers/opencode-manager';
import { PiManager } from '../../managers/pi-manager';
import type { CodingAgentProvider, ProviderForkPoint } from '../../managers/coding-agent-provider';
import type { QueuedMessage } from '../message-queue-service';
import { ChatCommands } from './chat-commands';
import { gitService } from '../../git/service';
import { monolithService } from '../monolith-service';
import { AgentChatActivityTrackerService } from '../../analytics/agent/activity/agent-chat-activity-tracker-service';
import { AgentTokenUsageTracker } from '../../analytics/token-usage/agent-token-usage-tracker';
import { CodexTokenUsageAdapter } from '../../analytics/token-usage/codex';
import { ENGINE_ENV } from '../../engine-env';
import { totalmem } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWriteFile } from '../../utils/file';
import { isRecord } from '../../utils/type-guards';
import { keepAliveService } from '../keep-alive-service';
import { flushAllCanvasItems } from '../upload-canvas-items';
import { currentTranscriptAuth, flushAllChatTranscripts, normalizeTranscriptAuth, uploadChatTranscript, type ChatTranscriptSource, type TranscriptAuth } from '../upload-chat-transcripts';
import { flushRepoState } from '../upload-repo-state';
import { refreshRepoStatuses } from '../refresh-repo-state';
import { pullRequestCheckService } from '../pull-request-check-service';
import { flushAllEngineLogs } from '../upload-engine-logs';
import { buildForkHandoff, hashTranscriptBlocks, type ForkHandoffSegment, readPullRequestDecisions, unseenConversationExcerpt, unseenTurnsExcerpt } from './fork-handoff';
import {
  CHATS_FILE,
  CLAUDE_HISTORY_DIR,
  FORKS_DIR,
  CODEX_HISTORY_DIR,
  CURSOR_HISTORY_DIR,
  ENGINE_DIR,
  HISTORY_DIR_BY_PROVIDER,
  OPENCODE_HISTORY_DIR,
} from './history-paths';
import {
  CHAT_SENDERS_DIR,
  chatMessageSendersFilePath,
  parseChatMessageSendersJsonl,
} from './chat-senders';
import {
  ChatBusyError,
  ChatMessagePersistenceError,
  ChatNotFoundError,
  ChatProviderUnavailableError,
  DuplicateDefaultChatError,
} from './errors';
import { isAgentAvailable } from '../../managers/agent-auth-detection';
import { normalizeImages } from '../../utils/image-utils';
import { ItemUpdateCoalescer } from '../../managers/codex-asp/item-update-coalescer';

const CHATS_BACKUP_FILE = `${CHATS_FILE}.bak`;

function createTurnMetadata(
  message: Pick<
    SendChatMessageRequest,
    | 'message'
    | 'images'
    | 'senderUserId'
    | 'senderEmail'
    | 'senderDisplayName'
    | 'senderAvatarUrl'
    | 'replacesMessageId'
  >,
  messageId: string,
  recordedAt: string,
): { event: AgentEvent; sender?: ChatMessageSender } {
  const event = createAcceptedUserMessageEvent(
    message.message,
    messageId,
    recordedAt,
    message.images,
    message.replacesMessageId,
  );
  const sender = message.senderUserId && message.senderEmail
    ? {
        messageId,
        senderUserId: message.senderUserId,
        senderEmail: message.senderEmail,
        ...(message.senderDisplayName ? { senderDisplayName: message.senderDisplayName } : {}),
        ...(message.senderAvatarUrl ? { senderAvatarUrl: message.senderAvatarUrl } : {}),
        recordedAt,
      }
    : undefined;
  return { event, ...(sender ? { sender } : {}) };
}

function isSameAcceptedUserEvent(event: AgentEvent, acceptedEvent: AgentEvent): boolean {
  // Provider transcript events (e.g. claude-user) carry the stamped message id
  // but not the event_msg shape, so match by identity before heuristics.
  const eventMessageId = getUserMessageId(event);
  if (eventMessageId && eventMessageId === getUserMessageId(acceptedEvent)) return true;
  if (areSameUserMessageEvents(event, acceptedEvent)) return true;
  const eventMessage = getUserMessage(event);
  const acceptedMessage = getUserMessage(acceptedEvent);
  if (!eventMessage || !acceptedMessage) return false;
  return areUserMessagesWithinMatchWindow(
    { content: eventMessage, timestamp: event.timestamp },
    { content: acceptedMessage, timestamp: acceptedEvent.timestamp },
  );
}

function terminalErrorsFromEvent(
  event: AgentEvent,
  provider: AgentProvider,
): string[] | null | undefined {
  if (event.type === 'claude-result') {
    const payload = coerceClaudeResultPayload(event.payload);
    if (!isClaudeResultError(payload)) return null;
    const errors = stripAgentDiagnosticErrors(payload.errors ?? []);
    return errors.length > 0 ? errors : [payload.result || 'Claude run failed'];
  }

  if (event.type === CODEX_QUOTA_STATUS_EVENT_TYPE) {
    return event.payload.state === 'out_of_credits'
      ? ['Codex is out of credits. Top up the connected OpenAI account to resume.']
      : null;
  }

  if (event.type === 'codex-asp-error') {
    return [typeof event.payload.message === 'string' ? event.payload.message : 'Codex run failed'];
  }

  if (event.type === CODEX_TURN_RETRY_EVENT_TYPE) return null;

  const codexTurn = codexTurnFromEvent(event);
  if (codexTurn) {
    return normalizeCodexAspTranscriptStatus(codexTurn.status) === 'failed'
      ? [codexTurn.error ?? 'Codex run failed']
      : undefined;
  }

  const mayContainProviderError = (
    provider === 'cursor' && event.type === 'cursor-error'
  ) || (
    provider === 'gemini' && event.type === 'gemini-error'
  ) || (
    provider === 'opencode' && (event.type === 'opencode-error' || event.type === 'opencode-message.updated')
  ) || (
    provider === 'pi' && (event.type === 'pi-error' || event.type === 'pi-message_end')
  ) || (
    provider === 'muse' && event.type === 'muse-error'
  );
  if (!mayContainProviderError) return undefined;

  const errors = parseAgentEvents([event], provider)
    .flatMap((message) => message.type === 'error' ? [message.message] : []);
  return errors.length > 0 ? errors : undefined;
}

interface PersistedChat {
  id: string;
  provider: EngineAgentProvider;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  title: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  providerSessionId: string | null;
  parentChatId: string | null;
  lastMessageText?: string | null;
  deletedAt?: string | null;
  fork?: ChatForkInfo | null;
  pendingForkHandoff?: boolean;
  pullRequestNotesPath?: string;
  kind?: ChatKind;
  forkedThroughTurn?: string;
  /** Set until the provider saves the forked session, so a fork deferred to the next turn survives a restart. */
  pendingProviderFork?: ProviderForkPoint;
  chatCredential?: AgentCredentialSnapshot | 'workspace';
  /** The auth the latest turn started on, so a later upload does not record auth changed since. */
  transcriptAuth?: TranscriptAuth;
  lastSenderKey?: string;
  uploadedHistory?: { version: string; size: number };
  // Command state from an engine older than the command file: read once at load, then dropped.
  acceptedSendResponses?: Record<string, SendChatMessageResponse>;
  removedMessageIds?: string[];
  turnStartedAt?: string;
  turnErrorNotificationTargets?: IntegrationErrorNotificationTarget[];
}

const LAST_MESSAGE_PREVIEW_MAX = 200;
const FINAL_MESSAGE_MAX = 6_000;
// Live Activity updates run on Apple's budget, so the step is reported at most this often.
const PROGRESS_INTERVAL_MS = 20_000;
const STREAM_RECORD_TYPES = new Set(['opencode-message.part.delta', 'muse-item-delta', 'cursor-assistant', 'cursor-thinking', 'gemini-chunk']);
const PROGRESS_STEP_MAX = 120;
const TURN_REQUEST_MAX = 8_000;
const toolInputRequestSchema = z.object({
  requestId: z.string().optional(),
  toolName: z.string().optional(),
  questions: z.array(z.custom<ToolInputQuestion>(isToolInputQuestion)).optional(),
  plan: z.string().optional(),
});
const toolInputResolvedSchema = z.object({ requestId: z.string() });
const SUBAGENT_POLL_INTERVAL_MS = 2000;
// A send reaches the provider within milliseconds unless something it waits on has stopped answering.
const STOP_ARRIVAL_WAIT_MS = 3_000;
// An idle chat still holds its agent process (a Claude Code CLI is 200-300 MB plus its stdio MCP servers) until it's
// released; the next message resumes the session from disk. Child chats rarely get follow-ups, so they go sooner.
const CHAT_IDLE_RELEASE_MS = 15 * 60_000;
const CHILD_CHAT_IDLE_RELEASE_MS = 2 * 60_000;
// A Claude Code process measured 250-280 MB; read per check so the cap follows a resized sandbox (six at 8 GB).
const LIVE_AGENT_PROCESS_MB = 300;
const maxLiveAgentProcesses = () => ENGINE_ENV.OKIDOKI_MAX_LIVE_AGENT_PROCESSES
  ?? Math.max(1, Math.floor(totalmem() / 1024 / 1024 / 4 / LIVE_AGENT_PROCESS_MB));

interface RuntimeChat {
  persisted: PersistedChat;
  historyVersion: string;
  provider: CodingAgentProvider;
  pendingMessageIds: string[];
  requeued?: { id: string; afterId: string };
  steeringOnArrival: Set<string>;
  acceptedUserEvents: Map<string, AgentEvent>;
  commands: ChatCommands;
  acceptingSendResponses: Map<string, Promise<SendChatMessageResponse>>;
  lastSendAcceptance?: Promise<SendChatMessageResponse>;
  lastSendArrival?: Promise<void>;
  acceptingMessages: number;
  arrivingSends: Set<Promise<void>>;
  activeMessageId: string | null;
  hasActiveTurn: boolean;
  // Branches observed on each repo's HEAD during the active turn, keyed by
  // repo name. Populated from per-event HEAD snapshots so end-of-turn PR
  // detection can find PRs the agent opened on branches it has since left.
  observedBranchesByRepo: Map<string, Set<string>>;
  // User-facing error messages from the turn's terminal result event, if it
  // errored. Forwarded on agent_turn_complete so the monolith can notify
  // integrations (e.g. the Slack thread) instead of failing silently.
  lastTurnErrors: string[] | null;
  turnWorked: boolean;
  turnNotices: string[];
  unsaidNotes: string[];
  errorNotificationTargets: Map<string, IntegrationErrorNotificationTarget[]>;
  activeErrorNotificationTargets: IntegrationErrorNotificationTarget[];
  quotaExhaustion: AgentQuotaExhaustedPayload | null;
  lastSendRequest: SendChatMessageRequest | null;
  turnRequest: string | null;
  turnAnswer: Map<string, string>;
  turnCompletion: Promise<void> | null;
  stopped: TurnStopped | null;
  stopping: Promise<void> | null;
  publishedQueue: string | null;
  idleReleaseTimer: ReturnType<typeof setTimeout> | null;
  /** Its agent's login was withdrawn mid-turn; the session is dropped once the agent stops, not while it works. */
  releaseWhenIdle: boolean;
  release: Promise<void> | null;
  switching: Promise<unknown> | null;
  history: CodexHistoryFile;
  // Events of one chat reach the stream in the order they were made.
  outbox: AsyncLock;
  // History file offsets where events persisted but not yet published begin; deltas claim no historyEnd past them.
  unpublishedHistoryStarts: Array<{ at: number; swapCount: number }>;
  live: boolean;
  progressStep: string | null;
  progressSentStep: string | null;
  plainStep: string | null;
}

function createForkInfo(
  source: PersistedChat,
  trigger: ChatForkTrigger,
  startedAt: string,
  reason?: AgentFallbackReason,
): ChatForkInfo {
  return {
    source: { chatId: source.id, provider: source.provider, title: source.displayName ?? source.title },
    trigger,
    ...(reason ? { reason } : {}),
    state: 'preparing',
    startedAt,
  };
}

function withNotificationTargets(targets: IntegrationErrorNotificationTarget[], added: IntegrationErrorNotificationTarget[]): IntegrationErrorNotificationTarget[] {
  return [...targets, ...added.filter((target) => !targets.some((other) => JSON.stringify(other) === JSON.stringify(target)))];
}

function isForkPreparing(chat: RuntimeChat): boolean {
  return chat.persisted.fork?.state === 'preparing';
}

function hasActiveBackgroundWork(chat: RuntimeChat): boolean {
  return (chat.provider.hasActiveBackgroundTasks?.() ?? false) || isForkPreparing(chat);
}

const NOT_WORK_MESSAGE_TYPES = new Set<DisplayMessage['type']>(['user', 'error', 'capacity_retry', 'quota_status', 'auth_fallback', 'model_fallback']);

function hasActiveAgentWork(chat: RuntimeChat): boolean {
  return chat.provider.isProcessing() || hasActiveBackgroundWork(chat) || chat.turnCompletion !== null;
}

function isChatIdle(chat: RuntimeChat): boolean {
  return chat.acceptingMessages === 0 && !hasActiveChatTurn(chat) && !hasActiveAgentWork(chat);
}

// Background tasks alone don't count: an idle agent isn't waiting on them. They only keep the workspace alive (hasActiveAgentWork).
function hasActiveChatTurn(chat: RuntimeChat): boolean {
  return chat.hasActiveTurn
    || chat.pendingMessageIds.length > 0
    || isForkPreparing(chat)
    || chat.provider.isProcessing();
}

function isPersistedChat(value: unknown): value is PersistedChat {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value;

  return (
    typeof candidate.id === 'string'
    && typeof candidate.provider === 'string'
    && isEngineAgentProvider(candidate.provider)
    && typeof candidate.title === 'string'
    && (candidate.displayName === undefined || typeof candidate.displayName === 'string')
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && (candidate.providerSessionId === null || typeof candidate.providerSessionId === 'string')
    && (candidate.parentChatId === undefined || candidate.parentChatId === null || typeof candidate.parentChatId === 'string')
    && (candidate.deletedAt === undefined || candidate.deletedAt === null || typeof candidate.deletedAt === 'string')
  );
}

function normalizePersistedChat(chat: PersistedChat): PersistedChat {
  return {
    id: chat.id,
    provider: chat.provider,
    ...(typeof chat.model === 'string' && chat.model ? { model: chat.model } : {}),
    ...(isValidThinkingLevel(chat.thinkingLevel) ? { thinkingLevel: chat.thinkingLevel } : {}),
    title: chat.title,
    ...(chat.displayName ? { displayName: chat.displayName } : {}),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    providerSessionId: chat.providerSessionId,
    parentChatId: chat.parentChatId ?? null,
    lastMessageText: chat.lastMessageText ?? null,
    deletedAt: chat.deletedAt ?? null,
    fork: coerceChatForkInfo(chat.fork),
    pendingForkHandoff: chat.pendingForkHandoff === true,
    ...(typeof chat.pullRequestNotesPath === 'string' ? { pullRequestNotesPath: chat.pullRequestNotesPath } : {}),
    kind: getChatKind(chat),
    ...(typeof chat.forkedThroughTurn === 'string' ? { forkedThroughTurn: chat.forkedThroughTurn } : {}),
    ...(typeof chat.pendingProviderFork?.sessionId === 'string' && typeof chat.pendingProviderFork.throughTurn === 'string'
      ? { pendingProviderFork: chat.pendingProviderFork }
      : {}),
    ...(chat.chatCredential === 'workspace' || agentCredentialSnapshotSchema.safeParse(chat.chatCredential).success ? { chatCredential: chat.chatCredential } : {}),
    transcriptAuth: normalizeTranscriptAuth(chat.transcriptAuth),
    ...(typeof chat.lastSenderKey === 'string' ? { lastSenderKey: chat.lastSenderKey } : {}),
    ...(typeof chat.turnStartedAt === 'string' ? { turnStartedAt: chat.turnStartedAt } : {}),
    ...(chat.turnErrorNotificationTargets ? { turnErrorNotificationTargets: z.array(integrationErrorNotificationTargetSchema).safeParse(chat.turnErrorNotificationTargets).data } : {}),
    ...(isRecord(chat.uploadedHistory) && typeof chat.uploadedHistory.version === 'string' && typeof chat.uploadedHistory.size === 'number'
      ? { uploadedHistory: { version: chat.uploadedHistory.version, size: chat.uploadedHistory.size } }
      : {}),
    ...(Array.isArray(chat.removedMessageIds)
      ? { removedMessageIds: chat.removedMessageIds.filter((id): id is string => typeof id === 'string') }
      : {}),
    ...(isRecord(chat.acceptedSendResponses)
      ? {
        acceptedSendResponses: Object.fromEntries(Object.entries(chat.acceptedSendResponses).flatMap(([key, value]) => {
          const response = sendChatMessageResponseSchema.safeParse(value);
          return response.success ? [[key, response.data]] : [];
        })),
      }
      : {}),
  };
}

export function parsePersistedChatsContent(content: string): PersistedChat[] {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry) => isPersistedChat(entry))
    .map((entry) => normalizePersistedChat(entry));
}

function corruptChatsFilePath(): string {
  return `${CHATS_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

type PublishEventInput = {
  [TType in EngineEvent['type']]: {
    type: TType;
    payload: Extract<EngineEvent, { type: TType }>['payload'];
  }
}[EngineEvent['type']];

export class ChatService {
  private chats = new Map<string, RuntimeChat>();
  private readonly awaitedSubagents = new Map<string, number>();
  private readonly heldSubagentReports = new Map<string, { completedAt: string; errors: string[] | null }>();
  private forkSourceSeenBlocks = new Map<string, string[]>();
  private readonly restartedChats = new Map<string, boolean>();
  private persistPromise: Promise<void> | null = null;
  private persistQueued = false;

  constructor(
    private readonly workingDirectory: string,
    private readonly agentChatActivityTrackerService: AgentChatActivityTrackerService,
    private readonly agentTokenUsageTracker: AgentTokenUsageTracker,
  ) {
    keepAliveService.setActivityCheck(() =>
      [...this.chats.values()].some((chat) => !chat.persisted.deletedAt && hasActiveAgentWork(chat)),
    );
  }

  async initialize(): Promise<void> {
    await mkdir(ENGINE_DIR, { recursive: true });
    await mkdir(CLAUDE_HISTORY_DIR, { recursive: true });
    await mkdir(CODEX_HISTORY_DIR, { recursive: true });
    await mkdir(CURSOR_HISTORY_DIR, { recursive: true });
    await mkdir(OPENCODE_HISTORY_DIR, { recursive: true });
    await mkdir(CHAT_SENDERS_DIR, { recursive: true });

    const persisted = await this.loadChats();
    let fromOlderEngine = false;
    for (const chat of persisted) {
      const stored = await ChatCommands.load(chat.id);
      const commands = stored ?? new ChatCommands(chat.id);
      const { state } = commands;
      let changed = !stored;
      if (chat.acceptedSendResponses || chat.removedMessageIds || chat.turnStartedAt) {
        // An older engine wrote these, after any command file was saved (an upgrade that was rolled back). It never saw
        // that file's queue or turn, so neither is run or reported after everything it did since. The queued messages
        // get no removal record: the user saw them as sent all through the rollback.
        fromOlderEngine = true;
        for (const [key, response] of Object.entries(chat.acceptedSendResponses ?? {})) state.accepted.set(key, { ...response, at: chat.updatedAt });
        state.queue = [];
        state.removed.push(...(chat.removedMessageIds ?? []));
        delete state.lost;
        delete state.running;
        if (chat.turnStartedAt) state.running = { errorNotificationTargets: chat.turnErrorNotificationTargets ?? [] };
        changed = true;
      }
      delete chat.acceptedSendResponses;
      delete chat.removedMessageIds;
      delete chat.turnStartedAt;
      delete chat.turnErrorNotificationTargets;
      if (chat.deletedAt && (state.running || state.lost || state.queue.length > 0)) {
        delete state.running;
        delete state.lost;
        state.queue = [];
        changed = true;
      }
      const runtime = this.createRuntimeChat(chat, commands);
      const { history } = runtime;
      try {
        // The history's lost, accepted and removed records follow from the command file, so only the ones a crash kept from being written are written now.
        const accepted = new Set<string>();
        const removed = new Set<string>();
        let lostRecorded = false;
        if (state.running?.id || state.queue.length > 0 || state.removing.length > 0) {
          for await (const event of history.eventsFrom(state.checkFrom ?? 0, [CHAT_TURN_LOST_EVENT_TYPE, ACCEPTED_USER_MESSAGE_SOURCE, QUEUED_MESSAGE_REMOVED_EVENT_TYPE])) {
            if (event.type === CHAT_TURN_LOST_EVENT_TYPE && state.running?.id && event.payload.messageId === state.running.id) lostRecorded = true;
            const messageId = event.payload.source === ACCEPTED_USER_MESSAGE_SOURCE ? getUserMessageId(event) : null;
            if (messageId) accepted.add(messageId);
            for (const removedId of getRemovedMessageIds(event)) removed.add(removedId);
          }
        }
        if (state.running) {
          // A record that cannot be written must not keep the turn from being reported: the queue runs next and would overwrite it.
          if (!lostRecorded) {
            await history.record({
              timestamp: new Date().toISOString(),
              type: CHAT_TURN_LOST_EVENT_TYPE,
              payload: state.running.id ? { messageId: state.running.id } : {},
            }).written.catch((error: unknown) => console.error('[ChatService] Failed to record a turn lost to an engine restart:', { chatId: chat.id, error }));
          }
          // A restart before the last lost turn was reported: its targets are still owed the notice.
          const owed = state.lost && !state.lost.reported ? state.lost.errorNotificationTargets : [];
          state.lost = { errorNotificationTargets: withNotificationTargets(owed, state.running.errorNotificationTargets) };
          delete state.running;
          changed = true;
        }
        if (state.lost && !state.lost.reported) {
          runtime.activeErrorNotificationTargets = state.lost.errorNotificationTargets;
          this.restartedChats.set(chat.id, true);
        }
        for (const message of state.queue) {
          if (accepted.has(message.id)) continue;
          const { event, sender } = createTurnMetadata(message, message.id, message.queuedAt);
          await history.record(event).written;
          if (sender) await this.appendSender(chat.id, sender);
        }
        const unrecorded = state.removing.filter((messageId) => !removed.has(messageId));
        if (unrecorded.length > 0) {
          await history.record({
            timestamp: new Date().toISOString(),
            type: QUEUED_MESSAGE_REMOVED_EVENT_TYPE,
            payload: { [REMOVED_MESSAGE_IDS_PAYLOAD_KEY]: unrecorded },
          }).written;
        }
        if (state.removing.length > 0) {
          state.removing = [];
          changed = true;
        }
      } catch (error) {
        console.error('[ChatService] Failed to recover a chat after an engine restart:', { chatId: chat.id, error });
      }
      if (state.queue.length > 0 && !this.restartedChats.has(chat.id)) this.restartedChats.set(chat.id, false);
      if (changed) await commands.save();
      if (chat.uploadedHistory?.size === history.historyEnd) runtime.historyVersion = chat.uploadedHistory.version;
      this.chats.set(chat.id, runtime);
    }
    if (fromOlderEngine) await this.persistAllChats();
  }

  /** The monolith is only reachable once the engine is active, so what a restart interrupted is picked up here rather than at load. */
  resumeAfterRestart(): void {
    for (const [chatId, turnLost] of this.restartedChats) {
      this.restartedChats.delete(chatId);
      const chat = this.getRuntimeChat(chatId);
      if (!chat) continue;
      const { queue } = chat.commands.state;
      for (const message of queue) {
        chat.pendingMessageIds.push(message.id);
        if (message.errorNotificationTargets?.length) chat.errorNotificationTargets.set(message.id, message.errorNotificationTargets);
        this.agentChatActivityTrackerService.noteMessageAccepted(message.id, message);
        chat.lastSendRequest = message;
      }
      if (queue.length > 0) chat.provider.restoreQueue(queue);
      if (turnLost) {
        this.handleTurnFinished(chatId, true)
          .catch((error) => console.error('[ChatService] Failed to report a turn lost to an engine restart:', { chatId, error }));
      }
    }
  }

  private settleLostTurn(chat: RuntimeChat, done: 'reported' | 'told'): void {
    const { state } = chat.commands;
    if (!state.lost) return;
    state.lost[done] = true;
    if (state.lost.reported && state.lost.told) delete state.lost;
  }

  listChats(includeChildren = false): ChatSummary[] {
    return Array.from(this.chats.values())
      .filter((chat) => !chat.persisted.deletedAt && (includeChildren || chat.persisted.parentChatId === null))
      .map((chat) => this.toSummary(chat))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  hasActiveAgentWork(provider: 'claude' | 'codex'): boolean {
    return [...this.chats.values()].some((chat) => chat.persisted.provider === provider
      && (hasActiveAgentWork(chat) || chat.acceptingMessages > 0 || chat.pendingMessageIds.length > 0));
  }

  async releaseAgentSessions(provider: AgentProvider): Promise<void> {
    const chats = [...this.chats.values()].filter((chat) => !chat.persisted.deletedAt && chat.persisted.provider === provider);
    for (const chat of chats) chat.releaseWhenIdle = !isChatIdle(chat);
    await Promise.all(chats.filter((chat) => !chat.releaseWhenIdle).map((chat) => this.releaseAgentProcess(chat)));
  }

  listDeletedChats(includeChildren = false): ChatSummary[] {
    return Array.from(this.chats.values())
      .filter((chat) => chat.persisted.deletedAt && (includeChildren || chat.persisted.parentChatId === null))
      .map((chat) => this.toSummary(chat))
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  listChildChats(parentChatId: string): ChatSummary[] {
    return Array.from(this.chats.values())
      .filter((chat) => !chat.persisted.deletedAt && chat.persisted.parentChatId === parentChatId)
      .map((chat) => this.toSummary(chat))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getChat(chatId: string): ChatSummary | null {
    const chat = this.chats.get(chatId);
    return chat && !chat.persisted.deletedAt ? this.toSummary(chat) : null;
  }

  async listSlashCommands(chatId: string): Promise<ListSlashCommandsResponse> {
    const chat = this.requireChat(chatId);
    const provider = chat.persisted.provider;
    const [discovered, learnedSkills] = await Promise.all([
      chat.provider.listSlashCommands?.() ?? [],
      // Learned skills work in the background, so they stay out of the slash menu.
      readFile(LEARNED_SKILLS_MANIFEST_PATH, 'utf-8')
        .then((content) => new Set(learnedSkillsManifestSchema.parse(JSON.parse(content)).skills.flatMap(({ name }) => [`/${name}`, `/${LEARNED_SKILL_DIR_PREFIX}${name}`])))
        .catch(() => new Set<string>()),
    ]);
    const providerCommands: SlashCommand[] = discovered.filter(({ command }) => !learnedSkills.has(command)).map((command) => ({
      ...command,
      providers: [provider],
    }));

    return {
      commands: mergeSlashCommands(
        getSlashCommandsForProvider(provider),
        providerCommands,
      ),
    };
  }

  async createChat(request: Omit<CreateChatRequest, 'provider'> & { provider: EngineAgentProvider; fork?: ChatForkInfo; displayName?: string; pendingForkHandoff?: boolean; model?: string }): Promise<ChatSummary> {
    const now = request.createdAt ?? new Date().toISOString();
    const title = request.title?.trim() || `${request.provider} chat`;

    if (request.id) {
      const existing = this.chats.get(request.id);
      if (existing && !existing.persisted.deletedAt) {
        if (request.forkSourceChatId && existing.persisted.fork) return this.toSummary(existing);
        if (existing.persisted.provider !== request.provider) {
          throw new Error(`Chat ${request.id} already exists with a different provider`);
        }
        return this.toSummary(existing);
      }
    }

    const existingDefault = isDefaultChat({ provider: request.provider, title })
      ? Array.from(this.chats.values()).find((chat) => (
        !chat.persisted.deletedAt
        && chat.persisted.provider === request.provider
        && isDefaultChat(chat.persisted)
      ))
      : undefined;
    if (existingDefault) {
      if (!request.id || existingDefault.acceptingMessages > 0 || hasChatStarted(this.toSummary(existingDefault))) {
        throw new DuplicateDefaultChatError(request.provider);
      }
      this.chats.delete(existingDefault.persisted.id);
    }

    const parentChatId = request.parentChatId ?? null;
    if (parentChatId && !this.chats.has(parentChatId)) {
      throw new ChatNotFoundError(parentChatId);
    }

    const source = request.forkSourceChatId ? this.requireChat(request.forkSourceChatId) : undefined;

    const persisted: PersistedChat = {
      id: request.id ?? randomUUID(),
      provider: request.provider,
      title,
      createdAt: now,
      updatedAt: now,
      providerSessionId: null,
      parentChatId,
      fork: request.fork ?? null,
      ...(request.model ? { model: request.model } : {}),
      ...(request.pendingForkHandoff ? { pendingForkHandoff: true } : {}),
      kind: getChatKind({ title, kind: request.kind }),
      ...(request.displayName ? { displayName: request.displayName } : {}),
      ...(source ? {
        displayName: request.title?.trim() || undefined,
        model: source.persisted.provider === request.provider
          ? source.persisted.model : undefined,
        pendingForkHandoff: true,
        ...(request.pullRequestNotesPath ? { pullRequestNotesPath: request.pullRequestNotesPath } : {}),
        fork: createForkInfo(source.persisted, request.sideChat ? 'side' : 'manual', now),
      } : {}),
    };

    const runtime = this.createRuntimeChat(persisted);
    this.chats.set(persisted.id, runtime);
    await this.persistAllChats();

    await this.publish({
      type: 'chat.created',
      payload: {
        chat: this.toSummary(runtime),
        ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
      },
    });

    return this.toSummary(runtime);
  }

  async spawnSubagent(
    parentChatId: string,
    request: SpawnSubagentRequest,
  ): Promise<SubagentResponse> {
    const { providers } = await this.getSubagentProviders(parentChatId);
    if (!providers.includes(request.provider)) {
      throw new Error(`${request.provider} is not allowed as a subagent provider`);
    }
    if (!isAgentAvailable(request.provider)) {
      throw new Error(`Cannot spawn a ${request.provider} subagent because its credentials are unavailable`);
    }

    const chat = await this.createChat({
      provider: request.provider,
      title: request.title?.trim() || `Subagent (${request.provider})`,
      parentChatId,
    });
    try {
      let message = request.prompt;
      if (request.forkTurns !== 'none') {
        const parent = this.requireChat(parentChatId).persisted;
        message = await this.createForkHandoffMessage(chat.id, {
          source: { chatId: parentChatId, provider: parent.provider, title: parent.title },
          trigger: 'manual',
          subagent: true,
          turnLimit: request.forkTurns && request.forkTurns !== 'all' ? Number(request.forkTurns) : undefined,
          message: request.prompt,
        });
      }
      await this.sendMessage(chat.id, {
        message,
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        ...(request.fastMode !== undefined ? { fastMode: request.fastMode } : {}),
        ...(request.ultrafastMode ? { ultrafastMode: true } : {}),
      });
    } catch (error) {
      await this.deleteChat(chat.id).catch(() => {});
      throw error;
    }
    return this.getSubagent(parentChatId, chat.id);
  }

  async getSubagentProviders(parentChatId: string): Promise<Pick<GetSubagentMcpConfigResponse, 'providers'>> {
    this.requireSubagentParent(parentChatId);
    const config = await monolithService.getSubagentMcpConfig();
    if (!config) throw new Error('Unable to verify subagent settings');
    return { providers: config.providers };
  }

  async messageSubagent(
    parentChatId: string,
    chatId: string,
    request: MessageSubagentRequest,
  ): Promise<SubagentResponse> {
    this.requireSubagent(parentChatId, chatId);
    await this.sendMessage(chatId, {
      message: request.message,
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      ...(request.fastMode !== undefined ? { fastMode: request.fastMode } : {}),
      ...(request.ultrafastMode ? { ultrafastMode: true } : {}),
    });
    return this.getSubagent(parentChatId, chatId);
  }

  async getSubagent(parentChatId: string, chatId: string): Promise<SubagentResponse> {
    const chat = this.requireSubagent(parentChatId, chatId);
    if (hasActiveChatTurn(chat)) return { chatId, status: 'working' };
    const history = await chat.provider.getHistory();
    return {
      chatId,
      status: 'completed',
      response: extractFinalResponse(history, chat.persisted.provider) ?? '[No response from subagent]',
    };
  }

  async deleteSubagent(parentChatId: string, chatId: string): Promise<void> {
    this.requireSubagent(parentChatId, chatId);
    await this.deleteChat(chatId);
  }

  private requireSubagentParent(parentChatId: string): RuntimeChat {
    const parent = this.requireChat(parentChatId);
    if (parent.persisted.parentChatId !== null) throw new Error('Subagents cannot spawn their own subagents');
    return parent;
  }

  private requireSubagent(parentChatId: string, chatId: string): RuntimeChat {
    this.requireSubagentParent(parentChatId);
    const child = this.requireChat(chatId);
    if (child.persisted.parentChatId !== parentChatId || child.persisted.fork?.trigger === 'side') throw new Error('Chat is not a subagent of this chat');
    return child;
  }

  async waitForSubagent(
    parentChatId: string,
    chatId: string,
    timeoutMinutes?: number,
    signal?: AbortSignal,
  ): Promise<SubagentResponse> {
    const timeoutMs = timeoutMinutes ? timeoutMinutes * 60_000 : null;
    const startedAt = Date.now();
    this.awaitedSubagents.set(chatId, (this.awaitedSubagents.get(chatId) ?? 0) + 1);
    try {
      while (true) {
        if (signal?.aborted) throw new Error('Subagent wait was cancelled');
        const result = await this.getSubagent(parentChatId, chatId);
        if (result.status === 'completed' && !signal?.aborted) {
          this.heldSubagentReports.delete(chatId);
          return result;
        }
        if (this.requireChat(parentChatId).provider.getQueue().some(({ steeredAt }) => steeredAt && Date.parse(steeredAt) >= startedAt)) {
          return { ...result, interruptedByUserMessage: true };
        }
        const remainingMs = timeoutMs === null ? null : timeoutMs - (Date.now() - startedAt);
        if (remainingMs !== null && remainingMs <= 0) return { ...result, timedOut: true };
        await new Promise((resolve) => setTimeout(
          resolve,
          remainingMs === null ? SUBAGENT_POLL_INTERVAL_MS : Math.min(SUBAGENT_POLL_INTERVAL_MS, remainingMs),
        ));
      }
    } finally {
      const waits = (this.awaitedSubagents.get(chatId) ?? 1) - 1;
      if (waits > 0) this.awaitedSubagents.set(chatId, waits);
      else {
        this.awaitedSubagents.delete(chatId);
        const held = this.heldSubagentReports.get(chatId);
        const child = this.getRuntimeChat(chatId);
        this.heldSubagentReports.delete(chatId);
        if (held && child) void this.reportSubagentToParent(child, held.completedAt, held.errors);
      }
    }
  }

  private async reportSubagentToParent(chat: RuntimeChat, completedAt: string, errors: string[] | null): Promise<void> {
    const parentChatId = chat.persisted.parentChatId;
    if (!parentChatId) return;
    if (this.awaitedSubagents.has(chat.persisted.id)) {
      this.heldSubagentReports.set(chat.persisted.id, { completedAt, errors });
      return;
    }
    // The parent's instructions come with each request, so a parent with no request since the engine started has none to send.
    if (!this.getRuntimeChat(parentChatId)?.lastSendRequest) return;
    // The turn ends before the harness reports idle, so the history is read directly rather than through getSubagent.
    const detail = errors?.length
      ? errors.join('\n')
      : extractFinalResponse(await chat.provider.getHistory(), chat.persisted.provider) ?? '[No response from subagent]';
    await this.reportToChat(parentChatId, chat, completedAt, {
      summary: `${errors?.length ? MANAGER_TURN_ERROR_SUMMARY : 'Finished its turn.'} It is a subagent in this workspace: reach it with the ${SUBAGENT_MCP_TOOLS.messageAgent} and ${SUBAGENT_MCP_TOOLS.getAgent} tools and this chat_id.`,
      detail: truncateManagerEventResponse(detail, SUBAGENT_MCP_TOOLS.getAgent),
    }, `subagent-finished:${chat.persisted.id}:${completedAt}`);
  }

  private async reportPullRequestFixesDecision(chat: RuntimeChat, sourceChatId: string, completedAt: string): Promise<void> {
    const detail = extractFinalResponse(await chat.provider.getHistory(), chat.persisted.provider);
    if (!detail?.includes(PR_FIXES_NEEDS_DECISION)) return;
    await this.reportToChat(sourceChatId, chat, completedAt, {
      summary: `Needs a decision before it can go on. Ask the user for it, and when they answer, carry it out: the fix is committed in its worktree, so push it from there with the command it gives, change it, or drop it.`,
      detail,
    }, `pr-fixes-decision:${chat.persisted.id}:${completedAt}`);
  }

  private async reportToChat(targetChatId: string, chat: RuntimeChat, completedAt: string, event: { summary: string; detail: string }, idempotencyKey: string): Promise<void> {
    const last = this.getRuntimeChat(targetChatId)?.lastSendRequest;
    try {
      await this.sendMessage(targetChatId, {
        message: formatManagerEvents([{
          id: randomUUID(),
          at: completedAt,
          kind: 'finished',
          agentId: chat.persisted.id,
          agentName: chat.persisted.title,
          chatId: chat.persisted.id,
          ...event,
        }]),
        ...(last?.customInstructions ? { customInstructions: last.customInstructions } : {}),
        ...(last?.enableInteractiveTools !== undefined ? { enableInteractiveTools: last.enableInteractiveTools } : {}),
        type: MANAGER_EVENT_MESSAGE_TYPE,
        merge: true,
        inheritThinkingLevel: true,
        idempotencyKey,
      });
    } catch (error) {
      console.error('[ChatService] Failed to report a chat to another chat:', { chatId: chat.persisted.id, targetChatId, error });
    }
  }

  async sendMessage(chatId: string, request: SendChatMessageRequest): Promise<SendChatMessageResponse> {
    const chat = this.requireChat(chatId);
    // Fork handoffs wrap the message below; previews should show what the user typed.
    const typedMessage = request.message;
    const idempotencyKey = request.idempotencyKey ?? request.messageId;
    if (idempotencyKey) {
      // A retry during the steer waits for it, since the response stored on acceptance has no `steered` yet.
      const accepting = chat.acceptingSendResponses.get(idempotencyKey);
      if (accepting) return accepting;
      const accepted = chat.commands.state.accepted.get(idempotencyKey);
      if (accepted) {
        const { at: _at, ...response } = accepted;
        return response;
      }
    }
    if (chat.switching) await chat.switching.catch(() => {});
    const continuation = getChatContinuation(this.listChats(), chatId);
    if (continuation) {
      const forwardedRequest = requestForContinuation(request, chat.persisted.provider, continuation.provider);
      if (request.model && !forwardedRequest.model) {
        // Continuations that already saved a forwarded model their harness doesn't offer would otherwise fail every turn.
        const target = this.requireChat(continuation.id);
        if (target.persisted.model === request.model && !AGENT_MODELS[continuation.provider].includes(request.model)) delete target.persisted.model;
      }
      const forwarded = await this.sendMessage(continuation.id, forwardedRequest);
      return { ...forwarded, chatId: forwarded.chatId ?? continuation.id };
    }
    const { provider, ...sameHarnessRequest } = request;
    if (provider && !isEngineAgentProvider(provider)) throw new ChatProviderUnavailableError(provider);
    if (provider && provider !== chat.persisted.provider) return this.switchHarness(chat, { ...sameHarnessRequest, provider });
    request = sameHarnessRequest;
    const nameFromMessage = !chat.persisted.displayName && !chat.persisted.fork && !chat.persisted.parentChatId
      && getChatKind(chat.persisted) === 'standard' && hasGeneratedChatTitle(chat.persisted) && !hasChatStarted(this.toSummary(chat));
    const previousAcceptance = chat.lastSendAcceptance;
    const previousArrival = chat.lastSendArrival;
    const arriving = Promise.withResolvers<void>();
    const arrived = () => {
      arriving.resolve();
      chat.arrivingSends.delete(arriving.promise);
    };
    chat.arrivingSends.add(arriving.promise);
    chat.lastSendArrival = arriving.promise;
    const accepting = (async () => {
      chat.acceptingMessages += 1;
      let seenBeforeSend: string[] | undefined;
      let unsaidBeforeSend: string[] | undefined;
      try {
        // Resolve inheritance after earlier submissions have saved their selections. Their steers are not waited for here: Stop waits for this send to arrive.
        await previousArrival;
        await chat.release;
        // The chat may have been deleted while its process was being released.
        this.requireChat(chatId);
        seenBeforeSend = this.forkSourceSeenBlocks.get(chatId);
        unsaidBeforeSend = [...chat.unsaidNotes];
        const fork = chat.persisted.fork;
        // `/compact` and a goal's clear, pause and resume are read whole, so text added to `/goal resume` would turn it into a new goal.
        const goalCommand = canUseGoalMode(chat.persisted.provider) ? getGoalCommand(request.message, request.goalMode) : null;
        const command = isCompactCommand(request.message) || (goalCommand !== null && goalCommand.type !== 'set');
        if (request.replacesMessageId) {
          request = { ...request, message: await this.rewindBefore(chat, request.replacesMessageId, request.message) };
        } else if (fork && (chat.persisted.pendingForkHandoff || fork.trigger === 'side')) {
          const models = fork.trigger === 'switch' ? { sourceModel: this.chats.get(fork.source.chatId)?.persisted.model, model: request.model } : {};
          request = {
            ...request,
            message: await this.createForkHandoffMessage(chatId, { source: fork.source, trigger: fork.trigger, message: request.message, ...models }),
          };
        } else if (fork && !command && chat.persisted.pullRequestNotesPath && this.getChat(fork.source.chatId)) {
          request = { ...request, message: await this.followForkSource(chat, fork, request.message) };
        }
        // Fetched once here, so every harness and the chat's history get the converted image, not a link that expires.
        if (request.images?.some((image) => image.source.type === 'url')) {
          const results = await Promise.all(request.images.map((image) => normalizeImages([image]).then(([normalized]) => normalized, (error: unknown) => error instanceof Error ? error.message : String(error))));
          const failed = results.filter((result) => typeof result === 'string');
          const images = `image${failed.length === 1 ? '' : 's'}`;
          if (failed.length) chat.unsaidNotes.push(`${failed.length} ${command ? `${images} attached to an earlier command` : `attached ${images}`} couldn't be loaded: ${failed.join('; ')}`);
          request = { ...request, images: results.filter((result) => typeof result !== 'string') };
        }
        if (chat.unsaidNotes.length > 0 && !command) {
          const note = wrapInTag(chat.unsaidNotes.splice(0).join('\n'), OKIDOKI_INSTRUCTIONS_TAG);
          // Before a trailing attachments note, which clients only read at the very end of the message.
          const at = request.message.search(/\n\n<okidoki_attachments>\n/);
          request = { ...request, message: at === -1 ? `${request.message}\n\n${note}` : `${request.message.slice(0, at)}\n\n${note}${request.message.slice(at)}` };
        }
        if (chat.persisted.pullRequestNotesPath && !command) {
          const decisions = await readPullRequestDecisions(chat.persisted.pullRequestNotesPath);
          if (decisions) request = { ...request, message: `${request.message}\n\n${decisions}` };
        }
        const savedModel = chat.persisted.model ?? (!request.model
          ? extractLatestContextUsage((await chat.provider.getHistory()).events, chat.persisted.provider)?.model
          : undefined);
        request = {
          ...request,
          model: request.model ?? savedModel ?? undefined,
          thinkingLevel: request.thinkingLevel ?? (request.inheritThinkingLevel ? chat.persisted.thinkingLevel : undefined),
        };
        const { steer, ...queued } = request;
        const enqueued = steer ? { ...queued, messageId: queued.messageId ?? `msg_${randomUUID()}` } : queued;
        if (enqueued.messageId && steer && chat.provider.isProcessing() && (steer === 'alone' || chat.provider.getQueue().every(({ steeredAt }) => steeredAt)) && canSteerMessage(chat.persisted.provider, enqueued)) {
          chat.steeringOnArrival.add(enqueued.messageId);
        }
        try {
          const response = await chat.provider.enqueueMessage(
            enqueued,
            (result, acceptedMessage) => this.withUnpublishedHistory(chat, () => this.handleMessageAccepted(
              chatId,
              chat,
              request,
              acceptedMessage,
              result,
              typedMessage,
            )),
          ).finally(arrived);
          if (!steer || !response.queued) return response;
          await previousAcceptance?.catch(() => {});
          const steered = await steerQueuedInOrder(steer === 'alone' ? [{ id: response.messageId }] : chat.provider.getQueue(), response.messageId, async (id) => (await this.steerFromQueue(chatId, id)).success);
          return { ...response, steered };
        } finally {
          if (enqueued.messageId && chat.steeringOnArrival.delete(enqueued.messageId)) this.publishQueueIfChanged(chatId);
        }
      } catch (error) {
        // The side agent never received these turns, so the retry must include them again.
        if (seenBeforeSend) this.forkSourceSeenBlocks.set(chatId, seenBeforeSend);
        else this.forkSourceSeenBlocks.delete(chatId);
        if (unsaidBeforeSend) chat.unsaidNotes = unsaidBeforeSend;
        throw error;
      } finally {
        chat.acceptingMessages -= 1;
        arrived();
      }
    })();
    chat.lastSendAcceptance = accepting;
    if (nameFromMessage) {
      void accepting
        .then(() => monolithService.generateChatName({ prompt: typedMessage, images: request.images }))
        .then((name) => name && !this.chats.get(chatId)?.persisted.displayName ? this.updateDisplayName(chatId, name) : undefined)
        .catch(() => {});
    }
    if (!idempotencyKey) return accepting;
    chat.acceptingSendResponses.set(idempotencyKey, accepting);
    try {
      return await accepting;
    } finally {
      if (chat.acceptingSendResponses.get(idempotencyKey) === accepting) {
        chat.acceptingSendResponses.delete(idempotencyKey);
      }
    }
  }

  private async handleMessageAccepted(
    chatId: string,
    chat: RuntimeChat,
    request: SendChatMessageRequest,
    acceptedMessage: SendChatMessageRequest,
    result: SendChatMessageResponse,
    typedMessage = request.message,
  ): Promise<void> {
    const now = Date.now();
    // A tap time from a clock that runs ahead would date this message, and through the latest record every later one, after their replies.
    const submittedAt = request.submittedAt && Date.parse(request.submittedAt) < now ? request.submittedAt : new Date(now).toISOString();
    // Readers order by timestamp. A send that was tapped during the previous reply and arrived after it must not sort into that reply.
    const { event: acceptedEvent, sender: recordedSender } = createTurnMetadata(
      acceptedMessage,
      result.messageId,
      Date.parse(submittedAt) < chat.history.latestRecordedAt ? new Date(chat.history.latestRecordedAt).toISOString() : submittedAt,
    );
    const { state } = chat.commands;
    const existingTargets = chat.errorNotificationTargets.get(result.messageId) ?? [];
    const notificationTargets = withNotificationTargets(existingTargets, [
      ...(request.errorNotificationTargets ?? []),
      ...(request.errorNotificationTarget ? [request.errorNotificationTarget] : []),
    ]);
    const previousQueued = state.queue.find(({ id }) => id === result.messageId);
    const queued: QueuedMessage = {
      ...acceptedMessage,
      id: result.messageId,
      queuedAt: previousQueued?.queuedAt ?? submittedAt,
      ...(notificationTargets.length > 0 ? { errorNotificationTargets: notificationTargets } : {}),
    };
    const previousPendingMessageIds = [...chat.pendingMessageIds];
    const previousAcceptedEvent = chat.acceptedUserEvents.get(result.messageId);
    const previousLastMessageText = chat.persisted.lastMessageText;
    const previousModel = chat.persisted.model;
    const previousThinkingLevel = chat.persisted.thinkingLevel;
    const previousUpdatedAt = chat.persisted.updatedAt;
    const previousFork = chat.persisted.fork;
    const previousPendingForkHandoff = chat.persisted.pendingForkHandoff;
    const idempotencyKey = request.idempotencyKey ?? request.messageId;
    const previousAccepted = idempotencyKey ? state.accepted.get(idempotencyKey) : undefined;
    if (idempotencyKey) state.accepted.set(idempotencyKey, { ...result, at: new Date().toISOString() });

    // A message merged into a queued tail comes back with the tail's id, which
    // is already pending; pushing it again leaves a duplicate that no turn
    // completion ever removes, so the chat reports processing forever.
    if (!state.removed.includes(result.messageId)) {
      if (state.queue.length === 0 && state.removing.length === 0) state.checkFrom = chat.history.historyEnd;
      if (previousQueued) state.queue[state.queue.indexOf(previousQueued)] = queued;
      else state.queue.push(queued);
      if (!chat.pendingMessageIds.includes(result.messageId)) {
        chat.pendingMessageIds.push(result.messageId);
      }
      chat.acceptedUserEvents.set(result.messageId, acceptedEvent);
    }
    chat.persisted.lastMessageText = typedMessage.trim().slice(0, LAST_MESSAGE_PREVIEW_MAX) || null;
    chat.persisted.model = acceptedMessage.model ?? previousModel;
    chat.persisted.thinkingLevel = acceptedMessage.thinkingLevel;
    chat.persisted.updatedAt = new Date().toISOString();
    if (chat.persisted.pendingForkHandoff && chat.persisted.fork) {
      chat.persisted.pendingForkHandoff = false;
      chat.persisted.fork = { ...chat.persisted.fork, state: 'ready', completedAt: chat.persisted.updatedAt };
    }
    try {
      // The command file comes first and the history record follows from it: a crash in between leaves a queued message
      // whose record is written at the next start, never a record or an answer for a message that is not saved.
      await chat.commands.save();
      await this.persistAllChats();
      await chat.history.record(acceptedEvent).written;
    } catch (error) {
      const index = state.queue.indexOf(queued);
      if (index !== -1) state.queue.splice(index, 1, ...(previousQueued ? [previousQueued] : []));
      if (idempotencyKey && previousAccepted) state.accepted.set(idempotencyKey, previousAccepted);
      else if (idempotencyKey) state.accepted.delete(idempotencyKey);
      chat.pendingMessageIds = previousPendingMessageIds;
      if (previousAcceptedEvent) chat.acceptedUserEvents.set(result.messageId, previousAcceptedEvent);
      else chat.acceptedUserEvents.delete(result.messageId);
      chat.persisted.lastMessageText = previousLastMessageText;
      chat.persisted.model = previousModel;
      chat.persisted.thinkingLevel = previousThinkingLevel;
      chat.persisted.updatedAt = previousUpdatedAt;
      chat.persisted.fork = previousFork;
      chat.persisted.pendingForkHandoff = previousPendingForkHandoff;
      await chat.commands.save().catch((saveError) => {
        console.error('[ChatService] Failed to take a rejected message back out of the command file:', { chatId, error: saveError });
      });
      throw new ChatMessagePersistenceError(error);
    }

    chat.lastSendRequest = request;
    this.agentChatActivityTrackerService.noteMessageAccepted(result.messageId, request);
    if (notificationTargets.length > 0) chat.errorNotificationTargets.set(result.messageId, notificationTargets);

    if (recordedSender) {
      await this.appendSender(chatId, recordedSender);
    }

    await this.publish({
      type: 'chat.turn.accepted',
      payload: {
        chatId,
        messageId: result.messageId,
        queued: result.queued,
        position: result.position,
        event: acceptedEvent,
        ...(recordedSender ? { sender: recordedSender } : {}),
      },
    }).catch((error) => {
      console.error('[ChatService] Failed to publish accepted turn:', { chatId, messageId: result.messageId, error });
    });
    if (chat.persisted.model !== previousModel || chat.persisted.thinkingLevel !== previousThinkingLevel || previousPendingForkHandoff) {
      await this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } }).catch((error) => {
        console.error('[ChatService] Failed to publish accepted chat update:', { chatId, error });
      });
    }
  }

  private async appendSender(chatId: string, sender: ChatMessageSender): Promise<void> {
    try {
      await appendFile(chatMessageSendersFilePath(chatId), JSON.stringify(sender) + '\n', 'utf-8');
    } catch (error) {
      // Best-effort: sender records are UI-only attribution, not required to send.
      console.error('[ChatService] Failed to append sender record:', error);
    }
  }

  private async readSenders(chatId: string): Promise<ChatMessageSender[]> {
    return readFile(chatMessageSendersFilePath(chatId), 'utf-8')
      .then(parseChatMessageSendersJsonl)
      .catch((error) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
        console.error('[ChatService] Failed to read sender records:', error);
        return [];
      });
  }

  async interrupt(chatId: string, stoppedAt?: string, stopped?: TurnStopped): Promise<InterruptChatResponse> {
    const chat = this.requireChat(chatId);
    // A send still on its way to the provider would start its turn after this Stop found nothing to stop; one that takes longer than this wait still does.
    await Promise.race([Promise.all(chat.arrivingSends), sleep(STOP_ARRIVAL_WAIT_MS, undefined, { ref: false })]);
    // Before the provider's interrupt: the turn end can arrive while it is awaited.
    if (stopped) chat.stopped = stopped;
    let result: InterruptChatResponse | undefined;
    try {
      result = await this.stopTurn(chat, stoppedAt);
    } finally {
      if (!result?.interrupted && chat.stopped === stopped) chat.stopped = null;
    }
    this.touch(chat);
    await this.publish({
      type: 'chat.interrupted',
      payload: {
        chatId,
        interrupted: result.interrupted,
        queue: result.queue,
      },
    });
    return result;
  }

  private async stopTurn(chat: RuntimeChat, stoppedAt?: string): Promise<InterruptChatResponse> {
    // While the provider is processing, every saved message is on its queue or about to start, and a stop cancels both.
    const stopped = new Set(chat.provider.isProcessing() ? chat.commands.state.queue.map(({ id }) => id) : []);
    // A stop takes every waiting message at once: the turn it ends is reported before their removal is on disk.
    const pending = chat.pendingMessageIds;
    chat.pendingMessageIds = [];
    const stopping = Promise.withResolvers<void>();
    // An earlier Stop still running may be the one that takes the turn's message.
    const stops: Promise<void> = Promise.all([chat.stopping, stopping.promise]).then(() => {
      if (chat.stopping === stops) chat.stopping = null;
    });
    chat.stopping = stops;
    const result = await chat.provider.interrupt((messageIds) => this.forgetPendingMessages(chat, messageIds), stoppedAt).catch((error) => {
      // A message that started while the stop was failing is no longer pending; the provider put the rest back on its queue.
      const queued = new Set(chat.provider.getQueue().map(({ id }) => id));
      chat.pendingMessageIds = [...new Set([...pending.filter((id) => queued.has(id)), ...chat.pendingMessageIds])];
      throw error;
    }).finally(() => stopping.resolve());
    const kept = new Set(chat.provider.getQueue().map(({ id }) => id));
    const { state } = chat.commands;
    const queue = state.queue.filter(({ id }) => kept.has(id) || !stopped.has(id));
    if (queue.length !== state.queue.length) {
      state.queue = queue;
      await chat.commands.save();
    }
    this.endTrackedTurn(chat);
    chat.hasActiveTurn = false;
    chat.activeMessageId = null;
    chat.acceptedUserEvents.clear();
    chat.turnAnswer.clear();
    return result;
  }

  async clearGoal(chatId: string): Promise<ClearChatGoalResponse> {
    const chat = this.requireChat(chatId);
    if (!chat.provider.clearGoal) {
      return { interrupted: false, queue: [], goal: null };
    }
    // Clearing a Claude goal runs a session turn outside the message queue.
    this.cancelIdleRelease(chat);
    await chat.release;
    this.requireChat(chatId);

    const interruptResult = await this.stopTurn(chat);

    const goal = await chat.provider.clearGoal(chat.persisted.model).finally(() => {
      chat.live = !!chat.provider.dispose;
      this.scheduleIdleRelease(chat);
    });
    this.touch(chat);
    await this.publish({
      type: 'chat.interrupted',
      payload: {
        chatId,
        interrupted: interruptResult.interrupted,
        queue: interruptResult.queue,
      },
    });
    await this.publish({
      type: 'chat.updated',
      payload: { chat: this.toSummary(chat) },
    });

    return {
      interrupted: interruptResult.interrupted,
      queue: interruptResult.queue,
      queueSenderUserIds: interruptResult.queueSenderUserIds,
      goal,
    };
  }

  async updateGoal(chatId: string, request: UpdateChatGoalRequest): Promise<UpdateChatGoalResponse> {
    const chat = this.requireChat(chatId);
    // Codex starts a resumed goal's turn at once, and only a turn the message queue runs answers its approvals and reads as working.
    if (request.status === 'active' && chat.provider.updateGoal) {
      const continuation = getChatContinuation(this.listChats(), chatId);
      if (continuation) return this.updateGoal(continuation.id, request);
      if (request.objective !== undefined) await chat.provider.updateGoal({ objective: request.objective });
      await this.sendMessage(chatId, { message: '/goal resume' });
      return { goal: chat.provider.getGoal?.() ?? null };
    }
    const goal = chat.provider.updateGoal ? await chat.provider.updateGoal(request) : null;
    this.touch(chat);
    await this.publish({
      type: 'chat.updated',
      payload: { chat: this.toSummary(chat) },
    });
    return { goal };
  }

  async updateDisplayName(chatId: string, displayName: string): Promise<ChatSummary> {
    const chat = this.requireChat(chatId);
    const previousDisplayName = chat.persisted.displayName;
    chat.persisted.displayName = displayName;
    try {
      await this.persistAllChats();
    } catch (error) {
      chat.persisted.displayName = previousDisplayName;
      throw error;
    }
    const summary = this.toSummary(chat);
    // Sleep captures write revision keys, so the sleeping tab list only sees a rename via the canonical upload.
    if (hasChatStarted(summary)) this.uploadChatTranscript(chat);
    await this.publish({ type: 'chat.updated', payload: { chat: summary } });
    return summary;
  }

  getChatQueue(chatId: string): ChatQueueResponse {
    const chat = this.requireChat(chatId);
    return {
      chatId,
      processing: hasActiveChatTurn(chat),
      queue: chat.provider.getQueue().map((message) => (chat.steeringOnArrival.has(message.id) && !message.steeredAt
        ? { ...message, steeredAt: message.queuedAt }
        : message)),
    };
  }

  private async withUnpublishedHistory<T>(chat: RuntimeChat, run: () => Promise<T>): Promise<T> {
    const start = { at: chat.history.end, swapCount: chat.history.swapCount };
    chat.unpublishedHistoryStarts.push(start);
    try {
      return await run();
    } finally {
      chat.unpublishedHistoryStarts.splice(chat.unpublishedHistoryStarts.indexOf(start), 1);
    }
  }

  private publishQueueIfChanged(chatId: string): void {
    const chat = this.getRuntimeChat(chatId);
    if (!chat) return;
    const payload = this.getChatQueue(chatId);
    const serialized = JSON.stringify(payload);
    if (serialized === chat.publishedQueue) return;
    chat.publishedQueue = serialized;
    this.publish({ type: 'chat.queue.changed', payload }).catch((error) => {
      console.error('[ChatService] Failed to publish chat queue:', { chatId, error });
    });
  }

  private async forgetPendingMessages(chat: RuntimeChat, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.withUnpublishedHistory(chat, async () => {
      const removed = new Set(messageIds);
      const event: AgentEvent = {
        timestamp: new Date().toISOString(),
        type: QUEUED_MESSAGE_REMOVED_EVENT_TYPE,
        payload: { [REMOVED_MESSAGE_IDS_PAYLOAD_KEY]: [...removed] },
      };
      const { state } = chat.commands;
      const queued = state.queue.filter(({ id }) => removed.has(id));
      const newlyRemoved = messageIds.filter((id) => !state.removed.includes(id));
      const previousCheckFrom = state.checkFrom;
      state.queue = state.queue.filter(({ id }) => !removed.has(id));
      if (state.queue.length === 0 && state.removing.length === 0) state.checkFrom = chat.history.historyEnd;
      state.removed.push(...newlyRemoved);
      state.removing.push(...messageIds);
      try {
        await chat.commands.save();
        await chat.history.record(event).written;
      } catch (error) {
        // The provider puts the messages back on its queue when their removal cannot be saved.
        state.queue.push(...queued);
        state.checkFrom = previousCheckFrom;
        state.removed = state.removed.filter((id) => !newlyRemoved.includes(id));
        state.removing = state.removing.filter((id) => !removed.has(id));
        await chat.commands.save().catch((saveError) => {
          console.error('[ChatService] Failed to put messages back in the command file:', { chatId: chat.persisted.id, error: saveError });
        });
        throw error;
      }
      // Written with the next save: until then a restart only checks that the record is there.
      state.removing = state.removing.filter((id) => !removed.has(id));
      chat.pendingMessageIds = chat.pendingMessageIds.filter((messageId) => !removed.has(messageId));
      this.forkSourceSeenBlocks.delete(chat.persisted.id);
      for (const messageId of removed) {
        chat.acceptedUserEvents.delete(messageId);
        chat.errorNotificationTargets.delete(messageId);
      }
      await this.publish({
        type: 'chat.turn.delta',
        payload: { chatId: chat.persisted.id, event },
      }).catch((error) => {
        console.error('[ChatService] Failed to publish queued-message removals:', error);
      });
      this.publish({
        type: 'chat.updated',
        payload: { chat: this.toSummary(chat) },
      }).catch(() => {});
    });
  }

  async removeFromQueue(chatId: string, messageId: string): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    const success = await chat.provider.removeFromQueue(messageId, () => this.forgetPendingMessages(chat, [messageId]));
    return {
      success,
      queue: chat.provider.getQueue(),
      removedMessageIds: success ? [messageId] : [],
    };
  }

  async clearQueue(chatId: string): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    let queuedIds: string[] = [];
    const success = await chat.provider.clearQueue(async (messageIds) => {
      queuedIds = messageIds;
      await this.forgetPendingMessages(chat, messageIds);
    });
    return {
      success,
      queue: chat.provider.getQueue(),
      removedMessageIds: success ? queuedIds : [],
    };
  }

  async updateQueuedMessage(chatId: string, messageId: string, message: string): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    const success = chat.provider.updateQueuedMessage(messageId, message);
    if (success) {
      const queued = chat.commands.state.queue.find(({ id }) => id === messageId);
      if (queued) {
        queued.message = message;
        await chat.commands.save();
      }
      // The accepted-event snapshot must track the edit: dedupe against the
      // real transcript event is content-based, so a stale snapshot renders
      // the pre-edit text as an extra bubble and steals its sender attribution.
      const acceptedEvent = chat.acceptedUserEvents.get(messageId);
      if (acceptedEvent) {
        chat.acceptedUserEvents.set(messageId, {
          ...acceptedEvent,
          payload: { ...acceptedEvent.payload, message },
        });
      }
      if (chat.pendingMessageIds.at(-1) === messageId) {
        chat.persisted.lastMessageText = message.trim().slice(0, LAST_MESSAGE_PREVIEW_MAX) || null;
        this.touch(chat);
      }
    }
    return {
      success,
      queue: chat.provider.getQueue(),
    };
  }

  async reorderQueue(chatId: string, messageId: string, position: number): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    const success = chat.provider.reorderQueue(messageId, position);
    if (success) await this.saveQueueOrder(chat);
    return {
      success,
      queue: chat.provider.getQueue(),
    };
  }

  private async saveQueueOrder(chat: RuntimeChat): Promise<void> {
    const order = new Map(chat.provider.getQueue().map(({ id }, index) => [id, index]));
    const { state } = chat.commands;
    if (chat.requeued && order.has(chat.requeued.id)) delete chat.requeued;
    // A message the provider no longer lists is about to start, so it stays first. One a send-now cut is listed only once its turn has ended, and stays behind the message that cut it.
    const rank = (id: string): number => order.get(id) ?? (id === chat.requeued?.id ? (order.get(chat.requeued.afterId) ?? -1) + 0.5 : -1);
    const queue = [...state.queue].sort((a, b) => rank(a.id) - rank(b.id));
    if (queue.every((message, index) => message === state.queue[index])) return;
    state.queue = queue;
    await chat.commands.save();
  }

  async steerFromQueue(chatId: string, messageId: string): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    const result = await chat.provider.steerFromQueue(messageId);
    if (result.success) {
      chat.pendingMessageIds = chat.pendingMessageIds.filter((pendingMessageId) => pendingMessageId !== messageId);
      this.publishQueueIfChanged(chatId);
    }
    return result;
  }

  async sendNow(chatId: string, messageId: string): Promise<QueueMutationResponse> {
    const chat = this.requireChat(chatId);
    const result = await chat.provider.sendNow(messageId);
    const waiting = result.queue.find(({ id }) => id === messageId);
    // A steered message is no longer pending, even when the cut for it was not taken.
    if (waiting ? waiting.steeredAt : result.success) {
      chat.pendingMessageIds = chat.pendingMessageIds.filter((pendingMessageId) => pendingMessageId !== messageId);
      this.publishQueueIfChanged(chatId);
    }
    return result;
  }

  async respondToToolInput(
    chatId: string,
    requestId: string,
    selectionId: string,
  ): Promise<boolean> {
    const chat = this.requireChat(chatId);
    if (!chat.provider.respondToToolInput) {
      return false;
    }
    return chat.provider.respondToToolInput(requestId, selectionId);
  }

  async deleteChat(chatId: string): Promise<void> {
    this.requireChat(chatId);

    const toDelete = [chatId, ...this.collectDescendants(chatId)];
    const deletedAt = new Date().toISOString();

    for (const id of toDelete) {
      const target = this.chats.get(id);
      if (!target || target.persisted.deletedAt) continue;

      if (target.provider.isProcessing()) {
        await target.provider.interrupt((messageIds) => this.forgetPendingMessages(target, messageIds)).catch(() => {});
        this.endTrackedTurn(target);
        target.hasActiveTurn = false;
        target.activeMessageId = null;
        target.pendingMessageIds = [];
        target.acceptedUserEvents.clear();
      }

      // Started chats are soft-deleted so tab history can restore them (the next
      // message resumes the session); pristine ones are removed outright. Hide the
      // chat before releasing so senders waiting on the release are rejected.
      const started = hasChatStarted(this.toSummary(target));
      if (started) {
        target.persisted.deletedAt = deletedAt;
        target.commands.state.queue = [];
        delete target.commands.state.running;
        delete target.commands.state.lost;
        await target.commands.save();
      } else {
        this.chats.delete(id);
      }
      await this.releaseAgentProcess(target);
      if (!started) {
        await target.history.flush();
        await this.deleteHistoryFile(target.persisted);
        await target.commands.remove();
      }
      await this.publish({ type: 'chat.deleted', payload: { chatId: id, chat: this.toSummary(target) } });
    }

    await this.persistAllChats();
    this.notifyWorkspaceAgentIdle();
  }

  async restoreChat(chatId: string): Promise<ChatSummary> {
    const chat = this.chats.get(chatId);
    if (!chat?.persisted.deletedAt) {
      throw new ChatNotFoundError(chatId);
    }

    // A live chat may have re-taken the default title while this one sat in
    // history; default titles must stay unique or the tab strip drops one.
    if (
      isDefaultChat(chat.persisted)
      && Array.from(this.chats.values()).some((other) => (
        other !== chat
        && !other.persisted.deletedAt
        && other.persisted.provider === chat.persisted.provider
        && other.persisted.title === chat.persisted.title
      ))
    ) {
      chat.persisted.title = `${chat.persisted.title} (restored)`;
    }

    const { deletedAt } = chat.persisted;
    const restoredAt = new Date().toISOString();
    for (const id of [chatId, ...this.collectDescendants(chatId)]) {
      const target = this.chats.get(id);
      // Children deleted on their own (like a closed side chat) stay deleted; only the delete cascade is undone.
      if (!target?.persisted.deletedAt || target.persisted.deletedAt !== deletedAt) continue;
      target.persisted.deletedAt = null;
      target.persisted.updatedAt = restoredAt;
      await this.publish({ type: 'chat.created', payload: { chat: this.toSummary(target) } });
    }

    // Keeping the sources' updatedAt keeps them read as the start of this chat rather than a diverged one.
    for (let fork = chat.persisted.fork; fork?.trigger === 'auto' || fork?.trigger === 'switch';) {
      const source = this.chats.get(fork.source.chatId);
      if (!source?.persisted.deletedAt || (fork.trigger === 'auto' && source.persisted.updatedAt > fork.startedAt)) break;
      source.persisted.deletedAt = null;
      await this.publish({ type: 'chat.created', payload: { chat: this.toSummary(source) } });
      fork = source.persisted.fork;
    }
    await this.persistAllChats();
    return this.toSummary(chat);
  }

  /**
   * Recursively collects all descendant chat IDs of a given parent.
   */
  private collectDescendants(parentId: string, visited = new Set<string>()): string[] {
    if (visited.has(parentId)) return [];
    visited.add(parentId);
    const descendants: string[] = [];
    for (const [id, chat] of this.chats) {
      if (chat.persisted.parentChatId === parentId) {
        descendants.push(id);
        descendants.push(...this.collectDescendants(id, visited));
      }
    }
    return descendants;
  }

  private async deleteHistoryFile(persisted: PersistedChat): Promise<void> {
    const historyPath = this.historyPath(persisted);
    await Promise.all([
      historyPath,
      `${historyPath}.pages.jsonl`,
      `${historyPath}.pages.index.json`,
    ].map((path) => rm(path, { force: true })));
    await rm(chatMessageSendersFilePath(persisted.id), { force: true });
    await rm(join(FORKS_DIR, persisted.id), { recursive: true, force: true });
  }

  private switchHarness(source: RuntimeChat, request: SendChatMessageRequest & { provider: EngineAgentProvider }): Promise<SendChatMessageResponse> {
    const switching = (async () => {
      if (source.persisted.parentChatId !== null) throw new ChatBusyError('Side chats and subagents keep their harness.');
      if (source.provider.getGoal?.()) throw new ChatBusyError('Clear the goal before switching harness.');
      if (request.replacesMessageId) throw new ChatBusyError('Send the edited message first, then switch harness.');
      if (!isAgentAvailable(request.provider)) throw new ChatProviderUnavailableError(request.provider);
      await source.lastSendAcceptance?.catch(() => {});
      const carried = (await source.provider.queuedRequests()).map(({ id: _id, queuedAt: _queuedAt, engineTurn: _engineTurn, ...queued }) => queued);
      // Background tasks alone end when the process is released below; stopping them would mark a finished turn as stopped.
      if (hasActiveChatTurn(source) || carried.length > 0) await this.interrupt(source.persisted.id);
      const { provider, ...message } = request;
      let target: RuntimeChat | undefined;
      let response: SendChatMessageResponse;
      try {
        target = this.requireChat((await this.createForkTarget(source.persisted.id, { provider, model: request.model }, 'switch')).id);
        response = await this.sendMessage(target.persisted.id, message);
        // Queued messages were accepted with the old harness's model and options, so they take the switch's.
        const harnessOptions = { model: message.model, thinkingLevel: message.thinkingLevel, inheritThinkingLevel: message.inheritThinkingLevel, fastMode: message.fastMode, ultrafastMode: message.ultrafastMode };
        for (const queued of carried) await this.sendMessage(target.persisted.id, { ...queued, ...harnessOptions });
      } catch (error) {
        if (target) {
          await this.deleteChat(target.persisted.id).catch((deleteError) => {
            console.error('[ChatService] Failed to remove the chat of a failed harness switch:', { chatId: target?.persisted.id, error: deleteError });
          });
        }
        // The stop took these off the old chat's queue; they go back there rather than nowhere, past the retry check that would answer them as already sent.
        source.switching = null;
        for (const queued of carried) {
          const key = queued.idempotencyKey ?? queued.messageId;
          if (key) source.commands.state.accepted.delete(key);
          await this.sendMessage(source.persisted.id, queued).catch((restoreError) => {
            console.error('[ChatService] Failed to requeue a message after a failed harness switch:', { chatId: source.persisted.id, error: restoreError });
          });
        }
        throw error;
      }
      const children = [...this.chats.values()].filter((chat) => chat.persisted.parentChatId === source.persisted.id);
      for (const child of children) child.persisted.parentChatId = target.persisted.id;
      await this.persistAllChats();
      await Promise.all(children.map((child) => this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(child) } })));
      // Anything that would still wake the old agent (a background task finishing) belongs to the new one now.
      void this.releaseAgentProcess(source);
      return { ...response, chatId: target.persisted.id };
    })();
    source.switching = switching;
    return switching.finally(() => {
      if (source.switching === switching) source.switching = null;
    });
  }

  /** Resolves once the target chat exists; the handoff and its first turn run in the background. */
  async forkChat(
    sourceChatId: string,
    request: ForkChatRequest,
    trigger: ChatForkTrigger = 'manual',
    reason?: AgentFallbackReason,
  ): Promise<ChatSummary> {
    const target = await this.createForkTarget(sourceChatId, request, trigger, reason);
    this.runFork(target.id, request).catch((error) => {
      console.error('[ChatService] Fork failed:', { sourceChatId, targetChatId: target.id, error });
    });
    return target;
  }

  private async createForkTarget(
    sourceChatId: string,
    request: ForkChatRequest,
    trigger: ChatForkTrigger,
    reason?: AgentFallbackReason,
  ): Promise<ChatSummary> {
    const source = this.requireChat(sourceChatId);
    if (trigger !== 'auto' && !isAgentAvailable(request.provider)) {
      throw new ChatProviderUnavailableError(request.provider);
    }
    const continues = trigger === 'auto' || trigger === 'switch';
    return this.createChat({
      id: request.id,
      provider: request.provider,
      title: request.title?.trim() || defaultForkChatTitle(source.persisted, request.provider),
      ...(continues ? {
        displayName: getContinuedChatName(source.persisted, request.provider),
      } : {}),
      ...(trigger === 'switch' ? { pendingForkHandoff: true, model: request.model } : {}),
      clientRequestId: request.clientRequestId,
      fork: createForkInfo(source.persisted, trigger, new Date().toISOString(), reason),
      ...(continues ? { kind: source.persisted.kind } : {}),
    });
  }

  private async threadSegments(chat: RuntimeChat): Promise<ForkHandoffSegment[]> {
    const thread = [...getChatThreadSources(this.listChats(), this.toSummary(chat)).map(({ id }) => this.requireChat(id)), chat];
    // Provider history reads flush pending writes before the handoff reads the file.
    await chat.provider.getHistory({ limit: 1 });
    return Promise.all(thread.map(async ({ persisted, history }) => ({ chatId: persisted.id, provider: persisted.provider, senders: await this.readSenders(persisted.id), openHistory: () => history.openAtFlushedEnd() })));
  }

  private async createForkHandoffMessage(
    targetChatId: string,
    options: Pick<ChatForkHandoff, 'source' | 'trigger' | 'reason' | 'message' | 'subagent' | 'sourceModel' | 'model'> & { turnLimit?: number; followsSource?: boolean },
  ): Promise<string> {
    const follows = options.trigger === 'side' || options.followsSource;
    const source = this.requireChat((follows && getCurrentChat(this.listChats(), options.source.chatId)?.id) || options.source.chatId);
    const handoff = await buildForkHandoff({
      segments: await this.threadSegments(source),
      targetChatId,
      turnLimit: options.turnLimit,
    });
    // A native fork's own event log starts empty, so the note keeps the inherited history reachable from later handoffs.
    if (!options.subagent && !options.followsSource && options.trigger !== 'side' && await this.forkProviderSession(source, this.requireChat(targetChatId))) {
      const note = wrapInTag(`This chat is a fork of "${options.source.title}": the conversation so far is that chat's history up to when you were forked, also saved at \`${handoff.transcriptPath}\`. The original chat carries on separately in this workspace, so files and git state may have changed since.`, OKIDOKI_INSTRUCTIONS_TAG);
      return `${options.message?.trim() || 'Confirm in a sentence that you have the context, then wait for the next request.'}\n\n${note}`;
    }
    if (options.trigger !== 'side' && !options.followsSource) return formatChatForkHandoffMessage({ ...handoff, ...options });
    const seen = this.forkSourceSeenBlocks.get(targetChatId);
    this.forkSourceSeenBlocks.set(targetChatId, hashTranscriptBlocks(handoff.blocks));
    if (!seen) return formatChatForkHandoffMessage({ ...handoff, ...options });
    const unseen = options.followsSource ? unseenConversationExcerpt(seen, handoff.blocks) : unseenTurnsExcerpt(seen, handoff.blocks);
    return unseen ? formatChatForkUpdateMessage(options.source, options.trigger, unseen, options.message ?? '') : options.message ?? '';
  }

  private async rewindBefore(chat: RuntimeChat, messageId: string, message: string): Promise<string> {
    if (chat.provider.isProcessing() || chat.provider.getQueue().length > 0 || chat.provider.hasActiveBackgroundTasks?.()) {
      throw new ChatBusyError('Stop the agent before editing a message.');
    }
    const files = 'Files and git state may still include changes from turns that came after the original message.';
    const point = await chat.provider.forkPoint?.(messageId).catch((error: unknown) => {
      console.warn('[ChatService] Could not find the edited message in the agent session; restarting it:', { chatId: chat.persisted.id, error });
      return null;
    });
    if (point && chat.provider.forkFrom) {
      chat.persisted.pendingProviderFork = point;
      await this.persistAllChats();
      await chat.provider.forkFrom(point);
      return `${message}\n\n${wrapInTag(`The user edited one of their earlier messages: the conversation above ends where that message was, and this is its edited version. ${files}`, OKIDOKI_INSTRUCTIONS_TAG)}`;
    }
    const handoff = await buildForkHandoff({
      segments: await this.threadSegments(chat),
      targetChatId: chat.persisted.id,
      beforeMessageId: messageId,
      transcriptName: 'transcript-before-edit.md',
    });
    await chat.provider.dispose?.();
    chat.persisted.providerSessionId = null;
    delete chat.persisted.pendingProviderFork;
    await this.persistAllChats();
    chat.provider = this.createRuntimeChat(chat.persisted, chat.commands, chat.history).provider;
    const note = handoff.blocks.length === 0
      ? `The user edited their first message, so your session restarted and this is its edited version. ${files}`
      : `The user edited one of their earlier messages, so your session restarted. The conversation before that message is below (also saved at \`${handoff.transcriptPath}\`), and this is its edited version. ${files}\n\n${handoff.excerptTruncated ? `${CHAT_FORK_EXCERPT_OMITTED_NOTICE}\n\n` : ''}${handoff.excerpt}`;
    return `${message}\n\n${wrapInTag(note, OKIDOKI_INSTRUCTIONS_TAG)}`;
  }

  private async forkProviderSession(source: RuntimeChat, target: RuntimeChat, point?: ProviderForkPoint): Promise<boolean> {
    if (source.persisted.provider !== target.persisted.provider || !source.provider.forkPoint || !target.provider.forkFrom) return false;
    const { forkedThroughTurn, pendingProviderFork } = target.persisted;
    try {
      point ??= await source.provider.forkPoint() ?? undefined;
      if (!point) return false;
      target.persisted.forkedThroughTurn = point.throughTurn;
      target.persisted.pendingProviderFork = point;
      await this.persistAllChats();
      await target.provider.forkFrom(point);
      return true;
    } catch (error) {
      target.persisted.forkedThroughTurn = forkedThroughTurn;
      target.persisted.pendingProviderFork = pendingProviderFork;
      console.warn('[ChatService] Native fork failed; using the transcript handoff:', { sourceChatId: source.persisted.id, targetChatId: target.persisted.id, error });
      return false;
    }
  }

  private async followForkSource(chat: RuntimeChat, fork: ChatForkInfo, message: string): Promise<string> {
    const source = this.requireChat(getCurrentChat(this.listChats(), fork.source.chatId)?.id ?? fork.source.chatId);
    if (source.persisted.provider === chat.persisted.provider && source.provider.forkPoint && chat.provider.forkFrom) {
      // Replacing the session under a running or queued turn would drop it, so a busy chat keeps its session.
      if (chat.provider.isProcessing() || chat.provider.getQueue().length > 0) return message;
      const point = await source.provider.forkPoint().catch(() => null);
      if (!point || point.throughTurn === chat.persisted.forkedThroughTurn) return message;
      if (await this.forkProviderSession(source, chat, point)) {
        const note = wrapInTag(`Okidoki re-forked this chat from "${fork.source.title}" so you have its latest context. Your own earlier turns are not in this history: your earlier fixes are in git and the notes file.`, OKIDOKI_INSTRUCTIONS_TAG);
        return `${message}\n\n${note}`;
      }
    }
    return this.createForkHandoffMessage(chat.persisted.id, { source: fork.source, trigger: fork.trigger, message, followsSource: true });
  }

  private async runFork(
    targetId: string,
    request: ForkChatRequest,
    errorNotificationTargets?: IntegrationErrorNotificationTarget[],
  ): Promise<boolean> {
    const target = this.chats.get(targetId);
    const fork = target?.persisted.fork;
    if (!target || !fork) return false;
    try {
      // Re-checked here because the credentials can go between choosing this harness and reaching it.
      if (!isAgentAvailable(target.persisted.provider)) throw new ChatProviderUnavailableError(request.provider);
      const message = await this.createForkHandoffMessage(targetId, {
        source: fork.source,
        trigger: fork.trigger,
        reason: fork.reason,
        message: request.message,
      });
      if (target.persisted.deletedAt) return false;

      await this.sendMessage(targetId, {
        message,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        enableInteractiveTools: request.enableInteractiveTools,
        senderUserId: request.senderUserId,
        senderEmail: request.senderEmail,
        senderDisplayName: request.senderDisplayName,
        senderAvatarUrl: request.senderAvatarUrl,
        errorNotificationTargets,
        idempotencyKey: `chat-fork:${targetId}`,
      });
    } catch (error) {
      if (target.persisted.deletedAt) return false;
      const message = error instanceof Error ? error.message : String(error);
      await this.updateFork(target, { state: 'failed', error: message.slice(0, 500), completedAt: new Date().toISOString() });
      throw error;
    }
    await this.updateFork(target, { state: 'ready', completedAt: new Date().toISOString() }).catch((error) => {
      console.error('[ChatService] Failed to finalize accepted fork:', { targetId, error });
    });
    return true;
  }

  private async updateFork(chat: RuntimeChat, patch: Partial<ChatForkInfo>): Promise<void> {
    if (!chat.persisted.fork) return;
    chat.persisted.fork = { ...chat.persisted.fork, ...patch };
    chat.persisted.updatedAt = new Date().toISOString();
    await this.persistAllChats();
    await this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } });
  }

  /** Providers of this chat and every chat it fell back from, so a fallback never loops back. A user's switch starts over. */
  private forkChainProviders(chat: RuntimeChat): AgentProvider[] {
    const providers = new Set<AgentProvider>();
    for (let current: RuntimeChat | undefined = chat; current;) {
      providers.add(current.persisted.provider);
      if (current.persisted.fork?.trigger !== 'auto') break;
      const source = this.chats.get(current.persisted.fork.source.chatId);
      if (!source) providers.add(current.persisted.fork.source.provider);
      current = source;
    }
    return [...providers];
  }

  private async autoForkAfterQuota(chat: RuntimeChat, exhaustion: AgentQuotaExhaustedPayload): Promise<boolean> {
    const target = exhaustion.forkTo;
    if (!target || chat.persisted.deletedAt || chat.persisted.fork?.trigger === 'side') return false;
    // One continuation per source chat: a repeat limit on the same chat, or one the user switched away from, has one.
    const alreadyContinued = Boolean(chat.switching) || [...this.chats.values()].some((other) => (
      (other.persisted.fork?.trigger === 'auto' || other.persisted.fork?.trigger === 'switch')
      && other.persisted.fork.source.chatId === chat.persisted.id && !other.persisted.deletedAt
    ));
    if (alreadyContinued) return false;
    const last = chat.lastSendRequest;
    const request: ForkChatRequest = {
      provider: target.provider,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
      enableInteractiveTools: last?.enableInteractiveTools,
      senderUserId: last?.senderUserId,
      senderEmail: last?.senderEmail,
      senderDisplayName: last?.senderDisplayName,
      senderAvatarUrl: last?.senderAvatarUrl,
    };
    const fallback = await this.createForkTarget(chat.persisted.id, request, 'auto', exhaustion.reason);
    const accepted = await this.runFork(fallback.id, request, chat.activeErrorNotificationTargets);
    if (!accepted) return false;
    chat.lastTurnErrors = null;
    chat.activeErrorNotificationTargets = [];
    return true;
  }

  async getChatHistoryRecord(chatId: string, record: ChatHistoryRecordRange): Promise<AgentEvent | undefined> {
    return this.requireChat(chatId).history.readRecord(record);
  }

  async getChatHistory(chatId: string, page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    const chat = this.requireChat(chatId);
    const versionBeforeRead = this.toSummary(chat).historyVersion;
    const [history, senders] = await Promise.all([
      chat.provider.getHistory(page),
      this.readSenders(chatId),
    ]);
    const historyEvents = excludeQueuedAcceptedEvents(
      mergeWorkspaceChatHistoryEvents([], history.events),
      chat.provider.getQueue(),
      chat.commands.state.removed,
    );
    for (const [messageId, acceptedEvent] of chat.acceptedUserEvents) {
      if (historyEvents.some((event) => isSameAcceptedUserEvent(event, acceptedEvent))) {
        chat.acceptedUserEvents.delete(messageId);
      }
    }
    const isLatestPage = isLatestChatHistoryPage(page);
    const historyVersion = isLatestPage && versionBeforeRead === this.toSummary(chat).historyVersion
      ? versionBeforeRead
      : undefined;
    // A prompt still in the provider queue is queued, not starting: the
    // previous turn's completion hook can run for seconds after hasActiveTurn
    // clears while the provider still reports processing, and without this
    // check a message sent in that window shows in history and the queue at once.
    const queuedMessageIds = new Set(chat.provider.getQueue().map((message) => message.id));
    const acceptedEvents = (isLatestPage ? [...chat.acceptedUserEvents.entries()] : [])
      .filter(([messageId]) => (
        messageId === chat.activeMessageId
        || (!chat.hasActiveTurn && chat.pendingMessageIds[0] === messageId && !queuedMessageIds.has(messageId))
      ))
      .map(([, acceptedEvent]) => acceptedEvent)
      .filter((acceptedEvent) => !historyEvents.some((event) => isSameAcceptedUserEvent(event, acceptedEvent)));
    const events = excludeQueuedAcceptedEvents(
      [...historyEvents, ...acceptedEvents].sort((a, b) => getEventTimestampMs(a) - getEventTimestampMs(b)),
      [],
      chat.commands.state.removed,
    );
    if (history.appendsAfter !== undefined || (page.limit !== undefined && 'beforeCursor' in history)) {
      const response = {
        ...history,
        historyVersion,
        events,
        removedMessageIds: chat.commands.state.removed,
        goal: history.goal ?? chat.provider.getGoal?.() ?? null,
        senders: getChatHistoryPageSenders(senders, page),
      };
      if (history.appendsAfter !== undefined) return response;
      const cursor = parseChatHistoryCursor(history.beforeCursor ?? undefined);
      return {
        ...response,
        beforeCursor: createChatHistoryCursor({
          events: cursor?.events ?? null,
          turns: cursor?.turns ?? null,
        }),
      };
    }
    if (history.eventsStartIndex !== undefined) {
      return {
        ...history,
        historyVersion,
        events,
        removedMessageIds: chat.commands.state.removed,
        totalEvents: (history.totalEvents ?? history.eventsStartIndex + history.events.length)
          - (history.events.length - historyEvents.length)
          + acceptedEvents.length,
        goal: history.goal ?? chat.provider.getGoal?.() ?? null,
        senders,
      };
    }
    return paginateChatHistory({
      thread_id: history.thread_id,
      historyVersion,
      events,
      removedMessageIds: chat.commands.state.removed,
      goal: history.goal ?? chat.provider.getGoal?.() ?? null,
      senders,
    }, page);
  }

  getProcessingCount(): number {
    let count = 0;
    for (const chat of this.chats.values()) {
      if (!chat.persisted.deletedAt && hasActiveAgentWork(chat)) {
        count += 1;
      }
    }
    return count;
  }

  getActiveTurnCount(): number {
    return [...this.chats.values()].filter((chat) => !chat.persisted.deletedAt && hasActiveChatTurn(chat)).length;
  }

  private toTranscriptSource(chat: RuntimeChat): ChatTranscriptSource {
    return {
      ...this.toSummary(chat),
      removedMessageIds: chat.commands.state.removed,
      openHistory: () => chat.history.openAtFlushedEnd(),
      subagentIndex: (opened) => chat.history.subagentIndexOf(opened),
      transcriptAuth: chat.persisted.transcriptAuth,
      currentHistoryVersion: () => this.toSummary(chat).historyVersion,
    };
  }

  private historyPath(persisted: PersistedChat): string {
    return join(HISTORY_DIR_BY_PROVIDER[persisted.provider], `${persisted.id}.jsonl`);
  }

  private async recordUploadedHistory(chatId: string, artifact: ChatTranscriptArtifact | null): Promise<void> {
    const chat = this.getRuntimeChat(chatId);
    const version = artifact?.metadata.historyVersion;
    if (!chat || !artifact || !version || version !== this.toSummary(chat).historyVersion) return;
    chat.persisted.uploadedHistory = { version, size: artifact.size };
    await this.persistAllChats();
  }

  private uploadChatTranscript(chat: RuntimeChat): void {
    const chatId = chat.persisted.id;
    uploadChatTranscript(
      chatId,
      this.historyPath(chat.persisted),
      this.toTranscriptSource(chat),
    ).then((artifact) => this.recordUploadedHistory(chatId, artifact)).catch((err) => {
      console.error('[ChatService] Failed to upload chat transcript:', { chatId, err });
    });
  }

  private persistTurnArtifacts(chat: RuntimeChat): void {
    chat.provider.getHistory({ limit: 1 }).then(() => {
      this.uploadChatTranscript(chat);
      return flushAllCanvasItems();
    }).catch((err) => {
      console.error('[ChatService] Failed to persist turn artifacts:', { chatId: chat.persisted.id, err });
    });
  }

  async flushAllChatTranscripts(): Promise<{ flushed: number; failed: number }> {
    return flushAllChatTranscripts(new Map(
      [...this.chats.entries()].map(([chatId, chat]) => [chatId, this.toTranscriptSource(chat)]),
    ), undefined, (chatId, artifact) => this.recordUploadedHistory(chatId, artifact));
  }

  async flushAllWorkspaceArtifacts(
    capture?: EngineWorkspaceArtifactsFlushRequest,
  ): Promise<EngineWorkspaceArtifactsFlushResponse> {
    const chatsById = new Map(
      [...this.chats.entries()].map(([chatId, chat]) => [chatId, this.toTranscriptSource(chat)]),
    );
    const [chatTranscripts, canvas, repoState, engineLogs, [chatActivity]] = await Promise.all([
      flushAllChatTranscripts(chatsById, capture, (chatId, artifact) => this.recordUploadedHistory(chatId, artifact)),
      flushAllCanvasItems(),
      flushRepoState(),
      flushAllEngineLogs(),
      Promise.all([
        this.agentChatActivityTrackerService.flush(),
        this.agentTokenUsageTracker.flush(),
      ]),
    ]);
    return {
      chatTranscripts,
      canvas,
      repoState,
      engineLogs,
      turnActivity: chatActivity.turnActivity,
      skillActivity: chatActivity.skillActivity,
      mcpActivity: chatActivity.mcpActivity,
    };
  }

  /** `history` is passed when the chat already has its log: a second object on the same file would write over the first. */
  private createRuntimeChat(
    persisted: PersistedChat,
    commands = new ChatCommands(persisted.id),
    history = new CodexHistoryFile(this.historyPath(persisted), ({ type }) => STREAM_RECORD_TYPES.has(type)),
  ): RuntimeChat {
    const saveSession = async (sessionId: string | null): Promise<void> => {
      persisted.providerSessionId = sessionId;
      delete persisted.pendingProviderFork;
      persisted.updatedAt = new Date().toISOString();
      await this.persistAllChats();
      const chat = this.getRuntimeChat(persisted.id);
      if (!chat) return;
      await this.publish({
        type: 'chat.updated',
        payload: { chat: this.toSummary(chat) },
      });
    };

    const onProviderTurnComplete = async (undeliveredMessageId?: string): Promise<void> => {
      await this.handleTurnFinished(persisted.id, false, undeliveredMessageId);
    };

    const record = (event: AgentEvent): void => {
      this.handleTurnEvent(persisted.id, event, history);
    };

    const onProviderEvent = (event: AgentEvent): void => {
      this.handleTurnEvent(persisted.id, event);
    };

    const onProviderUsage = (payload: unknown, occurredAt: string): void => {
      this.agentTokenUsageTracker.noteUsage(persisted.id, payload, occurredAt);
    };

    const onMessageStarted = (message: QueuedMessage): Promise<void> =>
      this.handleTurnStarted(persisted.id, message);

    // Its turn had started, so it was no longer saved as queued: a restart would neither run it nor report it lost.
    const onMessageRequeued = (message: QueuedMessage, afterMessageId: string): void => {
      const chat = this.getRuntimeChat(persisted.id);
      const { state } = commands;
      if (!chat) return;
      // Only the running turn can be cut, and the provider lists it again before the next turn starts, so one cut is outstanding at a time.
      chat.requeued = { id: message.id, afterId: afterMessageId };
      if (state.queue.some(({ id }) => id === message.id)) return;
      const errorNotificationTargets = chat.activeErrorNotificationTargets;
      state.queue.splice(state.queue.findIndex(({ id }) => id === afterMessageId) + 1, 0, {
        ...message,
        ...(errorNotificationTargets.length > 0 ? { errorNotificationTargets } : {}),
      });
      if (errorNotificationTargets.length > 0) chat.errorNotificationTargets.set(message.id, errorNotificationTargets);
      // Saved as queued again, it is no longer the running turn: a restart now would otherwise report it lost and run it too.
      if (state.running?.id === message.id) delete state.running;
      chat.pendingMessageIds.splice(chat.pendingMessageIds.indexOf(afterMessageId) + 1, 0, message.id);
      commands.save().catch((error) => {
        console.error('[ChatService] Failed to save a message that runs again:', { chatId: persisted.id, error });
      });
    };

    const onChatCredential = (credential: AgentCredentialSnapshot | 'workspace'): void => {
      if (JSON.stringify(persisted.chatCredential) === JSON.stringify(credential)) return;
      persisted.chatCredential = credential;
      void (async () => {
        await this.persistAllChats();
        const chat = this.getRuntimeChat(persisted.id);
        if (chat) await this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } });
      })().catch((error) => {
        console.error('[ChatService] Failed to record chat credential:', { chatId: persisted.id, error });
      });
    };

    const onLastSenderKeyChanged = async (senderKey: string | null): Promise<void> => {
      persisted.lastSenderKey = senderKey ?? undefined;
      await this.persistAllChats();
    };

    const onProcessingChanged = (processing: boolean): void => {
      if (processing) return;
      this.handleProcessingStopped(persisted.id);
    };

    // Deferred so a burst of synchronous queue edits publishes only its final state.
    const onQueueChanged = (): void => queueMicrotask(() => {
      this.publishQueueIfChanged(persisted.id);
      const chat = this.getRuntimeChat(persisted.id);
      if (chat) {
        this.saveQueueOrder(chat).catch((error) => {
          console.error('[ChatService] Failed to save the queue order:', { chatId: persisted.id, error });
        });
      }
    });

    const fallbackContext = () => {
      const chat = this.chats.get(persisted.id);
      return {
        userId: chat?.lastSendRequest?.senderUserId,
        excludeProviders: chat ? this.forkChainProviders(chat) : [persisted.provider],
        // A subagent thread is driven by its parent's tool call, which a sibling chat would leave hanging.
        forkable: (chat?.persisted ?? persisted).parentChatId === null,
      };
    };

    // Follow-up messages omit the model and inherit the chat's, which must be one the new endpoint serves.
    const onModelSwitched = async (model: string): Promise<void> => {
      const chat = this.chats.get(persisted.id);
      if (!chat || chat.persisted.model === model) return;
      chat.persisted.model = model;
      await this.persistAllChats();
      await this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } }).catch((error) => {
        console.error('[ChatService] Failed to publish switched chat model:', { chatId: persisted.id, error });
      });
    };

    // Ensure parentChatId is set (backwards compat for old persisted data)
    if (persisted.parentChatId === undefined) {
      persisted.parentChatId = null;
    }

    let originChatId = persisted.id;
    for (let chat: PersistedChat | undefined = persisted; chat;) {
      const next: string | undefined = chat.parentChatId ?? chat.fork?.source.chatId;
      if (!next) break;
      originChatId = next;
      chat = this.chats.get(next)?.persisted;
    }

    const baseProvider = persisted.provider;
    const managerOptions = {
      provider: baseProvider,
      workingDirectory: this.workingDirectory,
      history,
      record,
      initialSessionId: persisted.providerSessionId,
      onSaveSessionId: saveSession,
      onTurnComplete: onProviderTurnComplete,
      onEvent: onProviderEvent,
      onProcessingChanged,
      onMessageStarted,
      onMessageRequeued,
      onQueueChanged,
      onUsageUpdate: onProviderUsage,
      fallbackContext,
      chatId: persisted.id,
      originChatId,
      chatTitle: () => persisted.title,
      // Claude maps the model on each turn while the fallback credential is live, so the chat keeps its own for when the primary returns.
      ...(baseProvider === 'claude' ? {} : { onModelSwitched }),
      onChatCredential,
      lastSenderKey: persisted.lastSenderKey,
      onLastSenderKeyChanged,
      previousTurnLost: Boolean(commands.state.running || (commands.state.lost && !commands.state.lost.told)),
      parentChatId: persisted.parentChatId,
    };

    let provider: CodingAgentProvider;
    if (baseProvider === 'claude') {
      provider = new ClaudeManager(managerOptions);
    } else if (baseProvider === 'cursor') {
      provider = new CursorManager(managerOptions);
    } else if (baseProvider === 'gemini') {
      provider = new GeminiManager(managerOptions);
    } else if (baseProvider === 'muse') {
      provider = new MuseManager(managerOptions);
    } else if (baseProvider === 'opencode') {
      provider = new OpencodeManager(managerOptions);
    } else if (baseProvider === 'pi') {
      provider = new PiManager(managerOptions);
    } else {
      const codexTokenUsage = new CodexTokenUsageAdapter(
        persisted.id,
        () => this.agentTokenUsageTracker.getTokenUsageContext(persisted.id),
        (event) => this.agentTokenUsageTracker.recordEvent(event),
      );
      provider = new CodexAspManager({
        pendingFork: persisted.pendingProviderFork,
        ...managerOptions,
        onCodexTurnStarted: codexTokenUsage.onTurnStarted,
        onCodexTokenUsage: codexTokenUsage.onTokenUsage,
        onCodexModelRerouted: codexTokenUsage.onModelRerouted,
        onCodexTurnCompleted: codexTokenUsage.onTurnCompleted,
      });
    }

    return {
      persisted,
      historyVersion: randomUUID(),
      provider,
      pendingMessageIds: [],
      steeringOnArrival: new Set(),
      acceptedUserEvents: new Map(),
      commands,
      acceptingSendResponses: new Map(),
      acceptingMessages: 0,
      arrivingSends: new Set(),
      activeMessageId: null,
      hasActiveTurn: false,
      observedBranchesByRepo: new Map(),
      lastTurnErrors: null,
      turnWorked: false,
      turnNotices: [],
      unsaidNotes: [],
      turnRequest: null,
      turnAnswer: new Map(),
      turnCompletion: null,
      stopped: null,
      stopping: null,
      publishedQueue: null,
      idleReleaseTimer: null,
      releaseWhenIdle: false,
      history,
      outbox: new AsyncLock(),
      unpublishedHistoryStarts: [],
      live: false,
      progressStep: null,
      progressSentStep: null,
      plainStep: null,
      release: null,
      switching: null,
      errorNotificationTargets: new Map(),
      activeErrorNotificationTargets: [],
      quotaExhaustion: null,
      lastSendRequest: null,
    };
  }

  private touch(chat: RuntimeChat): void {
    chat.persisted.updatedAt = new Date().toISOString();
    this.persistAllChats().catch(() => {});
  }

  private toSummary(chat: RuntimeChat): ChatSummary {
    return {
      id: chat.persisted.id,
      provider: chat.persisted.provider,
      model: chat.persisted.model,
      thinkingLevel: chat.persisted.thinkingLevel,
      title: chat.persisted.title,
      displayName: chat.persisted.displayName,
      createdAt: chat.persisted.createdAt,
      updatedAt: chat.persisted.updatedAt,
      historyVersion: !hasActiveChatTurn(chat) && chat.acceptingMessages === 0
        ? chat.historyVersion
        : undefined,
      processing: hasActiveChatTurn(chat),
      activityTrackingVersion: 1,
      awaitingInput: chat.provider.isAwaitingInput?.() ?? false,
      isAuthRetrying: chat.provider.isAuthRetrying?.() ?? false,
      mayBeReconnecting: chat.provider.mayBeReconnecting?.() ?? false,
      goal: chat.provider.getGoal?.() ?? null,
      parentChatId: chat.persisted.parentChatId,
      lastMessageText: chat.persisted.lastMessageText ?? null,
      deletedAt: chat.persisted.deletedAt ?? null,
      fork: chat.persisted.fork ?? null,
      kind: chat.persisted.kind,
      ...(chat.persisted.chatCredential ? { chatCredential: chat.persisted.chatCredential } : {}),
    };
  }

  private requireChat(chatId: string): RuntimeChat {
    const chat = this.chats.get(chatId);
    if (!chat || chat.persisted.deletedAt) {
      throw new ChatNotFoundError(chatId);
    }
    return chat;
  }

  private activateTurn(chat: RuntimeChat, messageId: string): Promise<void> {
    chat.hasActiveTurn = true;
    chat.turnWorked = false;
    chat.stopped = null;
    chat.activeMessageId = messageId;
    chat.activeErrorNotificationTargets = chat.errorNotificationTargets.get(messageId) ?? [];
    chat.errorNotificationTargets.delete(messageId);
    const { state } = chat.commands;
    const starting = state.queue.find(({ id }) => id === messageId);
    state.queue = state.queue.filter(({ id }) => id !== messageId);
    state.running = { id: messageId, errorNotificationTargets: chat.activeErrorNotificationTargets };
    if (starting && takesTurnNotes(starting)) this.settleLostTurn(chat, 'told');
    const saved = chat.commands.save();
    this.touch(chat);
    chat.live = !!chat.provider.dispose;
    this.enforceLiveProcessCap();
    const request = chat.acceptedUserEvents.get(messageId)?.payload.message;
    chat.turnRequest = typeof request === 'string' ? request.trim().slice(0, TURN_REQUEST_MAX) : null;
    chat.turnAnswer.clear();
    const context = this.agentChatActivityTrackerService.noteTurnStarted(
      chat.persisted.id,
      messageId,
      chat.persisted.provider,
    );
    this.agentTokenUsageTracker.startTurn(context);
    return saved;
  }

  private async handleTurnStarted(chatId: string, message: QueuedMessage): Promise<void> {
    const chat = this.getRuntimeChat(chatId);
    if (!chat) return;

    chat.pendingMessageIds = chat.pendingMessageIds.filter((messageId) => messageId !== message.id);
    // Stamped at turn start rather than submission: a prompt queued behind a
    // running turn must not be placed inside that turn's output.
    const { event: acceptedEvent, sender } = createTurnMetadata(
      message,
      message.id,
      new Date().toISOString(),
    );
    chat.acceptedUserEvents.set(message.id, acceptedEvent);
    const saved = this.activateTurn(chat, message.id);
    chat.persisted.transcriptAuth = currentTranscriptAuth(chat.persisted.provider);
    // On disk before the agent starts, so a restart can never find work from a turn it does not know about.
    try {
      await saved;
    } catch (error) {
      chat.lastTurnErrors = ['This message was not run because the workspace could not save the chat.'];
      await this.handleTurnFinished(chatId);
      throw error;
    }
    await this.publish({
      type: 'chat.turn.started',
      payload: {
        chatId,
        messageId: message.id,
        event: acceptedEvent,
        ...(sender ? { sender } : {}),
      },
    });
  }

  /** `log` is the chat's log when the event is a record. It is taken once its message id is stamped. */
  private handleTurnEvent(chatId: string, event: AgentEvent, log?: CodexHistoryFile): void {
    const chat = this.getRuntimeChat(chatId);
    if (!chat) {
      log?.record(event);
      return;
    }

    keepAliveService.noteActivity();

    // A prompt still in the provider queue has not started, so these events belong to whatever the provider is running instead.
    if (
      !chat.hasActiveTurn
      && chat.pendingMessageIds.length > 0
      && !chat.provider.getQueue().some((message) => message.id === chat.pendingMessageIds[0])
    ) {
      const messageId = chat.pendingMessageIds.shift();
      if (!messageId) {
        return;
      }
      this.activateTurn(chat, messageId).catch((error) => {
        console.error('[ChatService] Failed to save the running turn:', { chatId, error });
      });
      this.publish({
        type: 'chat.turn.started',
        payload: {
          chatId: chat.persisted.id,
          messageId,
        },
      }).catch(() => {});
    }

    // The record is taken before anything below can throw, so a failure there costs the live event and not the record.
    const { state } = chat.commands;
    const readMessageId = event.payload[USER_MESSAGE_ID_PAYLOAD_KEY];
    let eventToPublish = event;
    if (event.type === 'event_msg' && event.payload.type === 'user_message') {
      // Steered messages arrive mid-turn already stamped with their own id; only fill in a missing one.
      if (chat.activeMessageId && !event.payload[USER_MESSAGE_ID_PAYLOAD_KEY]) {
        event.payload[USER_MESSAGE_ID_PAYLOAD_KEY] = chat.activeMessageId;
        eventToPublish = {
          ...event,
          payload: {
            ...event.payload,
            [USER_MESSAGE_ID_PAYLOAD_KEY]: chat.activeMessageId,
          },
        };
      }
      for (const [messageId, acceptedEvent] of chat.acceptedUserEvents) {
        if (isSameAcceptedUserEvent(event, acceptedEvent)) {
          chat.acceptedUserEvents.delete(messageId);
          break;
        }
      }
    }

    const taken = log?.record(event);

    this.agentTokenUsageTracker.noteAgentEvent(chatId, event);

    const parentToolUseId = typeof event.payload.parent_tool_use_id === 'string' ? event.payload.parent_tool_use_id : null;
    const messages = parseDisplayMessages([event], chat.persisted.provider, { filter: false, parentToolUseId });
    if (chat.hasActiveTurn) this.agentChatActivityTrackerService.noteSkillMcpCalls(chatId, messages);
    if (messages.some((message) => !NOT_WORK_MESSAGE_TYPES.has(message.type))) chat.turnWorked = true;
    // Codex reports a running command only through partial item events, so progress can't wait for the completed item.
    if (!parentToolUseId && !chat.persisted.parentChatId && event.type !== CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE) {
      const step = currentStepLabel(messages, chat.plainStep ?? undefined);
      chat.plainStep = lastPlainStepLabel(messages) ?? chat.plainStep;
      if (step) this.reportProgress(chat, step.slice(0, PROGRESS_STEP_MAX));
    }
    if (!parentToolUseId && event.type !== CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE && event.type !== CODEX_ITEM_PARTIAL_EVENT_TYPE && event.type !== 'pi-message_update') {
      for (const message of messages) {
        if (message.type === 'agent') {
          const { provider } = chat.persisted;
          chat.turnAnswer.set(provider === 'opencode' || provider === 'pi' ? message.id : `${chat.turnAnswer.size}`, message.content.slice(-FINAL_MESSAGE_MAX));
        } else if (message.type !== 'reasoning' && message.type !== 'background_task' && message.type !== 'model_fallback') {
          chat.turnAnswer.clear();
        }
      }
    }

    // A message the engine stopped is no failure of the turn the stop ended, nor of the next one, which is when its report can arrive.
    const terminalErrors = chat.provider.reportsOwnStop?.(event) ? undefined : terminalErrorsFromEvent(event, chat.persisted.provider);
    if (terminalErrors !== undefined) {
      chat.lastTurnErrors = terminalErrors;
    }
    const fallback = event.type === AUTH_FALLBACK_EVENT_TYPE ? coerceAuthFallbackPayload(event.payload) : null;
    if (fallback?.toModel) {
      const { headline, outcomeClause } = describeAuthFallback(fallback);
      chat.turnNotices.push(`${headline}, so this turn ${outcomeClause}.`);
    }
    const refusalFallback = coerceModelRefusalFallback(event);
    if (refusalFallback?.sessionSwitched) {
      const { headline, outcomeClause } = describeModelRefusalFallback(refusalFallback);
      chat.turnNotices.push(`${headline}, so it ${outcomeClause}.`);
      // Claude Code keeps answering on the older model, and follow-up messages inherit the chat's. A queued message already carries its own.
      if (chat.provider.getQueue().every(({ steeredAt }) => steeredAt)) chat.persisted.model = refusalFallback.toModel;
    }
    if (event.type === AGENT_QUOTA_EXHAUSTED_EVENT_TYPE) {
      chat.quotaExhaustion = agentQuotaExhaustedPayloadSchema.safeParse(event.payload).data ?? null;
    }

    // A steered message the agent has read belongs to the running turn, so a restart must not run it again.
    const read = state.queue.find(({ id }) => id === readMessageId);
    if (read) {
      state.queue = state.queue.filter(({ id }) => id !== readMessageId);
      // Its sender is owed the notice if a restart cuts this turn off: the message will not run again.
      if (state.running) state.running = { ...state.running, errorNotificationTargets: withNotificationTargets(state.running.errorNotificationTargets, read.errorNotificationTargets ?? []) };
      chat.commands.save().catch((error) => {
        console.error('[ChatService] Failed to save a steered message as read:', { chatId, error });
      });
    }

    // Partial-message flushes arrive every ~500ms while streaming; skip the
    // per-event disk persist and git snapshot — the final message covers both.
    if (event.type !== CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE) {
      this.touch(chat);
      this.observeCurrentBranches(chat).catch(() => {});
    }
    this.publish({
      type: 'chat.turn.delta',
      payload: {
        chatId,
        ...(chat.activeMessageId ? { messageId: chat.activeMessageId } : {}),
        event: eventToPublish,
      },
    }, taken).catch(() => {});

    // Tool-input request/resolve events flip the chat's awaitingInput flag.
    // Republish the chat summary so the dashboard sidebar / tab title can
    // distinguish "blocked on user" from "still computing" without polling.
    if (
      event.type === 'okidoki-tool-input-request'
      || event.type === 'okidoki-tool-input-resolved'
      || event.type === AUTH_RETRY_STATUS_EVENT_TYPE
      || event.type === AUTH_FALLBACK_EVENT_TYPE
      || event.type === CURSOR_CONNECTION_STATUS_EVENT_TYPE
      || event.type === CHAT_GOAL_EVENT_TYPE
      || event.type === 'claude-result'
      || refusalFallback?.sessionSwitched
      || (
        event.type === 'claude-system'
        && (
          event.payload.subtype === 'init'
          || event.payload.subtype === 'session_state_changed'
          || event.payload.subtype === 'background_tasks_changed'
          || coerceBackgroundTaskPayload(event.payload) !== null
        )
      )
    ) {
      this.publish({
        type: 'chat.updated',
        payload: { chat: this.toSummary(chat) },
      }).catch(() => {});
    }

    // A chat blocked on the user (e.g. plan approval) counts as processing, so
    // idle sleep never flushes it and the sandbox can hit the provider's hard
    // timeout first. Persist now so the plan stays viewable while asleep.
    if (event.type === 'okidoki-tool-input-request') {
      this.persistTurnArtifacts(chat);
      if (!chat.persisted.parentChatId) {
        const request = toolInputRequestSchema.safeParse(event.payload).data;
        void monolithService.sendEvent({
          type: 'agent_input_requested',
          payload: {
            chatId: chat.persisted.id,
            requestId: request?.requestId,
            toolName: request?.toolName,
            question: request?.questions?.[0]?.prompt,
            questions: request?.questions?.map(({ id, multiSelect, allowCustom, options }) => ({ id, multiSelect, allowCustom, options: options.map(({ id, label }) => ({ id, label })) })),
            plan: request?.plan,
            at: new Date().toISOString(),
          },
        });
      }
    }
    if (event.type === 'okidoki-tool-input-resolved' && !chat.persisted.parentChatId) {
      const resolved = toolInputResolvedSchema.safeParse(event.payload).data;
      if (resolved) void monolithService.sendEvent({ type: 'agent_input_resolved', payload: { chatId: chat.persisted.id, requestId: resolved.requestId } });
    }
  }

  private readonly progressCoalescer = new ItemUpdateCoalescer((chatId) => {
    const chat = this.getRuntimeChat(chatId);
    const latest = chat?.progressStep;
    if (!chat || !latest || latest === chat.progressSentStep || !hasActiveChatTurn(chat)) return;
    chat.progressSentStep = latest;
    void monolithService.sendEvent({ type: 'agent_progress', payload: { chatId, step: latest } });
  }, PROGRESS_INTERVAL_MS);

  private reportProgress(chat: RuntimeChat, step: string): void {
    chat.progressStep = step;
    // Codex repeats the running step on every partial event; a flush that sends nothing would still restart the window.
    if (step === chat.progressSentStep) this.progressCoalescer.cancel(chat.persisted.id);
    else this.progressCoalescer.schedule(chat.persisted.id);
  }

  private handleProcessingStopped(chatId: string): void {
    const chat = this.getRuntimeChat(chatId);
    if (!chat) return;
    this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } }).catch(() => {});
    this.notifyWorkspaceAgentIdle();
    if (chat.releaseWhenIdle && isChatIdle(chat)) void this.releaseAgentProcess(chat);
    else this.scheduleIdleRelease(chat);
  }

  // Idleness is re-checked when the timer fires: work that starts in between
  // ends with another processing stop, which schedules a fresh release.
  private scheduleIdleRelease(chat: RuntimeChat): void {
    this.cancelIdleRelease(chat);
    if (!chat.provider.dispose) return;
    this.enforceLiveProcessCap();
    chat.idleReleaseTimer = setTimeout(() => {
      chat.idleReleaseTimer = null;
      if (chat.persisted.deletedAt || !isChatIdle(chat)) return;
      void this.releaseAgentProcess(chat);
    }, chat.persisted.parentChatId === null ? CHAT_IDLE_RELEASE_MS : CHILD_CHAT_IDLE_RELEASE_MS);
    chat.idleReleaseTimer.unref?.();
  }

  private cancelIdleRelease(chat: RuntimeChat): void {
    if (chat.idleReleaseTimer) clearTimeout(chat.idleReleaseTimer);
    chat.idleReleaseTimer = null;
  }

  private enforceLiveProcessCap(): void {
    const live = [...this.chats.values()].filter((chat) => chat.live);
    const idle = live
      .filter(isChatIdle)
      .sort((a, b) => a.persisted.updatedAt.localeCompare(b.persisted.updatedAt));
    for (const chat of idle.slice(0, Math.max(0, live.length - maxLiveAgentProcesses()))) void this.releaseAgentProcess(chat);
  }

  /** Senders await `chat.release` so a new turn never starts against a session that is being torn down. */
  private releaseAgentProcess(chat: RuntimeChat): Promise<void> {
    this.cancelIdleRelease(chat);
    chat.live = false;
    chat.releaseWhenIdle = false;
    chat.release ??= Promise.resolve().then(() => chat.provider.dispose?.())
      .catch((error) => console.error('[ChatService] Failed to release chat agent process:', { chatId: chat.persisted.id, error }))
      .finally(() => { chat.release = null; });
    return chat.release;
  }

  private endTrackedTurn(chat: RuntimeChat): void {
    this.agentTokenUsageTracker.endTurn(chat.persisted.id);
    this.agentChatActivityTrackerService.noteTurnEnded(chat.persisted.id);
    if (chat.commands.state.running) {
      delete chat.commands.state.running;
      chat.commands.save().catch((error) => {
        console.error('[ChatService] Failed to save the end of a turn:', { chatId: chat.persisted.id, error });
      });
    }
    // The next turn, queued or not, starts from no step, and its first one is news even if it matches this turn's last.
    this.progressCoalescer.cancel(chat.persisted.id);
    chat.progressStep = null;
    chat.progressSentStep = null;
    chat.plainStep = null;
    this.touch(chat);
  }

  private async handleTurnFinished(chatId: string, lostToRestart = false, undeliveredMessageId?: string): Promise<void> {
    const chat = this.getRuntimeChat(chatId);
    if (!chat) {
      return;
    }

    if (lostToRestart) chat.lastTurnErrors = [`${CHAT_TURN_LOST_MESSAGE}${chat.provider.getQueue().length > 0 ? ' Queued messages are running now.' : ''}`];
    const userTurn = chat.hasActiveTurn || lostToRestart;
    if (!userTurn) {
      // No completed pending message means this completion is not tied to a
      // user turn: background work finishing after the turn, or a spurious
      // completion after an interrupt. Publish it anyway so clients and the
      // monolith see the final processing state.
      const queuedMessageIds = new Set(chat.provider.getQueue().map((message) => message.id));
      const completedMessageId = chat.pendingMessageIds.find((messageId) => !queuedMessageIds.has(messageId));
      chat.pendingMessageIds = chat.pendingMessageIds.filter((messageId) => messageId !== completedMessageId);
    }

    chat.hasActiveTurn = false;
    chat.activeMessageId = null;
    this.endTrackedTurn(chat);
    const completedAt = new Date().toISOString();
    const processing = chat.provider.getQueue().length > 0;
    const exhaustion = chat.quotaExhaustion;
    chat.quotaExhaustion = null;
    const stopped = chat.stopped;
    chat.stopped = null;
    // A provider can report the Stop's own abort as a failed request, and a turn someone ended is not one that needs them.
    if (stopped) chat.lastTurnErrors = null;

    this.persistTurnArtifacts(chat);

    let forked = false;
    if (exhaustion) {
      try {
        forked = await this.autoForkAfterQuota(chat, exhaustion);
      } catch (error) {
        console.error('[ChatService] Automatic fork after quota limit failed:', { chatId, error });
      }
    }

    const stillProcessing = processing || forked;
    const failedWithoutWork = !lostToRestart && !!chat.lastTurnErrors?.length && !chat.turnWorked;
    const answer = [...chat.turnAnswer.values()].filter((text) => text.trim()).join('\n\n').slice(-FINAL_MESSAGE_MAX) || null;
    const request = chat.turnRequest;
    chat.turnAnswer.clear();
    if (answer) chat.turnRequest = null;
    const responseComplete = this.publishTurnCompleted(chat, completedAt, stillProcessing, answer, request, userTurn);
    // A Stop knows only when it returns whether the agent had the message, and the turn can end before that.
    const handedBack = undeliveredMessageId === undefined
      ? Promise.resolve(undefined)
      : Promise.resolve(chat.stopping).then(() => (chat.commands.state.removed.includes(undeliveredMessageId) ? undeliveredMessageId : undefined));
    const completion = this.publishAgentTurnCompleteWebhook(chat, completedAt, stillProcessing, forked ? null : exhaustion, responseComplete, chat.turnCompletion, lostToRestart, stopped, handedBack)
      .catch((error) => console.error('[ChatService] Failed to report turn completion:', { chatId, error }))
      .finally(() => {
        if (chat.turnCompletion === completion) chat.turnCompletion = null;
        this.notifyWorkspaceAgentIdle(failedWithoutWork);
        // A slow completion can outlast the idle timer, which skips releasing while it's pending.
        this.scheduleIdleRelease(chat);
      });
    chat.turnCompletion = completion;
  }

  private async publishTurnCompleted(chat: RuntimeChat, completedAt: string, processing: boolean, answer: string | null, request: string | null, userTurn: boolean): Promise<void> {
    if (chat.persisted.parentChatId) {
      this.publish({ type: 'chat.updated', payload: { chat: this.toSummary(chat) } }).catch(() => {});
      // Read now: the turn-complete webhook clears the errors right after this runs.
      if (!processing && chat.persisted.fork?.trigger !== 'side') void this.reportSubagentToParent(chat, completedAt, chat.lastTurnErrors);
      return;
    }
    if (!processing && chat.persisted.fork && isPullRequestFeedbackChat(chat.persisted)) void this.reportPullRequestFixesDecision(chat, chat.persisted.fork.source.chatId, completedAt);
    this.publish({
      type: 'chat.turn.completed',
      payload: {
        chatId: chat.persisted.id,
        isComplete: true,
        processing,
        completedAt,
      },
    }).catch(() => {});
    await monolithService.sendEvent({
      type: 'agent_response_complete',
      payload: {
        completedAt,
        processing,
        ...(userTurn || answer ? { chatId: chat.persisted.id } : {}),
        ...(answer ? { finalMessage: answer, ...(request ? { request } : {}) } : {}),
        ...(isPullRequestFeedbackChat(chat.persisted) ? { pullRequestFeedback: true } : {}),
      },
    }, AbortSignal.timeout(10_000));
  }

  private notifyWorkspaceAgentIdle(failedWithoutWork = false): void {
    if (this.getProcessingCount() > 0) return;
    monolithService.sendEvent({ type: 'workspace_agent_idle', payload: failedWithoutWork ? { failedWithoutWork: true } : {} }).catch(() => {});
  }

  private getRuntimeChat(chatId: string): RuntimeChat | null {
    const chat = this.chats.get(chatId) ?? null;
    return chat && !chat.persisted.deletedAt ? chat : null;
  }

  private async loadChats(): Promise<PersistedChat[]> {
    try {
      const content = await readFile(CHATS_FILE, 'utf-8');
      return parsePersistedChatsContent(content);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }

      const quarantinePath = corruptChatsFilePath();
      console.error(`[ChatService] Failed to load ${CHATS_FILE}; quarantining and trying backup:`, error);
      try {
        await rename(CHATS_FILE, quarantinePath);
        console.error(`[ChatService] Quarantined corrupt chats file at ${quarantinePath}`);
      } catch (renameError) {
        console.error('[ChatService] Failed to quarantine corrupt chats file:', renameError);
      }

      try {
        const backupContent = await readFile(CHATS_BACKUP_FILE, 'utf-8');
        return parsePersistedChatsContent(backupContent);
      } catch (backupError) {
        if (
          backupError
          && typeof backupError === 'object'
          && 'code' in backupError
          && backupError.code === 'ENOENT'
        ) {
          return [];
        }
        console.error(`[ChatService] Failed to load backup ${CHATS_BACKUP_FILE}; starting with defaults:`, backupError);
        return [];
      }
    }
  }

  private persistAllChats(): Promise<void> {
    if (this.persistPromise) {
      this.persistQueued = true;
      return this.persistPromise;
    }
    this.persistPromise = (async () => {
      do {
        this.persistQueued = false;
        const payload = Array.from(this.chats.values()).map((chat) => chat.persisted);
        try {
          await copyFile(CHATS_FILE, CHATS_BACKUP_FILE);
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            console.error('[ChatService] Failed to update chats backup:', error);
          }
        }
        await atomicWriteFile(CHATS_FILE, `${JSON.stringify(payload, null, 2)}\n`);
      } while (this.persistQueued);
    })().finally(() => {
      this.persistPromise = null;
    });
    return this.persistPromise;
  }

  /**
   * A chat's events reach the stream in the order they were made, each one after every record taken before it is on disk.
   * The exception is the text of a message still being written, announced once written. `taken` is the event's own record: a dropped one is not announced.
   */
  private async publish(input: PublishEventInput, taken?: { at: number; written: Promise<void> }): Promise<void> {
    const event: EngineEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...input,
    };
    const chatId = 'chat' in event.payload && event.payload.chat
      ? event.payload.chat.id
      : 'chatId' in event.payload ? event.payload.chatId : undefined;
    const chat = chatId ? this.chats.get(chatId) : undefined;
    if (!chat) {
      await eventService.publish(event);
      return;
    }
    const { end, swapCount } = chat.history;
    const recorded = taken?.written ?? chat.history.flush();
    const dropped = await chat.outbox.run(async () => {
      if (await recorded.then(() => false, () => true)) return true;
      if (event.type === 'chat.queue.changed') {
        await eventService.publish(event);
        return false;
      }
      if (event.type === 'chat.turn.delta') {
        const { historyEnd } = chat.history;
        // Text of a message still being written is announced before it is synced, and a crash could take it back: it gets
        // no `historyEnd` while text announced before it sits past the synced end.
        // An offset taken before the log was swapped for its rewrite is the old file's, so that delta goes without a position too.
        if ((!taken || taken.at <= historyEnd) && [swapCount, ...chat.unpublishedHistoryStarts.map((start) => start.swapCount)].every((count) => count === chat.history.swapCount)) {
          event.payload.historyEnd = Math.min(end, historyEnd, ...chat.unpublishedHistoryStarts.map((start) => start.at));
        }
      }
      chat.historyVersion = event.id;
      if (event.type === 'chat.created' || event.type === 'chat.updated') {
        event.payload.chat.historyVersion = event.payload.chat.processing ? undefined : this.toSummary(chat).historyVersion;
      }
      await eventService.publish(event);
      return false;
    });
    // The queue's processing flag also derives from chat turn state, whose changes all publish a chat event.
    if (!dropped && event.type !== 'chat.queue.changed') this.publishQueueIfChanged(chat.persisted.id);
  }

  private async observeCurrentBranches(chat: RuntimeChat): Promise<void> {
    try {
      const snapshot = await gitService.snapshotCurrentBranches();
      for (const [repoName, branches] of snapshot) {
        let observed = chat.observedBranchesByRepo.get(repoName);
        if (!observed) {
          observed = new Set();
          chat.observedBranchesByRepo.set(repoName, observed);
        }
        for (const branch of branches) observed.add(branch);
      }
    } catch {
      // Best-effort: branch observation failures must not disrupt the turn.
    }
  }

  private async publishAgentTurnCompleteWebhook(
    chat: RuntimeChat,
    completedAt: string,
    processing: boolean,
    quotaExhaustion: AgentQuotaExhaustedPayload | null,
    responseComplete: Promise<void>,
    previousCompletion: Promise<void> | null,
    turnLost: boolean,
    stopped: RuntimeChat['stopped'],
    handedBack: Promise<string | undefined>,
  ): Promise<void> {
    const linearSessionId = ENGINE_ENV.OKIDOKI_LINEAR_SESSION_ID;
    // Sub-agent failures surface through their parent chat, not integrations.
    const errors = chat.persisted.parentChatId === null ? chat.lastTurnErrors : null;
    chat.lastTurnErrors = null;
    const notices = errors?.length ? [] : chat.turnNotices;
    chat.turnNotices = [];
    const errorNotificationTargets = chat.activeErrorNotificationTargets;
    chat.activeErrorNotificationTargets = [];
    const observedBranches = chat.observedBranchesByRepo;
    chat.observedBranchesByRepo = new Map();

    await previousCompletion;
    const refreshedRepoStatuses = await this.refreshTurnRepos(observedBranches);
    const repoStatuses = refreshedRepoStatuses ?? [];
    await responseComplete;

    if (chat.persisted.parentChatId) return;

    // A failed refresh cannot tell which URLs are unlinked, so they wait for the next turn.
    // Child chats send no turn webhook, so their parent reports for them.
    const unlinkedPullRequestUrls = refreshedRepoStatuses
      ? pullRequestCheckService.takeUnlinkedPublishedUrls(
        [chat.persisted.id, ...this.listChildChats(chat.persisted.id).map((child) => child.id)],
        refreshedRepoStatuses,
      )
      : [];

    // Always notify the monolith that the turn is complete, even if refreshRepos
    // failed — otherwise the backend may leave the agent session stuck.
    try {
      const historyCursor = await chat.provider.getHistory({ limit: 1 }).then((history) => history.afterCursor, () => undefined);
      const handedBackMessageId = await handedBack;
      const payload = {
        ...(linearSessionId ? { linearSessionId } : {}),
        completedAt,
        // A newer turn may have started while this completion ran; reporting idle would clear its Slack status.
        processing: processing || hasActiveChatTurn(chat),
        chatId: chat.persisted.id,
        ...(historyCursor !== undefined ? { historyCursor } : {}),
        repoStatuses,
        ...(unlinkedPullRequestUrls.length > 0 ? { unlinkedPullRequestUrls } : {}),
        ...(errors?.length ? { errors } : {}),
        ...(notices.length ? { notices } : {}),
        ...(turnLost ? { turnLost } : {}),
        ...(stopped ? { stopped } : {}),
        ...(handedBackMessageId ? { handedBackMessageId } : {}),
        ...((errors?.length || notices.length || quotaExhaustion) && errorNotificationTargets.length > 0 ? { errorNotificationTargets } : {}),
        ...(quotaExhaustion ? { quotaExhaustion } : {}),
        ...(isPullRequestFeedbackChat(chat.persisted) ? { pullRequestFeedback: true } : {}),
      };
      const sent = await monolithService.sendEvent({ type: 'agent_turn_complete', payload });
      // A report the monolith did not take stays owed, so the next start sends it again.
      if (turnLost && sent) {
        this.settleLostTurn(chat, 'reported');
        await chat.commands.save();
      }
    } catch (error) {
      console.error('[ChatService] Failed to send agent_turn_complete event:', error);
    }
  }

  private async refreshTurnRepos(observedBranches: Map<string, Set<string>>): Promise<EngineRepoState[] | null> {
    try {
      const repoStatuses = await refreshRepoStatuses(observedBranches);
      console.log(`Repository Statuses Refreshed: `, repoStatuses);
      return repoStatuses;
    } catch (error) {
      console.error('[ChatService] Failed to refresh repo statuses:', error);
      return null;
    }
  }
}
