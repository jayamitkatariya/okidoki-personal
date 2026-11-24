import { join } from 'path';
import {
  createAgentSession,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent as PiImageContent } from '@earendil-works/pi-ai';
import {
  CREDENTIAL_METHOD,
  readOllamaAuthEnv,
  readOpenAICompatibleAuthEnv,
  listOllamaModels,
  listOpenAICompatibleModels,
  getDefaultOllamaModel,
  ASTER_BASE_URL,
  ASTER_MODELS,
  ASTER_MODEL_LABELS,
  ASTER_PROVIDER,
  DEFAULT_ASTER_MODEL,
  DEFAULT_PI_MODEL,
  createProviderSlashCommand,
  detectAgentQuotaLimit,
  isAuthenticationErrorText,
  mergeSlashCommands,
  shouldRefreshPullRequests,
  type AgentCredentialSnapshot,
  type AgentEvent,
  type AgentQuotaLimitKind,
  type ChatHistoryPageParams,
  type ChatHistoryResponse,
  type SendChatMessageRequest,
  type SendChatMessageResponse,
  type SlashCommand,
  type ThinkingLevel,
  providerContextUsage,
} from '@okidoki/shared';
import {
  DEFAULT_OPENCODE_GO_MODEL,
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_PROVIDER,
  fetchOpenCodeGoCatalog,
  type OpenCodeGoModelDefinition,
} from '@okidoki/shared/opencode-go';
import { canSteerMessage } from '@okidoki/shared/workspace-chat';
import { CodingAgentManager, type CodingAgentManagerOptions } from './coding-agent-manager';
import { SWITCHED_CREDENTIAL_PROMPT, describeLoginFailure, describeQuotaExhaustion } from './auth-fallback';
import { ENGINE_ENV } from '../engine-env';
import { convertPiEvent } from '../utils/linear-converter';
import { LinearEventForwarder } from '../utils/linear-event-forwarder';
import type { MessageAcceptedHandler, QueuedMessage } from '../services/message-queue-service';
import { PI_HISTORY_DIR } from '../services/chat/history-paths';
import { isRecord } from '../utils/type-guards';
import { normalizeImages } from '../utils/image-utils';
import { evaluateCommandProtection, extractToolCommand, reportCommandProtectionBlock } from '../services/command-protection-service';
import { getAllowedOpenRouterModels } from '../services/openrouter-models-service';
import { PI_AUTH_PATH } from './agent-auth-paths';
import { getManagedPiMcpServers } from './managed-mcp-servers';
import { getPiProviderCredentials } from './pi-auth';
import { pullRequestCheckService } from '../services/pull-request-check-service';
import { createMcpAdapter } from 'pi-mcp-adapter';
import { SUBAGENT_MCP_SERVER_NAME } from '@okidoki/shared';
import { SUBAGENT_MCP_TOOL_TIMEOUT_MS, subagentMcpProcessConfig } from './subagent-mcp-config';

function registerOpenRouterModels(
  modelRegistry: ModelRegistry,
  apiKey: string,
  modelIds: readonly string[],
): void {
  const openRouterModels = modelRegistry.getAll().filter((model) => model.provider === 'openrouter');
  const modelTemplate = openRouterModels[0];
  if (!modelTemplate) throw new Error('Pi OpenAI-compatible model template is unavailable.');
  modelRegistry.registerProvider('openrouter', {
    api: modelTemplate.api,
    apiKey,
    baseUrl: modelTemplate.baseUrl,
    models: [
      ...openRouterModels,
      ...modelIds
        .filter((id) => !openRouterModels.some((model) => model.id === id))
        .map((id) => ({
          id,
          name: id,
          api: modelTemplate.api,
          baseUrl: modelTemplate.baseUrl,
          reasoning: modelTemplate.reasoning,
          input: modelTemplate.input,
          cost: modelTemplate.cost,
          contextWindow: modelTemplate.contextWindow,
          maxTokens: modelTemplate.maxTokens,
        })),
    ],
  });
}

export function registerPiProvider(
  modelRegistry: ModelRegistry,
  {
    providerId,
    name,
    apiKey,
    baseUrl,
    headers,
    models,
  }: {
    providerId: string;
    name: string;
    apiKey: string;
    baseUrl: string;
    headers?: Record<string, string>;
    models: readonly { id: string; name: string; contextWindow?: number; reasoning?: boolean; maxTokens?: number; input?: ('text' | 'image')[]; api?: OpenCodeGoModelDefinition['api'] }[];
  },
): void {
  modelRegistry.registerProvider(providerId, {
    name,
    api: 'openai-completions',
    apiKey,
    baseUrl,
    authHeader: !headers?.Authorization,
    ...(headers ? { headers } : {}),
    models: models.map((model) => {
      const builtin = modelRegistry.find(providerId, model.id);
      const api = model.api ?? builtin?.api ?? 'openai-completions';
      return {
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        maxTokens: 65_536,
        ...builtin,
        ...model,
        api,
        baseUrl: api === 'anthropic-messages' ? baseUrl.replace(/\/v1\/?$/, '') : baseUrl,
        compat: builtin?.api === api ? builtin.compat : undefined,
      };
    }),
  });
}

type PiAssistantMessage = Extract<Extract<AgentSessionEvent, { type: 'message_end' }>['message'], { role: 'assistant' }>;

function compactPiAssistantMessage(
  message: PiAssistantMessage,
  id: string | null,
): Record<string, unknown> {
  const content: Array<{ type: 'text'; text: string } | { type: 'thinking'; thinking: string }> = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
      else if (block.type === 'thinking' && block.thinking) content.push({ type: 'thinking', thinking: block.thinking });
    }
  }
  return {
    ...(id ? { id } : {}),
    role: message.role,
    content,
    ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    ...(typeof message.stopReason === 'string' ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === 'string' ? { errorMessage: message.errorMessage } : {}),
  };
}

function explicitSkillName(session: AgentSession, message: string): string | null {
  const match = message.match(/^\/skill:([^\s]+)(?:\s|$)/);
  if (!match) return null;
  return session.resourceLoader.getSkills().skills.some((skill) => skill.name === match[1]) ? match[1] : null;
}

type PiThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0];

function piThinkingLevel(thinkingLevel: ThinkingLevel): PiThinkingLevel {
  return thinkingLevel === 'max' || thinkingLevel === 'ultra' || thinkingLevel === 'ultracode'
    ? 'xhigh'
    : thinkingLevel;
}

function registerCommandProtection(
  cwd: string,
  recordHistoryEvent: Parameters<typeof reportCommandProtectionBlock>[0]['recordHistoryEvent'],
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const command = extractToolCommand(event.input);
      const result = await evaluateCommandProtection({
        provider: 'pi',
        source: 'pi_tool_call',
        toolName: event.toolName,
        toolInput: event.input,
        command,
        cwd,
        toolUseId: event.toolCallId,
      });
      if (!result.allowed) {
        reportCommandProtectionBlock({
          managerName: 'PiManager',
          action: 'tool call',
          eventType: 'pi-command-protection.blocked',
          result,
          command,
          context: { toolName: event.toolName, toolUseId: event.toolCallId },
          recordHistoryEvent,
        });
        return { block: true, reason: result.reason ?? 'Command blocked by Okidoki protection.' };
      }
      return undefined;
    });
    pi.on('tool_result', (event) => {
      if (!event.isError && shouldRefreshPullRequests(event.toolName, event.input)) {
        pullRequestCheckService.check().catch(() => {});
      }
    });
  };
}

export class PiManager extends CodingAgentManager {
  private session: AgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private activeSessionFile: string | null = null;
  private sessionSubagentMcpParentChatId: string | undefined;
  private sessionInstructions: string | undefined;
  private sessionCredential: AgentCredentialSnapshot | undefined;
  private providerId = 'openrouter';
  private providerApiKey: string | null = null;
  private modelRuntime: ModelRuntime | null = null;
  private linearForwarder: LinearEventForwarder | null = null;
  // Held until the turn ends: a call Pi retried or Okidoki moved to another credential is not the turn's failure.
  private failedCall: PiAssistantMessage | null = null;
  private failedCallId: string | null = null;
  private activeAssistantMessageId: string | null = null;
  private assistantMessageSeq = 0;
  private assistantDeltaSeq = 0;
  private steers: QueuedMessage[] = [];

  constructor(options: CodingAgentManagerOptions) {
    super(options);
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected async interruptActiveTurn(): Promise<void> {
    // An aborted run still hands queued steers to its next model call, so a Stop takes them back first.
    this.session?.clearQueue();
    await this.session?.abort();
  }

  protected override async steerRequest(request: QueuedMessage): Promise<boolean> {
    if (!this.session?.isStreaming || !canSteerMessage('pi', request)) return false;
    const images = await this.toPiImages(request);
    if (!this.session?.isStreaming || this.isSteerWithdrawn(request)) return false;
    this.steers.push(request);
    await this.session.steer(request.message, images);
    return true;
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.historyFile.flush();
    const history = await this.historyFile.loadEventsPage(page);
    return { thread_id: this.activeSessionFile ?? this.initialSessionId, ...history, goal: null };
  }

  async listSlashCommands(): Promise<SlashCommand[]> {
    await this.initialized;
    return mergeSlashCommands((this.session?.promptTemplates ?? [])
      .map((template) => createProviderSlashCommand('pi', template.name, template.description))
      .filter((command): command is SlashCommand => Boolean(command)));
  }

  async enqueueMessage(
    request: SendChatMessageRequest,
    onAccepted?: MessageAcceptedHandler,
  ): Promise<SendChatMessageResponse> {
    await this.initialized;
    if (!this.session && !(await getPiProviderCredentials()).ok) {
      throw new Error('OpenCode Go, Aster, OpenRouter, or OpenAI-compatible authentication is missing for Pi. Add one in Settings → Coding agents.');
    }
    return this.messageQueue.enqueue(request, onAccepted);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const session = this.session;
    this.session = null;
    this.modelRuntime = null;
    this.providerApiKey = null;
    if (session) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => {});
      session.dispose();
    }
  }

  private async ensureSession(request: SendChatMessageRequest): Promise<AgentSession> {
    // MCP servers and the system prompt are fixed at session creation, so reopen the session file to apply a change.
    const subagentMcpParentChatId = this.subagentMcpParentChatId();
    const instructions = this.buildCombinedInstructions(request.customInstructions) ?? '';
    let retainedModel: string | undefined;
    if (this.session && (this.sessionSubagentMcpParentChatId !== subagentMcpParentChatId || this.sessionInstructions !== instructions
      || this.sessionCredential !== ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.pi)) {
      retainedModel = this.session.model?.id;
      await this.dispose();
    }
    if (this.session) {
      // Re-checked every turn against the model the turn will actually run on: the registry keeps
      // Pi's built-in OpenRouter catalog plus everything registered earlier in the session, so
      // membership in it is not evidence the org still allows the model.
      const turnModel = request.model ?? this.session.model?.id;
      if (this.providerId === 'openrouter' && turnModel && !(await getAllowedOpenRouterModels()).includes(turnModel)) {
        throw new Error(`Pi model is not available through ${this.providerId}: ${turnModel}`);
      }
      if (request.model && request.model !== this.session.model?.id) {
        const modelRegistry = new ModelRegistry(this.session.modelRuntime);
        let model = modelRegistry.find(this.providerId, request.model);
        if (!model && this.providerId === 'openrouter' && this.providerApiKey) {
          registerOpenRouterModels(modelRegistry, this.providerApiKey, [request.model]);
          model = modelRegistry.find(this.providerId, request.model);
        }
        if (!model) throw new Error(`Pi model is not available through ${this.providerId}: ${request.model}`);
        await this.session.setModel(model);
      }
      if (request.thinkingLevel) {
        this.session.setThinkingLevel(piThinkingLevel(request.thinkingLevel));
      }
      return this.session;
    }
    const modelRuntime = await this.getModelRuntime();
    const credential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.pi;
    const credentialResult = await getPiProviderCredentials();
    if (!credentialResult.ok) throw new Error('OpenCode Go, Aster, OpenRouter, or OpenAI-compatible credentials are not configured for Pi.');
    const credentials = credentialResult.data;
    this.providerId = credentials.provider;
    this.providerApiKey = credentials.apiKey;

    const modelRegistry = new ModelRegistry(modelRuntime);
    let defaultModel = DEFAULT_ASTER_MODEL;
    const ollama = this.providerId === 'ollama' ? readOllamaAuthEnv('pi', process.env) : null;
    if (ollama) {
      const models = await listOllamaModels(ollama);
      defaultModel = request.model || getDefaultOllamaModel(models) || '';
      const selected = models.find((model) => model.id === defaultModel);
      if (!selected?.contextWindow || !selected.capabilities?.includes('tools')) {
        throw new Error('Select an Ollama coding model with context length and tool support in its model details.');
      }
      registerPiProvider(modelRegistry, {
        providerId: 'ollama', name: 'Ollama', apiKey: ollama.apiKey, baseUrl: `${ollama.baseUrl}/v1`,
        models: models.filter((model) => model.contextWindow && model.capabilities?.includes('tools')).map((model) => ({
          id: model.id, name: model.displayName, contextWindow: model.contextWindow,
          reasoning: model.capabilities?.includes('thinking'), maxTokens: 16_384,
          input: model.capabilities?.includes('vision') ? ['text', 'image'] : ['text'],
        })),
      });
    } else if (this.providerId === CREDENTIAL_METHOD.OPENAI_COMPATIBLE) {
      const compatible = readOpenAICompatibleAuthEnv('pi', process.env);
      if (!compatible) throw new Error('OpenAI-compatible endpoint is not configured for Pi.');
      const models = await listOpenAICompatibleModels(compatible);
      defaultModel = models[0].id;
      registerPiProvider(modelRegistry, {
        providerId: CREDENTIAL_METHOD.OPENAI_COMPATIBLE,
        name: 'OpenAI-compatible endpoint',
        apiKey: compatible.apiKey ?? '',
        baseUrl: compatible.baseUrl,
        ...(compatible.authorizationHeader ? { headers: { Authorization: compatible.authorizationHeader } } : {}),
        // The catalog says nothing about reasoning or output limits, so ask for neither beyond what any chat model accepts.
        models: models.map((model) => ({
          id: model.id, name: model.displayName, api: 'openai-responses', reasoning: false, maxTokens: 16_384,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        })),
      });
    } else if (this.providerId === OPENCODE_GO_PROVIDER) {
      const catalog = await fetchOpenCodeGoCatalog('pi', [request.model ?? DEFAULT_OPENCODE_GO_MODEL]);
      const models = Object.entries(catalog.models);
      defaultModel = catalog.models[DEFAULT_OPENCODE_GO_MODEL]
        ? DEFAULT_OPENCODE_GO_MODEL
        : models[0]?.[0] ?? DEFAULT_OPENCODE_GO_MODEL;
      registerPiProvider(modelRegistry, {
        providerId: OPENCODE_GO_PROVIDER,
        name: 'OpenCode Go',
        apiKey: credentials.apiKey,
        baseUrl: OPENCODE_GO_BASE_URL,
        models: models.map(([id, model]) => ({ id, name: model.name, api: model.api })),
      });
    } else if (this.providerId === ASTER_PROVIDER) {
      registerPiProvider(modelRegistry, {
        providerId: ASTER_PROVIDER,
        name: 'Aster',
        apiKey: credentials.apiKey,
        baseUrl: ASTER_BASE_URL,
        models: ASTER_MODELS.map((id) => ({
          id,
          name: ASTER_MODEL_LABELS[id] ?? id,
          contextWindow: id === 'kimi-k3' ? 1_000_000 : 131_072,
        })),
      });
    }
    let allowedModels: readonly string[] | null = null;
    if (this.providerId === 'openrouter') {
      allowedModels = await getAllowedOpenRouterModels();
      registerOpenRouterModels(modelRegistry, credentials.apiKey, allowedModels);
      defaultModel = allowedModels[0] ?? DEFAULT_PI_MODEL;
    }
    const modelId = request.model ?? retainedModel ?? defaultModel;
    const model = allowedModels && !allowedModels.includes(modelId)
      ? null
      : modelRegistry.find(this.providerId, modelId);
    if (!model) throw new Error(`Pi model is not available through ${this.providerId}: ${modelId}`);

    const sessionFile = this.activeSessionFile ?? this.initialSessionId;
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile, PI_HISTORY_DIR, this.workingDirectory)
      : SessionManager.create(this.workingDirectory, PI_HISTORY_DIR);
    const mcpServers = await getManagedPiMcpServers();
    if (subagentMcpParentChatId) {
      mcpServers[SUBAGENT_MCP_SERVER_NAME] = {
        ...subagentMcpProcessConfig(subagentMcpParentChatId),
        lifecycle: 'lazy',
        idleTimeout: 1,
        requestTimeoutMs: SUBAGENT_MCP_TOOL_TIMEOUT_MS,
        directTools: true,
        approveTools: false,
      };
    }
    const extensionFactories = [registerCommandProtection(this.workingDirectory, this.recordHistoryEvent.bind(this))];
    if (Object.keys(mcpServers).length > 0) {
      extensionFactories.push(createMcpAdapter({
        config: {
          mcpServers,
          ...(subagentMcpParentChatId ? { settings: { scriptMode: false } } : {}),
        },
      }));
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workingDirectory,
      agentDir: join(ENGINE_ENV.HOME_DIR, '.pi', 'agent'),
      extensionFactories,
      appendSystemPrompt: [instructions],
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd: this.workingDirectory,
      modelRuntime,
      model,
      sessionManager,
      resourceLoader,
    });
    this.session = result.session;
    this.sessionSubagentMcpParentChatId = subagentMcpParentChatId;
    this.sessionInstructions = instructions;
    this.sessionCredential = credential;
    if (request.thinkingLevel) {
      this.session.setThinkingLevel(piThinkingLevel(request.thinkingLevel));
    }
    this.activeSessionFile = sessionManager.getSessionFile() ?? null;
    await this.onSaveSessionId(this.activeSessionFile);
    this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
    // Extensions only start (MCP servers included) on the session_start event, which Pi emits from bindExtensions.
    await this.session.bindExtensions({});
    return this.session;
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntime ??= await ModelRuntime.create({ authPath: PI_AUTH_PATH, refreshOnCreate: false });
    return this.modelRuntime;
  }

  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === 'agent_start') void this.deliverEarlySteers();
    if (event.type === 'message_start' && event.message.role === 'user' && Array.isArray(event.message.content)) {
      const [first] = event.message.content;
      const index = first?.type === 'text' ? this.steers.findIndex(({ message }) => message === first.text) : -1;
      if (index !== -1) {
        const steer = this.markSteerRead(this.steers.splice(index, 1)[0].id);
        if (steer) this.recordUserMessageHistoryEvent(steer);
      }
    }
    if (event.type === 'message_end') this.onUsageUpdate(event, new Date().toISOString());
    const usage = event.type === 'message_end' && event.message.role === 'assistant' ? this.session?.getContextUsage() : undefined;
    if (usage?.tokens != null) {
      this.recordContextUsage(providerContextUsage({
        provider: 'pi',
        model: this.session?.model?.id ?? null,
        totalTokens: usage.tokens,
        maxTokens: usage.contextWindow,
        compactsAutomatically: this.session?.autoCompactionEnabled,
      }));
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      if (event.message.stopReason === 'error') {
        this.failedCall = event.message;
        this.failedCallId = this.activeAssistantMessageId;
        this.activeAssistantMessageId = null;
        return;
      }
      this.failedCall = null;
      this.failedCallId = null;
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      const existingId = isRecord(event.message) && typeof event.message.id === 'string' && event.message.id ? event.message.id : null;
      const id = existingId ?? `assistant-${Date.now()}-${++this.assistantMessageSeq}`;
      this.activeAssistantMessageId = id;
      this.emitSyntheticEvent('pi-message_start', { message: { id, role: 'assistant' } });
    } else if (event.type === 'message_update') {
      const { assistantMessageEvent } = event;
      if (assistantMessageEvent.type === 'text_delta' || assistantMessageEvent.type === 'thinking_delta') {
        this.emitSyntheticEvent('pi-message_update', {
          assistantMessageEvent: {
            type: assistantMessageEvent.type,
            delta: assistantMessageEvent.delta,
            sequence: ++this.assistantDeltaSeq,
            ...(this.activeAssistantMessageId ? { id: this.activeAssistantMessageId } : {}),
          },
        });
      }
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      const id = this.activeAssistantMessageId;
      this.activeAssistantMessageId = null;
      const message = compactPiAssistantMessage(event.message, id);
      if (Array.isArray(message.content) && message.content.length > 0) {
        this.recordHistoryEvent('pi-message_end', { message });
      }
    } else if (event.type === 'tool_execution_start') {
      this.recordHistoryEvent('pi-tool_execution_start', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    } else if (event.type === 'tool_execution_end') {
      this.recordHistoryEvent('pi-tool_execution_end', {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
    }
    const linearSessionId = this.linearSessionId;
    if (linearSessionId) this.linearForwarder?.sendEvent(convertPiEvent(event, linearSessionId));
  }

  private recordUserMessage(session: AgentSession, request: SendChatMessageRequest): void {
    const skillName = explicitSkillName(session, request.message);
    this.recordUserMessageHistoryEvent(request, skillName ? { skillName } : {}, this.turnBeganAt);
  }

  private async toPiImages(request: SendChatMessageRequest): Promise<PiImageContent[] | undefined> {
    if (!request.images?.length) return undefined;
    return (await normalizeImages(request.images)).map((image) => ({
      type: 'image',
      data: image.source.data,
      mimeType: image.source.media_type,
    }));
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    this.linearForwarder = new LinearEventForwarder(() => this.linearSessionId);
    try {
      let session = await this.ensureSession(request);
      const images = await this.toPiImages(request);
      if (!this.deliver(signal)) return;
      this.recordUserMessage(session, request);
      let retry = false;
      let limit: AgentQuotaLimitKind | undefined;
      while (true) {
        const attempted = this.sessionCredential;
        const thrown = await session.prompt(retry ? SWITCHED_CREDENTIAL_PROMPT : request.message, images && !retry ? { images } : undefined)
          .then(() => null, (error: unknown) => error);
        const failedCall = this.failedCall;
        const failedCallId = this.failedCallId;
        this.failedCall = null;
        this.failedCallId = null;
        const detail = thrown
          ? thrown instanceof Error ? thrown.message : String(thrown)
          : failedCall ? failedCall.errorMessage ?? 'Pi run failed' : null;
        if (detail === null) break;
        const quota = detectAgentQuotaLimit(detail);
        const authFailed = !quota && isAuthenticationErrorText(detail, [/\b401\b/]);
        const fallback = !signal.aborted && (quota || authFailed)
          ? await this.fallBackCredential(quota ?? 'auth_failed', detail, attempted, undefined, !!limit)
          : null;
        limit ??= quota ?? undefined;
        if (fallback?.outcome === 'switched') {
          if (signal.aborted) break;
          const model = fallback.model ?? session.model?.id;
          await this.dispose();
          session = await this.ensureSession({ ...request, ...(model ? { model } : {}) });
          if (signal.aborted) break;
          retry = true;
          continue;
        }
        const notice = fallback && limit
          ? describeQuotaExhaustion('pi', limit, attempted, fallback)
          : authFailed ? describeLoginFailure('pi', attempted, undefined, false) : null;
        if (notice) this.recordHistoryEvent('pi-error', { message: notice });
        else if (failedCall) this.recordHistoryEvent('pi-message_end', { message: compactPiAssistantMessage(failedCall, failedCallId) });
        if (fallback && limit) {
          this.emitQuotaExhausted({
            provider: 'pi',
            reason: limit,
            detail,
            ...(fallback.outcome === 'fork' ? { forkTo: fallback.target } : {}),
          });
        }
        if (thrown && !notice) throw thrown;
        break;
      }
      this.linearForwarder.flushThoughtAsResponse();
    } catch (error) {
      this.recordHistoryEvent('pi-error', { message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.linearForwarder = null;
      this.activeAssistantMessageId = null;
      this.failedCall = null;
      this.failedCallId = null;
      // Steers Pi has not read by the time its turn ends would open its next one, so they go back on our queue instead.
      this.session?.clearQueue();
      this.steers = [];
      await this.historyFile.flush();
      await this.onTurnComplete();
    }
  }
}
