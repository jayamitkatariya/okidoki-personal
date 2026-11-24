import { readFile, readdir } from 'fs/promises';
import { basename, extname, join } from 'path';
import {
  createProviderSlashCommand,
  CURSOR_CONNECTION_STATUS_EVENT_TYPE,
  DEFAULT_CURSOR_MODEL,
  extractErrorText,
  isTransientErrorText,
  mergeSlashCommands,
  clampTokensToWindow,
  percentage,
  raceWithTimeout,
  TIMEOUT,
  parseFrontmatter,
  type AgentEvent,
  type ChatHistoryPageParams,
  type ChatHistoryResponse,
  type ContextUsagePayload,
  type QueueMutationResponse,
  type SendChatMessageRequest,
  type SlashCommand,
} from '@okidoki/shared';
import { Agent as CursorAgent, AuthenticationError, CursorSdkError, type InteractionUpdate, type Run, type SDKAgent, type SDKUserMessage, type SettingSource } from '@cursor/sdk';
import { CodingAgentManager, type CodingAgentManagerOptions } from './coding-agent-manager';
import type { QueuedMessage } from '../services/message-queue-service';
import { ENGINE_ENV } from '../engine-env';
import { getAgentAdditionalDirectories } from '../utils/agent-additional-directories';
import { normalizeImages } from '../utils/image-utils';
import { isRecord } from '../utils/type-guards';
import { convertCursorEvent } from '../utils/linear-converter';
import { LinearEventForwarder } from '../utils/linear-event-forwarder';
import { ensureCursorCommandProtectionHook } from '../services/native-command-protection-hooks';
import { sendCursorRun } from './cursor-run-recovery';

const CURSOR_SLASH_COMMANDS_CACHE_MS = 30_000;
// Cursor's SDK runs the agent loop in-process, so a wedged run is otherwise unobservable; bound every wait on it.
const CURSOR_STREAM_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
const CURSOR_RUN_SETTLE_TIMEOUT_MS = 30_000;
const CURSOR_CANCEL_TIMEOUT_MS = 10_000;
const CURSOR_RECONNECT_NOTICE_DELAY_MS = 15_000;
const TURN_ABORTED = Symbol('cursor-turn-aborted');
// Replace once the Cursor SDK exposes modelContextWindow in turn usage events.
const CURSOR_COMPOSER_CONTEXT_WINDOW = 200_000;

const CURSOR_TRANSPORT_ERROR_PATTERNS = [
  /connection failed/,
  /connection stalled/,
  /cursor run stalled/,
  /stream closed/,
  /stream ended/,
  /nghttp2_/,
  /err_http2_stream_error/,
  /write ecanceled/,
];

function isCursorTransportError(text: string): boolean {
  return isTransientErrorText(text, { extraPatterns: CURSOR_TRANSPORT_ERROR_PATTERNS });
}

// Cursor's ErrorDetails auth codes plus the key-exchange 401 code. Matching free
// text like "unauthorized" misreports tool, GitHub, and MCP 401s as a bad Cursor key.
const CURSOR_AUTH_ERROR_CODES = [
  'unauthenticated',
  'not_logged_in',
  'agent_requires_login',
  'auth_token_not_found',
  'auth_token_expired',
  'invalid_auth_id',
  'unauthorized',
  'bad_api_key',
  'bad_user_api_key',
];
const CURSOR_AUTH_ERROR_TEXT_PATTERN = new RegExp(`\\berror_(${CURSOR_AUTH_ERROR_CODES.join('|')})\\b`);

function isCursorAuthenticationError(code: string | undefined, text: string): boolean {
  return CURSOR_AUTH_ERROR_CODES.includes(code?.toLowerCase().replace(/^error_/, '') ?? '')
    || CURSOR_AUTH_ERROR_TEXT_PATTERN.test(text.toLowerCase());
}

function finiteNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function extractCursorCommandDescription(content: string): string | undefined {
  return parseFrontmatter(content).description;
}

async function listCursorCommandsInDirectory(directory: string): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    console.warn('[CursorManager] Failed to read slash command directory:', error);
    return [];
  }

  const commands = await Promise.all(entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
    .map(async (entry) => {
      const name = basename(entry.name, '.md');
      let description: string | undefined;
      try {
        description = extractCursorCommandDescription(await readFile(join(directory, entry.name), 'utf8'));
      } catch (error) {
        console.warn('[CursorManager] Failed to read slash command file:', error);
      }
      return createProviderSlashCommand('cursor', name, description);
    }));

  return commands.filter((command): command is SlashCommand => Boolean(command));
}

export class CursorManager extends CodingAgentManager {
  private agent: SDKAgent | null = null;
  private activeRun: Run | null = null;
  private readonly pendingSteers = new Set<Promise<void>>();
  private activeModel: string | null = null;
  private abortActiveTurn: (() => void) | null = null;
  private reconnectNoticeVisible = false;
  private instructionsDelivered = false;
  private agentRequest: Promise<SDKAgent> | null = null;
  private resumeSessionId: string | null = null;
  private slashCommandsCache: { commands: SlashCommand[]; expiresAt: number } | null = null;
  private slashCommandsRequest: Promise<SlashCommand[]> | null = null;

  constructor(options: CodingAgentManagerOptions) {
    super(options);
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected async initialize(): Promise<void> {
    await ensureCursorCommandProtectionHook();
  }

  protected async interruptActiveTurn(): Promise<void> {
    // Wake the stream loop too: a cancelled run's iterator may not promptly yield `done`.
    await this.cancelRun(this.activeRun);
    this.abortActiveTurn?.();
  }

  // Cursor's steer API is text-only, so an image message waits for the turn to end.
  override async steerFromQueue(messageId: string): Promise<QueueMutationResponse> {
    await this.initialized;
    const queued = this.messageQueue.getQueue().find(({ id }) => id === messageId);
    return queued?.images?.length ? { success: false, queue: this.getQueue() } : super.steerFromQueue(messageId);
  }

  // Cursor's steer resolves once the turn appends the message, so it settles later; the turn
  // waits for pending steers before completing, and an unread one is requeued as a follow-up.
  protected override async steerRequest(request: QueuedMessage): Promise<boolean> {
    const run = this.activeRun;
    if (!run?.steer || run.status !== 'running' || request.images?.length) return false;
    const pending: Promise<void> = run.steer(request.message).then((outcome) => {
      if (outcome !== 'complete_delivered') return;
      const steer = this.markSteerRead(request.id);
      if (steer) this.recordUserMessageHistoryEvent(steer);
    }).catch((error) => {
      console.error('[CursorManager] Failed to steer Cursor run:', error);
    }).finally(() => this.pendingSteers.delete(pending));
    this.pendingSteers.add(pending);
    return true;
  }

  private async cancelRun(run: Run | null): Promise<void> {
    if (!run || run.status !== 'running') return;
    try {
      const result = await raceWithTimeout(run.cancel(), CURSOR_CANCEL_TIMEOUT_MS);
      if (result === TIMEOUT) {
        console.error('[CursorManager] Timed out cancelling Cursor run:', run.id);
      }
    } catch (error) {
      console.error('[CursorManager] Failed to cancel Cursor run:', error);
    }
  }

  private closeAgent(): void {
    const agent = this.agent;
    this.agent = null;
    try {
      agent?.close();
    } catch (error) {
      console.error('[CursorManager] Failed to close Cursor agent:', error);
    }
  }

  dispose(): void {
    this.closeAgent();
  }

  mayBeReconnecting(): boolean {
    return this.reconnectNoticeVisible;
  }

  private setReconnectNoticeVisible(value: boolean): void {
    if (this.reconnectNoticeVisible === value) return;
    this.reconnectNoticeVisible = value;
    this.emitSyntheticEvent(CURSOR_CONNECTION_STATUS_EVENT_TYPE, { mayBeReconnecting: value });
  }

  // Cursor keeps a thread's partial response and tool results, so once the model
  // has acted the session must stay resumable even if the run later fails or is
  // interrupted — otherwise a later user retry strands that work on an orphaned
  // thread. The same activity proves the instruction-bearing
  // first message reached the thread, so instructions must not be re-sent.
  private async retainThread(agentId: string): Promise<void> {
    if (this.instructionsDelivered && this.resumeSessionId === agentId) return;
    this.instructionsDelivered = true;
    this.resumeSessionId = agentId;
    await this.onSaveSessionId(agentId);
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.historyFile.flush();
    const history = await this.historyFile.loadEventsPage(page);
    return {
      thread_id: this.agent?.agentId ?? this.resumeSessionId ?? this.initialSessionId,
      ...history,
      goal: null,
    };
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    await this.initialized;
    const now = Date.now();
    if (this.slashCommandsCache && this.slashCommandsCache.expiresAt > now) {
      return this.slashCommandsCache.commands;
    }

    this.slashCommandsRequest ??= (async () => {
      try {
        const repoDirectories = await getAgentAdditionalDirectories();
        const commandDirectories = [this.workingDirectory, ...repoDirectories, ENGINE_ENV.HOME_DIR]
          .map((directory) => join(directory, '.cursor', 'commands'));
        const commands = mergeSlashCommands(
          ...await Promise.all(commandDirectories.map(listCursorCommandsInDirectory)),
        );
        this.slashCommandsCache = { commands, expiresAt: Date.now() + CURSOR_SLASH_COMMANDS_CACHE_MS };
        return commands;
      } finally {
        this.slashCommandsRequest = null;
      }
    })();

    return this.slashCommandsRequest;
  }

  // A stopped turn leaves its agent starting, so the next turn waits for that one instead of starting a second thread.
  private ensureAgent(request: SendChatMessageRequest): Promise<SDKAgent> {
    return this.agentRequest ??= this.startAgent(request).finally(() => {
      this.agentRequest = null;
    });
  }

  private async startAgent(request: SendChatMessageRequest): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    const apiKey = ENGINE_ENV.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error('Cursor API key is not configured for this workspace.');
    }

    const model = { id: request.model ?? DEFAULT_CURSOR_MODEL };
    // Omitting settingSources loads none of them — the SDK then never scans
    // .claude/.codex/.agents/.cursor skills dirs at cwd or $HOME, so the
    // okidoki-agent skill silently never reaches the agent.
    const settingSources: SettingSource[] = ['project', 'user'];
    const local = { cwd: this.workingDirectory, settingSources, enableAgentRetries: true };
    // Prefer a thread this instance already proved real so a user retry after a
    // failed run continues from any partial response or completed tool calls.
    const resumeId = this.resumeSessionId ?? this.initialSessionId;
    this.agent = resumeId
      ? await CursorAgent.resume(resumeId, {
          apiKey,
          model,
          local,
        })
      : await CursorAgent.create({
          apiKey,
          model,
          local,
        });

    // Only persist a resumed session id here (it was already delivered by the
    // instance that created it). A new thread's id is persisted once the model
    // acts on its instruction-bearing first message — persisting here would let
    // a failed first turn leave a resumable session whose instructions were
    // never sent, so a later instance would skip them.
    if (resumeId) await this.onSaveSessionId(this.agent.agentId);
    return this.agent;
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    let run: Run | null = null;
    let agent: SDKAgent | null = null;
    let sawCursorActivity = false;
    let reconnectNoticeTimer: ReturnType<typeof setTimeout> | null = null;
    const aborted = new Promise<typeof TURN_ABORTED>((resolve) => {
      this.abortActiveTurn = () => resolve(TURN_ABORTED);
    });
    const linearForwarder = new LinearEventForwarder(() => this.linearSessionId);
    const clearReconnectNoticeTimer = () => {
      if (!reconnectNoticeTimer) return;
      clearTimeout(reconnectNoticeTimer);
      reconnectNoticeTimer = null;
    };
    const markCursorActivity = () => {
      sawCursorActivity = true;
      clearReconnectNoticeTimer();
      this.setReconnectNoticeVisible(false);
    };

    try {
      // The Cursor SDK has no system-prompt channel, so workspace instructions
      // (skills hint, PR attribution, repo defaults) ride the first message of
      // a new thread; resumed threads already received them. Gate on actual
      // delivery, not agent existence: if message building (image normalization)
      // or the SDK send throws, the retry must still carry the instructions.
      const includeInstructions = !this.initialSessionId && !this.instructionsDelivered;
      const message = await this.toCursorMessage(request, includeInstructions);
      const model = request.model ?? DEFAULT_CURSOR_MODEL;
      this.activeModel = model;
      let failure: { text: string; code?: string; runId?: string; requestId?: string; transport: boolean; authentication: boolean } | null = null;

      try {
        reconnectNoticeTimer = setTimeout(() => {
          if (!sawCursorActivity && this.abortActiveTurn) {
            this.setReconnectNoticeVisible(true);
          }
        }, CURSOR_RECONNECT_NOTICE_DELAY_MS);
        const ensured = await Promise.race([this.ensureAgent(request), aborted]);
        if (ensured === TURN_ABORTED) return;
        agent = ensured;
        if (!this.deliver(signal)) return;
        this.recordUserMessageHistoryEvent(request, {}, this.turnBeganAt);

        const sending = sendCursorRun(agent, message, {
          model: { id: model },
          mode: 'agent',
          onDelta: (args) => {
            markCursorActivity();
            this.recordCursorContextUsage(args.update);
          },
        }, this.workingDirectory);
        const sent = await Promise.race([sending, aborted]);
        if (sent === TURN_ABORTED) {
          // The run can still start after this turn ended, with nobody left to stop it.
          void sending.then((late) => this.cancelRun(late), () => {});
          return;
        }
        run = sent;
        this.activeRun = run;
        void this.deliverEarlySteers();

        const events = run.stream()[Symbol.asyncIterator]();
        let interrupted = false;
        while (true) {
          const nextPromise = events.next();
          // Swallow late rejection from an abandoned iterator promise.
          nextPromise.catch(() => {});
          const next = await raceWithTimeout(
            Promise.race([nextPromise, aborted]),
            CURSOR_STREAM_INACTIVITY_TIMEOUT_MS,
          );
          if (next === TIMEOUT) {
            throw new Error(`Cursor run stalled: no events for ${CURSOR_STREAM_INACTIVITY_TIMEOUT_MS / 60_000} minutes; cancelling the run`);
          }
          if (next === TURN_ABORTED) {
            interrupted = true;
            break;
          }
          if (next.done) break;
          markCursorActivity();
          const event = next.value;
          this.recordHistoryEvent(`cursor-${event.type}`, event);
          const linearSessionId = this.linearSessionId;
          if (linearSessionId) {
            linearForwarder.sendEvent(convertCursorEvent(event, linearSessionId));
          }
        }

        // Cancel here too: an interrupt can race before this.activeRun is set.
        if (interrupted) {
          if (sawCursorActivity) await this.retainThread(agent.agentId);
          await this.cancelRun(run);
          return;
        }

        const result = await raceWithTimeout(run.wait(), CURSOR_RUN_SETTLE_TIMEOUT_MS);
        if (result === TIMEOUT) {
          throw new Error('Cursor run stalled after its event stream ended');
        }
        if (result.status === 'error') {
          // `RunResult.error` is often absent; Cursor persists the failure reason on the run record.
          const detail = await this.readRunErrorDetail(agent.agentId, result.id);
          const text = detail || result.error?.message || result.result || 'Cursor run failed';
          failure = {
            text,
            ...(result.error?.code ? { code: result.error.code } : {}),
            runId: result.id,
            ...(result.requestId ? { requestId: result.requestId } : {}),
            transport: isCursorTransportError(text),
            authentication: isCursorAuthenticationError(result.error?.code, text),
          };
        } else {
          await this.retainThread(agent.agentId);
          linearForwarder.flushThoughtAsResponse();
          return;
        }
      } catch (error) {
        await this.cancelRun(run);
        const text = extractErrorText(error) || 'Cursor run failed';
        const code = error instanceof CursorSdkError ? error.code : undefined;
        failure = {
          text,
          ...(code ? { code } : {}),
          ...(run ? { runId: run.id } : {}),
          ...(run?.requestId ? { requestId: run.requestId } : {}),
          transport: isCursorTransportError(text),
          authentication: error instanceof AuthenticationError || isCursorAuthenticationError(code, text),
        };
      }

      if (agent && sawCursorActivity) await this.retainThread(agent.agentId);
      if (!failure) return;
      console.error('[CursorManager] Cursor run failed:', {
        runId: failure.runId,
        requestId: failure.requestId,
        code: failure.code,
        model,
        detail: failure.text,
        transport: failure.transport,
        authentication: failure.authentication,
      });

      const credentialScope = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.cursor?.scope;
      const credentialLabel = credentialScope === 'user'
        ? 'personal API key or account'
        : credentialScope === 'org'
          ? 'organization API key or account'
          : 'configured API key or account';
      const authentication = failure.authentication && !failure.transport;
      // Cursor also returns login errors for expired or dropped sessions on a valid key,
      // so retry with a fresh agent (new key exchange) before asking for a new key.
      const authenticationMessage = authentication
        ? [
            `Cursor rejected the ${credentialLabel} for this request.`,
            'Retry the message to reconnect with the stored key.',
            'If it keeps failing, update the Cursor API key in Settings → Coding Agents (logging out and back in does not replace it), then start a new workspace.',
            failure.requestId
              ? `If a fresh key still fails, contact Cursor support with request ID ${failure.requestId}.`
              : '',
          ].filter(Boolean).join(' ')
        : null;
      const displayMessage = failure.transport
        ? sawCursorActivity
          ? 'Cursor couldn\'t reconnect after its automatic retries. Retry the message to continue from the same chat.'
          : run
            ? 'Cursor couldn\'t connect after its automatic retries. Retry the message or start a new Cursor chat if the problem continues.'
            : 'The connection to Cursor failed. Retry the message or start a new Cursor chat if the problem continues.'
        : authenticationMessage ?? failure.text;
      if (failure.transport || authentication) {
        this.activeRun = null;
        this.closeAgent();
      }
      this.recordHistoryEvent('cursor-error', {
        type: 'error',
        message: displayMessage,
        ...(displayMessage !== failure.text ? { detail: failure.text } : {}),
        ...(failure.code ? { code: failure.code } : {}),
        ...(failure.runId ? { runId: failure.runId } : {}),
        ...(failure.requestId ? { requestId: failure.requestId } : {}),
      });
    } catch (error) {
      await this.cancelRun(run);
      this.recordHistoryEvent('cursor-error', {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearReconnectNoticeTimer();
      this.setReconnectNoticeVisible(false);
      this.abortActiveTurn = null;
      this.activeRun = null;
      this.activeModel = null;
      await raceWithTimeout(Promise.allSettled(this.pendingSteers), CURSOR_RUN_SETTLE_TIMEOUT_MS);
      await this.historyFile.flush();
      await this.onTurnComplete();
    }
  }

  private async readRunErrorDetail(agentId: string, runId: string): Promise<string | null> {
    try {
      // Imported lazily: the subpath loads the native sqlite binding, and a
      // runtime without it must still report the generic failure.
      const { SqliteLocalAgentStore } = await import('@cursor/sdk/sqlite');
      const store = await SqliteLocalAgentStore.open({ workspaceRef: this.workingDirectory });
      try {
        const record = await store.runs.get({ agentId, runId });
        return record?.error?.trim() || null;
      } finally {
        await store.dispose();
      }
    } catch (error) {
      console.error('[CursorManager] Failed to read Cursor run error detail:', error);
      return null;
    }
  }

  private async toCursorMessage(request: SendChatMessageRequest, includeInstructions: boolean): Promise<string | SDKUserMessage> {
    const instructions = includeInstructions ? this.buildCombinedInstructions(request.customInstructions) : undefined;
    const text = [
      instructions ? `<workspace-instructions>\n${instructions}\n</workspace-instructions>` : null,
      request.message,
    ].filter((part): part is string => Boolean(part)).join('\n\n');
    if (!request.images || request.images.length === 0) {
      return text;
    }
    const images = await normalizeImages(request.images);
    return {
      text,
      images: images.map((image) => ({
        data: image.source.data,
        mimeType: image.source.media_type,
      })),
    };
  }

  // `turn-ended` is only ever an `onDelta` interaction update — it is not part of
  // the `SDKMessage` union the run stream yields, so usage has to be read here.
  private recordCursorContextUsage(update: InteractionUpdate): void {
    if (update.type !== 'turn-ended' || !update.usage) return;

    const inputTokens = finiteNumber(update.usage.inputTokens);
    const cacheReadTokens = finiteNumber(update.usage.cacheReadTokens);
    const cacheWriteTokens = finiteNumber(update.usage.cacheWriteTokens);
    const outputTokens = finiteNumber(update.usage.outputTokens);
    const rawTotalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
    if (rawTotalTokens <= 0) return;
    this.onUsageUpdate(update, new Date().toISOString());

    const maxTokens = CURSOR_COMPOSER_CONTEXT_WINDOW;
    const totalTokens = clampTokensToWindow(rawTotalTokens, maxTokens);
    const categories = [
      {
        name: 'Input',
        tokens: inputTokens,
        percentage: percentage(inputTokens, maxTokens),
      },
      {
        name: 'Cache read',
        tokens: cacheReadTokens,
        percentage: percentage(cacheReadTokens, maxTokens),
      },
      {
        name: 'Cache write',
        tokens: cacheWriteTokens,
        percentage: percentage(cacheWriteTokens, maxTokens),
      },
      {
        name: 'Output',
        tokens: outputTokens,
        percentage: percentage(outputTokens, maxTokens),
      },
    ].filter((category) => category.tokens > 0);

    const payload: ContextUsagePayload = {
      provider: 'cursor',
      source: 'provider_usage',
      model: this.activeModel,
      totalTokens,
      maxTokens,
      rawMaxTokens: maxTokens,
      percentage: percentage(totalTokens, maxTokens),
      compactsAutomatically: true,
      categories,
      updatedAt: new Date().toISOString(),
    };
    this.recordContextUsage(payload);
  }
}
