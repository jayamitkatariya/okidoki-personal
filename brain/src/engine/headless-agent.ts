import { readFile, writeFile } from 'node:fs/promises';
import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AGENT, codexReasoningEffortForThinkingLevel, headlessAgentRequestSchema, headlessAgentUsagePath, extractJsonObject, isRecord, type HeadlessAgentRequest, type HeadlessAgentUsage, withTimeout } from '@okidoki/shared';
import type { ServerNotification, v2 } from '@okidoki/shared/codex-asp-types';
import { buildCodexAgentEnv } from './utils/codex-agent-env';
import { AppServerProcess } from './managers/codex-asp/app-server-process';
import type { AspClient } from './managers/codex-asp/asp-client';
import { recoverCompletedTurn, THREAD_TOKEN_USAGE_UPDATED_METHOD } from './managers/codex-asp/notification-dispatch';
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk/v2';
import { Agent as CursorAgent } from '@cursor/sdk';
import { OPENCODE_GO_PROVIDER } from '@okidoki/shared/opencode-go';
import { fetchOpencodeModelVariants, getOpenCodeGoModel, getOpencodeProvider, opencodeConfig, opencodeModelRef, opencodeThinkingVariant } from './managers/opencode-config';
import { initializeMuse, museTurnStartParams, spawnMuseMsp, startMuseSession } from './managers/muse-msp';
import { initializeGeminiAcp, selectGeminiModel, spawnGeminiAcp, startGeminiSession } from './managers/gemini-acp';

interface HeadlessAgentResult {
  output: unknown;
  usage: HeadlessAgentUsage | null;
}

async function runClaude(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  const response = query({
    prompt: request.prompt,
    options: {
      cwd: request.workingDirectory,
      model: request.model,
      ...(request.thinkingLevel ? { effort: request.thinkingLevel } : {}),
      tools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: request.outputSchema },
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    },
  });
  const lastResult = async () => {
    let last: SDKResultMessage | null = null;
    for await (const message of response) {
      if (message.type === 'result') last = message;
    }
    return last;
  };
  let result: SDKResultMessage | null;
  try {
    result = await withTimeout(lastResult(), request.timeoutSeconds * 1_000, 'Claude run timed out');
  } finally {
    response.close();
  }
  if (!result) throw new Error('Claude Agent SDK returned no result');
  if (result.subtype !== 'success') throw new Error(result.errors.join('\n') || result.subtype);
  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = result.usage;
  return {
    output: result.structured_output ?? JSON.parse(result.result),
    usage: { inputTokens: input_tokens + cache_creation_input_tokens + cache_read_input_tokens, outputTokens: output_tokens },
  };
}

function runCodexTurn(
  client: AspClient,
  params: v2.TurnStartParams,
  timeoutMs: number,
): Promise<{ turn: v2.Turn; message: string | null; usage: HeadlessAgentUsage | null }> {
  return new Promise((resolve, reject) => {
    const completedItems: v2.ThreadItem[] = [];
    let usage: HeadlessAgentUsage | null = null;
    const messageDeltas = new Map<string, string>();
    const cleanup = () => {
      clearTimeout(timeout);
      client.off('notification', onNotification);
      client.off('dispose', onDispose);
    };
    const onNotification = (notification: ServerNotification) => {
      if (notification.method === THREAD_TOKEN_USAGE_UPDATED_METHOD) {
        if (notification.params.threadId !== params.threadId) return;
        const { inputTokens, outputTokens } = notification.params.tokenUsage.total;
        usage = { inputTokens, outputTokens };
        return;
      }
      if (notification.method === 'item/completed') {
        if (notification.params.threadId !== params.threadId
          || notification.params.item.type !== 'agentMessage') return;
        completedItems.push(notification.params.item);
        return;
      }
      if (notification.method === 'item/agentMessage/delta') {
        if (notification.params.threadId !== params.threadId) return;
        messageDeltas.set(
          notification.params.itemId,
          (messageDeltas.get(notification.params.itemId) ?? '') + notification.params.delta,
        );
        return;
      }
      if (notification.method !== 'turn/completed' || notification.params.threadId !== params.threadId) return;
      const turn = recoverCompletedTurn(notification.params.turn, completedItems, messageDeltas);
      const message = turn.items.findLast((item) => item.type === 'agentMessage')?.text ?? null;
      cleanup();
      resolve({ turn, message, usage });
    };
    const onDispose = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Codex ASP turn timed out'));
    }, timeoutMs);
    client.on('notification', onNotification);
    client.on('dispose', onDispose);
    void client.request<v2.TurnStartResponse>('turn/start', params).catch((error: Error) => {
      cleanup();
      reject(error);
    });
  });
}

async function runCodex(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  if (process.env.OKIDOKI_CODEX_AUTH_METHOD === 'oauth' && !request.codexOauthTokens) {
    throw new Error('Codex OAuth credentials were not provided');
  }
  const appServer = new AppServerProcess({
    cwd: request.workingDirectory,
    env: buildCodexAgentEnv(),
    configOverrides: ['shell_environment_policy.inherit=none', 'tools.web_search=false'],
    ...(request.codexOauthTokens
      ? {
          chatgptAuthTokens: {
            accessToken: request.codexOauthTokens.accessToken,
            chatgptAccountId: request.codexOauthTokens.accountId,
            chatgptPlanType: null,
          },
          refreshChatgptAuthTokens: async () => {
            throw new Error('Failed to refresh token in standalone memory job');
          },
        }
      : {}),
  });
  try {
    const { client } = await appServer.start();
    client.on('serverRequest', (serverRequest) => {
      if (serverRequest.method === 'account/chatgptAuthTokens/refresh') return;
      client.reject(serverRequest.id, -32601, 'Headless agents do not accept server requests');
    });
    const thread = await client.request<v2.ThreadStartResponse>('thread/start', {
      model: request.model,
      cwd: request.workingDirectory,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
    } satisfies v2.ThreadStartParams);
    const { turn, message, usage } = await runCodexTurn(client, {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: request.prompt, text_elements: [] }],
      outputSchema: request.outputSchema,
      ...(request.thinkingLevel ? { effort: codexReasoningEffortForThinkingLevel(request.thinkingLevel) } : {}),
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    } satisfies v2.TurnStartParams, request.timeoutSeconds * 1_000);
    if (turn.status === 'failed') throw new Error(turn.error?.message ?? 'Codex ASP turn failed');
    if (!message) throw new Error('Codex ASP returned no final message');
    return { output: JSON.parse(message), usage };
  } finally {
    await appServer.stop();
  }
}

// Native JSON-schema output keeps the result valid; it runs as a tool, so tools stay on in the throwaway sandbox.
async function runOpencode(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  const provider = await getOpencodeProvider();
  const model = provider === OPENCODE_GO_PROVIDER ? getOpenCodeGoModel(request.model) : request.model;
  const { providerID, modelID } = opencodeModelRef(provider, model);
  const server = await createOpencodeServer({ port: 0, timeout: 30_000, config: opencodeConfig(provider, model) });
  try {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    const client = createOpencodeClient({
      baseUrl: server.url,
      ...(password ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } } : {}),
    });
    const variant = opencodeThinkingVariant((await fetchOpencodeModelVariants(client, request.workingDirectory, providerID)).get(modelID), request.thinkingLevel);
    const session = await client.session.create({ directory: request.workingDirectory, model: { providerID, id: modelID } }, { throwOnError: true });
    const result = await client.session.prompt({
      sessionID: session.data.id,
      directory: request.workingDirectory,
      model: { providerID, modelID },
      ...(variant ? { variant } : {}),
      format: { type: 'json_schema', schema: request.outputSchema, retryCount: 2 },
      parts: [{ type: 'text', text: request.prompt }],
    }, { throwOnError: true, signal: AbortSignal.timeout(request.timeoutSeconds * 1_000) });
    const { info } = result.data;
    if (info.error) throw new Error(`${info.error.name}: ${JSON.stringify(info.error.data)}`);
    if (info.structured === undefined) throw new Error('Opencode returned no structured output');
    return {
      output: info.structured,
      usage: { inputTokens: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write, outputTokens: info.tokens.output + info.tokens.reasoning },
    };
  } finally {
    server.close();
  }
}

// Harnesses without schema-constrained output get the schema in the prompt, and the caller validates the JSON.
const jsonReplyPrompt = (request: HeadlessAgentRequest) =>
  `${request.prompt}\n\nReply with only JSON, no prose or code fences, matching this JSON Schema:\n${JSON.stringify(request.outputSchema)}`;

function parseJsonReply(reply: string): unknown {
  const output = extractJsonObject(reply);
  if (output === null) throw new Error(`Reply was not JSON: ${reply.slice(0, 200)}`);
  return output;
}

async function runCursor(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('Cursor API key is not configured');
  const agent = await CursorAgent.create({ apiKey, model: { id: request.model }, local: { cwd: request.workingDirectory, settingSources: [] } });
  const run = await agent.send(jsonReplyPrompt(request));
  const result = await withTimeout(run.wait(), request.timeoutSeconds * 1_000, 'Cursor run timed out');
  if (result.status !== 'finished' || !result.result) throw new Error(result.error?.message ?? `Cursor run ${result.status}`);
  return {
    output: parseJsonReply(result.result),
    usage: result.usage ? { inputTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens, outputTokens: result.usage.outputTokens } : null,
  };
}

// Muse's MSP has no schema-constrained output. Tools are denied rather than prompted for, so the turn never waits on an approval.
async function runMuse(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  const { child, client } = spawnMuseMsp(request.workingDirectory);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.on('exit', (code, signal) => client.dispose(new Error(`Muse exited with ${code ?? signal}: ${stderr.trim()}`)));
  client.on('serverRequest', (serverRequest) => client.reject(serverRequest.id, -32601, 'Headless agents do not accept server requests'));
  try {
    await initializeMuse(client, 'okidoki_headless_agent');
    const sessionId = await startMuseSession(client, { approvalMode: 'denyUnmatched', modelId: request.model, workspaceRoot: request.workingDirectory });
    let message: string | null = null;
    let usage: HeadlessAgentUsage | null = null;
    const completed = new Promise<void>((resolve, reject) => {
      client.on('dispose', reject);
      client.on('notification', (frame: unknown) => {
        if (!isRecord(frame) || !isRecord(frame.params) || frame.params.sessionId !== sessionId) return;
        const { method, params } = frame;
        if (method === 'item/completed' && isRecord(params.item) && params.item.kind === 'agentMessage' && typeof params.item.text === 'string') {
          message = params.item.text;
        } else if (method === 'session/tokenUsage' && isRecord(params.cumulative)
          && typeof params.cumulative.promptTokens === 'number' && typeof params.cumulative.outputTokens === 'number') {
          usage = { inputTokens: params.cumulative.promptTokens, outputTokens: params.cumulative.outputTokens };
        } else if (method === 'turn/completed') {
          if (isRecord(params.error)) reject(new Error(typeof params.error.message === 'string' ? params.error.message : 'Muse turn failed'));
          else resolve();
        }
      });
    });
    await Promise.all([
      client.request('turn/start', museTurnStartParams(sessionId, [{ type: 'text', text: jsonReplyPrompt(request) }], request.thinkingLevel)),
      withTimeout(completed, request.timeoutSeconds * 1_000, 'Muse turn timed out'),
    ]);
    if (!message) throw new Error('Muse returned no final message');
    return { output: parseJsonReply(message), usage };
  } finally {
    client.dispose();
    child.kill('SIGTERM');
  }
}

// Antigravity has no schema-constrained output over ACP, and questions to the user are cancelled.
async function runGemini(request: HeadlessAgentRequest): Promise<HeadlessAgentResult> {
  const { child, client } = spawnGeminiAcp(request.workingDirectory);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.on('exit', (code, signal) => client.dispose(new Error(`Antigravity exited with ${code ?? signal}: ${stderr.trim()}`)));
  client.on('serverRequest', (serverRequest) => client.respond(serverRequest.id, { outcome: { outcome: 'cancelled' } }));
  try {
    await initializeGeminiAcp(client);
    const session = await startGeminiSession(client, { cwd: request.workingDirectory });
    await selectGeminiModel(client, session, request.model);
    let message = '';
    client.on('notification', (frame: unknown) => {
      if (!isRecord(frame) || !isRecord(frame.params) || frame.params.sessionId !== session.sessionId || !isRecord(frame.params.update)) return;
      const { update } = frame.params;
      if (update.sessionUpdate === 'agent_message_chunk' && isRecord(update.content) && typeof update.content.text === 'string') {
        message += update.content.text;
      }
    });
    const response = await withTimeout(
      client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: jsonReplyPrompt(request) }] }, { timeoutMs: 0 }),
      request.timeoutSeconds * 1_000,
      'Antigravity turn timed out',
    );
    if (!message) throw new Error('Antigravity returned no final message');
    const usage = isRecord(response) && isRecord(response.usage) ? response.usage : null;
    return {
      output: parseJsonReply(message),
      usage: usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number'
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
        : null,
    };
  } finally {
    client.dispose();
    child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  const [requestPath, outputPath] = process.argv.slice(2);
  if (!requestPath || !outputPath) throw new Error('Usage: okidoki-headless-agent <request.json> <output.json>');
  const request = headlessAgentRequestSchema.parse(JSON.parse(await readFile(requestPath, 'utf8')));
  let result: HeadlessAgentResult;
  switch (request.agent) {
    case AGENT.CLAUDE:
      result = await runClaude(request);
      break;
    case AGENT.CODEX:
      result = await runCodex(request);
      break;
    case AGENT.OPENCODE:
      result = await runOpencode(request);
      break;
    case AGENT.CURSOR:
      result = await runCursor(request);
      break;
    case AGENT.MUSE:
      result = await runMuse(request);
      break;
    case AGENT.GEMINI:
      result = await runGemini(request);
      break;
    case AGENT.PI:
      throw new Error('Send Pi credentials as an Opencode request, which reads the same stored secrets');
    case AGENT.OKIDOKI:
      throw new Error('Okidoki chats run on the harness worker, not the engine');
    default: {
      const unsupported: never = request.agent;
      throw new Error(`Unsupported headless agent: ${String(unsupported)}`);
    }
  }
  await writeFile(outputPath, JSON.stringify(result.output), { mode: 0o600 });
  if (result.usage) await writeFile(headlessAgentUsagePath(outputPath), JSON.stringify(result.usage), { mode: 0o600 });
}

// Exits explicitly: harness SDKs (Cursor's in particular) can keep handles open after the run is over.
main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
});
