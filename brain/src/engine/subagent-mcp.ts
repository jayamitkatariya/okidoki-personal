import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  SUBAGENT_MCP_SERVER_NAME,
  SUBAGENT_MCP_TOOLS,
  SUBAGENT_SERVICE_TIERS,
  serviceTierRequestFields,
  messageSubagentRequestSchema,
  readSseStream,
  spawnSubagentRequestSchema,
  subagentResponseSchema,
  waitSubagentRequestSchema,
} from '@okidoki/shared';
import { z } from 'zod';

const { values } = parseArgs({
  options: { parent: { type: 'string' } },
  strict: true,
});
const parentChatId = values.parent;
const port = process.env.OKIDOKI_ENGINE_PORT;
const secret = process.env.OKIDOKI_ENGINE_SECRET;
if (!parentChatId) throw new Error('--parent is required');
if (!port || !secret) throw new Error('Okidoki engine environment is unavailable');
const enginePort = port;
const engineSecret = secret;

async function request(path: string, method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<string> {
  const response = await fetch(`http://localhost:${enginePort}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Okidoki-Engine-Secret': engineSecret,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Subagent request failed (${response.status})`);
  return text || JSON.stringify({ success: true });
}

// A cancelled tool call must close the wait, or the engine hands the result to a call nobody reads and never reports it.
async function waitForAgent(chatId: string, timeoutMinutes: number | undefined, signal: AbortSignal): Promise<string> {
  const query = timeoutMinutes ? `?timeoutMinutes=${timeoutMinutes}` : '';
  const response = await fetch(`http://localhost:${enginePort}/chats/${parentChatId}/subagents/${chatId}/wait${query}`, {
    headers: {
      Accept: 'text/event-stream',
      'X-Okidoki-Engine-Secret': engineSecret,
    },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text() || `Subagent wait failed (${response.status})`);
  let result: string | undefined;
  await readSseStream<unknown>(response.body, (event) => {
    const parsed = subagentResponseSchema.safeParse(event);
    if (parsed.success) {
      result = JSON.stringify(parsed.data);
      return;
    }
    const failure = z.object({ error: z.string(), details: z.string().optional() }).safeParse(event);
    if (failure.success) throw new Error(failure.data.details || failure.data.error);
    throw new Error('Subagent wait stream returned an invalid response');
  });
  if (!result) throw new Error('Subagent wait stream ended without a result');
  return result;
}

const serviceTier = z.enum(SUBAGENT_SERVICE_TIERS).optional().describe(
  'Service tier for this turn: fast uses fast mode on Claude and Codex models that support it; ultrafast is Codex-only and falls back to fast. Other providers ignore it.',
);

function serviceTierFields(tier: z.infer<typeof serviceTier>) {
  return tier ? serviceTierRequestFields(tier) : {};
}

const server = new McpServer({ name: SUBAGENT_MCP_SERVER_NAME, version: '1.0.0' });

server.registerTool(SUBAGENT_MCP_TOOLS.getProviders, {
  description: 'List the agent providers allowed for subagents.',
}, async () => ({
  content: [{ type: 'text', text: await request(`/chats/${parentChatId}/subagents`, 'GET') }],
}));

server.registerTool(SUBAGENT_MCP_TOOLS.spawnAgent, {
  description: 'Spawn a child agent with all, none, or the latest N turns of parent context. Blocks by default; set blocking to false to return its chat ID immediately, and its final response reaches you as a message once your turn ends.',
  inputSchema: {
    provider: spawnSubagentRequestSchema.shape.provider.describe('Provider returned by get_providers.'),
    prompt: spawnSubagentRequestSchema.shape.prompt.describe('The child’s assigned task, scope, and expected result. Include all necessary context when fork_turns is none.'),
    fork_turns: spawnSubagentRequestSchema.shape.forkTurns.describe('Parent context to inherit: all (default), none, or a positive integer string such as 3 for the latest 3 user-led turns, including the current turn.'),
    model: spawnSubagentRequestSchema.shape.model,
    thinking_level: spawnSubagentRequestSchema.shape.thinkingLevel,
    service_tier: serviceTier,
    title: spawnSubagentRequestSchema.shape.title,
    blocking: z.boolean().optional().describe('Wait for the child to finish. Defaults to true.'),
    timeout_minutes: waitSubagentRequestSchema.shape.timeoutMinutes.describe('Maximum time to wait without interrupting the child.'),
  },
}, async ({ provider, prompt, fork_turns, model, thinking_level, service_tier, title, blocking, timeout_minutes }, { signal }) => {
  const created = await request(`/chats/${parentChatId}/subagents`, 'POST', {
      provider,
      prompt,
      forkTurns: fork_turns,
      ...(model ? { model } : {}),
      ...(thinking_level ? { thinkingLevel: thinking_level } : {}),
      ...serviceTierFields(service_tier),
      ...(title ? { title } : {}),
  });
  const createdAgent = subagentResponseSchema.parse(JSON.parse(created));
  return { content: [{ type: 'text', text: blocking === false ? created : await waitForAgent(createdAgent.chatId, timeout_minutes, signal) }] };
});

server.registerTool(SUBAGENT_MCP_TOOLS.getAgent, {
  description: 'Get the current status and final response, if available, for one of this chat’s subagents.',
  inputSchema: { chat_id: z.string().uuid() },
}, async ({ chat_id }) => ({
  content: [{ type: 'text', text: await request(`/chats/${parentChatId}/subagents/${chat_id}`, 'GET') }],
}));

server.registerTool(SUBAGENT_MCP_TOOLS.waitAgent, {
  description: 'Wait for one of this chat’s subagents to finish over a heartbeat stream. A timeout, or a new message from the user, stops waiting without interrupting the child.',
  inputSchema: {
    chat_id: z.string().uuid(),
    timeout_minutes: waitSubagentRequestSchema.shape.timeoutMinutes,
  },
}, async ({ chat_id, timeout_minutes }, { signal }) => ({
  content: [{ type: 'text', text: await waitForAgent(chat_id, timeout_minutes, signal) }],
}));

server.registerTool(SUBAGENT_MCP_TOOLS.messageAgent, {
  description: 'Send a follow-up to one of this chat’s subagents. Blocks by default; set blocking to false to return immediately, and its reply reaches you as a message once your turn ends.',
  inputSchema: {
    chat_id: z.string().uuid(),
    message: messageSubagentRequestSchema.shape.message,
    model: messageSubagentRequestSchema.shape.model,
    thinking_level: messageSubagentRequestSchema.shape.thinkingLevel,
    service_tier: serviceTier,
    blocking: z.boolean().optional().describe('Wait for the child to finish. Defaults to true.'),
    timeout_minutes: waitSubagentRequestSchema.shape.timeoutMinutes.describe('Maximum time to wait without interrupting the child.'),
  },
}, async ({ chat_id, message, model, thinking_level, service_tier, blocking, timeout_minutes }, { signal }) => {
  const accepted = await request(`/chats/${parentChatId}/subagents/${chat_id}/messages`, 'POST', {
      message,
      ...(model ? { model } : {}),
      ...(thinking_level ? { thinkingLevel: thinking_level } : {}),
      ...serviceTierFields(service_tier),
  });
  return { content: [{ type: 'text', text: blocking === false ? accepted : await waitForAgent(chat_id, timeout_minutes, signal) }] };
});

server.registerTool(SUBAGENT_MCP_TOOLS.deleteAgent, {
  description: 'Delete one of this chat’s subagents.',
  inputSchema: { chat_id: z.string().uuid() },
}, async ({ chat_id }) => ({
  content: [{ type: 'text', text: await request(`/chats/${parentChatId}/subagents/${chat_id}`, 'DELETE') }],
}));

await server.connect(new StdioServerTransport());
