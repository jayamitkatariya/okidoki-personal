import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import quickjsVariant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise } from 'quickjs-emscripten-core';
import { z } from 'zod';
import { getManagedPiMcpServers, managedMcpServerProcess } from './managers/managed-mcp-servers';
import { renderCatalog, searchTools, toolSignature, type CatalogTool } from './utils/codemode-catalog';
import { isRecord } from './utils/type-guards';

const { values } = parseArgs({ options: { config: { type: 'string' } }, strict: true });
// About 2,000 tokens, the budget OpenCode's Code Mode gives its tool listing.
const LISTING_BUDGET_CHARS = 8_000;

const STARTUP_WAIT_MS = 6_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;
const MAX_EXECUTE_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_CHARS = 40_000;

const servers = Object.entries(await getManagedPiMcpServers(values.config));
const namespaceOf = (name: string) => name.replace(/[^A-Za-z0-9_$]/g, '_');
const namespaceOwners = new Map(servers.toReversed().map(([name]) => [namespaceOf(name), name]));
const clients = new Map<string, Client>();
const catalog: CatalogTool[] = [];
const failed: string[] = [];
const connecting = new Set(servers.map(([name]) => name));

const connections = Promise.all(servers.map(async ([name, entry]) => {
  const namespace = namespaceOf(name);
  try {
    const owner = namespaceOwners.get(namespace);
    if (owner !== name) throw new Error(`its name reads as tools.${namespace}, which ${owner} already uses; rename one`);
    const client = new Client({ name: 'okidoki-codemode', version: '1.0.0' });
    const { command, args, env } = managedMcpServerProcess(entry);
    await client.connect(new StdioClientTransport({
      command,
      args,
      env: { ...Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)), ...env },
      stderr: 'ignore',
    }));
    const listed: Tool[] = [];
    for (let cursor: string | undefined; ;) {
      const page = await client.listTools({ cursor });
      listed.push(...page.tools);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    clients.set(namespace, client);
    catalog.push(...listed.map((tool) => ({ namespace, name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })));
    catalog.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  } catch (error) {
    failed.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
  }
  connecting.delete(name);
}));
await Promise.race([connections, new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS))]);

async function callTool(namespace: string, name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const client = clients.get(namespace);
  const tool = catalog.find((entry) => entry.namespace === namespace && entry.name === name);
  if (!client || !tool) {
    const closest = searchTools(catalog, `${namespace} ${name}`).slice(0, 3).map((entry) => toolSignature(entry, false));
    throw new Error(`Unknown tool tools.${namespace}.${name}.${closest.length ? ` Did you mean:\n${closest.join('\n')}` : ' Use the search tool to find tools.'}`);
  }
  const result = await client.callTool({ name, arguments: isRecord(input) ? input : {} }, undefined, { signal, timeout: MAX_EXECUTE_TIMEOUT_MS, resetTimeoutOnProgress: true });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
  if (result.isError) throw new Error(`tools.${namespace}.${name} failed: ${text || JSON.stringify(content)}`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text.length === 0 && content.length > 0) return content;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const quickjs = await newQuickJSWASMModuleFromVariant(quickjsVariant);
const SCRIPT_MEMORY_BYTES = 256 * 1024 * 1024;
// A script computing runs on the gateway's only thread, so one that never yields is stopped long before its time limit.
const MAX_UNBROKEN_COMPUTE_MS = 10_000;

const PRELUDE = `
globalThis.tools = new Proxy({}, { get: (_, namespace) => new Proxy({}, { get: (_, name) => (input) =>
  __call(String(namespace), String(name), JSON.stringify(input === undefined ? {} : input)).then(JSON.parse) }) });
const show = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.name + ': ' + value.message;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};
const log = (...values) => __log(values.map(show).join(' '));
globalThis.console = { log, info: log, warn: log, error: log, debug: log };
`;

/**
 * Scripts run in QuickJS, a JavaScript engine with no filesystem, network or process: `tools` is their only way out.
 * The harness checks shell commands before running them, and a script must not be a way around that.
 */
function execute(code: string, timeoutMs: number, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const runtime = quickjs.newRuntime();
    runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);
    let computingSince = Date.now();
    let stopped: string | undefined;
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline) stopped = `The script did not finish within ${timeoutMs} ms. Pass a larger timeout_ms if the work needs it.`;
      else if (Date.now() - computingSince > MAX_UNBROKEN_COMPUTE_MS) stopped = `The script computed for more than ${MAX_UNBROKEN_COMPUTE_MS / 1000} seconds without awaiting a tool call, so it was stopped. Check it for a loop that never ends.`;
      return stopped !== undefined;
    });
    const lines = code.split('\n').length;
    const context = runtime.newContext();
    const abort = new AbortController();
    const waiting = new Set<QuickJSDeferredPromise>();
    const logs: string[] = [];
    let calls = 0;
    let settled = false;

    const settle = (outcome: { value?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      abort.abort();
      // A script stopped mid-run leaves values the engine still counts as live, which makes its teardown throw.
      try {
        for (const deferred of waiting) deferred.dispose();
        context.dispose();
        runtime.dispose();
      } catch {
        // The engine's memory is dropped with the module either way.
      }
      const sections: string[] = [];
      if (outcome.error !== undefined) sections.push(outcome.error);
      else if (outcome.value !== undefined) sections.push(outcome.value);
      else if (!logs.length) sections.push(`The script returned nothing${calls ? ` after ${calls} tool call${calls === 1 ? '' : 's'}` : ''}. End it with \`return <value>\` to read a result.`);
      if (logs.length) sections.push(`[console]\n${logs.join('\n')}`);
      const text = sections.join('\n\n');
      resolve({
        text: text.length > MAX_OUTPUT_CHARS
          ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Output cut at ${MAX_OUTPUT_CHARS} of ${text.length} characters. Return only the fields you need.]`
          : text,
        isError: outcome.error !== undefined,
      });
    };
    const cancel = () => settle({ error: 'The call was cancelled.' });
    const timer = setTimeout(() => settle({ error: `The script did not finish within ${timeoutMs} ms. Pass a larger timeout_ms if the work needs it.` }), timeoutMs);
    signal.addEventListener('abort', cancel);

    const describe = (error: unknown): string => {
      if (stopped) return stopped;
      if (!isRecord(error)) return String(error);
      // The wrapper puts the script one line down.
      const line = Number(/script\.js:(\d+)/.exec(String(error.stack ?? ''))?.[1]) - 1;
      return `${String(error.name ?? 'Error')}: ${String(error.message)}${line >= 1 && line <= lines ? ` (script line ${line})` : ''}`;
    };
    const runJobs = () => {
      if (settled) return;
      computingSince = Date.now();
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const error = describe(context.dump(jobs.error));
        jobs.error.dispose();
        settle({ error });
      }
    };

    context.newFunction('__log', (line) => {
      logs.push(context.getString(line));
    }).consume((handle) => context.setProp(context.global, '__log', handle));
    context.newFunction('__call', (namespace, name, input) => {
      calls += 1;
      const deferred = context.newPromise();
      waiting.add(deferred);
      const finish = (settleWith: 'resolve' | 'reject', text: string) => {
        if (settled) return;
        waiting.delete(deferred);
        const value = settleWith === 'resolve' ? context.newString(text) : context.newError(text);
        deferred[settleWith](value);
        value.dispose();
        deferred.dispose();
        runJobs();
      };
      callTool(context.getString(namespace), context.getString(name), JSON.parse(context.getString(input)), abort.signal).then(
        (value) => finish('resolve', JSON.stringify(value === undefined ? null : value)),
        (error: unknown) => finish('reject', error instanceof Error ? error.message : String(error)),
      );
      return deferred.handle;
    }).consume((handle) => context.setProp(context.global, '__call', handle));
    context.unwrapResult(context.evalCode(PRELUDE, 'prelude.js')).dispose();

    computingSince = Date.now();
    const evaluated = context.evalCode(`(async () => {\n${code}\n})().then((value) => { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch (cause) { throw new Error("The script's return value cannot be written as JSON (" + cause.message + "). Return plain data."); } })`, 'script.js');
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      return settle({ error: `Script does not parse. ${describe(error)}` });
    }
    const outcome = context.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    void outcome.then((result) => {
      if (settled) return;
      if (result.error) {
        const error = describe(context.dump(result.error));
        result.error.dispose();
        return settle({ error });
      }
      const value: unknown = context.dump(result.value);
      result.value.dispose();
      settle({ value: typeof value === 'string' ? value : undefined });
    });
    runJobs();
  });
}

const server = new McpServer({ name: 'codemode', version: '1.0.0' }, {
  instructions: `Tools callable inside \`execute\` as \`tools.<server>.<tool>(input)\`. A tool listed without \`(...)\` arguments needs \`search\` first to get its signature.\n${renderCatalog(catalog, failed, [...connecting], LISTING_BUDGET_CHARS)}`,
});

server.registerTool('search', {
  description: 'Find tools callable inside `execute`. Returns each match as a TypeScript signature with its parameter docs. Pass `server` with an empty query to list the tools on one server.',
  inputSchema: {
    query: z.string().describe('Words describing what you need, or a tool name.'),
    server: z.string().optional().describe('Only search this server.'),
    limit: z.number().int().min(1).max(50).optional().describe('Most signatures to return. Defaults to 8.'),
    offset: z.number().int().min(0).optional().describe('Skip this many matches, to read past the first `limit`.'),
  },
  annotations: { readOnlyHint: true },
}, ({ query, server: namespace, limit, offset = 0 }) => {
  const matches = searchTools(catalog, query, namespace);
  const shown = matches.slice(offset, offset + (limit ?? 8));
  const rest = matches.length - offset - shown.length;
  return { content: [{ type: 'text', text: shown.length
    ? `${shown.map((tool) => toolSignature(tool, true)).join('\n\n')}${rest > 0 ? `\n\n${rest} more matched. Pass offset: ${offset + shown.length} to read on.` : ''}`
    : 'No tools matched. Try other words, or list a server with an empty query.' }] };
});

server.registerTool('execute', {
  description: [
    'Run JavaScript that calls tools from the connected MCP servers, and get back only what the script returns.',
    'Call a tool as `await tools.<server>.<tool>({ ...input })`. It resolves to the parsed result (JSON when the tool returns JSON, otherwise text) and throws when the tool fails.',
    'Do the whole job in one script: run independent calls with `Promise.all`, loop over pages, filter, join and aggregate in code, and `return` only the answer. Intermediate results stay out of your context.',
    'The script is the body of an async JavaScript function: `await` and `return` work at the top level, and `console.log` output comes back with the result. It has no filesystem, shell or modules; use your other tools for those.',
    'When you do not know the shape of a result, return one sample before writing the full script.',
    'The servers and their tools are listed in the instructions of this MCP server.',
  ].join('\n'),
  inputSchema: {
    code: z.string().describe('The JavaScript to run.'),
    timeout_ms: z.number().int().min(1_000).max(MAX_EXECUTE_TIMEOUT_MS).optional().describe(`Stop the script after this long. Defaults to ${DEFAULT_EXECUTE_TIMEOUT_MS}.`),
  },
}, async ({ code, timeout_ms }, { signal }) => {
  const { text, isError } = await execute(code, timeout_ms ?? DEFAULT_EXECUTE_TIMEOUT_MS, signal);
  return { content: [{ type: 'text', text }], isError };
});

await server.connect(new StdioServerTransport());
