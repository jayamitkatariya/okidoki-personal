import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import type {
  AgentEvent,
  ChatGoal,
  ChatGoalEventPayload,
  CodexTurnRetryPayload,
  ChatHistoryPageParams,
  ChatHistoryResponse,
  CodexAspTranscriptItem,
  CodexAspTranscriptStatus,
  InterruptChatResponse,
  Result,
  SendChatMessageRequest,
  SlashCommand,
  UpdateChatGoalRequest,
} from '@okidoki/shared';
import {
  AGENT,
  CHAT_GOAL_EVENT_TYPE,
  CODEX_ASP_ITEM_ID_PAYLOAD_KEY,
  CODEX_TURN_RETRY_EVENT_TYPE,
  buildCodexTokenUsageContextUsagePayload,
  canonicalizeChatTranscriptBlocks,
  codexItemEvent,
  codexPromptTurnId,
  codexTranscriptToEvents,
  codexTurnEvent,
  coerceChatGoalPayload,
  createErrorResult,
  createProviderSlashCommand,
  createSuccessResult,
  detectAgentQuotaLimit,
  engineCredentialRefreshFailureSchema,
  extractJsonObject,
  getGoalCommand,
  imageContentToUserMessageImages,
  isCompactCommand,
  isLatestChatHistoryPage,
  MANAGER_INSTRUCTIONS_TAG,
  mergeSlashCommands,
  normalizeCodexAspTranscriptStatus,
  parseAgentEvents,
  splitManagerInstructions,
  wrapInTag,
} from '@okidoki/shared';
import { CodingAgentManager, type CodingAgentManagerOptions } from '../coding-agent-manager';
import type { ProviderForkPoint } from '../coding-agent-provider';
import { describeLoginFailure, describeQuotaExhaustion } from '../auth-fallback';
import { CODEX_ULTRAFAST_SERVICE_TIER, getCodexAspHost, listCodexModels, restartCodexAspHost, type CodexAspHost } from './asp-host';
import { AspRequestTimeoutError, AspResponseError, type AspClient, type AspNotification, type AspServerRequest } from './asp-client';
import type { v2 } from '@okidoki/shared/codex-asp-types';
import { normalizeImages, removeTempImageFiles } from '../../utils/image-utils';
import { AsyncLock } from '../../utils/async-lock';
import { CodexAspAuthMethodChangedError, codexTokenManager } from '../codex-token-manager';
import { ENGINE_ENV } from '../../engine-env';
import { getCodexModelProvider } from './app-server-process';
import {
  convertCodexAspNotification,
  extractPlanFromCodexAspNotification,
} from '../../utils/linear-converter';
import { CodexQuotaStatusTracker } from '../../utils/codex-quota';
import { LinearEventForwarder } from '../../utils/linear-event-forwarder';
import { isCodexAuthError } from '@okidoki/shared';
import { canSteerMessage } from '@okidoki/shared/workspace-chat';
import { evaluateCommandProtection } from '../../services/command-protection-service';
import { applyCodexSkillRegistries } from '../../services/skill-registry-service';
import { pullRequestCheckService } from '../../services/pull-request-check-service';
import {
  ACCOUNT_RATE_LIMITS_READ_METHOD,
  DEFAULT_MODEL,
  SKILLS_LIST_METHOD,
  THREAD_BACKGROUND_TERMINALS_CLEAN_METHOD,
  COLLABORATION_MODE_LIST_METHOD,
  THREAD_COMPACT_START_METHOD,
  THREAD_FORK_METHOD,
  THREAD_GOAL_CLEAR_METHOD,
  THREAD_GOAL_GET_METHOD,
  THREAD_GOAL_SET_METHOD,
  THREAD_INJECT_ITEMS_METHOD,
  THREAD_READ_METHOD,
  THREAD_RESUME_METHOD,
  THREAD_SETTINGS_UPDATE_METHOD,
  THREAD_START_METHOD,
  TURN_INTERRUPT_METHOD,
  TURN_START_METHOD,
  TURN_STEER_METHOD,
  aspGoalToChatGoal,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnInput,
  buildTurnStartParams,
  extractRateLimitsSnapshot,
  formatTurnFailure,
  getReconciledActiveTurnId,
  isQuotaErrorMessage,
  isQuotaTurnFailure,
  appendCodexAspTranscriptOutput,
  itemToTranscriptItem,
  timestampFromMilliseconds,
  timestampFromSeconds,
  threadToAspTranscript,
} from './mappers';
import {
  ACCOUNT_RATE_LIMITS_UPDATED_METHOD,
  AGENT_MESSAGE_DELTA_METHOD,
  COMMAND_EXECUTION_OUTPUT_DELTA_METHOD,
  FILE_CHANGE_OUTPUT_DELTA_METHOD,
  ITEM_COMPLETED_METHOD,
  ITEM_STARTED_METHOD,
  MODEL_REROUTED_METHOD,
  REASONING_SUMMARY_TEXT_DELTA_METHOD,
  REASONING_TEXT_DELTA_METHOD,
  REASONING_SUMMARY_PART_ADDED_METHOD,
  THREAD_COMPACTED_METHOD,
  THREAD_GOAL_CLEARED_METHOD,
  THREAD_GOAL_UPDATED_METHOD,
  THREAD_STATUS_CHANGED_METHOD,
  THREAD_TOKEN_USAGE_UPDATED_METHOD,
  TURN_COMPLETED_METHOD,
  TURN_PLAN_UPDATED_METHOD,
  TURN_STARTED_METHOD,
  type AspNotificationHandlers,
  dispatchAspNotification,
  recoverCompletedTurn,
} from './notification-dispatch';
import { ItemUpdateCoalescer } from './item-update-coalescer';
import { CodexThreadNotFoundError } from '../../services/chat/errors';
import type { QueuedMessage } from '../../services/message-queue-service';

interface CodexAspManagerOptions extends CodingAgentManagerOptions {
  pendingFork?: ProviderForkPoint;
  onCodexTurnStarted?: (threadId: string, turnId: string) => void;
  onCodexTokenUsage?: (
    notification: v2.ThreadTokenUsageUpdatedNotification,
    occurredAt: string,
  ) => void;
  onCodexModelRerouted?: (notification: v2.ModelReroutedNotification) => void;
  onCodexTurnCompleted?: (threadId: string, turnId: string) => void;
}
/** Carries a quota failure past the turn boundary so the credential swap is handled once, at the top. */
class CodexQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexQuotaError';
  }
}

class CodexModelAtCapacityError extends Error {
  constructor(message: string, readonly turnId: string) {
    super(message);
    this.name = 'CodexModelAtCapacityError';
  }
}

class CodexStoppedAnsweringError extends Error {
  constructor(readonly stoppedTurnId: string) {
    super('Codex stopped answering and was restarted. This turn did not finish.');
    this.name = 'CodexStoppedAnsweringError';
  }
}

// Codex gives up on a capacity error after ~3s; production overloads clear within a couple of minutes.
const MODEL_AT_CAPACITY_RETRIES = 5;
const MODEL_AT_CAPACITY_RETRY_BASE_MS = 5_000;
const MODEL_AT_CAPACITY_CONTINUE_PROMPT =
  'Your previous turn stopped because the model was at capacity. Continue from where you left off: '
  + 'first check what is already done, and do not repeat commands, edits, or messages you already completed.';

interface CodexSubagent {
  turnId: string;
  item: Extract<CodexAspTranscriptItem, { type: 'subagent' }>;
  active: Set<string>;
  failed: boolean;
}

/** In-progress items of the active turn; each becomes an immutable history event when it completes. */
interface LiveTurn {
  id: string;
  items: Map<string, CodexAspTranscriptItem>;
  persistedItemIds: Set<string>;
}

const CODEX_SLASH_COMMANDS_CACHE_MS = 30_000;
const POLICY_REASON_INJECTION_TIMEOUT_MS = 5000;
const CODEX_INTERRUPT_TIMEOUT_MS = 5_000;
// It answers in under 10 ms from the app-server's own state, even mid-turn, so 2 s unanswered means the app-server is frozen.
const CODEX_LIVENESS_TIMEOUT_MS = 2_000;
// Codex fixes a thread's native multi-agent tools when the thread starts, so each thread keeps the subagent mode it started with.
const SUBAGENT_MCP_THREADS_DIR = join(ENGINE_ENV.HOME_DIR, '.okidoki', 'codex', 'subagent-mcp-threads');

async function markSubagentMcpThread(threadId: string): Promise<void> {
  await mkdir(SUBAGENT_MCP_THREADS_DIR, { recursive: true });
  await writeFile(join(SUBAGENT_MCP_THREADS_DIR, threadId), '');
}

function formatBlockedCommandReason(reason: string | undefined): string {
  return reason?.includes('Blocked by organization policy')
    ? reason
    : `Blocked by organization policy: ${reason || 'agents may not merge pull requests.'}`;
}

export async function readCodexAspThreadHistory(threadId: string): Promise<ChatHistoryResponse> {
  let thread: v2.Thread;
  try {
    const host = await getCodexAspHost();
    ({ thread } = await host.client.request<v2.ThreadReadResponse>(
      THREAD_READ_METHOD,
      { threadId, includeTurns: true },
    ));
  } catch {
    throw new CodexThreadNotFoundError(threadId);
  }
  return { thread_id: threadId, events: codexTranscriptToEvents(threadToAspTranscript(thread)), goal: null };
}

function skillToSlashCommand(skill: v2.SkillMetadata): SlashCommand | null {
  if (!skill.enabled) return null;
  const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
  return createProviderSlashCommand('codex', skill.name, description);
}

function skillsListToSlashCommands(response: v2.SkillsListResponse): SlashCommand[] {
  return mergeSlashCommands(
    ...response.data.map((entry) => entry.skills.flatMap((skill) => {
      const command = skillToSlashCommand(skill);
      return command ? [command] : [];
    })),
  );
}

export class CodexAspManager extends CodingAgentManager {
  private currentThreadId: string | null = null;
  private pendingFork: ProviderForkPoint | null = null;
  private activeTurnId: string | null = null;
  private lastTurnFailure: { turnId: string; message: string } | null = null;
  private attachedClient: CodexAspHost['client'] | null = null;
  private attachedModel: string | null = null;
  private attachedDeveloperInstructions: string | null = null;
  private attachedAutoCompactTokens: number | null = null;
  private attachedNativeSubagentsDisabled = false;
  private liveTurn: LiveTurn | null = null;
  private readonly codexSubagents = new Map<string, CodexSubagent>();
  private readonly quotaStatus = new CodexQuotaStatusTracker();
  private currentGoal: ChatGoal | null = null;
  private goalHistoryKnown = false;
  private goalRevision = 0;
  private onGoalChanged: (() => void) | null = null;
  private lateStart: Promise<void> | null = null;
  private stopGiveUp: { hold: () => void; arm: () => void } | null = null;
  private unansweredStop: { client: AspClient; turnId: string } | null = null;
  private unansweredStopAtPress: { client: AspClient; turnId: string } | null = null;
  private readonly itemUpdateCoalescer = new ItemUpdateCoalescer((itemId) => {
    const item = this.liveTurn?.items.get(itemId);
    if (this.liveTurn && item) this.onEvent(codexItemEvent(this.liveTurn.id, item, true));
  });
  private skillRegistriesApplied = false;
  private activeServiceTier: string | null | undefined;
  private slashCommandsCache: { commands: SlashCommand[]; expiresAt: number } | null = null;
  private slashCommandsRequest: Promise<SlashCommand[]> | null = null;
  private steeredTempImagePaths: string[] = [];
  // Codex never sees a message stopped before its turn started, so it is sent again with the next one.
  // `sent` is that message as the user sent it, which a Stop before the next turn hands back.
  private unreadRequests: (SendChatMessageRequest & { sent?: QueuedMessage })[] = [];
  private compacting = false;
  private cutForMessage: string | null = null;
  private cutLineAt: string | null = null;
  // Codex names a turn before it starts it, and refuses to interrupt it until then.
  private startedTurnId: string | null = null;
  // Codex has been asked for a turn, or is running one, so the start of its next turn will be seen.
  private observingTurn = false;
  private readonly steerLock = new AsyncLock();
  private readonly onCodexTurnStarted?: CodexAspManagerOptions['onCodexTurnStarted'];
  private readonly onCodexTokenUsage?: CodexAspManagerOptions['onCodexTokenUsage'];
  private readonly onCodexModelRerouted?: CodexAspManagerOptions['onCodexModelRerouted'];
  private readonly onCodexTurnCompleted?: CodexAspManagerOptions['onCodexTurnCompleted'];

  constructor(options: CodexAspManagerOptions) {
    super({ ...options, provider: AGENT.CODEX });
    this.pendingFork = options.pendingFork ?? null;
    this.onCodexTurnStarted = options.onCodexTurnStarted;
    this.onCodexTokenUsage = options.onCodexTokenUsage;
    this.onCodexModelRerouted = options.onCodexModelRerouted;
    this.onCodexTurnCompleted = options.onCodexTurnCompleted;
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected async initialize(): Promise<void> {
    await this.historyFile.ensureItemEventFormat();
    this.currentThreadId = this.initialSessionId;
    const goalEvent = await this.historyFile.findLastEventOfType(CHAT_GOAL_EVENT_TYPE);
    if (goalEvent) {
      this.currentGoal = coerceChatGoalPayload(goalEvent.payload);
      this.goalHistoryKnown = true;
    }
    for (const { turnId, item } of (await this.historyFile.findSubagentItems()).values()) {
      if (item.status === 'in_progress') this.updateCodexSubagent({ turnId, item, active: new Set(), failed: false });
    }
  }

  protected override async subagentMcpForTurn(enabled: boolean): Promise<boolean> {
    return this.currentThreadId ? existsSync(join(SUBAGENT_MCP_THREADS_DIR, this.currentThreadId)) : enabled;
  }

  override async interrupt(persistRemoval: (messageIds: string[]) => Promise<void>, requestedStoppedAt?: string): Promise<InterruptChatResponse> {
    this.cutForMessage = null;
    const unansweredStop = this.unansweredStop;
    // Bounded like the interrupt itself, so a Stop does not wait two minutes on an app-server that has stopped answering.
    const pauseGoal = () => this.updateGoal({ status: 'paused' }, CODEX_INTERRUPT_TIMEOUT_MS).catch((error) => {
      console.error('[CodexAspManager] Failed to pause the goal on Stop:', error);
    });
    if (this.currentGoal?.status === 'active') await pauseGoal();
    // interruptActiveTurn reads it before its first await, so each Stop sees only what was remembered when it was pressed.
    this.unansweredStopAtPress = unansweredStop;
    const interrupting = super.interrupt(persistRemoval, requestedStoppedAt);
    this.unansweredStopAtPress = null;
    const response = await interrupting;
    // A Stop that restarted the app-server lost the pause it sent there, and the goal would run again with the next message.
    if (this.currentGoal?.status === 'active') await pauseGoal();
    if (!this.cutLineAt) return response;
    // A Stop that caught the cut turn as it wound up left its own line. One that only took the message back before Codex had it stopped nothing, but the press had: one stop, in Stop's words.
    if (!response.interrupted) this.writeCutLine(false);
    this.cutLineAt = null;
    return { ...response, interrupted: true };
  }

  protected override deliver(signal: AbortSignal): boolean {
    if (!super.deliver(signal)) return false;
    this.writeCutLine(true);
    return true;
  }

  protected override async keepStoppedRequest(request: SendChatMessageRequest): Promise<boolean> {
    if (!canSteerMessage('codex', request)) return false;
    // The model reads adjacent text inputs as one run of text, so a carried-over message needs its own break.
    this.unreadRequests.push({ ...request, message: `${request.message}\n\n`, sent: this.turnRequest });
    return true;
  }

  // `/compact` and a goal's clear or pause send Codex no input; a goal being set or resumed does.
  protected override carriesKeptRequests(request: Pick<SendChatMessageRequest, 'goalMode' | 'message'>): boolean {
    const command = getGoalCommand(request.message, request.goalMode)?.type;
    return !isCompactCommand(request.message) && command !== 'clear' && command !== 'pause';
  }

  protected override takeKeptRequests(): { sent: Promise<QueuedMessage[]>; putBack: () => void } {
    if (this.turnRequest && !this.carriesKeptRequests(this.turnRequest)) return { sent: Promise.resolve([]), putBack: () => {} };
    const unread = this.unreadRequests;
    this.unreadRequests = [];
    return {
      sent: Promise.resolve(unread.flatMap(({ sent }) => sent ?? [])),
      putBack: () => {
        this.unreadRequests = [...unread, ...this.unreadRequests];
      },
    };
  }

  protected async interruptActiveTurn(stoppedAt?: string): Promise<void> {
    if (!this.currentThreadId || !this.activeTurnId) {
      return;
    }

    const threadId = this.currentThreadId;
    const expectedTurnId = this.activeTurnId;
    // Only a Stop passes stoppedAt. Its turn is given up once Codex has answered the interrupt, so until then it is still running there and the chat says so.
    const giveUp = stoppedAt ? this.stopGiveUp : null;
    giveUp?.hold();
    const unansweredBefore = stoppedAt ? this.unansweredStopAtPress : null;
    let client: AspClient | null = null;
    let unanswered: AspRequestTimeoutError | null = null;
    // Before turn/interrupt: once the turn completes, the queue can start the next turn on this thread.
    try {
      client = (await getCodexAspHost()).client;
      await client.request(
        THREAD_BACKGROUND_TERMINALS_CLEAN_METHOD,
        { threadId } satisfies v2.ThreadBackgroundTerminalsCleanParams,
        { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS },
      );
    } catch (error) {
      console.warn('[CodexAspManager] Failed to stop the turn\'s running commands:', error);
      if (error instanceof AspRequestTimeoutError) unanswered = error;
    }
    const interrupting = this.requestActiveTurnWithReconciliation(
      'interrupt',
      expectedTurnId,
      (host, turnId) => host.client.request(
        TURN_INTERRUPT_METHOD,
        { threadId, turnId } satisfies v2.TurnInterruptParams,
        { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS },
      ),
    );
    void interrupting.then((result) => {
      if (giveUp === this.stopGiveUp && (result.ok || !(result.error.details instanceof AspRequestTimeoutError))) giveUp?.arm();
    });
    if (!stoppedAt || !unanswered) {
      const result = await interrupting;
      if (!result.ok) {
        console.warn(
          result.error.code === 'retry_failed'
            ? '[CodexAspManager] Failed to interrupt reconciled active turn; leaving shared Codex app-server running:'
            : '[CodexAspManager] Failed to interrupt active turn:',
          result.error.details,
        );
        if (result.error.details instanceof AspRequestTimeoutError) unanswered = result.error.details;
      }
    }
    if (!stoppedAt) return;
    if (!unanswered) {
      this.unansweredStop = null;
      return;
    }
    if (client) this.unansweredStop = { client, turnId: expectedTurnId };
    // One unanswered Stop can be a slow app-server, so only a turn that had already left an earlier Stop unanswered for its full bound goes on to the restart.
    if (unansweredBefore?.client !== client || unansweredBefore.turnId !== expectedTurnId) throw unanswered;
    // An app-server that still answers is alive and only this turn is not stopping, which a restart would cut for every chat.
    const alive = await unansweredBefore.client.request(COLLABORATION_MODE_LIST_METHOD, {}, { timeoutMs: CODEX_LIVENESS_TIMEOUT_MS }).then(() => true, (error: unknown) => error instanceof AspResponseError);
    if (alive) throw unanswered;
    // Not awaited: the turn is over once the client is disposed, and what needs the new app-server waits for it there.
    void restartCodexAspHost(new CodexStoppedAnsweringError(expectedTurnId));
  }

  private async requestActiveTurnWithReconciliation(
    operation: 'interrupt' | 'steer',
    expectedTurnId: string,
    request: (host: CodexAspHost, turnId: string) => Promise<unknown>,
  ): Promise<Result<string, 'request_failed' | 'retry_failed'>> {
    try {
      await request(await getCodexAspHost(), expectedTurnId);
      return createSuccessResult(expectedTurnId);
    } catch (error) {
      const reconciledTurnId = getReconciledActiveTurnId(error, expectedTurnId);
      if (!reconciledTurnId) {
        return createErrorResult({ code: 'request_failed', message: `Failed to ${operation} active turn`, details: error });
      }

      this.activeTurnId = reconciledTurnId;
      console.warn(`[CodexAspManager] Active turn changed during ${operation}; retrying with provider turn:`, reconciledTurnId);
      try {
        await request(await getCodexAspHost(), reconciledTurnId);
        return createSuccessResult(reconciledTurnId);
      } catch (retryError) {
        return createErrorResult({
          code: 'retry_failed',
          message: `Failed to ${operation} reconciled active turn`,
          details: retryError,
        });
      }
    }
  }

  // Serialize so concurrent steers can't race one `turn/steer` RPC ahead of another.
  protected override steerRequest(request: QueuedMessage): Promise<boolean> {
    return this.steerLock.run(() => this.steerActiveTurnLocked(request));
  }

  private async steerActiveTurnLocked(request: QueuedMessage): Promise<boolean> {
    const threadId = this.currentThreadId;
    const expectedTurnId = this.activeTurnId;
    if (!threadId || !expectedTurnId || !this.messageQueue.isProcessing()) return false;
    if (this.compacting || this.cutForMessage) return false;
    if (!canSteerMessage('codex', request)) return false;

    const { input, tempImagePaths } = await buildTurnInput(request);
    const result = await this.requestActiveTurnWithReconciliation(
      'steer',
      expectedTurnId,
      (host, turnId) => {
        if (this.isSteerWithdrawn(request)) throw new Error('Steer was withdrawn');
        return host.client.request<v2.TurnSteerResponse>(
          TURN_STEER_METHOD,
          { threadId, expectedTurnId: turnId, input, clientUserMessageId: request.id } satisfies v2.TurnSteerParams,
        );
      },
    );
    if (!result.ok) {
      await removeTempImageFiles(tempImagePaths);
      console.warn(
        result.error.code === 'retry_failed'
          ? '[CodexAspManager] Failed to steer reconciled active turn, keeping message queued:'
          : '[CodexAspManager] Failed to steer active turn, keeping message queued:',
        result.error.details,
      );
      return false;
    }

    if (this.activeTurnId === result.data) {
      this.steeredTempImagePaths.push(...tempImagePaths);
    } else {
      // Turn already completed, so its `finally` cleanup ran; remove these paths now to avoid leaking them.
      await removeTempImageFiles(tempImagePaths);
    }
    return true;
  }

  protected override canDeliverSteersNow(): boolean {
    return true;
  }

  // Codex holds a steer it is given during its final answer until the answer ends, so sending one now ends the turn: Codex drops the steers it had not read, and they start the next turn in order.
  protected override deliverSteersNow(): Promise<boolean> {
    return this.cutTurnForMessage();
  }

  // Unlike Stop, background commands keep running: a preview can depend on one.
  protected override async cutTurnForMessage(message?: QueuedMessage): Promise<boolean> {
    if (this.compacting || (this.turnMessage && isCompactCommand(this.turnMessage.message))) return true;
    // A command that sends Codex no input carries nothing, so a message Codex was never asked to run goes again after it.
    if (message && !this.carriesKeptRequests(message) && !this.activeTurnId && !this.observingTurn) return super.cutTurnForMessage(message);
    this.cutForMessage ??= new Date().toISOString();
    const turn = this.turnMessage;
    // The queue's stop cannot be taken back, so it waits until Codex has taken the interrupt. A turn Codex is still to start is cut when it starts.
    if (this.activeTurnId && this.activeTurnId === this.startedTurnId) {
      if (!await this.interruptForMessage()) return false;
    } else if (this.observingTurn) return true;
    // A turn Codex was never asked for never reaches it. The queue can have moved on to the message by now, which is left alone.
    if (this.turnMessage === turn) this.messageQueue.cancelActiveTurn();
    return true;
  }

  private async interruptForMessage(): Promise<boolean> {
    const threadId = this.currentThreadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) return true;
    try {
      await (await getCodexAspHost()).client.request(TURN_INTERRUPT_METHOD, { threadId, turnId } satisfies v2.TurnInterruptParams, { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS });
      return true;
    } catch (error) {
      console.error('[CodexAspManager] Failed to interrupt the turn for a waiting message:', error);
      if (this.activeTurnId !== turnId) return true;
      this.cutForMessage = null;
      void this.deliverEarlySteers();
      return false;
    }
  }

  // The turn has given way to the message, and is owed a stop line with the time of the press. A turn that finished by itself gets none.
  private settleCutForMessage(): void {
    this.cutLineAt ??= this.cutForMessage;
    this.cutForMessage = null;
  }

  // Written as Codex is handed the message, so that a Stop which takes the message back first can leave its own line instead.
  private writeCutLine(steered: boolean): void {
    if (this.cutLineAt) this.recordInterrupted(this.cutLineAt, steered);
    this.cutLineAt = null;
  }

  async forkPoint(beforeMessageId?: string): Promise<ProviderForkPoint | null> {
    await this.initialized;
    const sessionId = this.currentThreadId;
    if (!sessionId) return null;
    const { thread } = await (await getCodexAspHost()).client.request<v2.ThreadReadResponse>(
      THREAD_READ_METHOD,
      { threadId: sessionId, includeTurns: true },
    );
    const edited = beforeMessageId ? parseAgentEvents(await this.historyFile.loadAll(), 'codex').findLast(({ id }) => id === beforeMessageId) : undefined;
    const editedTurnId = edited && codexPromptTurnId(edited);
    const turns = beforeMessageId ? thread.turns.slice(0, Math.max(0, thread.turns.findIndex((turn) => turn.id === editedTurnId))) : thread.turns;
    const throughTurn = turns.findLast((turn) => turn.status !== 'inProgress')?.id;
    return throughTurn ? { sessionId, throughTurn } : null;
  }

  /** The fork happens on the next turn: Codex keeps a loaded thread's settings, so it must be created with this chat's own. */
  async forkFrom(point: ProviderForkPoint): Promise<void> {
    await this.initialized;
    this.pendingFork = point;
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.initialized;
    await this.historyFile.flush();
    const latestPage = isLatestChatHistoryPage(page);
    if (latestPage && !this.goalHistoryKnown && this.currentThreadId) {
      try {
        await this.refreshThreadGoal(await getCodexAspHost(), this.currentThreadId);
      } catch (error) {
        console.warn('[CodexAspManager] Failed to connect while refreshing thread goal:', error);
      }
    }
    const history = await this.historyFile.loadEventsPage(page);
    const liveTurn = latestPage ? this.liveTurn : null;
    const liveEvents = liveTurn
      ? [...liveTurn.items.values()].map((item) => codexItemEvent(liveTurn.id, item, true))
      : [];
    return {
      thread_id: this.currentThreadId,
      ...history,
      events: [...history.events, ...liveEvents],
      goal: this.currentGoal,
    };
  }

  getGoal(): ChatGoal | null {
    return this.currentGoal;
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    await this.initialized;

    const now = Date.now();
    if (this.slashCommandsCache && this.slashCommandsCache.expiresAt > now) {
      return this.slashCommandsCache.commands;
    }

    if (!this.slashCommandsRequest) {
      this.slashCommandsRequest = (async () => {
        try {
          const host = await getCodexAspHost();
          await this.applySkillRegistries(host);
          const response = await host.client.request<v2.SkillsListResponse>(
            SKILLS_LIST_METHOD,
            { cwds: [this.workingDirectory] },
          );
          const commands = skillsListToSlashCommands(response);
          this.slashCommandsCache = { commands, expiresAt: Date.now() + CODEX_SLASH_COMMANDS_CACHE_MS };
          return commands;
        } catch (error) {
          console.warn('[CodexAspManager] Failed to load slash commands:', error);
          return this.slashCommandsCache?.commands ?? [];
        } finally {
          this.slashCommandsRequest = null;
        }
      })();
    }

    return this.slashCommandsRequest;
  }

  async clearGoal(): Promise<ChatGoal | null> {
    await this.initialized;
    if (!this.currentThreadId) {
      this.recordGoalChange(null, true);
      return null;
    }

    const host = await getCodexAspHost();
    await host.client.request<v2.ThreadGoalClearResponse>(
      THREAD_GOAL_CLEAR_METHOD,
      { threadId: this.currentThreadId },
    );
    this.recordGoalChange(null, true);
    return null;
  }

  async updateGoal(request: UpdateChatGoalRequest, timeoutMs?: number): Promise<ChatGoal | null> {
    await this.initialized;
    // Codex reopens a completed goal it is told to pause, so the goal goes back as it is. A new objective makes it a new goal.
    if (request.status === 'paused' && request.objective === undefined && this.currentGoal?.status === 'complete') return this.currentGoal;
    if (!this.currentThreadId) return null;
    // A resume makes Codex start a turn at once, so like a message it waits until a late start is stopped. Stop's own pause never waits.
    if (request.status !== 'paused') await this.lateStart;

    const host = await getCodexAspHost();
    const response = await host.client.request<v2.ThreadGoalSetResponse>(
      THREAD_GOAL_SET_METHOD,
      {
        threadId: this.currentThreadId,
        ...(request.objective !== undefined ? { objective: request.objective } : {}),
        ...(request.status !== undefined ? { status: request.status } : {}),
      },
      { timeoutMs },
    );
    this.recordGoalChange(response.goal, true);
    return this.currentGoal;
  }

  private recordUserMessageEvent(request: SendChatMessageRequest, extraPayload: Record<string, unknown> = {}, timestamp?: string): void {
    const images = imageContentToUserMessageImages(request.images);
    this.recordUserMessageHistoryEvent(request, { ...(images ? { images } : {}), ...extraPayload }, timestamp);
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    this.settleCutForMessage();
    let userMessageRecorded = false;
    let quotaFallbackAttempted = false;
    const recordUserMessage = (extraPayload: Record<string, unknown> = {}): void => {
      if (userMessageRecorded) return;
      userMessageRecorded = true;
      this.recordUserMessageEvent(request, extraPayload, this.turnBeganAt);
    };

    const goalCommand = getGoalCommand(request.message, request.goalMode);

    const dispatch = async (): Promise<void> => {
      if (isCompactCommand(request.message)) {
        await this.executeAspTurn(request, recordUserMessage, signal, {
          runTurn: (host, threadId) => this.observeTurn(host, threadId, request, signal, async () => {
            await host.client.request<v2.ThreadCompactStartResponse>(
              THREAD_COMPACT_START_METHOD,
              { threadId } satisfies v2.ThreadCompactStartParams,
            );
            return { turn: null, tempImagePaths: [] };
          }),
          userMessagePayload: { command: 'compact' },
        });
        return;
      }
      // Codex reopens a completed goal it is told to pause or resume, and the model then loops on a goal it has already finished.
      if ((goalCommand?.type === 'pause' || goalCommand?.type === 'resume') && this.currentGoal?.status === 'complete') {
        recordUserMessage({ command: 'goal' });
        this.recordHistoryEvent('codex-asp-error', { message: 'This goal is already complete. Set a new one with `/goal <objective>`.' });
        return;
      }
      if (goalCommand?.type === 'clear') {
        await this.executeGoalClearCommand(request, recordUserMessage, signal);
        return;
      }
      if (goalCommand?.type === 'pause') {
        await this.executeGoalPauseCommand(request, recordUserMessage, signal);
        return;
      }
      if (goalCommand?.type === 'set' || goalCommand?.type === 'resume') {
        await this.executeAspTurn(request, recordUserMessage, signal, {
          runTurn: (host, threadId) => this.runGoalTurn(host, threadId, request, goalCommand.type === 'set' ? goalCommand.objective : undefined, signal),
          userMessagePayload: { command: 'goal' },
        });
        return;
      }
      await this.executeAspTurn(request, recordUserMessage, signal);
    };

    // The thread keeps everything the failed turn did, so a turn with no new input picks up where it stopped.
    // A failed compaction did nothing yet, so it simply runs again.
    const retryAfterCapacityFailure = isCompactCommand(request.message)
      ? dispatch
      : () => this.executeAspTurn(request, recordUserMessage, signal, {
        continuation: true,
      });

    const dispatchWithCapacityRetries = async (): Promise<void> => {
      try {
        await dispatch();
      } catch (error) {
        let failure = error;
        for (let attempt = 1; failure instanceof CodexModelAtCapacityError && attempt <= MODEL_AT_CAPACITY_RETRIES; attempt++) {
          this.recordHistoryEvent(CODEX_TURN_RETRY_EVENT_TYPE, {
            attempt,
            maxAttempts: MODEL_AT_CAPACITY_RETRIES,
            [CODEX_ASP_ITEM_ID_PAYLOAD_KEY]: failure.turnId,
          } satisfies CodexTurnRetryPayload);
          await sleep(MODEL_AT_CAPACITY_RETRY_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2), undefined, { signal }).catch(() => {});
          if (signal.aborted) {
            this.settleCutForMessage();
            return;
          }
          try {
            await retryAfterCapacityFailure();
            return;
          } catch (retryError) {
            failure = retryError;
          }
        }
        throw failure;
      }
    };

    let attemptedCredential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex;
    try {
      await dispatchWithCapacityRetries();
    } catch (error) {
      let terminalError = error;
      if (terminalError instanceof CodexQuotaError && !quotaFallbackAttempted) {
        quotaFallbackAttempted = true;
        const fallback = await this.fallBackCredential(
          detectAgentQuotaLimit(terminalError.message) ?? 'rate_limit',
          terminalError.message,
          attemptedCredential,
        );
        if (fallback.outcome === 'switched') {
          // `dispatch` reads the request when it runs, so the retry picks up the chosen model.
          if (fallback.model) request = { ...request, model: fallback.model };
          attemptedCredential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex;
          const retryFailure = await this.restartAndRetry(dispatchWithCapacityRetries);
          if (!retryFailure) return;
          terminalError = retryFailure.error;
        } else {
          const reason = await this.confirmOutOfCredits(await getCodexAspHost())
            ? 'out_of_credits'
            : detectAgentQuotaLimit(terminalError.message) ?? 'rate_limit';
          this.emitQuotaExhausted({
            provider: 'codex',
            reason,
            detail: terminalError.message,
            ...(fallback.outcome === 'fork' ? { forkTo: fallback.target } : {}),
          });
          // Unpaired with the failed turn so it renders beside the raw failure: this is
          // the message Slack and Linear post, and only it names the exhausted account.
          this.recordHistoryEvent('codex-asp-error', {
            message: describeQuotaExhaustion('codex', reason, attemptedCredential, fallback),
          });
          if (reason === 'out_of_credits') return;
          throw terminalError;
        }
      }
      if (terminalError instanceof CodexAspAuthMethodChangedError) {
        const retryFailure = await this.restartAndRetry(dispatchWithCapacityRetries);
        if (!retryFailure) return;
        terminalError = retryFailure.error;
      }
      let loginFailure: string | null = null;
      if (isCodexAuthError(terminalError)) {
        const refreshed = await codexTokenManager.fetchFreshCredentials(
          terminalError instanceof Error ? terminalError.message : String(terminalError),
          'rejected',
          attemptedCredential,
        );
        if (refreshed.ok) {
          const retryFailure = await this.restartAndRetry(dispatchWithCapacityRetries);
          if (!retryFailure) return;
          terminalError = retryFailure.error;
        }
        if (isCodexAuthError(terminalError)) {
          const failure = refreshed.ok ? null : engineCredentialRefreshFailureSchema.safeParse(extractJsonObject(refreshed.error.message)).data;
          const login = refreshed.ok ? ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex : attemptedCredential ?? failure?.credential;
          const method = login?.method ?? ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD;
          loginFailure = describeLoginFailure(
            'codex',
            login,
            ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD,
            (!method || method === 'oauth') && failure?.code === 'oauth_disconnected',
          );
        }
      }
      const message = terminalError instanceof Error ? terminalError.message : String(terminalError);
      const failedTurnId = this.lastTurnFailure?.message === message ? this.lastTurnFailure.turnId : null;
      this.recordHistoryEvent('codex-asp-error', {
        message,
        ...(failedTurnId ? { [CODEX_ASP_ITEM_ID_PAYLOAD_KEY]: failedTurnId } : {}),
      });
      // Recorded after the failed turn so it is the last error event, which is the one reported as the turn's failure.
      if (loginFailure) this.recordHistoryEvent('codex-asp-error', { message: loginFailure });
      throw terminalError;
    } finally {
      this.itemUpdateCoalescer.flushPending();
      this.itemUpdateCoalescer.dispose();
      this.activeTurnId = null;
      this.compacting = false;
      // With no message left to hand to Codex, a line still owed is written here. A Stop leaves its own.
      if (!this.isStopped(signal) && this.getQueue().length === 0) this.writeCutLine(true);
      await removeTempImageFiles(this.steeredTempImagePaths.splice(0));
      await this.historyFile.flush();
      await this.onTurnComplete();
      // Last, so a press that lands while a finished turn is wound up leaves no stop line either.
      this.cutForMessage = null;
    }
  }

  private async executeGoalClearCommand(
    request: SendChatMessageRequest,
    recordUserMessage: (extraPayload?: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const prepared = await this.prepareGoalCommand(request, recordUserMessage, signal);
    if (!prepared) return;
    const { host, threadId } = prepared;
    await host.client.request<v2.ThreadGoalClearResponse>(
      THREAD_GOAL_CLEAR_METHOD,
      { threadId },
    );
    this.recordGoalChange(null, true);
  }

  private async executeGoalPauseCommand(
    request: SendChatMessageRequest,
    recordUserMessage: (extraPayload?: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const prepared = await this.prepareGoalCommand(request, recordUserMessage, signal);
    if (!prepared) return;
    const { host, threadId } = prepared;
    const response = await host.client.request<v2.ThreadGoalSetResponse>(
      THREAD_GOAL_SET_METHOD,
      { threadId, status: 'paused' },
    );
    this.recordGoalChange(response.goal, true);
  }

  private async prepareGoalCommand(
    request: SendChatMessageRequest,
    recordUserMessage: (extraPayload?: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<{ host: CodexAspHost; threadId: string } | null> {
    const host = await getCodexAspHost();
    const developerInstructions = this.buildCombinedInstructions(splitManagerInstructions(request.customInstructions).customInstructions, true);
    const threadId = await this.ensureThread(host, request, developerInstructions);
    await this.lateStartStopped(signal);
    const delivered = this.deliver(signal);
    if (delivered || !(this.isStopped(signal) || this.isRequeued(signal))) recordUserMessage({ command: 'goal' });
    return delivered ? { host, threadId } : null;
  }

  // The app-server takes a start written behind one still in flight into that one's turn, so the next one waits until that one is stopped, undelivered: a Stop meanwhile still withdraws it.
  private async lateStartStopped(signal: AbortSignal): Promise<void> {
    if (!this.lateStart || signal.aborted) return;
    await Promise.race([this.lateStart, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
  }

  private async executeAspTurn(
    request: SendChatMessageRequest,
    recordUserMessage: (extraPayload?: Record<string, unknown>) => void,
    signal: AbortSignal,
    options: {
      runTurn?: (host: CodexAspHost, threadId: string) => Promise<v2.Turn>;
      continuation?: boolean;
      userMessagePayload?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const host = await getCodexAspHost();

    const developerInstructions = this.buildCombinedInstructions(splitManagerInstructions(request.customInstructions).customInstructions, true);
    const threadId = await this.ensureThread(host, request, developerInstructions);
    const serviceTier = await this.resolveRequestedServiceTier(host, request);
    await this.applyThreadServiceTier(host, threadId, serviceTier);
    // Loading images can take seconds, so the input is ready before the message counts as delivered: a Stop meanwhile still withdraws it.
    let runTurn = options.runTurn;
    let tempImagePaths: string[] = [];
    if (!runTurn) {
      const carried = options.continuation ? [] : [...this.unreadRequests];
      const turnStart = await buildTurnStartParams(
        threadId,
        options.continuation ? { ...request, images: undefined } : request,
        serviceTier,
        carried,
      ).catch((error: unknown) => {
        // Otherwise a carried message whose images can't be loaded would fail every later turn.
        this.unreadRequests = this.unreadRequests.map((unread) => ({ ...unread, images: undefined }));
        if (!signal.aborted) recordUserMessage(options.userMessagePayload);
        throw error;
      });
      tempImagePaths = turnStart.tempImagePaths;
      runTurn = (aspHost, aspThreadId) => this.runTurn(aspHost, aspThreadId, request, turnStart, signal, carried, options.continuation);
    }
    await this.lateStartStopped(signal);
    if (!this.deliver(signal)) {
      await removeTempImageFiles(tempImagePaths);
      if (this.isStopped(signal) || this.isRequeued(signal)) return;
      recordUserMessage(options.userMessagePayload);
      this.settleCutForMessage();
      // Commands and continuations have no new message for the next turn to carry.
      if (!options.runTurn && !options.continuation) await this.keepStoppedRequest(request);
      return;
    }
    recordUserMessage(options.userMessagePayload);

    let completedTurn: v2.Turn;
    try {
      completedTurn = await runTurn(host, threadId);
    } catch (error) {
      if (isQuotaErrorMessage(error)) {
        throw new CodexQuotaError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }

    if (completedTurn.status === 'failed') {
      const failure = formatTurnFailure(completedTurn);
      if (completedTurn.error?.codexErrorInfo === 'serverOverloaded') throw new CodexModelAtCapacityError(failure, completedTurn.id);
      throw isQuotaTurnFailure(completedTurn) ? new CodexQuotaError(failure) : new Error(failure);
    }

    this.emitQuotaEvent(this.quotaStatus.recordTurnSuccess());
  }

  private async ensureThread(
    host: CodexAspHost,
    request: SendChatMessageRequest,
    developerInstructions: string | undefined,
  ): Promise<string> {
    if (this.attachedClient !== host.client) {
      this.skillRegistriesApplied = false;
      this.closeCodexSubagents();
      host.client.off('notification', this.onSubagentThreadStatus);
      host.client.on('notification', this.onSubagentThreadStatus);
    }
    await this.applySkillRegistries(host);

    const existingThreadId = this.currentThreadId;
    const requestedModel = request.model ?? DEFAULT_MODEL;
    const subagentMcpParentChatId = this.subagentMcpParentChatId();
    const disableNativeSubagents = this.nativeSubagentsDisabled();
    // Loaded threads ignore resume config, so enforce a newly resolved restriction on a fresh fork.
    const fork = this.pendingFork ?? (existingThreadId && disableNativeSubagents && !this.attachedNativeSubagentsDisabled
      ? { sessionId: existingThreadId, throughTurn: undefined }
      : null);
    if (existingThreadId && !fork) {
      // Resume is the only place developer instructions can be set, so a changed value has to
      // re-resume an attached thread. Re-seeding merges the transcript rather than appending.
      if (
        this.attachedClient !== host.client
        || requestedModel !== this.attachedModel
        || (developerInstructions ?? null) !== this.attachedDeveloperInstructions
      ) {
        const serviceTier = await this.resolveRequestedServiceTier(host, request);
        const coldResume = this.attachedClient !== host.client;
        const previous = coldResume
          ? await host.client.request<v2.ThreadReadResponse>(THREAD_READ_METHOD, { threadId: existingThreadId, includeTurns: true }).catch(() => null)
          : null;
        const response = previous?.thread.modelProvider && previous.thread.modelProvider !== getCodexModelProvider(ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD)
          ? await this.continueWithNewProvider(host, previous.thread, request, developerInstructions, serviceTier)
          : await host.client.request<v2.ThreadResumeResponse>(
            THREAD_RESUME_METHOD,
            await buildThreadResumeParams(this.workingDirectory, existingThreadId, request, developerInstructions, serviceTier, subagentMcpParentChatId, this.autoCompactTokens, this.originChatId, disableNativeSubagents),
          );
        this.currentThreadId = response.thread.id;
        this.activeServiceTier = response.serviceTier;
        // Resuming a loaded thread only rejoins it and keeps its original developer instructions.
        if (this.attachedClient === host.client && developerInstructions && developerInstructions !== this.attachedDeveloperInstructions) {
          await host.client.request<v2.ThreadInjectItemsResponse>(THREAD_INJECT_ITEMS_METHOD, {
            threadId: this.currentThreadId,
            items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: developerInstructions }] }],
          } satisfies v2.ThreadInjectItemsParams);
        }
        this.attachedClient = host.client;
        this.attachedModel = requestedModel;
        this.attachedDeveloperInstructions = developerInstructions ?? null;
        // Codex ignores config overrides when resuming a thread it still has loaded.
        if (coldResume) {
          this.attachedAutoCompactTokens = this.autoCompactTokens;
          this.attachedNativeSubagentsDisabled = disableNativeSubagents;
        }
        await this.onSaveSessionId(this.currentThreadId);
      }
      return this.currentThreadId ?? existingThreadId;
    }

    const serviceTier = await this.resolveRequestedServiceTier(host, request);
    let response: v2.ThreadStartResponse | v2.ThreadForkResponse;
    if (fork) {
      const { threadId: sourceThreadId, ...settings } = await buildThreadResumeParams(this.workingDirectory, fork.sessionId, request, developerInstructions, serviceTier, subagentMcpParentChatId, this.autoCompactTokens, this.originChatId, disableNativeSubagents);
      response = await host.client.request<v2.ThreadForkResponse>(
        THREAD_FORK_METHOD,
        { ...settings, threadId: sourceThreadId, lastTurnId: fork.throughTurn, excludeTurns: true } satisfies v2.ThreadForkParams,
      );
      this.pendingFork = null;
    } else {
      response = await host.client.request<v2.ThreadStartResponse>(
        THREAD_START_METHOD,
        await buildThreadStartParams(this.workingDirectory, request, developerInstructions, serviceTier, subagentMcpParentChatId, this.autoCompactTokens, this.originChatId, disableNativeSubagents),
      );
    }
    const threadId = response.thread.id;
    this.currentThreadId = threadId;
    this.activeServiceTier = response.serviceTier;
    this.attachedClient = host.client;
    this.attachedModel = requestedModel;
    this.attachedDeveloperInstructions = developerInstructions ?? null;
    this.attachedAutoCompactTokens = this.autoCompactTokens;
    this.attachedNativeSubagentsDisabled = disableNativeSubagents;
    if (subagentMcpParentChatId) await markSubagentMcpThread(threadId);
    await this.onSaveSessionId(this.currentThreadId);
    return threadId;
  }

  private async continueWithNewProvider(
    host: CodexAspHost,
    previous: v2.Thread,
    request: SendChatMessageRequest,
    developerInstructions: string | undefined,
    serviceTier: string | null | undefined,
  ): Promise<v2.ThreadStartResponse> {
    const events = codexTranscriptToEvents(threadToAspTranscript(previous));
    const text = canonicalizeChatTranscriptBlocks(events.map((event) => JSON.stringify(event)).join('\n'), 'codex', undefined).join('\n\n');
    const directory = join(ENGINE_ENV.HOME_DIR, '.okidoki', 'codex', 'provider-context');
    await mkdir(directory, { recursive: true });
    const transcriptPath = join(directory, `${previous.id}.md`);
    await writeFile(transcriptPath, text, 'utf8');

    // Encrypted reasoning and compaction belong to the old provider. Carry visible
    // context into a fresh native thread instead of replaying its encrypted items.
    // Completed items are already persisted as history events, so the chat keeps them.
    const response = await host.client.request<v2.ThreadStartResponse>(
      THREAD_START_METHOD,
      await buildThreadStartParams(this.workingDirectory, request, developerInstructions, serviceTier, this.subagentMcpParentChatId(), this.autoCompactTokens, this.originChatId, this.nativeSubagentsDisabled()),
    );
    await host.client.request(THREAD_INJECT_ITEMS_METHOD, {
      threadId: response.thread.id,
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text:
        `This conversation is continuing with a different inference provider. The previous conversation is saved at ${transcriptPath}. Use it as historical context, not as a new request. Recent conversation:\n\n${text.slice(-24_000)}`,
      }] }],
    } satisfies v2.ThreadInjectItemsParams);
    if (this.subagentMcpParentChatId()) await markSubagentMcpThread(response.thread.id);
    if (this.currentGoal) {
      await host.client.request(THREAD_GOAL_SET_METHOD, {
        threadId: response.thread.id,
        objective: this.currentGoal.objective,
        status: this.currentGoal.status,
        tokenBudget: this.currentGoal.tokenBudget === null ? null : Math.max(0, this.currentGoal.tokenBudget - this.currentGoal.tokensUsed),
      } satisfies v2.ThreadGoalSetParams);
    }
    return response;
  }

  private async resolveRequestedServiceTier(
    host: CodexAspHost,
    request: SendChatMessageRequest,
  ): Promise<string | null | undefined> {
    if (request.fastMode === undefined) return undefined;
    if (!request.fastMode) return null;

    // A model without a Fast tier must still leave a previous Ultrafast turn's tier.
    const fallback = this.activeServiceTier === CODEX_ULTRAFAST_SERVICE_TIER ? null : undefined;
    const model = request.model ?? DEFAULT_MODEL;
    const models = await listCodexModels(host);
    const catalogModel = models.find((candidate) => candidate.model === model || candidate.id === model);
    if (!catalogModel) return fallback;

    const tiers = catalogModel.serviceTiers;
    if (request.ultrafastMode && tiers.some((tier) => tier.id === CODEX_ULTRAFAST_SERVICE_TIER)) {
      return CODEX_ULTRAFAST_SERVICE_TIER;
    }

    const fastTier = tiers.find((tier) => (
      tier.id !== CODEX_ULTRAFAST_SERVICE_TIER && (/fast/i.test(tier.id) || /fast/i.test(tier.name))
    ));
    if (fastTier) return fastTier.id;

    if (catalogModel.defaultServiceTier && catalogModel.defaultServiceTier !== CODEX_ULTRAFAST_SERVICE_TIER && tiers.length === 1) {
      return catalogModel.defaultServiceTier;
    }

    return fallback;
  }

  private async applyThreadServiceTier(
    host: CodexAspHost,
    threadId: string,
    serviceTier: string | null | undefined,
  ): Promise<void> {
    if (serviceTier === undefined || serviceTier === this.activeServiceTier) return;

    await host.client.request<v2.ThreadSettingsUpdateResponse>(
      THREAD_SETTINGS_UPDATE_METHOD,
      { threadId, serviceTier },
    );
    this.activeServiceTier = serviceTier;
  }

  private async applySkillRegistries(host: CodexAspHost): Promise<void> {
    if (this.skillRegistriesApplied) return;

    try {
      await applyCodexSkillRegistries({
        client: host.client,
        homeDir: ENGINE_ENV.HOME_DIR,
      });
      this.skillRegistriesApplied = true;
    } catch (error) {
      console.warn('[CodexAspManager] Failed to apply skill registries:', error);
    }
  }

  private async runTurn(
    host: CodexAspHost,
    threadId: string,
    request: SendChatMessageRequest,
    { params, tempImagePaths }: Awaited<ReturnType<typeof buildTurnStartParams>>,
    signal: AbortSignal,
    carried: SendChatMessageRequest[],
    continuation = false,
  ): Promise<v2.Turn> {
    return this.observeTurn(host, threadId, request, signal, async () => {
      const turnStartResponse = await host.client.request<v2.TurnStartResponse>(
        TURN_START_METHOD,
        continuation
          ? {
            ...params,
            input: [],
            additionalContext: {
              ...params.additionalContext,
              okidoki_capacity_retry: { kind: 'application', value: MODEL_AT_CAPACITY_CONTINUE_PROMPT },
            },
          } satisfies v2.TurnStartParams
          : params,
      );
      // A start can be answered after its turn was given up on, when later turns have kept messages of their own.
      this.unreadRequests = this.unreadRequests.filter((unread) => !carried.includes(unread));
      return { turn: turnStartResponse.turn, tempImagePaths };
    });
  }

  private async runGoalTurn(
    host: CodexAspHost,
    threadId: string,
    request: SendChatMessageRequest,
    objective: string | undefined,
    signal: AbortSignal,
  ): Promise<v2.Turn> {
    const { managerInstructions } = splitManagerInstructions(request.customInstructions);
    const carried = [...this.unreadRequests];
    const unreadContent = await Promise.all(carried.map(async (unread) => [
      { type: 'input_text', text: unread.message },
      ...(await normalizeImages(unread.images ?? [])).map((image) => ({ type: 'input_image', image_url: `data:${image.source.media_type};base64,${image.source.data}` })),
    ])).catch((error: unknown) => {
      this.unreadRequests = this.unreadRequests.map((unread) => ({ ...unread, images: undefined }));
      throw error;
    });
    return this.observeTurn(host, threadId, request, signal, async () => {
      // thread/goal/set has no additionalContext, so the rules stripped from developer instructions go in directly.
      if (managerInstructions) {
        await host.client.request<v2.ThreadInjectItemsResponse>(THREAD_INJECT_ITEMS_METHOD, {
          threadId,
          items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: wrapInTag(managerInstructions, MANAGER_INSTRUCTIONS_TAG) }] }],
        } satisfies v2.ThreadInjectItemsParams);
      }
      if (unreadContent.length > 0) {
        await host.client.request<v2.ThreadInjectItemsResponse>(THREAD_INJECT_ITEMS_METHOD, {
          threadId,
          items: [{ type: 'message', role: 'user', content: unreadContent.flat() }],
        } satisfies v2.ThreadInjectItemsParams);
        this.unreadRequests = this.unreadRequests.filter((unread) => !carried.includes(unread));
      }
      const response = await host.client.request<v2.ThreadGoalSetResponse>(
        THREAD_GOAL_SET_METHOD,
        { threadId, ...(objective !== undefined ? { objective } : {}), status: 'active' },
      );
      this.recordGoalChange(response.goal, true);
      return { turn: null, tempImagePaths: [] };
    });
  }

  private async observeTurn(
    host: CodexAspHost,
    threadId: string,
    request: SendChatMessageRequest,
    signal: AbortSignal,
    startTurn: () => Promise<{ turn: v2.Turn | null; tempImagePaths: string[] }>,
  ): Promise<v2.Turn> {
    let stopSent = false;
    // Called from turn/started only: Codex names a turn before it starts it, and refuses to interrupt it until then.
    const interruptIfStopped = (): void => {
      if (!signal.aborted || stopSent) return;
      stopSent = true;
      void (this.cutForMessage ? this.interruptForMessage() : this.interruptActiveTurn()).catch((error) => {
        console.error('[CodexAspManager] Failed to interrupt a turn stopped before it started:', error);
      });
    };
    let resolveCompleted: (turn: v2.Turn) => void;
    const completed = new Promise<v2.Turn>((resolve) => {
      resolveCompleted = resolve;
    });
    let rejectDisposed: (error: Error) => void = () => {};
    const disposed = new Promise<never>((_resolve, reject) => {
      rejectDisposed = reject;
    });
    void disposed.catch(() => {});
    // The app-server is shared by every Codex chat, so a turn it will not stop is left behind rather than killed.
    let stopTimer: NodeJS.Timeout | undefined;
    let rejectStopUnanswered: (error: Error) => void = () => {};
    const stopUnanswered = new Promise<never>((_resolve, reject) => {
      rejectStopUnanswered = reject;
    });
    void stopUnanswered.catch(() => {});
    const giveUpIfStopUnanswered = (): void => {
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => rejectStopUnanswered(new Error(
        `Codex did not stop this turn within ${CODEX_INTERRUPT_TIMEOUT_MS / 1000} seconds of Stop, so it was ended here. Send a message to continue.`,
      )), CODEX_INTERRUPT_TIMEOUT_MS);
    };
    if (signal.aborted) giveUpIfStopUnanswered();
    else signal.addEventListener('abort', giveUpIfStopUnanswered, { once: true });
    this.stopGiveUp = { hold: () => clearTimeout(stopTimer), arm: giveUpIfStopUnanswered };
    let observedTurnId: string | null = null;
    const observedTurnIds = new Set<string>();
    let lastCompletedTurn: v2.Turn | null = null;
    let completedResolved = false;
    const completedItems: v2.ThreadItem[] = [];
    const agentMessageDeltas = new Map<string, string>();
    const model = request.model ?? DEFAULT_MODEL;
    let tempImagePaths: string[] = [];
    const linearForwarder = new LinearEventForwarder(() => this.linearSessionId);

    const matchesTurn = (notificationThreadId: string, notificationTurnId: string | null): boolean => (
      notificationThreadId === threadId &&
      (!observedTurnId || notificationTurnId === null || notificationTurnId === observedTurnId || notificationTurnId === this.activeTurnId)
    );
    const resolveIfGoalIdle = (): void => {
      if (!lastCompletedTurn || completedResolved) return;
      // Goals can be created by a tool during an ordinary user turn.
      if (lastCompletedTurn.status !== 'completed' || this.currentGoal?.status !== 'active') {
        completedResolved = true;
        resolveCompleted(lastCompletedTurn);
      }
    };
    const handlers: AspNotificationHandlers = {
      [ACCOUNT_RATE_LIMITS_UPDATED_METHOD]: (notification) => {
        this.handleRateLimits(notification.params.rateLimits);
      },
      [THREAD_TOKEN_USAGE_UPDATED_METHOD]: (notification) => {
        if (notification.params.threadId !== threadId) return;
        const occurredAt = new Date().toISOString();
        this.onCodexTokenUsage?.(notification.params, occurredAt);
        this.emitCodexTokenUsage(notification.params.tokenUsage, model, occurredAt);
      },
      [MODEL_REROUTED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.onCodexModelRerouted?.(notification.params);
      },
      [THREAD_GOAL_UPDATED_METHOD]: (notification) => {
        if (notification.params.threadId !== threadId) return;
        this.recordGoalChange(notification.params.goal);
      },
      [THREAD_GOAL_CLEARED_METHOD]: (notification) => {
        if (notification.params.threadId !== threadId) return;
        this.recordGoalChange(null);
      },
      [THREAD_COMPACTED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.compacting = false;
        void this.deliverEarlySteers();
      },
      [TURN_STARTED_METHOD]: (notification) => {
        if (notification.params.threadId !== threadId) return;
        observedTurnId = notification.params.turn.id;
        observedTurnIds.add(notification.params.turn.id);
        this.activeTurnId = notification.params.turn.id;
        this.startedTurnId = notification.params.turn.id;
        this.onCodexTurnStarted?.(threadId, notification.params.turn.id);
        void this.deliverEarlySteers();
        lastCompletedTurn = null;
        completedItems.length = 0;
        agentMessageDeltas.clear();
        this.startTurn(notification.params.turn);
        if (this.cutForMessage && !signal.aborted) void this.cutTurnForMessage();
        else interruptIfStopped();
        linearForwarder.sendEvent(convertCodexAspNotification(notification, this.linearSessionId ?? ''));
      },
      [TURN_PLAN_UPDATED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        linearForwarder.sendPlan(extractPlanFromCodexAspNotification(notification));
      },
      [ITEM_STARTED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        if (notification.params.item.type === 'contextCompaction') this.compacting = true;
        if (notification.params.item.type === 'userMessage' && notification.params.item.clientId) {
          const steer = this.markSteerRead(notification.params.item.clientId);
          if (steer) this.recordUserMessageEvent(steer);
        }
        this.startItem(
          notification.params.turnId,
          itemToTranscriptItem(notification.params.item, timestampFromMilliseconds(notification.params.startedAtMs), 'in_progress'),
        );
        linearForwarder.sendEvent(convertCodexAspNotification(notification, this.linearSessionId ?? ''));
      },
      [ITEM_COMPLETED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        completedItems.push(notification.params.item);
        if (notification.params.item.type === 'contextCompaction') {
          this.compacting = false;
          void this.deliverEarlySteers();
        }
        const itemFailed = notification.params.item.type === 'commandExecution'
          && typeof notification.params.item.exitCode === 'number'
          && notification.params.item.exitCode !== 0;
        this.completeItem(
          notification.params.turnId,
          itemToTranscriptItem(
            notification.params.item,
            timestampFromMilliseconds(notification.params.completedAtMs),
            itemFailed ? 'failed' : 'completed',
          ),
        );
        linearForwarder.sendEvent(convertCodexAspNotification(notification, this.linearSessionId ?? ''));
        const completedItem = notification.params.item;
        const toolResult = completedItem.type === 'commandExecution'
          ? { toolName: 'commandExecution', toolInput: { command: completedItem.command }, output: completedItem.aggregatedOutput, success: completedItem.exitCode === 0 }
          : completedItem.type === 'mcpToolCall'
            ? { toolName: completedItem.tool, toolInput: completedItem.arguments, output: completedItem.result, success: completedItem.status === 'completed' && !completedItem.error }
            : completedItem.type === 'dynamicToolCall'
              ? { toolName: completedItem.tool, toolInput: completedItem.arguments, output: completedItem.contentItems, success: completedItem.success === true }
              : null;
        if (toolResult) {
          pullRequestCheckService.onToolResult(toolResult, this.chatId).catch((error) => {
            console.error('[CodexAspManager] Failed to capture published PR:', error);
          });
        }
      },
      [AGENT_MESSAGE_DELTA_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        const currentText = agentMessageDeltas.get(notification.params.itemId) ?? '';
        agentMessageDeltas.set(notification.params.itemId, currentText + notification.params.delta);
        this.appendAgentMessageDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
      },
      [REASONING_SUMMARY_TEXT_DELTA_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.appendReasoningDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
      },
      [REASONING_TEXT_DELTA_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.appendReasoningDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
      },
      [REASONING_SUMMARY_PART_ADDED_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.appendReasoningDelta(notification.params.turnId, notification.params.itemId, '\n\n');
      },
      [COMMAND_EXECUTION_OUTPUT_DELTA_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.appendOutputDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
      },
      [FILE_CHANGE_OUTPUT_DELTA_METHOD]: (notification) => {
        if (!matchesTurn(notification.params.threadId, notification.params.turnId)) return;
        this.appendOutputDelta(notification.params.turnId, notification.params.itemId, notification.params.delta);
      },
      [TURN_COMPLETED_METHOD]: (notification) => {
        if (notification.params.threadId !== threadId) return;
        if (!observedTurnIds.has(notification.params.turn.id) && notification.params.turn.id !== this.activeTurnId) return;
        observedTurnIds.add(notification.params.turn.id);
        observedTurnId = notification.params.turn.id;
        this.onCodexTurnCompleted?.(threadId, notification.params.turn.id);
        const completedTurn = recoverCompletedTurn(notification.params.turn, completedItems, agentMessageDeltas);
        this.completeTurn(completedTurn);
        if (completedTurn.status === 'interrupted') this.settleCutForMessage();
        if (this.activeTurnId === completedTurn.id) this.activeTurnId = null;
        // Codex sends no item/completed for a compaction that the end of its turn cuts short.
        this.compacting = false;
        lastCompletedTurn = completedTurn;
        resolveIfGoalIdle();
        if (!completedResolved && this.currentGoal?.status === 'active') {
          void this.refreshThreadGoal(host, threadId);
        }
      },
    };

    const onNotification = (notification: AspNotification): void => {
      dispatchAspNotification(notification, handlers);
    };

    const onServerRequest = (serverRequest: AspServerRequest): void => {
      if (serverRequest.method === 'account/chatgptAuthTokens/refresh') return;
      void this.respondToServerRequest(host, serverRequest).catch((error) => {
        console.warn(`[CodexAspManager] Failed to handle ASP server request ${serverRequest.method}:`, error);
        host.client.reject(serverRequest.id, -32603, `Failed to handle ${serverRequest.method}`);
      });
    };

    const onDispose = (reason: Error): void => {
      this.attachedClient = null;
      this.activeTurnId = null;
      // The Stop that restarted the app-server stopped its own turn, which no longer has a Codex to say so.
      if (reason instanceof CodexStoppedAnsweringError && reason.stoppedTurnId === observedTurnId) {
        onNotification({ method: TURN_COMPLETED_METHOD, params: { threadId, turn: { id: observedTurnId, items: [], itemsView: 'notLoaded', status: 'interrupted', error: null, startedAt: null, completedAt: null, durationMs: null, rootTurnId: null } } });
        return;
      }
      if (reason instanceof CodexAspAuthMethodChangedError || reason instanceof CodexStoppedAnsweringError) {
        rejectDisposed(reason);
        return;
      }
      const turnLabel = observedTurnId ? ` ${observedTurnId}` : '';
      rejectDisposed(new Error(`Codex turn${turnLabel} did not finish: ${reason.message}`));
    };

    host.client.on('notification', onNotification);
    host.client.on('serverRequest', onServerRequest);
    host.client.on('dispose', onDispose);
    this.onGoalChanged = resolveIfGoalIdle;
    this.observingTurn = true;

    try {
      const starting = startTurn();
      const started = await Promise.race([starting, stopUnanswered]).catch((error) => {
        // The app-server answers a start before its turn can be interrupted, and says when it can with turn/started.
        const announced = Promise.withResolvers<void>();
        const onLateTurn = (notification: AspNotification): void => dispatchAspNotification(notification, {
          [TURN_STARTED_METHOD]: ({ params }) => {
            if (params.threadId === threadId) announced.resolve();
          },
        });
        host.client.on('notification', onLateTurn);
        // The turn can still start after this one ended, with nobody left to stop it.
        const stopped = starting.then(async (late) => {
          await removeTempImageFiles(late.tempImagePaths);
          let turnId = late.turn?.id;
          // A goal set this late is active, which Stop could not pause, and Codex starts its turn at once.
          if (!late.turn && this.currentGoal?.status === 'active') {
            await host.client.request<v2.ThreadGoalSetResponse>(THREAD_GOAL_SET_METHOD, { threadId, status: 'paused' }, { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS })
              .then((response) => this.recordGoalChange(response.goal, true))
              .catch(() => {});
            const { thread } = await host.client.request<v2.ThreadReadResponse>(THREAD_READ_METHOD, { threadId, includeTurns: true }, { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS });
            // No start is written until this is done, so a turn still running is the goal's own.
            turnId = thread.turns.findLast((turn) => turn.status === 'inProgress')?.id;
          }
          if (turnId) {
            const waited = new AbortController();
            await Promise.race([announced.promise, sleep(CODEX_INTERRUPT_TIMEOUT_MS, undefined, { signal: waited.signal }).catch(() => {})]);
            waited.abort();
            await host.client.request(
              TURN_INTERRUPT_METHOD,
              { threadId, turnId } satisfies v2.TurnInterruptParams,
              { timeoutMs: CODEX_INTERRUPT_TIMEOUT_MS },
            );
          }
        }).catch(() => {}).finally(() => host.client.off('notification', onLateTurn));
        this.lateStart = stopped;
        void stopped.then(() => {
          if (this.lateStart === stopped) this.lateStart = null;
        });
        throw error;
      });
      tempImagePaths = started.tempImagePaths;
      if (started.turn && !observedTurnIds.has(started.turn.id)) {
        observedTurnId = started.turn.id;
        observedTurnIds.add(started.turn.id);
        this.activeTurnId = started.turn.id;
        this.onCodexTurnStarted?.(threadId, started.turn.id);
        void this.deliverEarlySteers();
        this.startTurn(started.turn);
      }
      const turn = await Promise.race([completed, disposed, stopUnanswered]);
      linearForwarder.flushThoughtAsResponse();
      return turn;
    } finally {
      host.client.off('notification', onNotification);
      host.client.off('serverRequest', onServerRequest);
      host.client.off('dispose', onDispose);
      clearTimeout(stopTimer);
      signal.removeEventListener('abort', giveUpIfStopUnanswered);
      this.stopGiveUp = null;
      this.unansweredStop = null;
      this.onGoalChanged = null;
      this.observingTurn = false;
      this.itemUpdateCoalescer.flushPending();
      await removeTempImageFiles(tempImagePaths);
      if (host.client.isDisposed) {
        this.attachedClient = null;
      }
    }
  }

  private async respondToServerRequest(
    host: CodexAspHost,
    serverRequest: AspServerRequest,
  ): Promise<void> {
    const requestId = serverRequest.id;
    const method = serverRequest.method;

    switch (serverRequest.method) {
      case 'item/commandExecution/requestApproval': {
        const result = await evaluateCommandProtection({
          provider: 'codex',
          source: 'codex_approval_request',
          toolName: 'commandExecution',
          toolInput: {
            command: serverRequest.params.command,
            commandActions: serverRequest.params.commandActions ?? null,
          },
          command: serverRequest.params.command,
          cwd: serverRequest.params.cwd ?? null,
          toolUseId: serverRequest.params.itemId ?? null,
        });
        if (!result.allowed) {
          console.warn(`[CodexAspManager] blocked command approval: ${result.reason ?? 'unknown reason'}`);
          this.recordBlockedCommand(
            serverRequest.params.turnId,
            serverRequest.params.itemId,
            serverRequest.params.command ?? '',
            result.reason,
            serverRequest.params.startedAtMs,
            serverRequest.params.cwd,
            serverRequest.params.commandActions,
          );
          await this.injectBlockedCommandReason(
            host,
            serverRequest.params.threadId,
            result.reason,
          );
          host.client.respond(requestId, { decision: 'decline' });
          return;
        }
        host.client.respond(requestId, { decision: 'accept' });
        return;
      }
      case 'item/fileChange/requestApproval':
        console.warn('[CodexAspManager] approval requested while sandbox is danger-full-access');
        host.client.respond(requestId, { decision: 'accept' });
        return;

      case 'execCommandApproval': {
        const command = serverRequest.params.command.join(' ');
        const result = await evaluateCommandProtection({
          provider: 'codex',
          source: 'codex_approval_request',
          toolName: 'execCommand',
          toolInput: {
            command: serverRequest.params.command,
            parsedCmd: serverRequest.params.parsedCmd ?? null,
          },
          command,
          cwd: serverRequest.params.cwd ?? null,
          toolUseId: serverRequest.params.callId ?? null,
        });
        if (!result.allowed) {
          console.warn(`[CodexAspManager] blocked legacy command approval: ${result.reason ?? 'unknown reason'}`);
          this.recordBlockedCommand(
            this.activeTurnId ?? `legacy-${requestId}`,
            serverRequest.params.callId,
            command,
            result.reason,
            Date.now(),
            serverRequest.params.cwd,
            [{ type: 'unknown', command }],
          );
          await this.injectBlockedCommandReason(
            host,
            this.currentThreadId ?? serverRequest.params.conversationId,
            result.reason,
          );
          host.client.respond(requestId, { decision: 'denied' });
          return;
        }
        host.client.respond(requestId, { decision: 'approved' });
        return;
      }
      case 'applyPatchApproval':
        console.warn('[CodexAspManager] legacy approval requested while sandbox is danger-full-access');
        host.client.respond(requestId, { decision: 'approved' });
        return;

      case 'item/permissions/requestApproval': {
        const requested = serverRequest.params.permissions;
        const permissions: v2.GrantedPermissionProfile = {};
        if (requested.network) permissions.network = requested.network;
        if (requested.fileSystem) permissions.fileSystem = requested.fileSystem;
        const response: v2.PermissionsRequestApprovalResponse = {
          permissions,
          scope: 'turn',
        };
        host.client.respond(requestId, response);
        return;
      }

      case 'item/tool/call': {
        const response: v2.DynamicToolCallResponse = {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: `Okidoki does not support Codex dynamic tool calls yet: ${serverRequest.params.namespace ? `${serverRequest.params.namespace}.` : ''}${serverRequest.params.tool}`,
          }],
        };
        host.client.respond(requestId, response);
        return;
      }

      case 'mcpServer/elicitation/request': {
        const response: v2.McpServerElicitationRequestResponse = {
          action: 'cancel',
          content: null,
          _meta: null,
        };
        host.client.respond(requestId, response);
        return;
      }

      case 'item/tool/requestUserInput':
      case 'attestation/generate':
        host.client.reject(requestId, -32601, `Okidoki does not support ASP server request ${method}`);
        return;
    }

    host.client.reject(requestId, -32601, `Okidoki does not support ASP server request ${method}`);
  }

  private async injectBlockedCommandReason(
    host: CodexAspHost,
    threadId: string,
    reason: string | undefined,
  ): Promise<void> {
    try {
      await host.client.request<v2.ThreadInjectItemsResponse>(
        THREAD_INJECT_ITEMS_METHOD,
        {
          threadId,
          items: [{
            type: 'message',
            role: 'developer',
            content: [{
              type: 'input_text',
              text: [
                '<organization_policy>',
                'The command currently awaiting approval was rejected for this reason:',
                formatBlockedCommandReason(reason),
                'Do not retry the blocked command unchanged. Adjust your approach to comply with this policy.',
                '</organization_policy>',
              ].join('\n'),
            }],
          }],
        } satisfies v2.ThreadInjectItemsParams,
        { timeoutMs: POLICY_REASON_INJECTION_TIMEOUT_MS },
      );
    } catch (error) {
      console.warn('[CodexAspManager] Failed to inject blocked command reason:', error);
    }
  }

  private recordBlockedCommand(
    turnId: string,
    itemId: string,
    command: string,
    reason: string | undefined,
    startedAtMs: number | null | undefined,
    cwd: string | null | undefined,
    commandActions: v2.CommandAction[] | null | undefined,
  ): void {
    const blockedItem: Extract<v2.ThreadItem, { type: 'commandExecution' }> = {
      type: 'commandExecution',
      id: itemId,
      command,
      cwd: cwd ?? this.workingDirectory,
      processId: null,
      pluginId: null,
      scriptPath: null,
      source: 'agent',
      commandActions: commandActions ?? [{ type: 'unknown', command }],
      aggregatedOutput: formatBlockedCommandReason(reason),
      exitCode: null,
      status: 'declined',
      durationMs: null,
    };
    this.completeItem(turnId, itemToTranscriptItem(blockedItem, timestampFromMilliseconds(startedAtMs), 'failed'));
  }

  private ensureLiveTurn(turnId: string): LiveTurn {
    if (this.liveTurn?.id !== turnId) {
      this.liveTurn = { id: turnId, items: new Map(), persistedItemIds: new Set() };
    }
    return this.liveTurn;
  }

  private startTurn(turn: v2.Turn): void {
    this.ensureLiveTurn(turn.id);
    const startedAt = timestampFromSeconds(turn.startedAt);
    for (const item of turn.items) {
      this.startItem(turn.id, itemToTranscriptItem(item, startedAt, 'in_progress'));
    }
  }

  private startItem(turnId: string, item: CodexAspTranscriptItem | null): void {
    if (!item) return;
    const turn = this.ensureLiveTurn(turnId);
    const existing = turn.items.get(item.id);
    // Streamed text can arrive before the item itself; an empty started record must not erase it.
    const started = existing?.type === 'agentMessage' && item.type === 'agentMessage' && !item.text
      ? { ...item, text: existing.text }
      : item;
    turn.items.set(item.id, { ...started, timestamp: existing?.timestamp ?? item.timestamp });
    this.itemUpdateCoalescer.schedule(item.id, { immediate: true });
  }

  private completeItem(turnId: string, item: CodexAspTranscriptItem | null): void {
    if (!item) return;
    const turn = this.ensureLiveTurn(turnId);
    const live = turn.items.get(item.id);
    turn.items.delete(item.id);
    turn.persistedItemIds.add(item.id);
    const completed = live ? { ...item, timestamp: live.timestamp, completedAt: item.timestamp } : item;
    const persisted: CodexAspTranscriptItem = completed.type === 'subagent' && completed.status === 'completed' ? { ...completed, status: 'in_progress' } : completed;
    if (persisted.type === 'subagent' && persisted.status === 'in_progress') {
      const subagent = { turnId, item: persisted, active: new Set(persisted.receiverThreadIds), failed: false };
      for (const threadId of subagent.active) this.codexSubagents.set(threadId, subagent);
    }
    const event = codexItemEvent(turnId, persisted);
    this.record(event);
  }

  private updateCodexSubagent(subagent: CodexSubagent): void {
    const status = normalizeCodexAspTranscriptStatus(subagent.active.size > 0 ? 'inProgress' : 'completed', subagent.failed);
    if (subagent.item.status === status) return;
    subagent.item = { ...subagent.item, status };
    const event = codexItemEvent(subagent.turnId, subagent.item);
    this.record(event);
  }

  private closeCodexSubagents(): void {
    for (const subagent of new Set(this.codexSubagents.values())) {
      subagent.active.clear();
      this.updateCodexSubagent(subagent);
    }
    this.codexSubagents.clear();
  }

  private readonly onSubagentThreadStatus = (notification: AspNotification): void => {
    if (notification.method !== THREAD_STATUS_CHANGED_METHOD) return;
    const { threadId, status: { type } } = notification.params;
    const subagent = this.codexSubagents.get(threadId);
    if (!subagent) return;
    if (type === 'active') subagent.active.add(threadId);
    else subagent.active.delete(threadId);
    subagent.failed ||= type === 'systemError';
    this.updateCodexSubagent(subagent);
  };

  private completeTurn(turn: v2.Turn): void {
    const live = this.ensureLiveTurn(turn.id);
    // Codex reports turn times in whole seconds, which can sort before items started in the same second.
    const completedAt = new Date().toISOString();
    const status: CodexAspTranscriptStatus = turn.status === 'failed' ? 'failed' : 'completed';
    for (const item of turn.items) {
      if (!live.persistedItemIds.has(item.id)) this.completeItem(turn.id, itemToTranscriptItem(item, completedAt, status));
    }
    // A dropped item/completed must not leave a finished turn's reasoning "thinking".
    for (const item of live.items.values()) {
      this.completeItem(turn.id, item.type === 'reasoning' ? { ...item, status } : item);
    }
    const failure = turn.error ? formatTurnFailure(turn) : undefined;
    this.lastTurnFailure = failure === undefined ? null : { turnId: turn.id, message: failure };
    const event = codexTurnEvent(turn.id, turn.status, completedAt, failure);
    this.record(event);
    this.liveTurn = null;
  }

  private appendAgentMessageDelta(turnId: string, itemId: string, delta: string): void {
    const turn = this.ensureLiveTurn(turnId);
    const existing = turn.items.get(itemId);
    turn.items.set(itemId, existing?.type === 'agentMessage'
      ? { ...existing, text: `${existing.text}${delta}` }
      : { type: 'agentMessage', id: itemId, text: delta, timestamp: new Date().toISOString() });
    this.itemUpdateCoalescer.schedule(itemId);
  }

  private appendReasoningDelta(turnId: string, itemId: string, delta: string): void {
    const turn = this.ensureLiveTurn(turnId);
    const existing = turn.items.get(itemId);
    if (!existing && !delta.trim()) return;
    turn.items.set(itemId, existing?.type === 'reasoning'
      ? { ...existing, text: `${existing.text}${delta}` }
      : { type: 'reasoning', id: itemId, text: delta, timestamp: new Date().toISOString(), status: 'in_progress' });
    this.itemUpdateCoalescer.schedule(itemId);
  }

  private appendOutputDelta(turnId: string, itemId: string, delta: string): void {
    const turn = this.ensureLiveTurn(turnId);
    const item = turn.items.get(itemId);
    if (item?.type !== 'commandExecution' && item?.type !== 'fileChange') return;
    turn.items.set(itemId, { ...item, output: appendCodexAspTranscriptOutput(item.output, delta), status: 'in_progress' });
    this.itemUpdateCoalescer.schedule(itemId);
  }

  private async refreshThreadGoal(host: CodexAspHost, threadId: string): Promise<void> {
    const revision = this.goalRevision;
    const currentThreadId = this.currentThreadId;
    const attachedClient = this.attachedClient;
    try {
      const response = await host.client.request<v2.ThreadGoalGetResponse>(
        THREAD_GOAL_GET_METHOD,
        { threadId },
      );
      if (
        this.goalRevision !== revision
        || this.currentThreadId !== currentThreadId
        || this.attachedClient !== attachedClient
        || host.client.isDisposed
      ) return;
      this.recordGoalChange(response.goal);
    } catch (error) {
      console.warn('[CodexAspManager] Failed to read ASP thread goal:', error);
    }
  }

  private recordGoalChange(goal: v2.ThreadGoal | null, force = false): void {
    this.goalRevision += 1;
    this.goalHistoryKnown = true;
    const nextGoal = goal ? aspGoalToChatGoal(goal) : null;
    if (force || JSON.stringify(this.currentGoal) !== JSON.stringify(nextGoal)) {
      this.currentGoal = nextGoal;
      this.recordHistoryEvent(CHAT_GOAL_EVENT_TYPE, { goal: nextGoal } satisfies ChatGoalEventPayload);
    }
    this.onGoalChanged?.();
  }

  private handleRateLimits(rateLimits: v2.RateLimitSnapshot): void {
    const snapshot = extractRateLimitsSnapshot(rateLimits);
    if (snapshot) {
      this.emitQuotaEvent(this.quotaStatus.observe(snapshot));
    }
  }

  private async refreshQuotaSnapshot(host: CodexAspHost): Promise<void> {
    try {
      const response = await host.client.request<v2.GetAccountRateLimitsResponse>(
        ACCOUNT_RATE_LIMITS_READ_METHOD,
        undefined,
      );
      this.handleRateLimits(response.rateLimits);
    } catch {}
  }

  private async restartAndRetry(dispatch: () => Promise<void>): Promise<{ error: unknown } | null> {
    try {
      await restartCodexAspHost();
      this.attachedClient = null;
      await dispatch();
      return null;
    } catch (error) {
      return { error };
    }
  }

  private async confirmOutOfCredits(host: CodexAspHost): Promise<boolean> {
    await this.refreshQuotaSnapshot(host);
    const event = this.quotaStatus.confirmOutOfCredits();
    if (!event) return false;
    this.emitQuotaEvent(event);
    return true;
  }

  private emitQuotaEvent(event: AgentEvent | null): void {
    if (!event) return;
    this.record(event);
  }

  private emitCodexTokenUsage(
    tokenUsage: v2.ThreadTokenUsage,
    model: string,
    updatedAt: string,
  ): void {
    const payload = buildCodexTokenUsageContextUsagePayload({
      model,
      modelContextWindow: tokenUsage.modelContextWindow,
      autoCompactTokens: this.attachedAutoCompactTokens,
      last: {
        inputTokens: tokenUsage.last.inputTokens,
        outputTokens: tokenUsage.last.outputTokens,
        totalTokens: tokenUsage.last.totalTokens,
      },
      updatedAt,
    });
    this.recordContextUsage(payload);
  }

}
