import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  DEFAULT_MUSE_MODEL,
  createProviderSlashCommand,
  detectAgentQuotaLimit,
  isRecord,
  type ChatHistoryPageParams,
  type ChatHistoryResponse,
  type SendChatMessageRequest,
  type SlashCommand,
  toolInputAnswer,
  providerContextUsage,
} from '@okidoki/shared';
import { CodingAgentManager, type CodingAgentManagerOptions } from './coding-agent-manager';
import type { AspClient } from './codex-asp/asp-client';
import { initializeMuse, museTurnStartParams, spawnMuseMsp, startMuseSession } from './muse-msp';
import { execFileAsync, SUBPROCESS_MAX_BUFFER } from '../utils/exec';
import { uuidV7 } from '../utils/uuid-v7';

interface PendingInput {
  userInputId: string;
  toolCallId: string;
  questions: Array<{
    id: string;
    question?: string;
    options?: Array<{
      label?: string;
      description?: string;
      preview?: { content?: string };
    }>;
    selection?: { mode?: string };
  }>;
}

interface PendingApproval {
  approvalId: string;
  sessionId: string;
  itemId: string;
  toolName: string;
  rawArgs: string;
  currentRequirementId: { approvalId: string; sourceIndex: number };
  availableChoices: Array<{ choiceId: string; label: string; decision: string; rulePreview?: string }>;
  subject: Record<string, unknown>;
  requestId: string;
  viewCursor?: string;
  selectionId?: string;
}

class MuseQuotaError extends Error {}

const MUSE_INTERRUPT_TIMEOUT_MS = 5_000;

function isPendingQuestion(value: unknown): value is PendingInput['questions'][number] {
  return isRecord(value) && typeof value.id === 'string';
}

export class MuseManager extends CodingAgentManager {
  private process: ChildProcessWithoutNullStreams | null = null;
  private client: AspClient | null = null;
  private sessionId: string | null = null;
  private activeTurnId: string | null = null;
  private deliveredInstructions: string | null = null;
  private turnComplete: { resolve: () => void } | null = null;
  private turnError: string | null = null;
  private compactionComplete: { resolve: () => void } | null = null;
  private pendingInput: PendingInput | null = null;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly resolvedApprovals = new Set<string>();
  private slashCommands: SlashCommand[] | null = null;

  constructor(options: CodingAgentManagerOptions) {
    super({ ...options, provider: 'muse' });
    this.sessionId = options.initialSessionId;
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  private async start(model: string): Promise<void> {
    if (this.process) return;
    const { child, client } = spawnMuseMsp(this.workingDirectory, this.originChatId ? { OKIDOKI_CHAT_ID: this.originChatId } : undefined);
    this.process = child;
    this.client = client;
    client.on('notification', (notification) => this.handleNotification(notification));
    client.on('serverRequest', (request) => {
      const frame: unknown = request;
      if (isRecord(frame) && frame.method === 'approval/request') {
        this.handleNotification({ method: 'approval/requested', params: frame.params });
        client.respond(request.id, {});
      } else {
        client.reject(request.id, -32601, 'Unsupported Muse request');
      }
    });
    child.stderr.on('data', (chunk) => console.error('[muse MSP]', chunk.toString().trimEnd()));
    child.on('error', (error) => this.handleProcessExit(child, error));
    child.on('exit', (code, signal) => this.handleProcessExit(
      child,
      new Error(`The Muse process exited (${signal ?? `code ${code}`}) before the turn finished`),
    ));

    await initializeMuse(client, 'okidoki', 0);
    if (this.sessionId) {
      try {
        await this.request('session/resume', {
          commandId: uuidV7(),
          sessionId: this.sessionId,
          excludeItems: true,
        });
      } catch (error) {
        // A resume that failed because this process stopped says nothing about the session, so the next turn still resumes it.
        if (this.client !== client) throw error;
        this.sessionId = null;
      }
      if (this.sessionId) await this.refreshPendingApprovals();
    }
    if (!this.sessionId) {
      const sessionId = await startMuseSession(client, { approvalMode: 'allowAll', modelId: model, workspaceRoot: this.workingDirectory }, 0);
      this.sessionId = sessionId;
      await this.onSaveSessionId(sessionId);
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 0): Promise<unknown> {
    if (!this.client) return Promise.reject(new Error('Muse MSP is not running.'));
    return this.client.request(method, params, { timeoutMs });
  }

  private async refreshPendingApprovals(): Promise<void> {
    if (!this.sessionId) return;
    const previous = new Map(this.pendingApprovals);
    const result = await this.request('approval/listPending', { sessionId: this.sessionId }).catch(() => null);
    if (!isRecord(result) || !Array.isArray(result.approvals)) return;
    for (const [approvalId, pending] of previous) {
      if (this.pendingApprovals.get(approvalId) === pending
        && !result.approvals.some((approval) => isRecord(approval) && approval.approvalId === approvalId)) {
        this.resolveApproval(approvalId, 'resolved');
      }
    }
    for (const approval of result.approvals) {
      this.handleNotification({ method: 'approval/requested', params: approval });
    }
  }

  private resolveApproval(approvalId: string, selectionId: string, terminal = true): void {
    const pending = this.pendingApprovals.get(approvalId);
    if (terminal) this.resolvedApprovals.add(approvalId);
    if (!pending) return;
    this.pendingApprovals.delete(approvalId);
    const choice = pending.availableChoices.find((choice) => choice.choiceId === selectionId);
    this.recordHistoryEvent('okidoki-tool-input-resolved', {
      requestId: pending.requestId,
      toolUseId: pending.itemId,
      toolName: pending.toolName,
      selectionId: choice ? JSON.stringify({ approval: { options: [choice.choiceId] } }) : selectionId,
      selectionSummary: choice?.label,
      parent_tool_use_id: null,
    });
  }

  private handleApproval(params: Record<string, unknown>): void {
    if (!this.sessionId || params.sessionId !== this.sessionId || typeof params.approvalId !== 'string'
      || this.resolvedApprovals.has(params.approvalId)) return;
    const previous = this.pendingApprovals.get(params.approvalId);
    const value = { ...previous, ...params };
    const requirement = value.currentRequirementId;
    if (!isRecord(requirement) || requirement.approvalId !== params.approvalId
      || typeof requirement.sourceIndex !== 'number' || !Number.isSafeInteger(requirement.sourceIndex) || requirement.sourceIndex < 0
      || typeof value.itemId !== 'string' || typeof value.toolName !== 'string' || typeof value.rawArgs !== 'string'
      || !isRecord(value.subject) || !Array.isArray(value.availableChoices)) return;
    const choices = value.availableChoices.filter((choice): choice is PendingApproval['availableChoices'][number] => (
      isRecord(choice) && typeof choice.choiceId === 'string' && typeof choice.label === 'string'
      && typeof choice.decision === 'string' && (choice.rulePreview === undefined || typeof choice.rulePreview === 'string')
    ));
    if (choices.length === 0 || choices.length !== value.availableChoices.length) return;
    if (previous && (requirement.sourceIndex < previous.currentRequirementId.sourceIndex
      || (typeof params.viewCursor === 'string' && params.viewCursor === previous.viewCursor))) return;
    const requestId = previous?.currentRequirementId.sourceIndex === requirement.sourceIndex
      ? previous.requestId : `muse-approval:${params.approvalId}:${requirement.sourceIndex}:${uuidV7()}`;
    const pending: PendingApproval = {
      approvalId: params.approvalId,
      sessionId: this.sessionId,
      itemId: value.itemId,
      toolName: value.toolName,
      rawArgs: value.rawArgs,
      currentRequirementId: { approvalId: params.approvalId, sourceIndex: requirement.sourceIndex },
      availableChoices: choices,
      subject: value.subject,
      requestId,
      ...(typeof params.viewCursor === 'string' ? { viewCursor: params.viewCursor } : {}),
      ...(previous?.requestId === requestId ? { selectionId: previous.selectionId } : {}),
    };
    if (previous && previous.requestId !== requestId) {
      this.resolveApproval(pending.approvalId, previous.selectionId ?? 'resolved', false);
    }
    this.pendingApprovals.set(pending.approvalId, pending);
    const stages = Array.isArray(pending.subject.stages) ? pending.subject.stages : [];
    const stage = stages.find((stage) => isRecord(stage) && isRecord(stage.requirementId)
      && stage.requirementId.sourceIndex === requirement.sourceIndex);
    const stageLabel = isRecord(stage) ? ` (stage ${stage.position} of ${stage.totalStages})` : '';
    this.recordHistoryEvent('okidoki-tool-input-request', {
      requestId,
      toolUseId: pending.itemId,
      toolName: pending.toolName,
      questions: [{
        id: 'approval',
        prompt: `Allow ${pending.toolName}${stageLabel}?\n\n${typeof pending.subject.command === 'string'
          ? pending.subject.command : JSON.stringify(pending.subject, null, 2)}`,
        multiSelect: false,
        allowCustom: false,
        options: choices.map((choice) => ({ id: choice.choiceId, label: choice.label, ...(choice.rulePreview ? { preview: choice.rulePreview } : {}) })),
      }],
      parent_tool_use_id: null,
    });
    this.recordHistoryEvent('muse-item-started', {
      item: { itemId: pending.itemId, kind: 'toolCall', tool: pending.toolName, args: pending.rawArgs, status: 'inProgress' },
    });
  }

  private handleProcessExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    const hadPendingRequest = (this.client?.pendingRequestCount ?? 0) > 0;
    this.process = null;
    this.client?.dispose(error);
    this.client = null;
    for (const approvalId of this.pendingApprovals.keys()) this.resolveApproval(approvalId, 'aborted');
    this.resolvedApprovals.clear();
    if ((this.turnComplete || this.compactionComplete) && !hadPendingRequest) {
      this.recordHistoryEvent('muse-error', { message: error.message });
    }
    this.turnComplete?.resolve();
    this.turnComplete = null;
    this.compactionComplete?.resolve();
    this.compactionComplete = null;
  }

  private stopProcess(signal: NodeJS.Signals = 'SIGTERM'): void {
    const process = this.process;
    this.process = null;
    this.client?.dispose();
    this.client = null;
    for (const approvalId of this.pendingApprovals.keys()) this.resolveApproval(approvalId, 'aborted');
    this.resolvedApprovals.clear();
    this.turnComplete?.resolve();
    this.turnComplete = null;
    this.compactionComplete?.resolve();
    this.compactionComplete = null;
    process?.kill(signal);
  }

  private createTurnInput(text: string, images: SendChatMessageRequest['images']): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [{ type: 'text', text }];
    for (const image of images ?? []) {
      if (image.source.type !== 'base64') throw new Error('Muse requires images to be base64 encoded.');
      if (image.label) input.push({ type: 'text', text: image.label });
      input.push({ type: 'image', mediaType: image.source.media_type, base64Data: image.source.data });
    }
    return input;
  }

  private handleNotification(frame: unknown): void {
    if (!isRecord(frame) || typeof frame.method !== 'string' || !isRecord(frame.params)) return;
    if (typeof frame.params.sessionId === 'string' && this.sessionId && frame.params.sessionId !== this.sessionId) return;
    this.recordHistoryEvent(`muse-${frame.method.replaceAll('/', '-')}`, frame.params);
    if (frame.method === 'approval/requested' || frame.method === 'approval/updated') {
      this.handleApproval(frame.params);
    } else if (frame.method === 'approval/resolved' && typeof frame.params.approvalId === 'string') {
      const pending = this.pendingApprovals.get(frame.params.approvalId);
      const decision = typeof frame.params.decision === 'string' ? frame.params.decision : 'resolved';
      const choice = pending?.availableChoices.find((choice) => choice.decision === decision
        && choice.choiceId === pending.selectionId)
        ?? pending?.availableChoices.find((choice) => choice.decision === decision);
      this.resolveApproval(frame.params.approvalId, choice?.choiceId ?? decision);
    } else if (frame.method === 'turn/completed') {
      for (const approvalId of this.pendingApprovals.keys()) this.resolveApproval(approvalId, 'aborted');
      this.turnError = isRecord(frame.params.error) && typeof frame.params.error.message === 'string'
        ? frame.params.error.message
        : null;
      this.activeTurnId = null;
      this.turnComplete?.resolve();
      this.turnComplete = null;
    } else if (frame.method === 'item/completed'
      && isRecord(frame.params.item)
      && frame.params.item.kind === 'compaction') {
      this.compactionComplete?.resolve();
      this.compactionComplete = null;
    } else if (frame.method === 'session/tokenUsage') {
      this.onUsageUpdate(frame.params, new Date().toISOString());
    } else if (frame.method === 'session/contextUsage') {
      const used = typeof frame.params.usedTokens === 'number' ? frame.params.usedTokens : 0;
      const size = typeof frame.params.windowTokens === 'number' ? frame.params.windowTokens : 0;
      this.recordContextUsage(providerContextUsage({ provider: 'muse', model: DEFAULT_MUSE_MODEL, totalTokens: used, maxTokens: size }));
    } else if (frame.method === 'userInput/requested' && typeof frame.params.userInputId === 'string') {
      const questions = Array.isArray(frame.params.questions) ? frame.params.questions.filter(isPendingQuestion) : [];
      this.pendingInput = {
        userInputId: frame.params.userInputId,
        toolCallId: typeof frame.params.toolCallId === 'string' ? frame.params.toolCallId : frame.params.userInputId,
        questions,
      };
      this.recordHistoryEvent('okidoki-tool-input-request', {
        requestId: frame.params.userInputId,
        toolUseId: this.pendingInput.toolCallId,
        toolName: typeof frame.params.toolName === 'string' ? frame.params.toolName : 'request_user_input',
        questions: questions.map((question) => ({
          id: question.id,
          prompt: question.question ?? question.id,
          multiSelect: question.selection?.mode === 'multiple',
          options: (question.options ?? []).flatMap((option) => typeof option.label === 'string' ? [{
            id: option.label,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            ...(option.preview?.content ? { preview: option.preview.content } : {}),
          }] : []),
        })),
        parent_tool_use_id: null,
      });
    }
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    let userMessageRecorded = false;
    // Muse runs one process per chat, and the next turn resumes the session on a new one.
    let stopTimer: NodeJS.Timeout | undefined;
    const endIfStopUnanswered = (): void => {
      stopTimer = setTimeout(() => {
        // A message Muse never got was handed back or runs again, so the chat has no turn to explain.
        if (userMessageRecorded) {
          this.recordHistoryEvent('muse-error', {
            message: `Muse did not stop this turn within ${MUSE_INTERRUPT_TIMEOUT_MS / 1000} seconds of Stop, so its process was ended. Send a message to continue.`,
          });
        }
        this.stopProcess('SIGKILL');
      }, MUSE_INTERRUPT_TIMEOUT_MS);
    };
    if (signal.aborted) endIfStopUnanswered();
    else signal.addEventListener('abort', endIfStopUnanswered, { once: true });

    const dispatch = async (): Promise<void> => {
      const model = request.model ?? DEFAULT_MUSE_MODEL;
      await this.start(model);
      if (!this.sessionId) throw new Error('Muse MSP failed to initialize.');
      const compact = /^\/compact$/i.test(request.message.trim());
      const recordUserMessage = (): void => {
        if (userMessageRecorded) return;
        userMessageRecorded = true;
        this.recordUserMessageHistoryEvent(request, compact ? { command: 'compact' } : {}, this.turnBeganAt);
      };

      if (compact) {
        if (!this.deliver(signal)) return;
        recordUserMessage();
        const completed = new Promise<void>((resolve) => { this.compactionComplete = { resolve }; });
        const result = await this.request('session/compact', {
          commandId: uuidV7(),
          sessionId: this.sessionId,
        });
        if (isRecord(result) && result.status === 'accepted') {
          await completed;
        } else {
          this.compactionComplete = null;
        }
        return;
      }

      await this.request('session/setApprovalMode', {
        commandId: uuidV7(),
        sessionId: this.sessionId,
        mode: 'allowAll',
      });
      await this.request('session/setModel', {
        commandId: uuidV7(),
        sessionId: this.sessionId,
        model: { providerId: 'meta', modelId: model },
      });
      const instructions = this.buildCombinedInstructions(request.customInstructions);
      const pending = instructions && instructions !== this.deliveredInstructions ? instructions : null;
      const text = `${pending ? `<workspace-instructions>\n${pending}\n</workspace-instructions>\n\n` : ''}${request.message}`;
      if (!this.deliver(signal)) return;
      recordUserMessage();
      this.turnError = null;
      const completed = new Promise<void>((resolve) => { this.turnComplete = { resolve }; });
      const result = await this.request('turn/start', {
        ...museTurnStartParams(this.sessionId, this.createTurnInput(text, request.images), request.thinkingLevel),
        displayText: request.message,
      });
      if (!isRecord(result) || typeof result.turnId !== 'string') throw new Error('Muse did not start a turn.');
      this.activeTurnId = result.turnId;
      if (pending) this.deliveredInstructions = pending;
      await completed;
      if (this.turnError && detectAgentQuotaLimit(this.turnError)) throw new MuseQuotaError(this.turnError);
    };

    try {
      await dispatch();
    } catch (error) {
      if (error instanceof MuseQuotaError) {
        const quotaKind = detectAgentQuotaLimit(error.message);
        const fallback = await this.fallBackCredential(quotaKind ?? 'rate_limit', error.message);
        if (fallback.outcome === 'switched') {
          this.stopProcess();
          try {
            await dispatch();
          } catch (retryError) {
            if (retryError instanceof MuseQuotaError) return;
            this.recordHistoryEvent('muse-error', {
              message: retryError instanceof Error ? retryError.message : String(retryError),
            });
            throw retryError;
          }
        } else if (fallback.outcome === 'fork') {
          this.emitQuotaExhausted({ provider: 'muse', reason: quotaKind ?? 'rate_limit', detail: error.message, forkTo: fallback.target });
        }
        return;
      }
      if (signal.aborted) return;
      this.recordHistoryEvent('muse-error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      clearTimeout(stopTimer);
      signal.removeEventListener('abort', endIfStopUnanswered);
      this.turnComplete?.resolve();
      this.turnComplete = null;
      this.activeTurnId = null;
      this.turnError = null;
      this.pendingInput = null;
      for (const approvalId of this.pendingApprovals.keys()) this.resolveApproval(approvalId, 'aborted');
      this.compactionComplete?.resolve();
      this.compactionComplete = null;
      try {
        await this.historyFile.flush();
      } finally {
        await this.onTurnComplete();
      }
    }
  }

  protected async interruptActiveTurn(): Promise<void> {
    if (!this.sessionId || !this.activeTurnId) return;
    await this.request('turn/interrupt', {
      commandId: uuidV7(),
      sessionId: this.sessionId,
      turnId: this.activeTurnId,
    }, MUSE_INTERRUPT_TIMEOUT_MS).catch((error) => {
      console.error('[MuseManager] Failed to interrupt the turn:', error);
    });
  }

  async respondToToolInput(requestId: string, selectionId: string): Promise<boolean> {
    const approval = [...this.pendingApprovals.values()].find((pending) => pending.requestId === requestId);
    if (approval) {
      if (!this.sessionId || approval.selectionId) return false;
      let selections: unknown;
      try { selections = JSON.parse(selectionId); } catch {}
      const answer = isRecord(selections) && isRecord(selections.approval) ? selections.approval : null;
      const choiceId = selectionId === 'declined'
        ? approval.availableChoices.find((choice) => choice.decision === 'abort' || choice.decision === 'denied')?.choiceId
        : answer && !answer.custom && Array.isArray(answer.options) && answer.options.length === 1 ? answer.options[0] : selectionId;
      const choice = approval.availableChoices.find((candidate) => candidate.choiceId === choiceId);
      if (!choice) return false;
      approval.selectionId = choice.choiceId;
      try {
        await this.request('approval/decide', {
          commandId: uuidV7(),
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
          requirementId: approval.currentRequirementId,
          choiceId: choice.choiceId,
        });
      } catch (error) {
        approval.selectionId = undefined;
        const current = this.pendingApprovals.get(approval.approvalId);
        if (current?.requestId === requestId) current.selectionId = undefined;
        await this.refreshPendingApprovals();
        throw error;
      }
      return true;
    }
    if (!this.pendingInput || this.pendingInput.userInputId !== requestId || !this.sessionId) return false;
    const pending = this.pendingInput;
    if (selectionId === 'declined') {
      await this.request('userInput/cancel', {
        commandId: uuidV7(),
        sessionId: this.sessionId,
        userInputId: pending.userInputId,
      });
    } else {
      const selections: unknown = JSON.parse(selectionId);
      const answers = pending.questions.map((question) => {
        const { custom, options } = toolInputAnswer(selections, question.id);
        if (custom) return { questionId: question.id, freeText: custom };
        const labels = options.flatMap((id) => question.options?.some((option) => option.label === id) ? [id] : []);
        return question.selection?.mode === 'multiple'
          ? { questionId: question.id, selectedLabels: labels }
          : { questionId: question.id, selectedLabel: labels[0] };
      });
      await this.request('userInput/answer', {
        commandId: uuidV7(),
        sessionId: this.sessionId,
        userInputId: pending.userInputId,
        answers,
      });
    }
    this.pendingInput = null;
    this.recordHistoryEvent('okidoki-tool-input-resolved', {
      requestId,
      toolUseId: pending.toolCallId,
      toolName: 'request_user_input',
      selectionId: selectionId === 'declined' ? 'aborted' : selectionId,
      parent_tool_use_id: null,
    });
    return true;
  }

  isAwaitingInput(): boolean { return this.pendingInput !== null || this.pendingApprovals.size > 0; }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.historyFile.flush();
    return { thread_id: this.sessionId, ...await this.historyFile.loadEventsPage(page), goal: null };
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    if (this.slashCommands) return this.slashCommands;
    try {
      const { stdout } = await execFileAsync('muse', [
        'skills',
        'list',
        '--enabled-only',
        '--workspace',
        this.workingDirectory,
        '--trust-workspace',
        '--json',
      ], { maxBuffer: SUBPROCESS_MAX_BUFFER });
      const parsed: unknown = JSON.parse(stdout);
      this.slashCommands = isRecord(parsed) && Array.isArray(parsed.skills)
        ? parsed.skills.flatMap((skill) => {
          if (!isRecord(skill) || typeof skill.name !== 'string') return [];
          const command = createProviderSlashCommand(
            'muse',
            skill.name,
            typeof skill.description === 'string' ? skill.description : undefined,
          );
          return command ? [command] : [];
        })
        : [];
    } catch (error) {
      console.warn('[MuseManager] Failed to load slash commands:', error);
      this.slashCommands = [];
    }
    return this.slashCommands;
  }

  dispose(): void {
    this.stopProcess();
  }
}
