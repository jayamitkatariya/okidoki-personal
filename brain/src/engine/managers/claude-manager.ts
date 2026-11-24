import {
  forkSession,
  getSessionMessages,
  query,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
  type Query,
  type SDKControlGetContextUsageResponse,
  type HookCallback,
  type HookJSONOutput,
  type SdkPluginConfig,
  type SlashCommand as ClaudeSlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_OLLAMA_MODEL, AGENT, CLAUDE_STOPPED_TOOL_RESULT, INTERRUPTED_MESSAGE_REGEX, isClaudeResultError, AGENT_MODELS, AUTH_FALLBACK_EVENT_TYPE, AUTH_RETRY_STATUS_EVENT_TYPE, CHAT_GOAL_EVENT_TYPE, CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE, CLAUDE_PEER_MESSAGE_EVENT_TYPE, DEFAULT_CLAUDE_MODEL, autoCompactThresholdField, canUseClaudeFastMode, clampTokensToWindow, coerceChatGoalPayload, createProviderSlashCommand, detectAgentQuotaLimit, extractErrorText, extractToolResultText, engineCredentialRefreshFailureSchema, extractJsonObject, getClaudeModelContextWindow, isSameCredential, MODEL_PREDECESSORS, getGoalCommand, isClaudeAuthErrorText, isRecord, isTransientErrorText, shouldRefreshPullRequests, mergeSlashCommands, normalizeAutoCompactThreshold, normalizeClaudeModel, percentage, raceWithTimeout, REPLACED_MESSAGE_ID_PAYLOAD_KEY, OKIDOKI_INSTRUCTIONS_TAG, safeJsonParse, USER_MESSAGE_ID_PAYLOAD_KEY, wrapInTag, type AgentCredentialSnapshot, type AgentEvent, type AuthFallbackPayload, type AgentQuotaLimitKind, type ChatGoal, type ChatGoalEventPayload, type ChatHistoryPageParams, type ChatHistoryResponse, type ClaudePartialMessagePayload, type ClaudePeerMessagePayload, type ContextUsagePayload, type SendChatMessageRequest, type SlashCommand, type ThinkingLevel } from '@okidoki/shared';
import { randomUUID, type UUID } from 'crypto';
import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { convertClaudeEvent } from '../utils/linear-converter';
import { normalizeImages } from '../utils/image-utils';
import { CodingAgentManager, takesTurnNotes, type CodingAgentManagerOptions } from './coding-agent-manager';
import type { ProviderForkPoint } from './coding-agent-provider';
import { describeLoginFailure, describeModelUnavailable, describeQuotaExhaustion, type AuthFallbackResult, type QuotaStopFallbackResult } from './auth-fallback';
import type { QueuedMessage } from '../services/message-queue-service';
import { ENGINE_ENV } from '../engine-env';
import { buildClaudeAgentEnv, resolveClaudeAuthMethodForMessage } from '../utils/agent-env';
import { getAgentAdditionalDirectories } from '../utils/agent-additional-directories';
import { claudeTokenManager } from './claude-token-manager';
import { forgetExhaustedCredentials, getFallbackModel } from '../services/credential-fallbacks';
import { LinearEventForwarder } from '../utils/linear-event-forwarder';
import { evaluateCommandProtection, extractToolCommand } from '../services/command-protection-service';
import { pullRequestCheckService } from '../services/pull-request-check-service';
import { buildClaudeRegistryConfig } from '../services/skill-registry-service';
import {
  createClaudeSessionActivity,
  isClaudeSessionActive,
  resetClaudeSessionActivity,
  updateClaudeSessionActivity,
} from './claude-activity';
import { ClaudeBackgroundTasks } from './claude-background-tasks';
import { OKIDOKI_MCP_SERVER_NAME, OKIDOKI_MCP_TOOLS, SUBAGENT_MCP_SERVER_NAME } from '@okidoki/shared';
import { subagentMcpProcessConfig } from './subagent-mcp-config';

class PromptStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private closed = false;
  private waiters: Array<(value: IteratorResult<SDKUserMessage, void>) => void> = [];
  readonly sentUuids = new Set<string>();

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    if (message.uuid) this.sentUuids.add(message.uuid);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) {
      waiter({ value: undefined, done: true });
    }
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, void> {
    return {
      next: () => {
        const nextItem = this.queue.shift();
        if (nextItem) {
          return Promise.resolve({ value: nextItem, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage, void>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

// Tools removed from the model's context entirely. Sessions set no canUseTool callback, so nothing could answer AskUserQuestion or ExitPlanMode.
const ALWAYS_DISALLOWED_TOOLS = [
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'CronCreate', 'CronDelete', 'CronList',
  'RemoteTrigger', 'PushNotification',
] as const;

const COMMAND_PROTECTION_SAFE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'TodoRead',
  'TodoWrite',
  'WebFetch',
  'LS',
]);

const CLAUDE_PARTIAL_MESSAGE_FLUSH_MS = 80;
const CLAUDE_SLASH_COMMANDS_CACHE_MS = 60_000;
const CLAUDE_SLASH_COMMANDS_DISCOVERY_TIMEOUT_MS = 30_000;
const CLAUDE_BACKGROUND_CONTINUATION_GRACE_MS = 10_000;
const CLAUDE_BACKGROUND_RECOVERY_START_TIMEOUT_MS = 60_000;
const CLAUDE_INTERRUPT_TIMEOUT_MS = 5_000;

function supportsClaudeThinkingDisplay(model: string): boolean {
  const normalized = (normalizeClaudeModel(model) ?? model).toLowerCase();
  return AGENT_MODELS.claude.includes(normalized)
    || /^claude-(?:opus|sonnet|haiku)-[4-9]/.test(normalized);
}

class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAuthError';
  }
}

class ClaudeModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeModelUnavailableError';
  }
}

class ClaudeTransientTurnError extends Error {
  constructor(message: string, readonly midTurn = false) {
    super(message);
    this.name = 'ClaudeTransientTurnError';
  }
}

class ClaudeMissingSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeMissingSessionError';
  }
}

// Claude Code re-reads changed instruction files when a session starts, after it decides whether to compact, so a
// resumed or forked session near its window can be refused before any compaction or model call.
class ClaudeContextBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeContextBlockedError';
  }
}

class ClaudeQuotaError extends Error {
  constructor(message: string, readonly kind: AgentQuotaLimitKind, readonly resetsAt?: string) {
    super(message);
    this.name = 'ClaudeQuotaError';
  }
}

const MAX_AUTH_RETRIES = 2;
const MAX_TRANSIENT_RETRIES = 2;
const MAX_MIDTURN_CONTINUE_RETRIES = 2;
const TRANSIENT_RETRY_DELAYS_MS = [1000, 2500];
const CLAUDE_TRANSIENT_HTTP_STATUSES = [408, 500, 502, 503, 504, 529] as const;
const CLAUDE_MIDTURN_CONTINUE_PROMPT =
  'Your previous turn was interrupted by a transient network error before it could finish. '
  + 'Continue from exactly where you left off. Do not repeat any tool calls, commits, messages, '
  + 'or other actions you have already completed — first check what is already done, then do only '
  + 'the remaining work.';
const CLAUDE_BACKGROUND_TURN_CONTINUE_PROMPT =
  'Your previous turn was cut off by an error before it could finish, and the session was restarted, '
  + 'which stopped any background tasks or agents that were still running. Continue from where you left off: '
  + 'first check what is already done, rerun only the background work whose results you still need, and do not '
  + 'repeat tool calls, commits, or messages you have already completed.';
const CLAUDE_RETRY_PROMPT =
  'Your previous attempt to respond to the message above failed before producing a response. Respond to it now.';

/**
 * Inputs that determine the shape of the underlying SDK `query()` call. If
 * these differ from the live session's signature, the session must be torn
 * down and recreated — at the cost of killing any background tasks that were
 * running inside it. Settings that the SDK supports hot-swapping (`model`) are
 * intentionally excluded so they don't force a restart.
 */
interface SessionSignature {
  credential: string | undefined;
  combinedInstructions: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  fastMode: boolean;
  autoCompactTokens: number | null;
  subagentMcpParentChatId: string | undefined;
  disableNativeSubagents: boolean;
}

type ClaudeUserContent = Exclude<SDKUserMessage['message']['content'], string>;

// The model reads adjacent text blocks as one run of text, so a carried-over prompt needs its own break.
function appendUserContent(earlier: ClaudeUserContent, later: ClaudeUserContent): ClaudeUserContent {
  const last = earlier.at(-1);
  return last?.type === 'text' ? [...earlier.slice(0, -1), { ...last, text: `${last.text}\n\n` }, ...later] : [...earlier, ...later];
}

interface PendingTurn {
  // The initial prompt plus steered ones: a steer that misses the running turn gets its own turn.
  userMessageUuids: Set<string>;
  steers: Map<string, { messageId: string; userMessage: SDKUserMessage & { uuid: UUID } }>;
  resolve: () => void;
  reject: (err: unknown) => void;
  sawActivity: boolean;
}

interface ClaudePartialMessageStream {
  streamId: string;
  parent_tool_use_id: string | null;
  text: string;
  // When each flush went out and how much text it carried, so a stopped reply keeps what had reached the user.
  flushes: Array<{ at: number; length: number }>;
  thinking: string;
  tool?: ClaudePartialMessagePayload['tool'];
  toolUse?: { id: string; name: string; input: string };
}

// Claude Code's tools take their target first: a file tool's path, which has streamed long before the edit itself, and
// Bash's command, whose first line has streamed long before the rest of a heredoc.
const TOOL_TARGET = /^\s*\{\s*"(\w+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)(")?)?/;
const JSON_FIRST_LINE = /^(?:[^\\]|\\[^n])*?(?=\\n)/;

function isPromptMessage(message: unknown): boolean {
  const content = isRecord(message) ? message.content : undefined;
  return typeof content === 'string' || (Array.isArray(content) && content.some((block) => !isRecord(block) || block.type !== 'tool_result'));
}

function toSlashCommands(command: ClaudeSlashCommand): SlashCommand[] {
  const names = [command.name, ...(command.aliases ?? [])];
  return names.flatMap((name) => {
    const result = createProviderSlashCommand('claude', name, command.description, command.argumentHint);
    return result ? [result] : [];
  });
}

function normalizeClaudeSlashCommands(commands: ClaudeSlashCommand[]): SlashCommand[] {
  return mergeSlashCommands(...commands.map(toSlashCommands));
}

export class ClaudeManager extends CodingAgentManager {
  private sessionId: string | null = null;
  private activeQuery: Query | null = null;
  private activePromptStream: PromptStream | null = null;
  private activeSessionSignature: SessionSignature | null = null;
  private activeSessionModel: string | null = null;
  private sessionLoop: Promise<void> | null = null;
  private sessionLinearForwarder: LinearEventForwarder | null = null;
  private pendingTurn: PendingTurn | null = null;
  private attemptSawActivity = false;
  // A broken login the turn moved past; if the turn still fails, it is the error the user can act on.
  private turnLoginFailure: string | null = null;
  private readonly sessionActivity = createClaudeSessionActivity();
  private backgroundContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInterrupt = false;
  private stoppedAtMs = Infinity;
  // A turn started before a stop's teardown would run on the process being stopped and end with it.
  private stopping: Promise<void> | null = null;
  // Claude Code emits a stopped turn's partial reply only after acknowledging the interrupt, so teardown waits for the turn to end.
  private stoppedTurnEnded: PromiseWithResolvers<void> | null = null;
  protected override readonly reportsPromptStart = true;
  // Claude Code writes a started prompt to the session transcript even when the turn then fails, so a retry must not resend it.
  private turnPromptRecorded = false;
  private readonly endedReplies = new Set<string>();
  // Whether the cut landed in time; kept until Claude Code answers the interrupt, however late.
  private pendingCut: Promise<boolean> | null = null;
  // The time of the press, so the stop line is dated when the person cut the reply, not when Claude Code reports it.
  private cutSentAt: string | null = null;
  private compacting = false;
  // Claude Code never sees a prompt cut off before it started, so it is sent again with the next message; a Stop before then hands back `requests`, the messages in it as the user sent them.
  private unreadPrompt: { uuid: string; content: ClaudeUserContent; requests: QueuedMessage[] } | null = null;
  private sentPrompt: { uuid: string; signal: AbortSignal; record?: () => Promise<void> } | null = null;
  private turnPromptWritten = false;
  private readonly runningTools = new Map<string, string>();
  // Claude Code tells the model the user rejected the tool calls a stop cuts off, so the next prompt corrects that.
  private readonly cutOffTools = new Map<string, string>();
  private readonly backgroundTasks = new ClaudeBackgroundTasks();
  private backgroundRecoveryAttempted = false;
  // Ultracode workflow child agents never reach the SDK stream (forwardSubagentText
  // covers only Task subagents); their conversations exist solely as
  // agent-<agentId>.jsonl files in the run's transcript directory, keyed by task id.
  private readonly workflowTranscripts = new Map<string, { dir: string; offsets: Map<string, number> }>();
  private readonly ambientTaskIds = new Set<string>();
  // Set when Claude starts a turn on its own (e.g. woken by a finished background
  // task); cleared once that turn's completion is reported through onTurnComplete.
  private pendingBackgroundCompletion = false;
  private backgroundCompletionsInFlight = 0;
  private readonly partialMessageStreams = new Map<string, ClaudePartialMessageStream>();
  private readonly requestsInFlight = new Map<string, unknown>();
  private readonly partialMessageFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private supportedSlashCommands: SlashCommand[] = [];
  private slashCommandsDiscoveredAt = 0;
  private slashCommandsDiscovery: Promise<SlashCommand[]> | null = null;
  private authRetrying = false;
  private currentGoal: ChatGoal | null = null;
  private goalClear: Promise<void> | null = null;
  private lastRequest: SendChatMessageRequest | null = null;
  private readonly onChatCredential: (credential: AgentCredentialSnapshot | 'workspace') => void;

  constructor(options: CodingAgentManagerOptions) {
    super({
      ...options,
      provider: AGENT.CLAUDE,
      onProcessingChanged: (processing) => {
        if (!processing) this.maybeCompleteBackgroundTurn();
        options.onProcessingChanged?.(processing);
      },
    });
    this.onChatCredential = options.onChatCredential ?? (() => {});

    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected async interruptActiveTurn(stoppedAt?: string): Promise<void> {
    this.pendingInterrupt = true;
    this.stoppedAtMs = stoppedAt ? Date.parse(stoppedAt) : Date.now();
    const stopping = (async () => {
      const query = this.activeQuery;
      if (query) {
        // Only Claude Code's interrupt records the stop, so the next turn doesn't resume the old work; cancelQueued (untyped in the SDK) keeps steers from starting.
        const interrupt: (options: { cancelQueued: boolean }) => Promise<unknown> = query.interrupt.bind(query);
        const ended = isClaudeSessionActive(this.sessionActivity) ? Promise.withResolvers<void>() : null;
        this.stoppedTurnEnded = ended;
        await raceWithTimeout(Promise.all([interrupt({ cancelQueued: true }).catch(() => {}), ended?.promise]), CLAUDE_INTERRUPT_TIMEOUT_MS);
        this.stoppedTurnEnded = null;
      }
      // Acknowledged interrupts can leave resumed tasks alive; Stop ends the owned SDK process.
      await this.tearDownSession(true);
    })();
    this.stopping = stopping;
    await stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = null;
    });
  }

  // A request cut before its stop reason never reaches Claude Code's totals, so it is counted from what it started with.
  private countCutRequests(): void {
    for (const started of this.requestsInFlight.values()) this.onUsageUpdate(started, new Date().toISOString());
    this.requestsInFlight.clear();
  }

  // Stop can tear a session down before its command_lifecycle event is read, so the transcript decides.
  private async promptRecorded(promptUuid: string): Promise<boolean> {
    return !!this.sessionId
      && (await getSessionMessages(this.sessionId, { dir: this.workingDirectory })).some(({ uuid }) => uuid === promptUuid);
  }

  private async dropRecordedUnreadPrompt(): Promise<void> {
    if (this.unreadPrompt && await this.promptRecorded(this.unreadPrompt.uuid)) this.unreadPrompt = null;
  }

  // Claude Code makes everything sent with a slash command part of that command's own entry, which the model does not answer.
  protected override carriesKeptRequests(request: Pick<SendChatMessageRequest, 'goalMode' | 'message'>): boolean {
    return takesTurnNotes(request);
  }

  protected override async readStoppedMessage(signal: AbortSignal): Promise<boolean> {
    return this.sentPrompt?.signal === signal && this.promptRecorded(this.sentPrompt.uuid);
  }

  // The chat's own copy of a prompt is written once Claude Code has it, so a prompt stopped before then leaves nothing behind.
  private async recordSentPrompt(): Promise<void> {
    const record = this.sentPrompt?.record;
    if (!this.sentPrompt || !record) return;
    this.sentPrompt.record = undefined;
    await record();
  }

  protected override async keepStoppedRequest(request: SendChatMessageRequest, signal: AbortSignal): Promise<boolean> {
    await this.dropRecordedUnreadPrompt();
    const { uuid, message } = await this.buildUserMessage(request);
    // Loading its images can take seconds, and a Stop meanwhile has handed the message back.
    if (this.isStopped(signal)) return false;
    this.keepUnreadPrompt(uuid, appendUserContent(this.unreadPrompt?.content ?? [], message.content));
    return true;
  }

  private keepUnreadPrompt(uuid: string, content: ClaudeUserContent): void {
    const requests = this.unreadPrompt?.requests ?? [];
    this.unreadPrompt = { uuid, content, requests: !this.turnRequest || requests.includes(this.turnRequest) ? requests : [...requests, this.turnRequest] };
  }

  protected override takeKeptRequests(): { sent: Promise<QueuedMessage[]>; putBack: () => void } {
    const unread = this.unreadPrompt;
    this.unreadPrompt = null;
    return {
      sent: (async () => unread && !await this.promptRecorded(unread.uuid) ? unread.requests : [])(),
      putBack: () => {
        if (!unread) return;
        const later = this.unreadPrompt;
        this.unreadPrompt = later ? { ...later, content: appendUserContent(unread.content, later.content), requests: [...unread.requests, ...later.requests] } : unread;
      },
    };
  }

  // A steer is read when the tool call in flight returns; with none, Claude Code reads it only once the whole reply is written.
  // An interrupt would also end background agents and make a compaction start over, and one sent once the reply is cut or over would cut the reply to the steer itself.
  private repliesInFlight(): string[] {
    const turn = this.pendingTurn;
    if (!turn || !this.turnPromptRecorded || this.compacting || this.runningTools.size > 0 || this.backgroundTasks.runsAgents) return [];
    return [...turn.userMessageUuids].filter((uuid) => !turn.steers.has(uuid) && !this.endedReplies.has(uuid));
  }

  protected override canDeliverSteersNow(): boolean {
    return this.activeQuery !== null && (this.backgroundTasks.foreground.size > 0 || this.pendingCut !== null || this.repliesInFlight().length > 0);
  }

  protected override async deliverSteersNow(): Promise<boolean> {
    const query = this.activeQuery;
    if (!query) return true;
    const foreground = [...this.backgroundTasks.foreground.values()];
    if (foreground.length > 0) {
      await Promise.all(foreground.map((toolUseId) => query.backgroundTasks(toolUseId)));
      return true;
    }
    // An interrupt Claude Code has not answered may still land, and a second one behind it would cut the reply to the steer itself.
    if (this.pendingCut) return this.pendingCut;
    const cut = this.repliesInFlight();
    for (const uuid of cut) this.endedReplies.add(uuid);
    this.cutSentAt = new Date().toISOString();
    // An interrupt that keeps what is queued ends the reply and starts the steers in the same session.
    // One Claude Code rejects cut nothing, so it leaves the reply for a later Send now.
    const answered = query.interrupt().then(
      () => true,
      () => {
        for (const uuid of cut) this.endedReplies.delete(uuid);
        this.cutSentAt = null;
        return false;
      },
    );
    const pending = raceWithTimeout(answered, CLAUDE_INTERRUPT_TIMEOUT_MS).then((landed) => landed === true);
    this.pendingCut = pending;
    void answered.then(() => { if (this.pendingCut === pending) this.pendingCut = null; });
    return pending;
  }

  // Claude Code folds a `next`-priority prompt into the running turn at its next tool boundary.
  protected override async steerRequest(request: QueuedMessage): Promise<boolean> {
    const pendingTurn = this.pendingTurn;
    const promptStream = this.activePromptStream;
    if (!pendingTurn || !promptStream) return false;
    if (getGoalCommand(request.message, request.goalMode)) return false;
    const userMessage = await this.buildUserMessage(request);
    if (this.pendingTurn !== pendingTurn || this.activePromptStream !== promptStream || this.isSteerWithdrawn(request)) return false;
    pendingTurn.userMessageUuids.add(userMessage.uuid);
    pendingTurn.steers.set(userMessage.uuid, { messageId: request.id, userMessage });
    promptStream.push({ ...userMessage, priority: 'next' });
    return true;
  }

  private async recordSteerRead(uuid: string): Promise<void> {
    const steer = this.pendingTurn?.steers.get(uuid);
    if (!steer) return;
    this.pendingTurn?.steers.delete(uuid);
    if (this.markSteerRead(steer.messageId)) await this.recordEvent(steer.userMessage, steer.messageId);
  }

  // Claude Code starts a command for another chat's SendMessage without streaming its text, and can start it a moment before writing it.
  private async recordPeerMessage(uuid: string, query: Query): Promise<void> {
    for (const delayMs of [0, 100, 300, 600, 1000]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (this.activeQuery !== query || !this.sessionId) return;
      const entry = (await getSessionMessages(this.sessionId, { dir: this.workingDirectory })).findLast((message) => message.uuid === uuid);
      if (!entry) continue;
      const origin = 'origin' in entry && isRecord(entry.origin) ? entry.origin : null;
      // In-process teammates also send as peers, but they're this chat's own agents, not another chat.
      if (origin?.kind !== 'peer' || origin.senderTaskId) return;
      const text = extractToolResultText(isRecord(entry.message) ? entry.message.content : undefined);
      // Messages that arrive together share one command, and its origin carries only the first body.
      const envelopes = [...text.matchAll(/<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/g)].map(([, attributes, body]) => ({
        name: /\bfrom-name="([^"]*)"/.exec(attributes)?.[1],
        from: /\bfrom="([^"]*)"/.exec(attributes)?.[1],
        body,
      }));
      const messages = envelopes.length > 0 ? envelopes
        : typeof origin.body === 'string' ? [{ name: typeof origin.name === 'string' ? origin.name : undefined, from: typeof origin.from === 'string' ? origin.from : undefined, body: origin.body }]
          : [];
      for (const { name, from, body } of messages) {
        this.recordHistoryEvent(CLAUDE_PEER_MESSAGE_EVENT_TYPE, {
          ...(name ? { name } : {}),
          ...(from ? { from } : {}),
          body,
        } satisfies ClaudePeerMessagePayload);
      }
      return;
    }
  }

  isAuthRetrying(): boolean {
    return this.authRetrying;
  }

  override isProcessing(): boolean {
    return super.isProcessing()
      || isClaudeSessionActive(this.sessionActivity)
      || this.backgroundCompletionsInFlight > 0;
  }

  getGoal(): ChatGoal | null {
    return this.currentGoal;
  }

  async clearGoal(model?: string): Promise<ChatGoal | null> {
    await this.initialized;
    const previousGoal = this.currentGoal;
    if (!previousGoal) return null;
    this.recordGoalChange(null);
    // Claude Code restores an uncleared goal whenever the session resumes, so the clear has to reach the session itself.
    if (this.sessionId) {
      // Reuses the chat's session settings so the clear doesn't switch its model or force another restart.
      this.goalClear = this.executeQuery(
        { model, ...this.lastRequest, message: '/goal clear', images: undefined, goalMode: false },
        { skipUserMessageRecord: true },
      ).finally(() => {
        this.goalClear = null;
      });
      try {
        await this.goalClear;
      } catch (error) {
        this.recordGoalChange(previousGoal);
        throw error;
      }
    }
    return null;
  }

  private recordGoalChange(goal: ChatGoal | null): void {
    if (!goal && !this.currentGoal) return;
    this.currentGoal = goal;
    this.recordHistoryEvent(CHAT_GOAL_EVENT_TYPE, { goal } satisfies ChatGoalEventPayload);
  }

  // Keeps the workspace alive without showing the chat as working: an idle agent isn't waiting on these.
  hasActiveBackgroundTasks(): boolean {
    return this.backgroundTasks.active.size > 0 || this.backgroundContinuationTimer !== null;
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    await this.initialized;

    if (this.activeQuery) {
      if (this.isProcessing()) {
        return this.supportedSlashCommands;
      }
      try {
        const commands = await this.activeQuery.supportedCommands();
        if (commands) {
          this.supportedSlashCommands = normalizeClaudeSlashCommands(commands);
          this.slashCommandsDiscoveredAt = Date.now();
        }
      } catch (error) {
        console.warn('[ClaudeManager] Failed to load slash commands:', error);
      }
      return this.supportedSlashCommands;
    }

    if (this.slashCommandsDiscoveredAt > 0
        && Date.now() - this.slashCommandsDiscoveredAt < CLAUDE_SLASH_COMMANDS_CACHE_MS) {
      return this.supportedSlashCommands;
    }

    this.slashCommandsDiscovery ??= this.discoverSlashCommands().finally(() => {
      this.slashCommandsDiscovery = null;
    });
    return this.slashCommandsDiscovery;
  }

  /**
   * Sessions are created lazily on the first message, but the dashboard needs
   * the command list as soon as a chat opens — so with no session alive we
   * spawn a throwaway query (no prompt is ever pushed, so no model call is
   * made), read supportedCommands(), and terminate it.
   */
  private async discoverSlashCommands(): Promise<SlashCommand[]> {
    const promptStream = new PromptStream();
    let discovery: Query | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const shared = await this.buildSharedQueryOptions();
      discovery = query({
        prompt: promptStream,
        options: {
          cwd: this.workingDirectory,
          additionalDirectories: shared.additionalDirectories,
          settingSources: ['user', 'project', 'local'],
          ...(shared.plugins.length > 0 ? { plugins: shared.plugins } : {}),
          ...(shared.enableAllSkills ? { skills: 'all' as const } : {}),
          env: shared.env,
        },
      });
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error('Slash command discovery timed out')),
          CLAUDE_SLASH_COMMANDS_DISCOVERY_TIMEOUT_MS,
        );
      });
      const commands = await Promise.race([discovery.supportedCommands(), timeout]);
      if (commands) {
        this.supportedSlashCommands = normalizeClaudeSlashCommands(commands);
      }
    } catch (error) {
      console.warn('[ClaudeManager] Failed to discover slash commands:', error);
    } finally {
      // Stamp the attempt (even on empty/timeout/error) so we back off for the
      // cache TTL instead of respawning a CLI query on every poll.
      this.slashCommandsDiscoveredAt = Date.now();
      clearTimeout(timeoutHandle);
      promptStream.close();
      discovery?.close();
    }
    return this.supportedSlashCommands;
  }

  private setAuthRetrying(value: boolean): void {
    if (this.authRetrying === value) return;
    this.authRetrying = value;
    this.emitSyntheticEvent(AUTH_RETRY_STATUS_EVENT_TYPE, { isAuthRetrying: value });
  }

  private buildCommandProtectionHook(): HookCallback {
    return async (input, toolUseID, options): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      if (COMMAND_PROTECTION_SAFE_TOOLS.has(input.tool_name)) return {};

      const result = await evaluateCommandProtection({
        provider: 'claude',
        source: 'claude_pre_tool_use',
        toolName: input.tool_name,
        toolInput: input.tool_input,
        command: extractToolCommand(input.tool_input),
        cwd: input.cwd,
        toolUseId: toolUseID ?? input.tool_use_id,
      }, options.signal);

      if (result.allowed) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason || 'Blocked by Okidoki command protection.',
        },
      };
    };
  }

  private async forwardWorkflowAgentTranscripts(taskId: string): Promise<void> {
    const workflow = this.workflowTranscripts.get(taskId);
    // An ambient task is hidden from the transcript, so its children must not be
    // persisted either — nothing would ever render them.
    if (!workflow || this.ambientTaskIds.has(taskId)) return;
    for (const file of await readdir(workflow.dir).catch(() => [])) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(file)?.[1];
      if (!agentId) continue;
      const offset = workflow.offsets.get(file) ?? 0;
      const buffer = await readFile(join(workflow.dir, file)).catch(() => Buffer.alloc(0));
      // The CLI may be mid-append; everything past the last newline stays for the next drain.
      const end = buffer.lastIndexOf(0x0a);
      if (end < offset) continue;
      workflow.offsets.set(file, end + 1);
      for (const line of buffer.toString('utf8', offset, end).split('\n').filter(Boolean)) {
        const entry = safeJsonParse<{ type?: unknown; message?: unknown; timestamp?: unknown; sessionId?: unknown } | null>(line, null);
        if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || typeof entry.message !== 'object' || !entry.message) continue;
        const event: AgentEvent = {
          timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
          type: `claude-${entry.type}`,
          payload: {
            type: entry.type,
            message: entry.message,
            parent_tool_use_id: agentId,
            session_id: typeof entry.sessionId === 'string' ? entry.sessionId : this.sessionId ?? '',
          },
        };
        this.record(event);
      }
    }
  }

  private async processMessageInternal(request: QueuedMessage, signal: AbortSignal): Promise<void> {
    let lastError: unknown;
    let failedLogin: { credential: AgentCredentialSnapshot | undefined; revoked: boolean } | undefined;
    let loginRevoked = false;
    let namedLogin: AgentCredentialSnapshot | undefined;
    let failedCredentials: AgentCredentialSnapshot[] = [];
    let modelRejected: AgentCredentialSnapshot[] = [];
    let walkLimit: { kind: AgentQuotaLimitKind; credential: AgentCredentialSnapshot | undefined } | undefined;
    let authRetries = 0;
    let transientRetries = 0;
    let midTurnContinues = 0;
    let missingSessionReset = false;
    let compactedForContext = false;
    let compactBeforeRetry = false;
    let currentRequest = request;
    let carriedSteers: PendingTurn['steers'] = new Map();
    this.turnLoginFailure = null;
    this.turnPromptWritten = false;
    await this.goalClear?.catch(() => {});
    await this.stopping?.catch(() => {});
    try {
      while (true) {
        const attemptedCredential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.claude;
        const steers = carriedSteers;
        carriedSteers = new Map();
        this.attemptSawActivity = false;
        try {
          if (compactBeforeRetry) {
            await this.executeQuery({ ...currentRequest, message: '/compact', images: [], goalMode: false }, { skipUserMessageRecord: true, engineTurn: true, signal });
            compactBeforeRetry = false;
          }
          await this.executeQuery(currentRequest, { skipUserMessageRecord: this.turnPromptWritten || request.engineTurn, engineTurn: request.engineTurn, signal, steers });
          return;
        } catch (error) {
          lastError = error;
          if (error instanceof ClaudeContextBlockedError) {
            if (compactedForContext) {
              await this.emitTerminalErrorResult(error.message, [error.message]);
              return;
            }
            compactedForContext = compactBeforeRetry = true;
            currentRequest = { ...currentRequest, message: request.message, images: request.images, goalMode: request.goalMode };
            carriedSteers = steers;
            continue;
          }
          // A spent account is only remembered for an hour, so a long turn can meet one again;
          // only a repeat with no work done since means the walk is going in circles.
          if (this.attemptSawActivity) failedCredentials = [];
          if (this.turnPromptRecorded && !compactBeforeRetry) {
            currentRequest = { ...currentRequest, message: CLAUDE_RETRY_PROMPT, images: [], goalMode: false };
          }

          const modelUnavailable = error instanceof ClaudeModelUnavailableError;
          const quotaKind = modelUnavailable ? null : ClaudeManager.quotaLimitKind(error);
          const isAuthError = !quotaKind && !modelUnavailable && ClaudeManager.isAuthError(error);
          if (isAuthError && authRetries < MAX_AUTH_RETRIES) {
            authRetries++;
            console.error(
              `[ClaudeManager] Auth failure detected (attempt ${authRetries}/${MAX_AUTH_RETRIES}), refreshing credentials and retrying...`,
              error,
            );
            this.setAuthRetrying(true);
            const refreshed = await claudeTokenManager.fetchFreshCredentials(
              error instanceof Error ? error.message : String(error),
              'rejected',
              attemptedCredential,
              attemptedCredential ? [attemptedCredential.method] : undefined,
            );
            if (refreshed.ok) {
              const live = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.claude;
              if (attemptedCredential && live && !isSameCredential(attemptedCredential, live)) {
                this.turnLoginFailure ??= describeLoginFailure('claude', attemptedCredential, resolveClaudeAuthMethodForMessage(), false);
              }
              continue;
            }
            const method = attemptedCredential?.method ?? resolveClaudeAuthMethodForMessage();
            const failure = engineCredentialRefreshFailureSchema.safeParse(extractJsonObject(refreshed.error.message)).data;
            // A workspace that started after its OAuth login died has no credential and no other auth configured.
            loginRevoked = (method === 'oauth' || method === 'unknown') && failure?.code === 'oauth_disconnected';
            namedLogin = failure?.credential;
          }

          if (quotaKind || isAuthError || modelUnavailable) {
            const reason = quotaKind ?? (modelUnavailable ? 'model_unavailable' : 'auth_failed');
            const detail = error instanceof ClaudeQuotaError || error instanceof ClaudeModelUnavailableError ? error.message : extractErrorText(error);
            const repeated = !!attemptedCredential && failedCredentials.some((failed) => isSameCredential(failed, attemptedCredential));
            if (attemptedCredential) failedCredentials.push(attemptedCredential);
            if (attemptedCredential && modelUnavailable) modelRejected.push(attemptedCredential);
            const limit = quotaKind ? { kind: quotaKind, credential: attemptedCredential } : walkLimit;
            const fallback: AuthFallbackResult = repeated
              ? { outcome: 'unavailable' }
              : await this.fallBackCredential(reason, detail, attemptedCredential, error instanceof ClaudeQuotaError ? error.resetsAt : undefined, !!walkLimit);
            if (fallback.outcome === 'switched') {
              walkLimit = limit;
              if (isAuthError) {
                this.turnLoginFailure ??= describeLoginFailure('claude', attemptedCredential ?? namedLogin, resolveClaudeAuthMethodForMessage(), loginRevoked);
              }
              if (fallback.model) currentRequest = { ...currentRequest, model: fallback.model };
              authRetries = 0;
              loginRevoked = false;
              namedLogin = undefined;
              await this.tearDownSession();
              continue;
            }
            if (limit && (quotaKind || fallback.outcome === 'fork')) {
              if (isAuthError) {
                this.turnLoginFailure ??= describeLoginFailure('claude', attemptedCredential ?? namedLogin, resolveClaudeAuthMethodForMessage(), loginRevoked);
              }
              await this.emitQuotaExhaustedEvent(limit.kind, fallback, detail, limit.credential);
              return;
            }
            if (modelUnavailable) {
              const model = normalizeClaudeModel(currentRequest.model) ?? DEFAULT_CLAUDE_MODEL;
              const predecessor = MODEL_PREDECESSORS[model];
              if (predecessor) {
                currentRequest = { ...currentRequest, model: predecessor };
                if (attemptedCredential) {
                  const { method, scope, account } = attemptedCredential;
                  this.record({
                    timestamp: new Date().toISOString(),
                    type: AUTH_FALLBACK_EVENT_TYPE,
                    payload: {
                      provider: 'claude', reason: 'model_unavailable', status: 'switched', detail,
                      exhaustedMethod: method, exhaustedScope: scope, candidateMethod: method, candidateScope: scope,
                      ...(account ? { exhaustedAccount: account, candidateAccount: account } : {}),
                      fromModel: model, toModel: predecessor,
                    } satisfies AuthFallbackPayload,
                  });
                }
                // The predecessor is a new request, so a limit it hits may still walk the chain,
                // including credentials that only lacked the newer model.
                forgetExhaustedCredentials('claude', modelRejected);
                failedCredentials = [];
                modelRejected = [];
                continue;
              }
              const requested = normalizeClaudeModel(request.model) ?? DEFAULT_CLAUDE_MODEL;
              await this.emitTerminalErrorResult(detail, [describeModelUnavailable('claude', [...new Set([requested, model])], attemptedCredential)]);
              return;
            }
            failedLogin = { credential: attemptedCredential ?? namedLogin, revoked: loginRevoked };
            throw error;
          }

          // A turn stopped before Claude Code wrote its transcript leaves a session ID that can never resume.
          if (error instanceof ClaudeMissingSessionError && !missingSessionReset) {
            missingSessionReset = true;
            console.warn(`[ClaudeManager] Session ${this.sessionId} has no transcript; starting a fresh session:`, error.message);
            this.sessionId = null;
            // The dead session never read the steered prompts, so the fresh one has to receive them.
            carriedSteers = steers;
            await this.onSaveSessionId(null);
            await this.tearDownSession();
            continue;
          }

          if (error instanceof ClaudeTransientTurnError && error.midTurn) {
            if (midTurnContinues >= MAX_MIDTURN_CONTINUE_RETRIES) {
              await this.emitMidTurnExhaustedEvent(error);
              return;
            }
            midTurnContinues++;
            const delayMs = TRANSIENT_RETRY_DELAYS_MS[midTurnContinues - 1] ?? TRANSIENT_RETRY_DELAYS_MS[TRANSIENT_RETRY_DELAYS_MS.length - 1];
            console.warn(
              `[ClaudeManager] Mid-turn transient failure detected (attempt ${midTurnContinues}/${MAX_MIDTURN_CONTINUE_RETRIES}), resuming session and continuing in ${delayMs}ms...`,
              error,
            );
            await this.tearDownSession();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            currentRequest = { ...request, message: CLAUDE_MIDTURN_CONTINUE_PROMPT, images: [], goalMode: false };
            continue;
          }

          if (ClaudeManager.isTransientTurnError(error) && transientRetries < MAX_TRANSIENT_RETRIES) {
            transientRetries++;
            const delayMs = TRANSIENT_RETRY_DELAYS_MS[transientRetries - 1] ?? TRANSIENT_RETRY_DELAYS_MS[TRANSIENT_RETRY_DELAYS_MS.length - 1];
            console.warn(
              `[ClaudeManager] Transient turn failure detected (attempt ${transientRetries}/${MAX_TRANSIENT_RETRIES}), retrying in ${delayMs}ms...`,
              error,
            );
            await this.tearDownSession();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          const detail = error instanceof Error ? error.message : String(error);
          await this.emitTerminalErrorResult(detail, [`Claude Code stopped before this turn finished (${detail}). Send a message to continue.`]);
          throw error;
        }
      }
    } finally {
      this.setAuthRetrying(false);
      if (failedLogin) {
        await this.emitAuthRetryExhaustedEvent(lastError, failedLogin.credential, failedLogin.revoked);
      }
      this.turnLoginFailure = null;
      try {
        await this.historyFile.flush();
        await this.onTurnComplete();
      } catch (error) {
        console.error('[ClaudeManager] onTurnComplete failed:', error);
      }
    }
  }

  // `errors` is the field the dashboard renders (see claude-parser); `result` is
  // only retained on the raw event for debugging. The user-facing message goes in `errors`.
  private async emitTerminalErrorResult(result: string, errors: string[]): Promise<void> {
    const event: AgentEvent = {
      timestamp: new Date().toISOString(),
      type: 'claude-result',
      payload: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result,
        errors: [...new Set([...(this.turnLoginFailure ? [this.turnLoginFailure] : []), ...errors])],
        session_id: this.sessionId ?? '',
        parent_tool_use_id: null,
      },
    };
    this.record(event);
  }

  private async emitAuthRetryExhaustedEvent(error: unknown, login: AgentCredentialSnapshot | undefined, revoked: boolean): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    await this.emitTerminalErrorResult(detail, [describeLoginFailure('claude', login, resolveClaudeAuthMethodForMessage(), revoked)]);
  }

  private async emitQuotaExhaustedEvent(
    kind: AgentQuotaLimitKind,
    fallback: QuotaStopFallbackResult,
    detail: string,
    credential: AgentCredentialSnapshot | undefined,
  ): Promise<void> {
    await this.emitTerminalErrorResult(detail, [describeQuotaExhaustion('claude', kind, credential, fallback)]);
    this.emitQuotaExhausted({
      provider: 'claude',
      reason: kind,
      detail,
      ...(fallback.outcome === 'fork' ? { forkTo: fallback.target } : {}),
    });
  }

  private async emitMidTurnExhaustedEvent(error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    await this.emitTerminalErrorResult(
      detail,
      ['The connection to Claude dropped mid-response and could not be resumed after multiple attempts.'],
    );
  }

  private async executeQuery(
    request: SendChatMessageRequest,
    options: { skipUserMessageRecord?: boolean; engineTurn?: boolean; signal?: AbortSignal; steers?: PendingTurn['steers'] } = {},
  ): Promise<void> {
    const {
      message,
      model,
      customInstructions,
      thinkingLevel,
      fastMode,
    } = request;
    if (!message || !message.trim()) {
      throw new Error('Message cannot be empty');
    }

    await this.initialized;
    this.lastRequest = request;

    // A pending interrupt that lingered past the previous turn's resolution
    // (e.g. interrupt() fired in the tiny gap between result-resolve and
    // processing-flag-clear) is stale — it was meant for the prior turn, not
    // this one. Any genuine interrupt against this turn will set the flag
    // again during ensureSession or after the push.
    this.pendingInterrupt = false;

    const userMessage = await this.buildUserMessage(request);

    // Stamped so history rendering can pair this transcript event with the
    // accepted snapshot by identity — content/timestamp matching breaks when
    // a queued message is edited or waits past the match grace period.
    // It keeps the time the turn began, so the turn's duration still counts the wait for Claude Code to start.
    const promptAt = new Date().toISOString();
    const recordPrompt = options.skipUserMessageRecord ? undefined : async () => {
      this.turnPromptWritten = true;
      await this.recordEvent(userMessage, request.messageId, request.replacesMessageId, promptAt);
    };

    const goalCommand = getGoalCommand(message, request.goalMode);
    // Claude Code goals can't be paused, so pause clears and resume re-sets the current condition.
    const goalObjective = goalCommand?.type === 'set'
      ? goalCommand.objective
      : goalCommand?.type === 'resume' ? this.currentGoal?.objective : undefined;
    if (goalCommand && !options.skipUserMessageRecord) {
      const now = new Date().toISOString();
      this.recordGoalChange(goalObjective ? {
        threadId: this.sessionId ?? '',
        objective: goalObjective,
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      } : null);
    }

    const combinedInstructions = [
      this.buildCombinedInstructions(customInstructions, true),
      'Background tasks must have a concrete completion condition. Use foreground commands for sequential work and managed workspace services for servers. Reserve persistent Monitor tasks for ongoing watches the user requested. You may end a turn while actual background work continues, but do not promise a later update unless a task was successfully launched. Report completion or failure when its notification arrives. Always give background commands a short description: the chat shows it to the user when the task finishes.',
    ].filter(Boolean).join('\n\n');
    const requestedModel = normalizeClaudeModel(model);
    const authMethod = resolveClaudeAuthMethodForMessage();
    const isClaudeModel = !!requestedModel && /^claude-/i.test(requestedModel);
    // Each endpoint serves only its own models: Ollama runs the one its fallback step chose while that fallback is live,
    // and Anthropic runs its default for a model a fallback picked on Ollama, which the chat's history still names.
    const resolvedModel = authMethod === 'ollama'
      ? getFallbackModel('claude') ?? (requestedModel && !isClaudeModel ? requestedModel : DEFAULT_OLLAMA_MODEL)
      : (authMethod === 'oauth' || authMethod === 'api_key') && requestedModel && !isClaudeModel
        ? DEFAULT_CLAUDE_MODEL
        : requestedModel || DEFAULT_CLAUDE_MODEL;
    const resolvedFastMode = Boolean(fastMode && canUseClaudeFastMode(resolvedModel));
    this.onChatCredential('workspace');
    const signature: SessionSignature = {
      credential: JSON.stringify(ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.claude),
      combinedInstructions,
      thinkingLevel,
      fastMode: resolvedFastMode,
      autoCompactTokens: this.autoCompactTokens,
      subagentMcpParentChatId: this.subagentMcpParentChatId(),
      disableNativeSubagents: this.nativeSubagentsDisabled(),
    };

    await this.ensureSession({
      signature,
      combinedInstructions,
      resolvedModel,
      thinkingLevel,
    });

    const promptStream = this.activePromptStream;
    const activeQuery = this.activeQuery;
    if (!promptStream || !activeQuery) {
      throw new Error('Claude session unavailable after ensureSession');
    }

    await this.dropRecordedUnreadPrompt();
    const prompt: ClaudeUserContent = goalCommand
      ? [{ type: 'text', text: `/goal ${goalObjective ?? 'clear'}` }]
      : userMessage.message.content;
    const takesUnread = this.carriesKeptRequests(request);
    // Claude Code reads a slash command from the last text block, so the unread prompt goes first.
    const notedCutOffs = takesUnread ? [...this.cutOffTools.keys()] : [];
    const cutOffNote: ClaudeUserContent = notedCutOffs.length > 0 ? [{
      type: 'text',
      text: wrapInTag(`The user pressed Stop while these tool calls were running: ${[...new Set(this.cutOffTools.values())].map((name) => `\`${name}\``).join(', ')}. Claude Code reports a call cut off this way as "The user doesn't want to proceed with this tool use. The tool use was rejected", but nobody rejected or declined them: they were stopped mid-run. Describe them as stopped or interrupted, never as rejected. They may or may not have taken effect, so check before relying on or repeating them.`, OKIDOKI_INSTRUCTIONS_TAG),
    }] : [];
    // Kept until Claude Code records the prompt or it is saved to resend, so a retried prompt still carries the note.
    const dropNotedCutOffs = () => { for (const id of notedCutOffs) this.cutOffTools.delete(id); };
    const unsent = appendUserContent(appendUserContent(cutOffNote, this.unreadPrompt?.content ?? []), prompt);
    const content = takesUnread ? unsent : prompt;
    if (this.pendingInterrupt || options.signal?.aborted) {
      this.pendingInterrupt = false;
      if (!options.engineTurn && !this.isStopped(options.signal) && !this.isRequeued(options.signal)) {
        await recordPrompt?.();
        this.keepUnreadPrompt(userMessage.uuid, unsent);
        dropNotedCutOffs();
      }
      // Caller interrupted before we could push — surface to the message queue
      // as a no-op turn rather than starting a doomed iteration.
      return;
    }

    this.turnPromptRecorded = false;
    this.endedReplies.clear();
    this.cutSentAt = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const steers = options.steers ?? new Map();
        this.pendingTurn = {
          resolve, reject, sawActivity: false, steers,
          userMessageUuids: new Set([userMessage.uuid, ...steers.keys()]),
        };
        if (options.signal && !options.engineTurn) this.sentPrompt = { uuid: userMessage.uuid, signal: options.signal, record: recordPrompt };
        promptStream.push({ ...userMessage, message: { role: 'user', content } });
        for (const { userMessage: steer } of steers.values()) promptStream.push({ ...steer, priority: 'next' });
        void this.deliverEarlySteers();
      });
    } finally {
      const requeued = this.isRequeued(options.signal);
      const carried = options.signal?.aborted && !options.engineTurn && !requeued && !this.isStopped(options.signal);
      if (this.turnPromptRecorded || carried) dropNotedCutOffs();
      if (!this.turnPromptRecorded && carried) this.keepUnreadPrompt(userMessage.uuid, unsent);
      else if (takesUnread && this.turnPromptRecorded) this.unreadPrompt = null;
      else if (takesUnread && this.unreadPrompt && options.signal?.aborted) this.unreadPrompt = { ...this.unreadPrompt, uuid: userMessage.uuid };
      if (this.sentPrompt?.record) {
        if (!requeued && (!this.isStopped(options.signal) || await this.promptRecorded(userMessage.uuid))) await this.recordSentPrompt();
        // A Stop withdrew it or it runs again, and the end of a later turn must not write it into the chat.
        else this.sentPrompt.record = undefined;
      }
    }
  }

  private async buildUserMessage({ message, images }: SendChatMessageRequest): Promise<SDKUserMessage & { uuid: UUID; message: { content: ClaudeUserContent } }> {
    const content: ClaudeUserContent = [
      {
        type: 'text',
        text: message,
      },
    ];

    if (images && images.length > 0) {
      const normalizedImages = await normalizeImages(images);
      for (const image of normalizedImages) {
        if (image.label) content.push({ type: 'text', text: image.label });
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.source.media_type,
            data: image.source.data,
          },
        });
      }
    }

    return {
      type: 'user',
      uuid: randomUUID(),
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    };
  }

  private async ensureSession(args: {
    signature: SessionSignature;
    combinedInstructions: string | undefined;
    resolvedModel: string;
    thinkingLevel: ThinkingLevel | undefined;
  }): Promise<void> {
    const {
      signature,
      combinedInstructions,
      resolvedModel,
      thinkingLevel,
    } = args;

    // Restarting would kill in-flight background subagents.
    if (this.activeQuery && this.activeSessionSignature
        && (this.sessionSignaturesMatch(this.activeSessionSignature, signature)
          || (this.backgroundTasks.active.size > 0 && this.activeSessionSignature.credential === signature.credential))) {
      // Hot-swap mid-session settings that the SDK supports changing without
      // a restart. Anything else is baked into the original query() call.
      if (this.activeSessionModel !== resolvedModel) {
        try {
          await this.activeQuery.setModel(resolvedModel);
          this.activeSessionModel = resolvedModel;
        } catch (err) {
          console.warn('[ClaudeManager] setModel failed; recreating session:', err);
          await this.tearDownSession();
        }
      }
      if (this.activeQuery) return;
    } else if (this.activeQuery) {
      await this.tearDownSession();
    }

    await this.startSession({
      combinedInstructions,
      resolvedModel,
      thinkingLevel,
      signature,
    });
  }

  private sessionSignaturesMatch(a: SessionSignature, b: SessionSignature): boolean {
    return a.combinedInstructions === b.combinedInstructions
      && a.credential === b.credential
      && a.thinkingLevel === b.thinkingLevel
      && a.fastMode === b.fastMode
      && a.autoCompactTokens === b.autoCompactTokens
      && a.subagentMcpParentChatId === b.subagentMcpParentChatId
      && a.disableNativeSubagents === b.disableNativeSubagents;
  }

  /** Query inputs shared by real sessions and slash-command discovery. */
  private async buildSharedQueryOptions(): Promise<{
    env: Record<string, string | undefined>;
    additionalDirectories: string[];
    plugins: SdkPluginConfig[];
    enableAllSkills: boolean;
  }> {
    // Strips a stray ANTHROPIC_API_KEY when the workspace is authenticated
    // via OAuth or Bedrock — see buildClaudeAgentEnv for the rationale.
    const env = buildClaudeAgentEnv({
      // Claude Code nudges a turn that ends without text to write some, unless it called one of these tools; a Manager handles ship and issue events with only these.
      CLAUDE_CODE_TERMINAL_MCP_TOOLS: [OKIDOKI_MCP_TOOLS.sendToChat, OKIDOKI_MCP_TOOLS.spawnSubagent, OKIDOKI_MCP_TOOLS.messageSubagent].map((tool) => `mcp__${OKIDOKI_MCP_SERVER_NAME}__${tool}`).join(','),
      ...(this.subagentMcpParentChatId() && { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '900000' }),
      ...(this.originChatId && { OKIDOKI_CHAT_ID: this.originChatId }),
    });
    const additionalDirectories = await getAgentAdditionalDirectories();

    let plugins: SdkPluginConfig[] = [];
    let enableAllSkills = false;
    try {
      const registryConfig = await buildClaudeRegistryConfig(ENGINE_ENV.HOME_DIR);
      plugins = registryConfig.plugins;
      enableAllSkills = registryConfig.enableAllSkills;
    } catch (error) {
      console.warn('[ClaudeManager] Failed to load skill registry config:', error);
    }

    return { env, additionalDirectories, plugins, enableAllSkills };
  }

  private async startSession(args: {
    combinedInstructions: string | undefined;
    resolvedModel: string;
    thinkingLevel: ThinkingLevel | undefined;
    signature: SessionSignature;
  }): Promise<void> {
    const {
      combinedInstructions,
      resolvedModel,
      thinkingLevel,
      signature,
    } = args;
    const ultracode = thinkingLevel === 'ultracode';
    const effort = thinkingLevel === 'ultra' || ultracode ? 'xhigh' : thinkingLevel;

    const systemPrompt = {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: combinedInstructions,
      // A recorded prompt ignores a new append on resume, so edited instructions would never apply.
      snapshot: false,
    };

    const shared = await this.buildSharedQueryOptions();

    const subagentMcpParentChatId = signature.subagentMcpParentChatId;
    const disallowedTools = [
      ...ALWAYS_DISALLOWED_TOOLS,
      ...(signature.disableNativeSubagents ? ['Agent'] : []),
    ];

    const promptStream = new PromptStream();
    const response = query({
      prompt: promptStream,
      options: {
        resume: this.sessionId || undefined,
        cwd: this.workingDirectory,
        additionalDirectories: shared.additionalDirectories,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        disallowedTools,
        settingSources: ['user', 'project', 'local'],
        systemPrompt,
        ...(subagentMcpParentChatId
          ? { mcpServers: { [SUBAGENT_MCP_SERVER_NAME]: { type: 'stdio', alwaysLoad: true, ...subagentMcpProcessConfig(subagentMcpParentChatId) } } }
          : {}),
        ...(shared.plugins.length > 0 ? { plugins: shared.plugins } : {}),
        ...(shared.enableAllSkills ? { skills: 'all' as const } : {}),
        env: {
          ...shared.env,
          // A resumed session reports tools from a still-connecting MCP server as removed, so the agent stops using them.
          // A new session waits too: tools that connect after its first request stay out of its tool list, so the next process would send a different list and rewrite the whole prompt cache.
          MCP_CONNECTION_NONBLOCKING: 'false',
          // That wait ends after 5 seconds. Without this, a chat that passes a server of its own would go on waiting for every server still connecting, up to 30 seconds.
          CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
          ...(resolveClaudeAuthMethodForMessage() === 'ollama' ? {
            ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel,
            ANTHROPIC_DEFAULT_OPUS_MODEL: resolvedModel,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: resolvedModel,
          } : {}),
        },
        model: resolvedModel,
        ...(this.chatTitle ? { title: this.chatTitle() } : {}),
        settings: {
          fastMode: signature.fastMode,
          // Every session in the sandbox is one of the user's chats; the default holds some peer messages for an approval no one is there to give.
          crossSessionInbound: 'accept',
          ...(signature.autoCompactTokens ? { autoCompactWindow: signature.autoCompactTokens } : {}),
          ...(ultracode ? { enableWorkflows: true, ultracode: true } : {}),
        },
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(supportsClaudeThinkingDisplay(resolvedModel)
          ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
          : {}),
        ...(effort ? { effort } : {}),
        hooks: {
          PreToolUse: [{
            matcher: '*',
            hooks: [this.buildCommandProtectionHook()],
            timeout: 30,
          }],
          PostToolUse: [{
            matcher: '*',
            hooks: [async (input): Promise<HookJSONOutput> => {
              if (input.hook_event_name === 'PostToolUse' && shouldRefreshPullRequests(input.tool_name, input.tool_input)) {
                pullRequestCheckService.check().catch(() => {});
              }
              return {};
            }],
            timeout: 30,
          }, {
            // Only Send now backgrounds commands here, so Claude Code's "manually backgrounded by user" isn't true.
            matcher: 'Bash',
            hooks: [async (input): Promise<HookJSONOutput> => {
              const response = input.hook_event_name === 'PostToolUse' ? input.tool_response : undefined;
              return isRecord(response) && response.backgroundedByUser === true
                ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, backgroundedByUser: false, backgroundedToDeliverMessage: true } } }
                : {};
            }],
            timeout: 30,
          }, {
            matcher: 'Workflow',
            hooks: [async (input): Promise<HookJSONOutput> => {
              const response = input.hook_event_name === 'PostToolUse' ? input.tool_response : undefined;
              if (isRecord(response) && typeof response.taskId === 'string' && typeof response.transcriptDir === 'string') {
                this.workflowTranscripts.set(response.taskId, { dir: response.transcriptDir, offsets: new Map() });
              }
              return {};
            }],
            timeout: 30,
          }],
        },
      },
    });

    this.activeQuery = response;
    this.activePromptStream = promptStream;
    this.activeSessionSignature = signature;
    this.activeSessionModel = resolvedModel;
    this.sessionLinearForwarder = new LinearEventForwarder(() => this.linearSessionId);

    this.sessionLoop = this.runSessionLoop(response).catch((err) => {
      console.error('[ClaudeManager] Session loop crashed:', err);
    });

    // Warm the command cache so fetches during the first turn aren't empty.
    void response.supportedCommands()
      .then((commands) => {
        this.supportedSlashCommands = normalizeClaudeSlashCommands(commands);
        this.slashCommandsDiscoveredAt = Date.now();
      })
      .catch(() => {});
  }

  private async runSessionLoop(response: Query): Promise<void> {
    const iterator = response[Symbol.asyncIterator]();
    let loopError: unknown = null;
    let suppressLinearResponseFlush = false;
    let creditsRequired = false;
    let resetsAt: string | undefined;
    let turnFailed = false;
    let heldRefusal: SDKMessage | null = null;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done || this.activeQuery !== response) break;
        const msg = next.value;
        if (!msg) break;
        if ((msg.type === 'assistant' || msg.type === 'user') && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') this.runningTools.set(block.id, block.name);
            if (block.type !== 'tool_result') continue;
            const name = this.runningTools.get(block.tool_use_id);
            this.runningTools.delete(block.tool_use_id);
            if (name && this.pendingInterrupt && block.is_error && extractToolResultText(block.content, '').startsWith(CLAUDE_STOPPED_TOOL_RESULT)) this.cutOffTools.set(block.tool_use_id, name);
          }
        }
        if (msg.type === 'stream_event') {
          const key = this.partialMessageStreamKey(msg);
          if (msg.event.type === 'message_start') this.requestsInFlight.set(key, msg.event.message);
          else if (msg.event.type === 'message_delta' && msg.event.delta.stop_reason) this.requestsInFlight.delete(key);
        }
        if (msg.type === 'result' && (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools')) this.countCutRequests();
        // The turn keeps a finished reply's prompt until its usage is read, so Send now has to learn here that the reply is over.
        if (msg.type === 'result' && msg.user_message_uuid) for (const uuid of msg.user_message_uuids ?? [msg.user_message_uuid]) this.endedReplies.add(uuid);
        if (msg.type === 'system' && msg.subtype === 'status') this.compacting = msg.status === 'compacting';
        // A stopped turn's partial reply and stop marker are kept so they survive a reload; its aborted result would read as a finished turn and clear the goal.
        if (this.pendingInterrupt) {
          if (msg.type === 'user') await this.recordEvent(msg);
          else if (msg.type === 'assistant') {
            // Claude keeps writing until the interrupt lands; only what was streamed before Stop is kept, so a reload shows what the user saw.
            const stream = this.partialMessageStreams.get(`${msg.session_id}:${msg.parent_tool_use_id ?? 'root'}`);
            let streamed = stream?.streamId === msg.message.id
              ? stream.flushes.findLast(({ at }) => at <= this.stoppedAtMs)?.length ?? 0
              : Infinity;
            const content = msg.message.content.map((block): typeof block => {
              if (block.type !== 'text') return block;
              const text = block.text.slice(0, streamed);
              streamed -= text.length;
              return { ...block, text };
            }).filter((block) => block.type !== 'text' || block.text);
            await this.recordEvent({ ...msg, message: { ...msg.message, content } });
          } else if (msg.type === 'result') {
            // Left out of the history, but nothing else counts the requests the stopped turn finished.
            this.onUsageUpdate(msg, new Date().toISOString());
            this.stoppedTurnEnded?.resolve();
          }
          continue;
        }
        // Send now's cut is marked once Claude Code says it interrupted the reply; a reply that ended by itself first was not cut.
        if (this.cutSentAt && (msg.type === 'result'
          ? msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools'
          : msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)
            && msg.message.content.some((block) => block.type === 'text' && INTERRUPTED_MESSAGE_REGEX.test(block.text)))) {
          this.recordInterrupted(this.cutSentAt, true);
          this.cutSentAt = null;
        }
        if (msg.type === 'result') this.cutSentAt = null;
        // Held until its result says why, so a refusal the engine compacts and resends never shows in the chat.
        if (msg.type === 'assistant' && msg.error === 'invalid_request' && msg.message.model === '<synthetic>') {
          heldRefusal = msg;
          continue;
        }
        if (msg.type === 'rate_limit_event') {
          creditsRequired = msg.rate_limit_info.errorCode === 'credits_required';
          // Kept past later events: a model the limit doesn't cover can still report allowed before the rejection surfaces.
          if (msg.rate_limit_info.status === 'rejected' && msg.rate_limit_info.resetsAt) {
            resetsAt = new Date(msg.rate_limit_info.resetsAt * 1000).toISOString();
          }
        }

        const authErrorMessage = ClaudeManager.detectAuthErrorInMessage(msg);
        const transientErrorMessage = ClaudeManager.detectTransientTurnErrorInMessage(msg);
        const turnError = authErrorMessage
          ? new ClaudeAuthError(authErrorMessage)
          : ClaudeManager.isModelUnavailableMessage(msg)
            ? new ClaudeModelUnavailableError(ClaudeManager.assistantText(msg))
          : msg.type === 'result' && msg.terminal_reason === 'blocking_limit'
            ? new ClaudeContextBlockedError(msg.subtype === 'success' ? msg.result : msg.errors.join('\n'))
          : msg.type === 'result' && msg.subtype !== 'success' && msg.num_turns === 0
            && msg.errors.some((err) => err.startsWith('No conversation found with session ID'))
            ? new ClaudeMissingSessionError(msg.errors.join('\n'))
            : ClaudeManager.detectQuotaErrorInMessage(msg, creditsRequired, resetsAt)
              ?? (transientErrorMessage
                ? new ClaudeTransientTurnError(transientErrorMessage, this.pendingTurn?.sawActivity ?? false)
                : null);
        if (turnError) {
          suppressLinearResponseFlush = true;
          turnFailed = true;
          this.failPendingTurn(turnError);
          try {
            response.close();
          } catch (err) {
            console.warn(`[ClaudeManager] query.close() after ${turnError.name} failed:`, err);
          }
          return;
        }
        if (heldRefusal) {
          await this.handleMessage(heldRefusal);
          heldRefusal = null;
        }

        const wasProcessing = this.isProcessing();
        this.setAuthRetrying(false);

        const lifecycle: unknown = msg;
        if (isRecord(lifecycle) && lifecycle.type === 'command_lifecycle' && lifecycle.state === 'started'
          && typeof lifecycle.command_uuid === 'string') {
          if (this.pendingTurn?.userMessageUuids.has(lifecycle.command_uuid)) {
            this.turnPromptRecorded = true;
            // A prompt Claude Code starts after a command cut it runs again all the same, so it is written to the chat then.
            if (lifecycle.command_uuid === this.sentPrompt?.uuid && !this.isRequeued(this.sentPrompt.signal)) {
              this.messageQueue.markDelivered();
              await this.recordSentPrompt();
            }
            this.settlePromptStart();
          } else if (!this.activePromptStream?.sentUuids.has(lifecycle.command_uuid)) await this.recordPeerMessage(lifecycle.command_uuid, response);
          if (this.activeQuery !== response) break;
          await this.recordSteerRead(lifecycle.command_uuid);
        }

        if (this.pendingTurn && ClaudeManager.isTurnActivity(msg)) {
          this.pendingTurn.sawActivity = true;
          this.attemptSawActivity = true;
        }
        if (
          (msg.type === 'result' && (msg.subtype !== 'success' || msg.num_turns !== 0 || msg.result !== ''))
          || ClaudeManager.isTurnActivity(msg)
        ) {
          this.clearBackgroundContinuationTimer();
        }
        updateClaudeSessionActivity(this.sessionActivity, msg);
        const hadActiveBackgroundTasks = this.backgroundTasks.active.size > 0;
        this.backgroundTasks.update(msg);
        if (hadActiveBackgroundTasks && this.backgroundTasks.active.size === 0) {
          this.startBackgroundContinuationGrace();
        }
        if (!this.pendingTurn && msg.type === 'system'
          && (msg.subtype === 'init' || (msg.subtype === 'session_state_changed' && msg.state === 'running'))) {
          this.pendingBackgroundCompletion = true;
        }
        const loginFailure = msg.type === 'result' && msg.user_message_uuid && this.pendingTurn?.userMessageUuids.has(msg.user_message_uuid)
          ? this.turnLoginFailure
          : null;
        await this.handleMessage(msg.type === 'result' && loginFailure && isClaudeResultError(msg)
          ? msg.subtype === 'success'
            ? { ...msg, result: `${loginFailure}\n${msg.result}` }
            : { ...msg, errors: [loginFailure, ...msg.errors] }
          : msg);
        if (this.activeQuery !== response) break;

        const linearSessionId = this.linearSessionId;
        if (linearSessionId && this.sessionLinearForwarder) {
          this.sessionLinearForwarder.processClaudeEventForPlan(msg);
          this.sessionLinearForwarder.sendEvent(convertClaudeEvent(msg, linearSessionId));
        }

        if (msg.type === 'result') {
          await this.recordQueryContextUsage(response);
          if (this.activeQuery !== response) break;
          this.sessionLinearForwarder?.flushThoughtAsResponse();
          // Autonomous task results can arrive ahead of the reply to an already queued user message.
          const pendingUuids = this.pendingTurn?.userMessageUuids;
          for (const uuid of msg.user_message_uuids ?? []) await this.recordSteerRead(uuid);
          if (msg.user_message_uuid) {
            for (const uuid of msg.user_message_uuids ?? [msg.user_message_uuid]) pendingUuids?.delete(uuid);
            if (pendingUuids?.size === 0) this.resolvePendingTurn();
          } else if (!msg.origin || msg.origin.kind === 'human') {
            this.resolvePendingTurn();
          }
        }
        this.maybeCompleteBackgroundTurn();
        if (wasProcessing && !this.isProcessing()) this.onProcessingChanged(false);
      }
    } catch (error) {
      loopError = error;
      turnFailed = ClaudeManager.isTransientTurnError(error) || ClaudeManager.isAuthError(error) || ClaudeManager.quotaLimitKind(error) !== null;
      if (ClaudeManager.isTransientTurnError(error) || ClaudeManager.isAuthError(error)) {
        suppressLinearResponseFlush = true;
      }
      if (!ClaudeManager.isTransientTurnError(error)) {
        console.error('[ClaudeManager] Session loop crashed:', error);
      }
    } finally {
      this.stoppedTurnEnded?.resolve();
      if (this.activeQuery !== response) return;
      // Iterator ended (close()/crash) — release the pending turn so callers
      // don't hang. The next message will spin up a fresh session.
      const pending = this.pendingTurn;
      const pendingError = loopError
        ? (
          pending?.sawActivity && ClaudeManager.isTransientTurnError(loopError)
            ? new ClaudeTransientTurnError('Claude session ended unexpectedly mid-response', true)
            : loopError
        )
        : (
          pending && !pending.sawActivity
            ? new ClaudeTransientTurnError('Claude session ended unexpectedly before producing a response')
            : new Error('Claude session ended unexpectedly')
        );
      if (ClaudeManager.isTransientTurnError(pendingError) || ClaudeManager.isAuthError(pendingError)) {
        suppressLinearResponseFlush = true;
      }
      if (!suppressLinearResponseFlush) {
        this.sessionLinearForwarder?.flushThoughtAsResponse();
      }
      this.failPendingTurn(pendingError);
      const orphanedBackgroundCompletion = this.pendingBackgroundCompletion
        && !this.messageQueue.isProcessing();
      this.settleBackgroundTasks('Claude session ended before this task completed.');
      this.clearSessionState();
      try {
        response.close();
      } catch {
      }
      // A turn Claude started on its own has no caller to switch credentials or retry, so it is resumed through the queue like a sent message.
      if (orphanedBackgroundCompletion && turnFailed && this.lastRequest) {
        void this.messageQueue.enqueue({
          ...this.lastRequest,
          messageId: undefined,
          message: CLAUDE_BACKGROUND_TURN_CONTINUE_PROMPT,
          images: [],
          goalMode: false,
          engineTurn: true,
        });
      } else if (orphanedBackgroundCompletion) {
        if (loopError) {
          const detail = loopError instanceof Error ? loopError.message : String(loopError);
          try {
            await this.emitTerminalErrorResult(detail, [`Claude Code stopped before this turn finished (${detail}). Send a message to continue.`]);
          } catch (error) {
            console.error('[ClaudeManager] Failed to record the background turn error:', error);
          }
        }
        this.notifyBackgroundTurnComplete();
      }
    }
  }

  private clearSessionState(): void {
    const hadBackgroundTasks = this.hasActiveBackgroundTasks();
    this.activeQuery = null;
    this.activePromptStream = null;
    this.activeSessionSignature = null;
    this.activeSessionModel = null;
    this.sessionLinearForwarder = null;
    this.sessionLoop = null;
    this.clearBackgroundContinuationTimer();
    resetClaudeSessionActivity(this.sessionActivity);
    this.backgroundTasks.reset();
    this.backgroundRecoveryAttempted = false;
    this.workflowTranscripts.clear();
    this.ambientTaskIds.clear();
    this.pendingBackgroundCompletion = false;
    for (const timer of this.partialMessageFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.partialMessageFlushTimers.clear();
    this.partialMessageStreams.clear();
    // The session is over, by a Stop Claude Code never answered or by its process ending, and that cuts whatever was still in flight.
    this.countCutRequests();
    this.runningTools.clear();
    this.pendingCut = null;
    this.compacting = false;
    // Background tasks don't count as processing, so ending them must still report idle for when-done actions.
    if (hadBackgroundTasks && !this.isProcessing()) this.onProcessingChanged(false);
  }

  private resolvePendingTurn(): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = null;
    // The turn (possibly interrupted) is over — let the next turn run fresh.
    this.pendingInterrupt = false;
    pending.resolve();
  }

  private maybeCompleteBackgroundTurn(): void {
    if (
      !this.pendingBackgroundCompletion
      || this.pendingTurn
      || this.messageQueue.isProcessing()
      || isClaudeSessionActive(this.sessionActivity)
    ) return;
    this.pendingBackgroundCompletion = false;
    this.notifyBackgroundTurnComplete();
  }

  private notifyBackgroundTurnComplete(after?: Promise<void> | null): void {
    this.backgroundCompletionsInFlight += 1;
    void Promise.resolve(after)
      .catch(() => {})
      .then(() => this.historyFile.flush())
      .then(() => this.onTurnComplete())
      .catch((error) => {
        console.error('[ClaudeManager] Background turn completion failed:', error);
      })
      .finally(() => {
        this.backgroundCompletionsInFlight -= 1;
        if (!this.isProcessing()) this.onProcessingChanged(false);
      });
  }

  private failPendingTurn(err: unknown): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = null;
    this.pendingInterrupt = false;
    pending.reject(err);
  }

  private startBackgroundContinuationGrace(): void {
    this.clearBackgroundContinuationTimer();
    const query = this.activeQuery;
    if (!query || this.pendingInterrupt) return;
    this.backgroundRecoveryAttempted = false;
    this.backgroundContinuationTimer = setTimeout(() => this.recoverBackgroundContinuation(query), CLAUDE_BACKGROUND_CONTINUATION_GRACE_MS);
  }

  private recoverBackgroundContinuation(query: Query): void {
    if (this.activeQuery !== query) return;
    this.backgroundContinuationTimer = null;
    if (this.pendingInterrupt || this.backgroundTasks.active.size > 0) return;
    if (this.sessionActivity.state === 'running' && !this.pendingTurn) return;
    if (this.pendingTurn || this.messageQueue.isProcessing() || this.sessionActivity.state === 'requires_action') {
      this.backgroundContinuationTimer = setTimeout(() => this.recoverBackgroundContinuation(query), CLAUDE_BACKGROUND_CONTINUATION_GRACE_MS);
      return;
    }
    if (this.backgroundRecoveryAttempted) {
      void this.failBackgroundSession(query, 'Claude did not resume after its background tasks finished. The session was stopped; send a message to continue.');
      return;
    }
    this.backgroundRecoveryAttempted = true;
    this.activePromptStream?.push({
      type: 'user',
      uuid: randomUUID(),
      isSynthetic: true,
      session_id: this.sessionId ?? '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Your background tasks have finished. Process their completion notifications and report the actual results. Continue only work that remains from the user request; do not repeat completed actions or restart finished tasks.',
      },
    });
    this.backgroundContinuationTimer = setTimeout(() => this.recoverBackgroundContinuation(query), CLAUDE_BACKGROUND_RECOVERY_START_TIMEOUT_MS);
  }

  private async failBackgroundSession(query: Query, message: string): Promise<void> {
    if (this.activeQuery !== query) return;
    await this.emitTerminalErrorResult(message, [message]);
    if (this.activeQuery === query) await this.tearDownSession();
  }

  async dispose(): Promise<void> {
    await this.tearDownSession();
  }

  async forkPoint(beforeMessageId?: string): Promise<ProviderForkPoint | null> {
    await this.initialized;
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    const messages = await getSessionMessages(sessionId, { dir: this.workingDirectory });
    const editedPrompt = beforeMessageId && await this.historyFile.findLastEvent(beforeMessageId, (event) => (
      event.type === 'claude-user' && event.payload[USER_MESSAGE_ID_PAYLOAD_KEY] === beforeMessageId
    ));
    // A running turn is cut off at the prompt that started it, so a fork never inherits half a turn.
    const turnUuids = this.pendingTurn?.userMessageUuids;
    const turnStart = turnUuids ? messages.findIndex((entry) => turnUuids.has(entry.uuid)) : -1;
    const end = beforeMessageId ? messages.findIndex((entry) => editedPrompt && entry.uuid === editedPrompt.payload.uuid)
      : turnStart >= 0 ? turnStart : this.isProcessing()
        ? Math.max(0, messages.findLastIndex((entry) => entry.type === 'user' && isPromptMessage(entry.message)))
        : messages.length;
    const throughTurn = messages[end - 1]?.uuid;
    return throughTurn ? { sessionId, throughTurn } : null;
  }

  async forkFrom(point: ProviderForkPoint): Promise<void> {
    await this.initialized;
    const { sessionId } = await forkSession(point.sessionId, { dir: this.workingDirectory, upToMessageId: point.throughTurn });
    await this.tearDownSession();
    this.sessionId = sessionId;
    await this.onSaveSessionId(sessionId);
  }

  private clearBackgroundContinuationTimer(): void {
    if (!this.backgroundContinuationTimer) return;
    clearTimeout(this.backgroundContinuationTimer);
    this.backgroundContinuationTimer = null;
  }

  private async tearDownSession(interrupted = false): Promise<void> {
    const query = this.activeQuery;
    const stream = this.activePromptStream;
    const loop = this.sessionLoop;
    const notifyCompletion = this.pendingBackgroundCompletion && !this.messageQueue.isProcessing();
    if (notifyCompletion) this.notifyBackgroundTurnComplete(loop);
    this.settleBackgroundTasks();

    if (interrupted) this.resolvePendingTurn();
    else this.failPendingTurn(new Error('Claude session torn down'));
    this.clearSessionState();

    if (query) {
      try {
        query.close();
      } catch (err) {
        console.warn('[ClaudeManager] query.close() failed:', err);
      }
    }
    stream?.close();
    if (loop) {
      try {
        await loop;
      } catch {
      }
    }
  }

  private settleBackgroundTasks(error?: string): void {
    for (const taskId of this.backgroundTasks.active) {
      void this.recordEvent({
        type: 'system', subtype: 'task_updated', task_id: taskId,
        uuid: randomUUID(), session_id: this.sessionId ?? '',
        patch: { status: error ? 'failed' : 'killed', ...(error ? { error } : {}) },
      });
    }
  }

  private buildContextUsagePayload(usage: SDKControlGetContextUsageResponse): ContextUsagePayload {
    const reportedMaxTokens = Number.isFinite(usage.maxTokens) ? usage.maxTokens : null;
    const knownMaxTokens = getClaudeModelContextWindow(usage.model);
    const maxTokens = knownMaxTokens ?? reportedMaxTokens;
    const totalTokens = clampTokensToWindow(usage.totalTokens, maxTokens);
    const autoCompactThreshold = normalizeAutoCompactThreshold(usage.autoCompactThreshold, maxTokens);

    return {
      provider: 'claude',
      source: 'claude_context',
      model: usage.model,
      totalTokens,
      maxTokens,
      rawMaxTokens: knownMaxTokens ?? (Number.isFinite(usage.rawMaxTokens) ? usage.rawMaxTokens : maxTokens),
      percentage: percentage(totalTokens, maxTokens),
      compactsAutomatically: usage.isAutoCompactEnabled === true,
      ...autoCompactThresholdField(autoCompactThreshold),
      categories: usage.categories
        .filter((category) => category.kind === 'used')
        .map((category) => ({
          name: category.name,
          tokens: category.tokens,
          percentage: percentage(category.tokens, maxTokens),
        })),
      updatedAt: new Date().toISOString(),
    };
  }

  private async recordQueryContextUsage(response: Query): Promise<void> {
    try {
      const usage = await response.getContextUsage({ detail: 'summary' });
      this.recordContextUsage(this.buildContextUsagePayload(usage));
    } catch (error) {
      console.warn('[ClaudeManager] Failed to record context usage:', error instanceof Error ? error.message : error);
    }
  }

  private static isModelUnavailableMessage(message: SDKMessage): boolean {
    return message.type === 'assistant' && 'error' in message && message.error === 'model_not_found';
  }

  private static assistantText(message: SDKMessage): string {
    return message.type === 'assistant' && Array.isArray(message.message?.content)
      ? message.message.content.map((block) => 'text' in block ? block.text : '').join('\n')
      : '';
  }

  private static isAuthError(error: unknown): boolean {
    if (error instanceof ClaudeAuthError) return true;
    return isClaudeAuthErrorText(error instanceof Error ? error.message : String(error));
  }

  private static quotaLimitKind(error: unknown): AgentQuotaLimitKind | null {
    if (error instanceof ClaudeQuotaError) return error.kind;
    return detectAgentQuotaLimit(extractErrorText(error));
  }

  private static detectQuotaErrorInMessage(
    message: SDKMessage,
    creditsRequired: boolean,
    resetsAt: string | undefined,
  ): ClaudeQuotaError | null {
    const quotaError = (text: string, kind: AgentQuotaLimitKind) =>
      new ClaudeQuotaError(text, creditsRequired ? 'credits_required' : kind, resetsAt);
    // A quota rejection arrives as a synthetic assistant message carrying an
    // `error` code, and the limit itself is only named in the message text —
    // the turn never reaches a result, so this is the only place to catch it.
    if (message.type === 'assistant' && 'error' in message) {
      const text = [typeof message.error === 'string' ? message.error : '', ClaudeManager.assistantText(message)]
        .filter(Boolean)
        .join('\n');
      const kind = detectAgentQuotaLimit(text);
      if (kind) return quotaError(text, kind);
    }

    if (message.type !== 'result' || !message.is_error) return null;
    const text = message.subtype === 'success' ? message.result : message.errors.join('\n');
    const kind = detectAgentQuotaLimit(text);
    return kind ? quotaError(text, kind) : null;
  }

  private static isTransientTurnError(error: unknown): boolean {
    if (error instanceof ClaudeTransientTurnError) return true;
    return ClaudeManager.isTransientTurnErrorText(extractErrorText(error));
  }

  private static isTransientTurnErrorText(text: string): boolean {
    return isTransientErrorText(text, { httpStatuses: CLAUDE_TRANSIENT_HTTP_STATUSES });
  }

  private static detectTransientTurnErrorInMessage(message: SDKMessage): string | null {
    if (message.type === 'assistant' && 'error' in message && typeof message.error === 'string') {
      return ClaudeManager.isTransientTurnErrorText(message.error) ? message.error : null;
    }

    if (message.type === 'result' && message.is_error) {
      const text = message.subtype === 'success' ? message.result : message.errors.join('\n');
      return ClaudeManager.isTransientTurnErrorText(text) ? text : null;
    }

    return null;
  }

  private static isTurnActivity(message: SDKMessage): boolean {
    return (message.type === 'assistant' || message.type === 'stream_event')
      && message.parent_tool_use_id === null;
  }

  // Done at the message-stream layer (rather than letting the failure flow
  // downstream as a normal result) so we can suppress emission before the
  // dashboard renders the raw 401 to the user.
  private static detectAuthErrorInMessage(message: SDKMessage): string | null {
    if (message.type === 'assistant' && 'error' in message) {
      const error = message.error;
      if (typeof error === 'string') {
        const errCode = error.toLowerCase();
        if (errCode === 'authentication_failed' || errCode === 'authentication_error') {
          return error;
        }
      }
    }

    if (message.type === 'result' && message.is_error) {
      if (message.subtype === 'success') {
        if (isClaudeAuthErrorText(message.result)) return message.result;
      } else {
        for (const err of message.errors) {
          if (isClaudeAuthErrorText(err)) return err;
        }
      }
    }

    return null;
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.initialized;
    await this.historyFile.flush();
    const history = await this.historyFile.loadEventsPage(page);
    return {
      thread_id: this.sessionId,
      ...history,
    };
  }

  private partialMessageStreamKey(message: SDKPartialAssistantMessage): string {
    return `${message.session_id}:${message.parent_tool_use_id ?? 'root'}`;
  }

  private clearPartialMessageFlush(key: string): void {
    const timer = this.partialMessageFlushTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.partialMessageFlushTimers.delete(key);
  }

  private flushPartialMessageStream(
    key: string,
    status: ClaudePartialMessagePayload['status'] = 'in_progress',
  ): void {
    this.clearPartialMessageFlush(key);
    const stream = this.partialMessageStreams.get(key);
    if (!stream || (!stream.text && !stream.thinking && !stream.tool)) return;
    stream.flushes.push({ at: Date.now(), length: stream.text.length });

    this.onEvent({
      timestamp: new Date().toISOString(),
      type: CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE,
      payload: {
        streamId: stream.streamId,
        parent_tool_use_id: stream.parent_tool_use_id,
        ...(stream.text ? { text: stream.text } : {}),
        ...(stream.thinking ? { thinking: stream.thinking } : {}),
        ...(stream.tool ? { tool: stream.tool } : {}),
        status,
      } satisfies ClaudePartialMessagePayload,
    });
  }

  private schedulePartialMessageFlush(key: string): void {
    if (this.partialMessageFlushTimers.has(key)) return;
    this.partialMessageFlushTimers.set(key, setTimeout(() => {
      this.partialMessageFlushTimers.delete(key);
      this.flushPartialMessageStream(key);
    }, CLAUDE_PARTIAL_MESSAGE_FLUSH_MS));
  }

  private handlePartialAssistantMessage(message: SDKPartialAssistantMessage): void {
    const key = this.partialMessageStreamKey(message);
    const streamEvent = message.event;

    if (streamEvent.type === 'message_start') {
      this.clearPartialMessageFlush(key);
      this.partialMessageStreams.set(key, {
        streamId: streamEvent.message.id || key,
        parent_tool_use_id: message.parent_tool_use_id,
        text: '',
        flushes: [],
        thinking: '',
      });
      return;
    }

    const stream = this.partialMessageStreams.get(key);
    if (!stream) return;

    if (streamEvent.type === 'content_block_start') {
      const block = streamEvent.content_block;
      if (block.type === 'text' && block.text) {
        stream.text += block.text;
        this.schedulePartialMessageFlush(key);
      } else if (block.type === 'thinking' && block.thinking) {
        stream.thinking += block.thinking;
        this.schedulePartialMessageFlush(key);
      } else if (block.type === 'tool_use') {
        stream.toolUse = { id: block.id, name: block.name, input: '' };
      }
      return;
    }

    if (streamEvent.type === 'content_block_delta') {
      const delta = streamEvent.delta;
      if (delta.type === 'text_delta') {
        stream.text += delta.text;
        this.schedulePartialMessageFlush(key);
      } else if (delta.type === 'thinking_delta') {
        stream.thinking += delta.thinking;
        this.schedulePartialMessageFlush(key);
      } else if (delta.type === 'input_json_delta' && stream.toolUse) {
        stream.toolUse.input += delta.partial_json;
        const [, field, raw = '', closed] = TOOL_TARGET.exec(stream.toolUse.input) ?? [];
        const line = field === 'command' ? JSON_FIRST_LINE.exec(raw)?.[0] : undefined;
        const value = closed || line ? safeJsonParse<unknown>(`"${line ?? raw}"`, null) : null;
        if (field && field !== 'file_path' && field !== 'command') {
          stream.toolUse = undefined;
        } else if (typeof value === 'string') {
          const { id, name } = stream.toolUse;
          stream.tool = field === 'command' ? { id, name, command: value } : { id, name, filePath: value };
          stream.toolUse = undefined;
          this.schedulePartialMessageFlush(key);
        } else if (stream.toolUse.input.length > 16_384) {
          // Each delta rescans the input, so a huge one-line command gives up on a label rather than cost quadratic time.
          stream.toolUse = undefined;
        }
      } else if (delta.type === 'input_json_delta') {
        this.schedulePartialMessageFlush(key);
      }
      return;
    }

    if (streamEvent.type === 'message_stop') {
      this.flushPartialMessageStream(key, 'completed');
      this.partialMessageStreams.delete(key);
    }
  }

  protected async initialize(): Promise<void> {
    const goalEvent = await this.historyFile.findLastEventOfType(CHAT_GOAL_EVENT_TYPE);
    if (goalEvent) this.currentGoal = coerceChatGoalPayload(goalEvent.payload);

    if (this.initialSessionId) {
      this.sessionId = this.initialSessionId;
      console.log(`[ClaudeManager] Restored session ID from persisted state: ${this.sessionId}`);
    }
  }

  private async handleMessage(message: SDKMessage): Promise<void> {
    if ('session_id' in message && message.session_id && !this.sessionId) {
      this.sessionId = message.session_id;
      // Persist the session ID for future wake-ups
      await this.onSaveSessionId(this.sessionId);
      console.log(`[ClaudeManager] Captured and persisted session ID: ${this.sessionId}`);
    }
    if (message.type === 'stream_event') {
      this.handlePartialAssistantMessage(message);
      return;
    }
    // Thinking-token estimates arrive several times a second while the model
    // thinks and nothing renders them; persisted, they bury a turn's real
    // events under hundreds of progress frames per history page.
    if (message.type === 'system' && message.subtype === 'thinking_tokens') return;
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.supportedSlashCommands = normalizeClaudeSlashCommands(message.commands);
      this.slashCommandsDiscoveredAt = Date.now();
    }
    // Commenting on, closing or merging someone else's PR also publishes it; only PRs this workspace opened or pushed to are its own.
    const publishedAction = 'action' in message ? message.action : undefined;
    if (message.type === 'system' && String(message.subtype) === 'code_change_published'
      && 'url' in message && typeof message.url === 'string'
      && (publishedAction === 'created' || publishedAction === 'pushed')) {
      await pullRequestCheckService.recordPublishedPullRequest(message.url, publishedAction === 'created', this.chatId).catch((error) => {
        console.error('[ClaudeManager] Failed to record published PR:', error);
      });
    }
    // Claude Code moved the session itself, so picking the first model again has to set it again.
    if (message.type === 'system' && message.subtype === 'model_refusal_fallback' && message.scope !== 'local') {
      this.activeSessionModel = message.fallback_model;
    }
    if (message.type === 'system' && message.subtype === 'task_started' && message.ambient) {
      this.ambientTaskIds.add(message.task_id);
    }
    if (
      message.type === 'system'
      && (message.subtype === 'task_progress' || message.subtype === 'task_updated' || message.subtype === 'task_notification')
    ) {
      await this.forwardWorkflowAgentTranscripts(message.task_id);
    }
    await this.recordEvent(message);
    this.trackGoalProgress(message);
  }

  // The SDK doesn't stream goal state, so it is inferred from the evaluator's "not met" feedback and the run's final result.
  private trackGoalProgress(message: SDKMessage): void {
    const goal = this.currentGoal;
    if (!goal) return;
    if (message.type === 'user' && message.isSynthetic) {
      const content = message.message.content;
      const text = typeof content === 'string' ? content : content[0]?.type === 'text' ? content[0].text : '';
      if (!text.startsWith('Stop hook feedback:')) return;
      const now = new Date();
      this.recordGoalChange({
        ...goal,
        timeUsedSeconds: Math.round((now.getTime() - Date.parse(goal.createdAt)) / 1000),
        updatedAt: now.toISOString(),
      });
      return;
    }
    // Evaluation is deferred while background work runs. A successful run that ends without any means the
    // evaluator judged the goal met or impossible, and Claude Code has already cleared it.
    if (message.type === 'result' && message.subtype === 'success' && message.num_turns > 0
      && this.backgroundTasks.active.size === 0) {
      this.recordGoalChange(null);
    }
  }

  private async recordEvent(event: SDKMessage, okidokiMessageId?: string, replacesMessageId?: string, timestamp = new Date().toISOString()): Promise<void> {
    // History is read in pages, so a later lifecycle event can be rendered without
    // the task_started that marked the task ambient — task_progress and task_updated
    // never carry the flag at all. Restamp it so every page can suppress the task on its own.
    const restampAmbient = event.type === 'system'
      && 'task_id' in event
      && this.ambientTaskIds.has(event.task_id);
    // The SDK's raw copy of a tool result repeats the one in `message` (screenshots included); nothing reads it.
    const payload: Record<string, unknown> = { ...event };
    delete payload.tool_use_result;
    const jsonEvent: AgentEvent = {
      timestamp,
      type: `claude-${event.type}`,
      payload: {
        ...payload,
        ...(restampAmbient ? { ambient: true } : {}),
        ...(okidokiMessageId ? { [USER_MESSAGE_ID_PAYLOAD_KEY]: okidokiMessageId } : {}),
        ...(replacesMessageId ? { [REPLACED_MESSAGE_ID_PAYLOAD_KEY]: replacesMessageId } : {}),
      },
    };
    this.record(jsonEvent);
  }
}
