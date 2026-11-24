import { existsSync } from 'fs';
import { copyFile, mkdir, readFile, rm } from 'fs/promises';
import { delimiter, dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { Agent, type Dispatcher } from 'undici';
import {
  CREDENTIAL_METHOD,
  readOllamaAuthEnv,
  readOpenAICompatibleAuthEnv,
  listOllamaModels,
  listOpenAICompatibleModels,
  getDefaultOllamaModel,
  ASTER_MODELS,
  ASTER_PROVIDER,
  DEFAULT_ASTER_MODEL,
  createProviderSlashCommand,
  DEFAULT_OPENCODE_MODEL,
  mergeSlashCommands,
  type AgentCredentialSnapshot,
  type AgentEvent,
  type ChatHistoryPageParams,
  type ChatHistoryResponse,
  type SendChatMessageRequest,
  type SlashCommand,
  type ThinkingLevel,
  toolInputAnswer,
} from '@okidoki/shared';
import {
  DEFAULT_OPENCODE_GO_MODEL,
  fetchOpenCodeGoCatalog,
  OPENCODE_GO_PROVIDER,
} from '@okidoki/shared/opencode-go';
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config as OpencodeConfig,
  type CommandV2Info,
  type OpencodeClient,
  type Part as OpencodePart,
  type QuestionRequest,
  type SkillV2Info,
  type V2CommandListResponse,
  type V2SkillListResponse,
} from '@opencode-ai/sdk/v2';
import { CodingAgentManager, type CodingAgentManagerOptions } from './coding-agent-manager';
import { SWITCHED_CREDENTIAL_PROMPT } from './auth-fallback';
import { ENGINE_ENV } from '../engine-env';
import { isRecord } from '../utils/type-guards';
import { convertOpencodePart } from '../utils/linear-converter';
import { LinearEventForwarder } from '../utils/linear-event-forwarder';
import { getAgentAdditionalDirectories } from '../utils/agent-additional-directories';
import { getAllowedOpenRouterModels } from '../services/openrouter-models-service';
import {
  getOpenCodeGoModel,
  opencodeModelRef,
  getOpencodeProvider,
  hasOpencodeCredentials,
  fetchOpencodeModelVariants,
  opencodeThinkingVariant,
  opencodeConfig,
} from './opencode-config';
import { getCommandProtectionHookPath, getPostToolPrHookPath } from '../services/native-command-protection-hooks';
import { SUBAGENT_MCP_SERVER_NAME } from '@okidoki/shared';
import { SUBAGENT_MCP_TOOL_TIMEOUT_MS, subagentMcpProcessConfig } from './subagent-mcp-config';

type OpencodeServerHandle = Awaited<ReturnType<typeof createOpencodeServer>>;
type OpencodeTextPart = Extract<OpencodePart, { type: 'text' }>;
type OpencodeReasoningPart = Extract<OpencodePart, { type: 'reasoning' }>;
type OpencodeMcpConfig = NonNullable<OpencodeConfig['mcp']>;
type OpencodeMcpEntry = OpencodeMcpConfig[string];
type OpencodeRuntimeEvent = { type: string; data?: unknown; properties?: unknown };
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchInitWithDispatcher = NonNullable<FetchInit> & { dispatcher: Dispatcher };

const OPENCODE_SHIM_DIR = dirname(fileURLToPath(new URL('../../scripts/opencode', import.meta.url)));
const OPENCODE_COMMAND_PROTECTION_PLUGIN_SOURCE = join(OPENCODE_SHIM_DIR, 'opencode-command-protection-plugin.ts');
const OPENCODE_COMMAND_PROTECTION_PLUGIN_PATH = join(ENGINE_ENV.HOME_DIR, '.config', 'opencode', 'plugins', 'okidoki-command-protection.ts');
const OPENCODE_LEGACY_COMMAND_PROTECTION_PLUGIN_PATH = join(ENGINE_ENV.HOME_DIR, '.config', 'opencode', 'plugins', 'okidoki-command-protection.mjs');
const OPENCODE_CONFIG_PATH = join(ENGINE_ENV.HOME_DIR, '.config', 'opencode', 'opencode.json');
const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 30_000;
const OPENCODE_SLASH_COMMANDS_CACHE_MS = 30_000;
// OpenCode sends `server.heartbeat` on its event stream every 10 seconds, also while a tool runs.
const OPENCODE_HEARTBEAT_TIMEOUT_MS = 60_000;
const OPENCODE_ABORT_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_GONE = 'exited or dropped its connection';
async function getDefaultOpencodeModel(provider: string): Promise<string> {
  const ollama = readOllamaAuthEnv('opencode', process.env);
  if (provider === 'ollama' && ollama) {
    const model = getDefaultOllamaModel(await listOllamaModels(ollama));
    if (!model) throw new Error('Select a tool-capable Ollama model in the model picker.');
    return model;
  }
  const compatible = provider === CREDENTIAL_METHOD.OPENAI_COMPATIBLE ? readOpenAICompatibleAuthEnv('opencode', process.env) : null;
  if (compatible) return (await listOpenAICompatibleModels(compatible))[0].id;
  if (provider === OPENCODE_GO_PROVIDER) return DEFAULT_OPENCODE_GO_MODEL;
  if (provider === ASTER_PROVIDER) return DEFAULT_ASTER_MODEL;
  return (await getAllowedOpenRouterModels())[0] ?? DEFAULT_OPENCODE_MODEL;
}

function opencodeCommandToSlashCommand(command: CommandV2Info): SlashCommand | null {
  return createProviderSlashCommand('opencode', command.name, command.description);
}

function opencodeSkillToSlashCommand(skill: SkillV2Info): SlashCommand | null {
  if (!skill.slash) return null;
  return createProviderSlashCommand('opencode', skill.name, skill.description);
}

function opencodeCommandListToSlashCommands(response: V2CommandListResponse): SlashCommand[] {
  return mergeSlashCommands(response.data.flatMap((command) => {
    const result = opencodeCommandToSlashCommand(command);
    return result ? [result] : [];
  }));
}

function opencodeSkillListToSlashCommands(response: V2SkillListResponse): SlashCommand[] {
  return mergeSlashCommands(response.data.flatMap((skill) => {
    const result = opencodeSkillToSlashCommand(skill);
    return result ? [result] : [];
  }));
}

function isOpencodePart(value: unknown): value is OpencodePart {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

function isOpencodeQuestionRequest(value: unknown): value is QuestionRequest {
  return isRecord(value) && typeof value.id === 'string' && typeof value.sessionID === 'string'
    && (value.tool === undefined || (isRecord(value.tool) && typeof value.tool.messageID === 'string' && typeof value.tool.callID === 'string'))
    && Array.isArray(value.questions) && value.questions.every((question) =>
      isRecord(question) && typeof question.question === 'string' && typeof question.header === 'string'
      && (question.multiple === undefined || typeof question.multiple === 'boolean')
      && (question.custom === undefined || typeof question.custom === 'boolean')
      && Array.isArray(question.options)
      && question.options.every((option) => isRecord(option) && typeof option.label === 'string' && typeof option.description === 'string'));
}

function opencodeQuestionToolUseId(request: QuestionRequest): string {
  return request.tool?.callID ?? request.id;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOpencodeMcpEntry(value: unknown): value is OpencodeMcpEntry {
  if (!isRecord(value) || Array.isArray(value)) return false;
  if (typeof value.enabled === 'boolean' && typeof value.type !== 'string') return true;
  if (value.type === 'local') {
    return isStringArray(value.command)
      && (value.environment === undefined || isStringRecord(value.environment));
  }
  if (value.type === 'remote') {
    return typeof value.url === 'string'
      && (value.headers === undefined || isStringRecord(value.headers));
  }
  return false;
}

async function readProvisionedOpencodeMcpConfig(): Promise<OpencodeMcpConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(OPENCODE_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    console.error('[OpencodeManager] Failed to read Opencode config:', error);
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.mcp) || Array.isArray(parsed.mcp)) return undefined;
    const mcp: OpencodeMcpConfig = {};
    for (const [name, entry] of Object.entries(parsed.mcp)) {
      if (isOpencodeMcpEntry(entry)) mcp[name] = entry;
    }
    return mcp;
  } catch (error) {
    console.error('[OpencodeManager] Failed to parse Opencode config:', error);
    return undefined;
  }
}

function timestampMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isOpencodeRuntimeEvent(value: unknown): value is OpencodeRuntimeEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function opencodeEventPayload(event: OpencodeRuntimeEvent): Record<string, unknown> | null {
  if ('properties' in event && isRecord(event.properties)) return event.properties;
  if ('data' in event && isRecord(event.data)) return event.data;
  return null;
}

function opencodeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;
  if (typeof error.message === 'string') return error.message;
  if (typeof error.name === 'string') return error.name;
  if ('error' in error) return opencodeErrorMessage(error.error);
  if ('data' in error) return opencodeErrorMessage(error.data);
  if ('body' in error) return opencodeErrorMessage(error.body);
  return undefined;
}

function opencodeErrorPayload(error: unknown): { message: string; code?: string; status?: number } {
  const message = opencodeErrorMessage(error) ?? String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  // The SDK's wrapClientError stashes the HTTP response status on the cause.
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
  const status = typeof cause?.status === 'number' ? cause.status : undefined;
  return {
    message: code === 'ENOENT'
      ? `Failed to start Opencode server binary (${message}).`
      : message,
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function opencodeFetch(dispatcher: Dispatcher) {
  return (input: FetchInput, init?: FetchInit): ReturnType<typeof fetch> => {
    const requestInit = { ...init, dispatcher } as unknown as FetchInitWithDispatcher;
    return fetch(input, requestInit);
  };
}

export class OpencodeManager extends CodingAgentManager {
  private client: OpencodeClient | null = null;
  private server: OpencodeServerHandle | null = null;
  private dispatcher: Agent | null = null;
  private sessionId: string | null = null;
  private activeAbortController: AbortController | null = null;
  // A stopped turn ends here before OpenCode has answered the stop, so the next turn waits for that: its server may be about to be replaced.
  private stopping: Promise<void> = Promise.resolve();
  private configuredModels = new Set<string>();
  private clientUpdate: Promise<void> = Promise.resolve();
  private providerId = 'openrouter';
  private serverSubagentMcpParentChatId: string | undefined;
  private eventAbortController: AbortController | null = null;
  private eventSubscriptionReady: Promise<void> = Promise.resolve();
  private resolveEventSubscriptionReady: (() => void) | null = null;
  private textParts = new Map<string, OpencodeTextPart>();
  private reasoningParts = new Map<string, OpencodeReasoningPart>();
  private nonAssistantMessageIds = new Set<string>();
  private stopsInFlight = 0;
  private stoppedBefore = 0;
  private activeLinearForwarder: LinearEventForwarder | null = null;
  private forwardedLinearPartKeys = new Set<string>();
  private handledAccountRateLimit = false;
  private pendingQuestions = new Map<string, QuestionRequest>();
  private credentialSwitch: Promise<void> | null = null;
  /** OpenCode reads its key when the server starts, so a server started on another credential has to restart. */
  private serverCredential: AgentCredentialSnapshot | undefined;
  private modelVariants = new Map<string, Set<string>>();
  private slashCommandsCache: { commands: SlashCommand[]; expiresAt: number } | null = null;
  private slashCommandsRequest: Promise<SlashCommand[]> | null = null;

  constructor(options: CodingAgentManagerOptions) {
    super({ ...options, provider: 'opencode' });
    this.sessionId = options.initialSessionId;
    this.initializeManager(this.processMessageInternal.bind(this));
  }

  protected interruptActiveTurn(): Promise<void> {
    const server = this.server;
    this.stopping = this.abortActiveTurn().catch((error) => {
      console.error('[OpencodeManager] Failed to abort Opencode session:', error);
      // The session may still be running on a server that cannot answer, and the next turn would wait on it.
      if (this.server === server) this.stopServer();
    });
    return this.stopping;
  }

  private async abortActiveTurn(): Promise<void> {
    this.activeAbortController?.abort();
    if (!this.client || !this.sessionId) return;
    this.stopsInFlight += 1;
    try {
      await this.client.session.abort(
        { sessionID: this.sessionId, directory: this.workingDirectory },
        { throwOnError: true, signal: AbortSignal.timeout(OPENCODE_ABORT_TIMEOUT_MS) },
      );
    } finally {
      this.stopsInFlight -= 1;
      this.stoppedBefore = Date.now();
    }
  }

  // OpenCode fails a stopped message as aborted whoever stopped it: this engine, or OpenCode itself when it shuts a session down.
  // An abort of this engine ends every message the session has made by the time OpenCode answers it.
  reportsOwnStop(event: AgentEvent): boolean {
    const { info } = event.payload;
    if (event.type !== 'opencode-message.updated' || !isRecord(info) || !isRecord(info.error) || info.error.name !== 'MessageAbortedError') return false;
    return this.stopsInFlight > 0 || (isRecord(info.time) && typeof info.time.created === 'number' && info.time.created <= this.stoppedBefore);
  }

  async getHistory(page: ChatHistoryPageParams = {}): Promise<ChatHistoryResponse> {
    await this.historyFile.flush();
    const history = await this.historyFile.loadEventsPage(page);
    return {
      thread_id: this.sessionId ?? this.initialSessionId,
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
        const provider = await getOpencodeProvider();
        const client = await this.ensureClient(await getDefaultOpencodeModel(provider), provider, true);
        const directories = [this.workingDirectory, ...await getAgentAdditionalDirectories()];
        const perDirectory = await Promise.all(directories.map(async (directory) => {
          try {
            const location = { directory };
            const [commandResponse, skillResponse] = await Promise.all([
              client.v2.command.list({ location }, { throwOnError: true }),
              client.v2.skill.list({ location }, { throwOnError: true }),
            ]);
            return mergeSlashCommands(
              opencodeCommandListToSlashCommands(commandResponse.data),
              opencodeSkillListToSlashCommands(skillResponse.data),
            );
          } catch (error) {
            console.warn('[OpencodeManager] Failed to load slash commands for directory:', directory, error);
            return [];
          }
        }));
        const commands = mergeSlashCommands(...perDirectory);
        this.slashCommandsCache = { commands, expiresAt: Date.now() + OPENCODE_SLASH_COMMANDS_CACHE_MS };
        return commands;
      } catch (error) {
        console.warn('[OpencodeManager] Failed to load slash commands:', error);
        return this.slashCommandsCache?.commands ?? [];
      } finally {
        this.slashCommandsRequest = null;
      }
    })();

    return this.slashCommandsRequest;
  }

  private async ensureClient(model: string, providerId: string, reuseExisting = false): Promise<OpencodeClient> {
    const previousUpdate = this.clientUpdate;
    let finishUpdate: () => void = () => {};
    this.clientUpdate = new Promise((resolve) => { finishUpdate = resolve; });
    await previousUpdate;
    try {
      if (reuseExisting && this.client) return this.client;
      // MCP servers are fixed at server start; sessions persist on disk, so a restart picks up a changed set.
      const subagentMcpParentChatId = this.subagentMcpParentChatId();
      if (this.client && (this.providerId !== providerId
        || this.serverSubagentMcpParentChatId !== subagentMcpParentChatId
        || this.serverCredential !== ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.opencode)) {
        this.stopServer();
      }
      this.providerId = providerId;
      const configuredModel = providerId === OPENCODE_GO_PROVIDER
        ? getOpenCodeGoModel(model)
        : model;
      const ollama = providerId === 'ollama' ? readOllamaAuthEnv('opencode', process.env) : null;
      const compatible = providerId === CREDENTIAL_METHOD.OPENAI_COMPATIBLE ? readOpenAICompatibleAuthEnv('opencode', process.env) : null;
      const providerModels = ollama ? (await listOllamaModels(ollama)).map(({ id }) => id)
        : compatible ? (await listOpenAICompatibleModels(compatible)).map(({ id }) => id)
        : providerId === OPENCODE_GO_PROVIDER
        ? Object.keys((await fetchOpenCodeGoCatalog('opencode')).models)
        : providerId === ASTER_PROVIDER
          ? ASTER_MODELS
          : await getAllowedOpenRouterModels();
      if (!providerModels.includes(configuredModel)) {
        throw new Error(`Model ${configuredModel} is not available through ${providerId}.`);
      }
      if (this.client && this.configuredModels.has(configuredModel)) {
        return this.client;
      }
      if (!await hasOpencodeCredentials(providerId)) {
        throw new Error('OpenCode Go, Aster, OpenRouter, OpenAI-compatible, or Ollama credentials are not configured for Opencode in this workspace.');
      }
      if (!existsSync(OPENCODE_COMMAND_PROTECTION_PLUGIN_SOURCE)) {
        throw new Error('Opencode command protection plugin is missing from the engine package.');
      }
      await mkdir(dirname(OPENCODE_COMMAND_PROTECTION_PLUGIN_PATH), { recursive: true });
      await copyFile(OPENCODE_COMMAND_PROTECTION_PLUGIN_SOURCE, OPENCODE_COMMAND_PROTECTION_PLUGIN_PATH);
      await rm(OPENCODE_LEGACY_COMMAND_PROTECTION_PLUGIN_PATH, { force: true });
      process.env.OKIDOKI_COMMAND_PROTECTION_HOOK_PATH = getCommandProtectionHookPath();
      process.env.OKIDOKI_POST_TOOL_PR_HOOK_PATH = getPostToolPrHookPath();
      process.env.OKIDOKI_COMMAND_PROTECTION_RUNTIME_PATH = process.execPath;
      this.stopServer();
      const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
      if (!pathEntries.includes(OPENCODE_SHIM_DIR)) {
        process.env.PATH = [OPENCODE_SHIM_DIR, ...pathEntries].join(delimiter);
      }

      const password = process.env.OPENCODE_SERVER_PASSWORD || randomBytes(24).toString('base64url');
      process.env.OPENCODE_SERVER_PASSWORD = password;
      const config = opencodeConfig(providerId, configuredModel, providerModels);
      const mcp = await readProvisionedOpencodeMcpConfig();
      if (mcp && Object.keys(mcp).length > 0) config.mcp = mcp;
      if (subagentMcpParentChatId) {
        const subagentMcp = subagentMcpProcessConfig(subagentMcpParentChatId);
        config.mcp = {
          ...config.mcp,
          [SUBAGENT_MCP_SERVER_NAME]: {
            type: 'local',
            command: [subagentMcp.command, ...subagentMcp.args],
            enabled: true,
            timeout: SUBAGENT_MCP_TOOL_TIMEOUT_MS,
          },
        };
      }

      // createOpencodeServer copies process.env when it spawns, before its first await, so this chat id reaches only this chat's server.
      if (this.originChatId) process.env.OKIDOKI_CHAT_ID = this.originChatId;
      const credential = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.opencode;
      const serverStart = createOpencodeServer({
        port: 0,
        timeout: OPENCODE_SERVER_STARTUP_TIMEOUT_MS,
        config,
      });
      delete process.env.OKIDOKI_CHAT_ID;
      const server = await serverStart;
      const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
      const client = createOpencodeClient({
        baseUrl: server.url,
        fetch: opencodeFetch(dispatcher) as unknown as typeof fetch,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        },
      });
      this.client = client;
      this.server = server;
      this.dispatcher = dispatcher;
      this.serverSubagentMcpParentChatId = subagentMcpParentChatId;
      this.serverCredential = credential;
      this.configuredModels = new Set(providerModels);
      const eventController = new AbortController();
      this.eventAbortController = eventController;
      this.eventSubscriptionReady = new Promise((resolve) => {
        this.resolveEventSubscriptionReady = resolve;
      });
      void this.subscribeToEvents(client, eventController, () => {
        this.loseServer(server, `stopped responding (no heartbeat for ${OPENCODE_HEARTBEAT_TIMEOUT_MS / 1000} seconds)`);
      }).catch((error) => {
        this.resolveEventSubscriptionReady?.();
        this.resolveEventSubscriptionReady = null;
        console.error('[OpencodeManager] Event subscription failed:', error);
      }).then(() => this.loseServer(server, OPENCODE_SERVER_GONE));
      await Promise.race([
        this.eventSubscriptionReady,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      return client;
    } finally {
      finishUpdate();
    }
  }

  dispose(): void {
    this.stopServer();
  }

  private stopServer(): void {
    this.eventAbortController?.abort();
    this.server?.close();
    // The next server usually takes the same port, so a pooled socket to this one would carry its requests.
    void this.dispatcher?.destroy();
    this.server = null;
    this.dispatcher = null;
    this.client = null;
    this.configuredModels.clear();
  }

  // Sessions persist on disk, so the next turn resumes this one on a fresh server.
  private loseServer(server: OpencodeServerHandle | null, reason: string): void {
    if (!server || this.server !== server) return;
    this.stopServer();
    const turn = this.activeAbortController;
    if (!turn || turn.signal.aborted) return;
    this.recordHistoryEvent('opencode-error', {
      message: `The OpenCode server ${reason}, so this turn ended. Send a message to continue.`,
    });
    turn.abort();
  }

  private async ensureSession(
    client: OpencodeClient,
    providerID: string,
    model: string,
    variant: string | undefined,
  ): Promise<string> {
    if (this.sessionId) {
      try {
        await client.session.get(
          { sessionID: this.sessionId, directory: this.workingDirectory },
          { throwOnError: true },
        );
        return this.sessionId;
      } catch {
        this.sessionId = null;
      }
    }

    const result = await client.session.create({
      directory: this.workingDirectory,
      agent: 'build',
      model: { providerID, id: model, ...(variant ? { variant } : {}) },
    }, { throwOnError: true });
    const session = result.data;
    this.sessionId = session.id;
    await this.onSaveSessionId(session.id);
    return session.id;
  }

  private async getModelVariants(client: OpencodeClient, providerID: string, model: string): Promise<Set<string>> {
    const key = `${providerID}/${model}`;
    const cached = this.modelVariants.get(key);
    if (cached) return cached;
    try {
      for (const [id, variants] of await fetchOpencodeModelVariants(client, this.workingDirectory, providerID)) {
        this.modelVariants.set(`${providerID}/${id}`, variants);
      }
    } catch {
      this.modelVariants.set(key, new Set());
    }
    return this.modelVariants.get(key) ?? new Set();
  }

  private async getThinkingVariant(
    client: OpencodeClient,
    providerID: string,
    model: string,
    thinkingLevel: ThinkingLevel | undefined,
  ): Promise<string | undefined> {
    if (!thinkingLevel) return undefined;
    return opencodeThinkingVariant(await this.getModelVariants(client, providerID, model), thinkingLevel);
  }

  private async processMessageInternal(request: SendChatMessageRequest, signal: AbortSignal): Promise<void> {
    const linearForwarder = new LinearEventForwarder(() => this.linearSessionId);
    this.activeLinearForwarder = linearForwarder;
    this.forwardedLinearPartKeys.clear();

    this.credentialSwitch = null;
    try {
      let retry = false;
      while (await this.promptTurn(request, linearForwarder, signal, retry)) retry = true;
    } finally {
      this.activeAbortController = null;
      this.activeLinearForwarder = null;
      this.forwardedLinearPartKeys.clear();
      await this.historyFile.flush();
      await this.onTurnComplete();
    }
  }

  private async promptTurn(
    request: SendChatMessageRequest,
    linearForwarder: LinearEventForwarder,
    signal: AbortSignal,
    retry: boolean,
  ): Promise<boolean> {
    const controller = new AbortController();
    this.handledAccountRateLimit = false;
    this.activeAbortController = controller;
    // A stop while the previous attempt switched credentials only reached the queue's signal.
    if (signal.aborted) controller.abort();
    let server: OpencodeServerHandle | null = null;

    try {
      await this.stopping;
      controller.signal.throwIfAborted();
      const provider = await getOpencodeProvider();
      const model = request.model ?? await getDefaultOpencodeModel(provider);
      const client = await this.ensureClient(model, provider);
      server = this.server;
      const { providerID, modelID } = opencodeModelRef(this.providerId, model);
      const variant = await this.getThinkingVariant(client, providerID, modelID, request.thinkingLevel);
      const sessionId = await this.ensureSession(client, providerID, modelID, variant);
      const system = this.buildCombinedInstructions(request.customInstructions);
      if (!retry) {
        if (!this.deliver(signal)) return false;
        this.recordUserMessageHistoryEvent(request, {}, this.turnBeganAt);
      }

      const result = await client.session.prompt({
        sessionID: sessionId,
        directory: this.workingDirectory,
        agent: 'build',
        model: { providerID, modelID },
        ...(variant ? { variant } : {}),
        ...(system ? { system } : {}),
        // OpenCode saves these on the session, so every turn sets the question tool explicitly.
        tools: {
          question: Boolean(request.enableInteractiveTools),
          ...(this.nativeSubagentsDisabled() ? { task: false } : {}),
        },
        parts: [{ type: 'text', text: retry ? SWITCHED_CREDENTIAL_PROMPT : request.message }],
      }, { signal: controller.signal, throwOnError: true });
      this.recordHistoryEvent('opencode-message.updated', { info: result.data.info });
      for (const part of result.data.parts) this.recordOpencodePart(part);
      linearForwarder.flushThoughtAsResponse();
      this.recordHistoryEvent('opencode-session.idle', { sessionID: sessionId });
    } catch (error) {
      const credentialSwitch = this.credentialSwitch;
      if (credentialSwitch) {
        this.credentialSwitch = null;
        // The retry replaces this server, so the session has to finish stopping on it first.
        await credentialSwitch.catch(() => {});
        if (!signal.aborted) return true;
      }
      // fetch rejects with a TypeError only when the connection itself failed.
      if (error instanceof TypeError) this.loseServer(server, OPENCODE_SERVER_GONE);
      if (controller.signal.aborted) {
        this.recordHistoryEvent('opencode-session.idle', { sessionID: this.sessionId });
      } else {
        console.error('[OpencodeManager] Turn failed:', error);
        this.recordHistoryEvent('opencode-error', opencodeErrorPayload(error));
      }
    } finally {
      for (const requestId of this.pendingQuestions.keys()) this.resolveQuestion(requestId, 'aborted');
    }
    return false;
  }

  private async subscribeToEvents(client: OpencodeClient, controller: AbortController, onSilent: () => void): Promise<void> {
    let streamError: unknown;
    const silence = setTimeout(onSilent, OPENCODE_HEARTBEAT_TIMEOUT_MS);
    try {
      // Since OpenCode 1.18 the v2 stream no longer carries live message parts; the directory stream does.
      const result = await client.event.subscribe(
        { directory: this.workingDirectory },
        {
          signal: controller.signal,
          sseMaxRetryAttempts: 1,
          onSseError: (error) => {
            streamError = error;
          },
        },
      );
      for await (const event of result.stream) {
        silence.refresh();
        this.resolveEventSubscriptionReady?.();
        this.resolveEventSubscriptionReady = null;
        if (isOpencodeRuntimeEvent(event)) {
          this.recordOpencodeEvent(event);
        }
      }
    } finally {
      clearTimeout(silence);
    }
    this.resolveEventSubscriptionReady?.();
    this.resolveEventSubscriptionReady = null;
    if (!controller.signal.aborted && streamError) throw streamError;
  }

  private recordOpencodeEvent(event: OpencodeRuntimeEvent): void {
    const payload = opencodeEventPayload(event);
    if (event.type === 'question.asked') {
      // The stream can deliver a question after a Stop has already cleared the turn's questions.
      const live = this.activeAbortController?.signal.aborted === false;
      if (live && isOpencodeQuestionRequest(payload) && payload.sessionID === this.sessionId) this.recordQuestion(payload);
      return;
    }
    // The directory stream also carries server-wide plugin and catalog events, which belong to no chat.
    if (!/^(session|message)\./.test(event.type)) return;
    if (!payload) return;
    const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
    const part = payload.part;
    if (typeof sessionID === 'string' && this.sessionId && sessionID !== this.sessionId) return;
    const partSessionID = isRecord(part) ? part.sessionID : undefined;
    if (typeof partSessionID === 'string' && this.sessionId && partSessionID !== this.sessionId) return;
    if (event.type === 'message.part.updated' && isOpencodePart(part)) {
      if (this.shouldRecordOpencodePart(part)) this.recordOpencodePart(part);
      return;
    }
    if (event.type === 'message.updated') this.recordOpencodeMessageRole(payload);
    if (event.type === 'session.status') {
      this.handleAccountRateLimit(payload).catch((error) => {
        console.error('[OpencodeManager] Failed to stop account-rate-limited turn:', error);
      });
    }
    if (this.recordOpencodeNextPart(event.type, payload)) return;
    this.recordHistoryEvent(`opencode-${event.type}`, payload);
  }

  private recordQuestion(request: QuestionRequest): void {
    this.pendingQuestions.set(request.id, request);
    this.recordHistoryEvent('okidoki-tool-input-request', {
      requestId: request.id,
      toolUseId: opencodeQuestionToolUseId(request),
      toolName: 'question',
      questions: request.questions.map((question, index) => ({
        id: String(index),
        prompt: question.question,
        multiSelect: question.multiple === true,
        allowCustom: question.custom !== false,
        options: question.options.map((option) => ({ id: option.label, label: option.label, description: option.description })),
      })),
      parent_tool_use_id: null,
    });
  }

  private resolveQuestion(requestId: string, selectionId: string): void {
    const request = this.pendingQuestions.get(requestId);
    if (!request) return;
    this.pendingQuestions.delete(requestId);
    this.recordHistoryEvent('okidoki-tool-input-resolved', {
      requestId,
      toolUseId: opencodeQuestionToolUseId(request),
      toolName: 'question',
      selectionId,
      parent_tool_use_id: null,
    });
  }

  async respondToToolInput(requestId: string, selectionId: string): Promise<boolean> {
    const request = this.pendingQuestions.get(requestId);
    if (!request || !this.client) return false;
    // Declining answers nothing rather than rejecting, which would make OpenCode end the turn instead of carrying on.
    const selections: unknown = selectionId === 'declined' ? {} : JSON.parse(selectionId);
    const answers = request.questions.map((_, index) => {
      const { custom, options } = toolInputAnswer(selections, String(index));
      return custom ? [custom] : options;
    });
    await this.client.question.reply({ requestID: requestId, directory: this.workingDirectory, answers }, { throwOnError: true });
    this.resolveQuestion(requestId, selectionId);
    return true;
  }

  isAwaitingInput(): boolean {
    return this.pendingQuestions.size > 0;
  }

  private async handleAccountRateLimit(payload: Record<string, unknown>): Promise<void> {
    const status = isRecord(payload.status) ? payload.status : null;
    const action = isRecord(status?.action) ? status.action : null;
    if (status?.type !== 'retry' || action?.reason !== 'account_rate_limit' || this.handledAccountRateLimit) return;

    this.handledAccountRateLimit = true;
    const message = typeof status.message === 'string'
      ? status.message
      : typeof action.message === 'string'
        ? action.message
        : 'OpenCode Go usage limit reached.';
    const controller = this.activeAbortController;
    const fallback = await this.fallBackCredential('rate_limit', message, this.serverCredential);
    // A turn stopped while the fallback ran is over; the next one starts on whichever credential is live.
    if (!controller || controller.signal.aborted || controller !== this.activeAbortController) return;
    if (fallback.outcome === 'switched') {
      this.credentialSwitch = this.abortActiveTurn();
      await this.credentialSwitch;
      return;
    }
    this.recordHistoryEvent('opencode-error', { message, code: 'account_rate_limit' });
    this.emitQuotaExhausted({
      provider: 'opencode',
      reason: 'rate_limit',
      detail: message,
      ...(fallback.outcome === 'fork' ? { forkTo: fallback.target } : {}),
    });
    await this.abortActiveTurn();
  }

  private recordOpencodeMessageRole(payload: Record<string, unknown>): void {
    const info = isRecord(payload.info) ? payload.info : null;
    const id = typeof info?.id === 'string' ? info.id : undefined;
    const role = typeof info?.role === 'string' ? info.role : undefined;
    if (!id || !role) return;
    if (role !== 'assistant') this.nonAssistantMessageIds.add(id);
  }

  private shouldRecordOpencodePart(part: OpencodePart): boolean {
    return !this.nonAssistantMessageIds.has(part.messageID);
  }

  private recordOpencodeNextPart(type: string, payload: Record<string, unknown>): boolean {
    const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
    const messageID = typeof payload.assistantMessageID === 'string' ? payload.assistantMessageID : undefined;
    if (!sessionID || !messageID) return false;

    if (type === 'session.next.text.started') {
      const id = typeof payload.textID === 'string' ? payload.textID : undefined;
      if (!id) return false;
      this.textParts.set(id, {
        id,
        sessionID,
        messageID,
        type: 'text',
        text: '',
        time: { start: timestampMs(payload.timestamp) },
      });
      return true;
    }

    if (type === 'session.next.text.delta' || type === 'session.next.text.ended') {
      const id = typeof payload.textID === 'string' ? payload.textID : undefined;
      if (!id) return false;
      const part = this.textParts.get(id) ?? {
        id,
        sessionID,
        messageID,
        type: 'text',
        text: '',
        time: { start: timestampMs(payload.timestamp) },
      };
      part.text = type === 'session.next.text.ended' && typeof payload.text === 'string'
        ? payload.text
        : `${part.text}${typeof payload.delta === 'string' ? payload.delta : ''}`;
      if (type === 'session.next.text.ended') {
        part.time = { start: part.time?.start ?? timestampMs(payload.timestamp), end: timestampMs(payload.timestamp) };
      }
      this.textParts.set(id, part);
      this.recordOpencodePart(part);
      return true;
    }

    if (type === 'session.next.reasoning.started') {
      const id = typeof payload.reasoningID === 'string' ? payload.reasoningID : undefined;
      if (!id) return false;
      this.reasoningParts.set(id, {
        id,
        sessionID,
        messageID,
        type: 'reasoning',
        text: '',
        time: { start: timestampMs(payload.timestamp) },
      });
      return true;
    }

    if (type === 'session.next.reasoning.delta' || type === 'session.next.reasoning.ended') {
      const id = typeof payload.reasoningID === 'string' ? payload.reasoningID : undefined;
      if (!id) return false;
      const part = this.reasoningParts.get(id) ?? {
        id,
        sessionID,
        messageID,
        type: 'reasoning',
        text: '',
        time: { start: timestampMs(payload.timestamp) },
      };
      part.text = type === 'session.next.reasoning.ended' && typeof payload.text === 'string'
        ? payload.text
        : `${part.text}${typeof payload.delta === 'string' ? payload.delta : ''}`;
      if (type === 'session.next.reasoning.ended') {
        part.time = { start: part.time.start, end: timestampMs(payload.timestamp) };
      }
      this.reasoningParts.set(id, part);
      this.recordOpencodePart(part);
      return true;
    }

    return false;
  }

  private forwardOpencodePartToLinear(part: OpencodePart): void {
    const linearSessionId = this.linearSessionId;
    if (!linearSessionId || !this.activeLinearForwarder) return;
    const event = convertOpencodePart(part, linearSessionId);
    if (!event) return;
    if (typeof part.id !== 'string') return;
    const key = `${part.type}:${part.id}:${JSON.stringify(event.content)}`;
    if (this.forwardedLinearPartKeys.has(key)) return;
    this.forwardedLinearPartKeys.add(key);
    this.activeLinearForwarder.sendEvent(event);
  }

  private recordOpencodePart(part: OpencodePart): void {
    if (part.type === 'step-finish') this.onUsageUpdate(part, new Date().toISOString());
    this.recordHistoryEvent(`opencode-part-${part.type}`, { part });
    this.forwardOpencodePartToLinear(part);
  }
}
