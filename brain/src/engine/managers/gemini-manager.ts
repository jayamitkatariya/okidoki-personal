import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  DEFAULT_GEMINI_MODEL,
  createProviderSlashCommand,
  detectAgentQuotaLimit,
  isRecord,
  isSameCredential,
  mergeSlashCommands,
  toolInputAnswer,
  type AgentCredentialSnapshot,
  type ChatHistoryPageParams,
  type ChatHistoryResponse,
  type SendChatMessageRequest,
  type SlashCommand,
  providerContextUsage,
} from '@okidoki/shared';
import { CodingAgentManager, type CodingAgentManagerOptions } from './coding-agent-manager';
import type { AuthFallbackResult } from './auth-fallback';
import type { AspClient } from './codex-asp/asp-client';
import { geminiSelectOption, initializeGeminiAcp, selectGeminiModel, spawnGeminiAcp, startGeminiSession, type GeminiSession } from './gemini-acp';
import { getInstalledSkillsAsSlashCommands } from '../services/installed-skill-service';
import { ENGINE_ENV } from '../engine-env';
import { normalizeImages } from '../utils/image-utils';
import type { QueuedMessage } from '../services/message-queue-service';
import { thinkingVariant } from '../utils/thinking-variant';
import { ensureGeminiCommandProtectionHook } from '../services/native-command-protection-hooks';

interface PendingQuestion {
  requestId: string | number;
  toolCallId: string;
  optionIds: string[];
}

class GeminiQuotaError extends Error {}

const GEMINI_LOGIN_REJECTED = /invalid_grant|not logged into Antigravity|Authentication required|UNAUTHENTICATED|Please log out \(\/logout\) and log back in/i;

export class GeminiManager extends CodingAgentManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private client: AspClient | null = null;
  private session: GeminiSession | null = null;
  private sessionId: string | null;
  private systemPrompt: string | null = null;
  private activePrompt: Promise<unknown> | null = null;
  private turnError: string | null = null;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private slashCommands: SlashCommand[] = [];

  constructor(options: CodingAgentManagerOptions) {
    super({ ...options, provider: 'gemini' });
    this.sessionId = options.initialSessionId;
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected async initialize(): Promise<void> {
    await ensureGeminiCommandProtectionHook();
  }

  /** Antigravity appends instructions to its system prompt only when a session starts, so changed ones restart it on the same conversation. */
  private async start(instructions: string): Promise<GeminiSession> {
    if (this.session && this.client && this.systemPrompt === instructions) return this.session;
    this.stopProcess();
    const { child, client } = spawnGeminiAcp(this.workingDirectory, this.originChatId ? { OKIDOKI_CHAT_ID: this.originChatId } : undefined);
    this.process = child;
    this.client = client;
    client.on('notification', (frame) => this.handleNotification(frame));
    client.on('serverRequest', (frame) => this.handleServerRequest(frame));
    child.stderr.on('data', (chunk) => console.error('[gemini ACP]', chunk.toString().trimEnd()));
    child.on('error', (error) => this.handleProcessExit(child, error));
    child.on('exit', (code, signal) => this.handleProcessExit(child, new Error(`Antigravity exited with code ${code ?? signal}`)));

    await initializeGeminiAcp(client, 0);
    let session: GeminiSession | null = null;
    if (this.sessionId) {
      session = await startGeminiSession(client, { cwd: this.workingDirectory, resumeSessionId: this.sessionId, systemPrompt: instructions }, 0).catch(() => null);
    }
    if (!session) {
      session = await startGeminiSession(client, { cwd: this.workingDirectory, systemPrompt: instructions }, 0);
      this.sessionId = session.sessionId;
      await this.onSaveSessionId(session.sessionId);
    }
    this.session = session;
    this.systemPrompt = instructions;
    return session;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error('Antigravity is not running.'));
    return this.client.request(method, params, { timeoutMs: 0 });
  }

  private handleProcessExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    const midTurn = (this.client?.pendingRequestCount ?? 0) > 0;
    this.process = null;
    this.session = null;
    this.client?.dispose(error);
    this.client = null;
    this.abortPendingQuestions();
    if (midTurn) this.turnError = error.message;
  }

  private stopProcess(): void {
    const process = this.process;
    this.process = null;
    this.session = null;
    this.client?.dispose();
    this.client = null;
    this.abortPendingQuestions();
    process?.kill('SIGTERM');
  }

  private handleNotification(frame: unknown): void {
    if (!isRecord(frame) || frame.method !== 'session/update' || !isRecord(frame.params) || !isRecord(frame.params.update)) return;
    if (frame.params.sessionId !== this.sessionId) return;
    const update = frame.params.update;
    const kind = update.sessionUpdate;
    if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      this.slashCommands = update.availableCommands.flatMap((command) => {
        if (!isRecord(command) || typeof command.name !== 'string') return [];
        const parsed = createProviderSlashCommand(
          'gemini',
          command.name,
          typeof command.description === 'string' ? command.description : undefined,
          isRecord(command.input) && typeof command.input.hint === 'string' ? command.input.hint : undefined,
        );
        return parsed ? [parsed] : [];
      });
      return;
    }
    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      if (this.session) this.session.configOptions = update.configOptions;
      return;
    }
    if (kind === 'usage_update' && typeof update.used === 'number' && typeof update.size === 'number') {
      this.recordContextUsage(providerContextUsage({
        provider: 'gemini',
        model: this.session ? geminiSelectOption(this.session.configOptions, 'model')?.currentValue ?? null : null,
        totalTokens: update.used,
        maxTokens: update.size,
      }));
      return;
    }
    if (kind === 'current_mode_update' || kind === 'session_info_update') return;
    this.recordHistoryEvent(kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' ? 'gemini-chunk' : 'gemini-session-update', { update });
  }

  private handleServerRequest(frame: unknown): void {
    const client = this.client;
    if (!client || !isRecord(frame) || (typeof frame.id !== 'string' && typeof frame.id !== 'number')) return;
    if (frame.method !== 'session/request_permission' || !isRecord(frame.params) || !isRecord(frame.params.toolCall)
      || !Array.isArray(frame.params.options)) {
      client.reject(frame.id, -32601, 'Unsupported request');
      return;
    }
    const toolCall = frame.params.toolCall;
    const options = frame.params.options.flatMap((option) => (
      isRecord(option) && typeof option.optionId === 'string'
        ? [{ id: option.optionId, label: typeof option.name === 'string' && option.name ? option.name : option.optionId, kind: option.kind }]
        : []
    ));
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : String(frame.id);
    // Antigravity sends its questions to the user as permission requests whose tool call id starts with `interaction_`.
    if (toolCallId.startsWith('interaction_')) {
      const requestId = `gemini-question:${toolCallId}`;
      this.pendingQuestions.set(requestId, { requestId: frame.id, toolCallId, optionIds: options.map((option) => option.id) });
      this.recordHistoryEvent('gemini-session-update', { update: { ...toolCall, sessionUpdate: 'tool_call', status: 'pending' } });
      this.recordHistoryEvent('okidoki-tool-input-request', {
        requestId,
        toolUseId: toolCallId,
        toolName: 'AskUserQuestion',
        questions: [{
          id: 'question',
          prompt: typeof toolCall.title === 'string' && toolCall.title ? toolCall.title : 'Choose an option.',
          multiSelect: false,
          options: options.map(({ id, label }) => ({ id, label })),
        }],
        parent_tool_use_id: null,
      });
      return;
    }
    const option = ['allow_always', 'allow_once'].flatMap((kind) => options.filter((candidate) => candidate.kind === kind))[0];
    client.respond(frame.id, { outcome: option ? { outcome: 'selected', optionId: option.id } : { outcome: 'cancelled' } });
  }

  private resolveQuestion(requestId: string, selectionId: string, selectionSummary?: string): PendingQuestion | undefined {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return undefined;
    this.pendingQuestions.delete(requestId);
    this.recordHistoryEvent('okidoki-tool-input-resolved', {
      requestId,
      toolUseId: pending.toolCallId,
      toolName: 'AskUserQuestion',
      selectionId,
      ...(selectionSummary ? { selectionSummary } : {}),
      parent_tool_use_id: null,
    });
    return pending;
  }

  private abortPendingQuestions(): void {
    for (const requestId of [...this.pendingQuestions.keys()]) {
      const pending = this.resolveQuestion(requestId, 'aborted');
      if (pending) this.client?.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
    }
  }

  async respondToToolInput(requestId: string, selectionId: string): Promise<boolean> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || !this.client) return false;
    if (selectionId === 'declined') {
      this.resolveQuestion(requestId, 'declined');
      this.client.respond(pending.requestId, { outcome: { outcome: 'cancelled' } });
      return true;
    }
    const answer = toolInputAnswer(JSON.parse(selectionId), 'question');
    const optionId = answer.options.find((id) => pending.optionIds.includes(id));
    if (!optionId) return false;
    this.resolveQuestion(requestId, selectionId);
    this.client.respond(pending.requestId, { outcome: { outcome: 'selected', optionId } });
    return true;
  }

  isAwaitingInput(): boolean {
    return this.pendingQuestions.size > 0;
  }

  private async createPrompt(request: SendChatMessageRequest): Promise<Array<Record<string, unknown>>> {
    const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: request.message }];
    for (const image of await normalizeImages(request.images ?? [])) {
      if (image.label) prompt.push({ type: 'text', text: image.label });
      prompt.push({ type: 'image', mimeType: image.source.media_type, data: image.source.data });
    }
    return prompt;
  }

  protected override async steerRequest(request: QueuedMessage): Promise<boolean> {
    if (!this.activePrompt || !this.sessionId) return false;
    const prompt = await this.createPrompt(request);
    const running = this.activePrompt;
    if (!running) return false;
    const steer = this.request('session/prompt', { sessionId: this.sessionId, prompt });
    steer.catch(() => {});
    this.activePrompt = steer;
    // Antigravity ends the running prompt once it takes the new one; a steer rejected first stays queued.
    const accepted = await Promise.race([running.then(() => true, () => true), steer.then(() => true, () => false)]);
    if (!accepted) {
      if (this.activePrompt === steer) this.activePrompt = running;
      return false;
    }
    const read = this.markSteerRead(request.id);
    if (read) this.recordUserMessageHistoryEvent(read);
    return true;
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    let userMessageRecorded = false;

    const dispatch = async (request: SendChatMessageRequest): Promise<void> => {
      const session = await this.start(this.buildCombinedInstructions(request.customInstructions));
      const client = this.client;
      if (!client) throw new Error('Antigravity failed to start.');
      if (!userMessageRecorded) {
        this.recordUserMessageHistoryEvent(request);
        userMessageRecorded = true;
      }
      await selectGeminiModel(client, session, request.model ?? DEFAULT_GEMINI_MODEL, 0);
      const thinking = geminiSelectOption(session.configOptions, 'thought_level');
      const thinkingValue = thinking ? thinkingVariant(new Set(thinking.values), request.thinkingLevel) : undefined;
      if (thinking && thinkingValue && thinkingValue !== thinking.currentValue) {
        const result = await this.request('session/set_config_option', { sessionId: session.sessionId, configId: thinking.id, value: thinkingValue });
        if (isRecord(result) && Array.isArray(result.configOptions)) session.configOptions = result.configOptions;
      }

      const prompt = await this.createPrompt(request);
      if (signal.aborted) return;
      this.turnError = null;
      let response: unknown;
      try {
        this.activePrompt = this.request('session/prompt', { sessionId: session.sessionId, prompt });
        // A steer is another prompt, which ends the running one and carries the turn on.
        for (let pending = this.activePrompt; ; pending = this.activePrompt) {
          response = await pending;
          if (pending === this.activePrompt) break;
        }
      } catch (error) {
        this.turnError = (error instanceof Error ? error.message : String(error)).replace(/^ASP request failed for session\/prompt: (?:-?\d+ )?/, '');
      }
      if (this.turnError) {
        if (detectAgentQuotaLimit(this.turnError)) throw new GeminiQuotaError(this.turnError);
        throw new Error(this.turnError);
      }
      if (isRecord(response) && isRecord(response.usage)) this.onUsageUpdate(response.usage, new Date().toISOString());
      this.recordHistoryEvent('gemini-turn-complete', { stopReason: isRecord(response) ? response.stopReason : undefined });
    };

    let current = request;
    let afterLimit = false;
    const failedLogins: AgentCredentialSnapshot[] = [];
    try {
      for (;;) {
        try {
          await dispatch(current);
          return;
        } catch (error) {
          if (signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          const quotaKind = error instanceof GeminiQuotaError ? detectAgentQuotaLimit(message) ?? 'rate_limit' : null;
          if (!quotaKind && !GEMINI_LOGIN_REJECTED.test(message)) {
            this.recordHistoryEvent('gemini-error', { message });
            throw error;
          }
          const attempted = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.gemini;
          const repeated = !!attempted && failedLogins.some((failed) => isSameCredential(failed, attempted));
          if (attempted) failedLogins.push(attempted);
          const fallback: AuthFallbackResult = repeated
            ? { outcome: 'unavailable' }
            : await this.fallBackCredential(quotaKind ?? 'auth_failed', message, attempted, undefined, afterLimit);
          if (fallback.outcome === 'switched') {
            afterLimit ||= !!quotaKind;
            if (fallback.model) current = { ...current, model: fallback.model };
            this.stopProcess();
            continue;
          }
          this.recordHistoryEvent('gemini-error', { message });
          if (fallback.outcome === 'fork') {
            this.emitQuotaExhausted({ provider: 'gemini', reason: quotaKind ?? 'auth_failed', detail: message, forkTo: fallback.target });
            return;
          }
          if (quotaKind) return;
          throw error;
        }
      }
    } finally {
      this.activePrompt = null;
      this.turnError = null;
      this.abortPendingQuestions();
      try {
        await this.historyFile.flush();
      } finally {
        await this.onTurnComplete();
      }
    }
  }

  protected async interruptActiveTurn(): Promise<void> {
    this.abortPendingQuestions();
    // Before the prompt starts there is nothing to cancel, and a stalled startup would hold the queue.
    if (!this.activePrompt) this.stopProcess();
    else if (this.client && this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.historyFile.flush();
    return { thread_id: this.sessionId, ...await this.historyFile.loadEventsPage(page), goal: null };
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    return mergeSlashCommands(this.slashCommands, await getInstalledSkillsAsSlashCommands(ENGINE_ENV.HOME_DIR, 'gemini'));
  }

  dispose(): void {
    this.stopProcess();
  }
}
