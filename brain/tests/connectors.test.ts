import { afterEach, expect, spyOn, test } from "bun:test";
import { callTool, closeAll, listTools, reconcile } from "../src/mcp";
import { KNOWN_ACTORS } from "../src/apify";
import { checkConnectorDecision, connectorPrompt, mcpCatalog, runConnector } from "../src/connectors";
import type { McpServerConfig } from "../src/types";

const stdio: McpServerConfig = {
  id: "local-fixture", name: "Local fixture", transport: "stdio", command: process.execPath,
  args: [new URL("fixtures/mcp-server.ts", import.meta.url).pathname],
  env: { OKIDOKI_FIXTURE_SECRET: "test-only-value" },
};
afterEach(closeAll);

// Run the complete HTTP protocol in memory; sandboxed runners cannot bind a TCP socket.
function httpFixture(handler: (request: Request) => Promise<Response>) {
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    handler(new Request(input as string | Request, init)));
  return { port: 43210, stop: (_force: boolean) => mock.mockRestore() };
}

test("stdio MCP discovery, decision, execution and returned output work together", async () => {
  const catalog = await mcpCatalog([stdio], 2000);
  expect(catalog[0].error).toBeUndefined();
  expect(catalog[0].tools.map(tool => tool.name)).toEqual(["echo"]);
  const decision = checkConnectorDecision({ kind: "connector", title: "echo", answer: "Read the local fixture", connectorCall: { connector: "mcp", server: stdio.id, tool: "echo", arguments: { message: "héllo 世界" } } }, { mcpServers: [stdio] }, catalog);
  expect(decision.kind).toBe("connector");
  const result = await runConnector({ runId: crypto.randomUUID(), prompt: "echo", call: JSON.parse(decision.connectorCallJSON!), mcpServers: [stdio] }, undefined);
  expect(result.ok).toBe(true);
  expect(result.output).toContain("héllo 世界");
  expect(result.output).toContain("test-only-value");
});

test("changed secrets, reconnect and disabling servers replace or close the actual process", async () => {
  const read = async (server: McpServerConfig) => JSON.parse((await callTool(server, "echo", {})).text);
  const first = await read(stdio);
  const changed = { ...stdio, env: { OKIDOKI_FIXTURE_SECRET: "new-value" } };
  const second = await read(changed);
  expect(second.pid).not.toBe(first.pid);
  expect(second.secret).toBe("new-value");
  reconcile([changed], true);
  const reconnected = await read(changed);
  expect(reconnected.pid).not.toBe(second.pid);
  reconcile([]);
  await Bun.sleep(30);
  expect(() => process.kill(reconnected.pid, 0)).toThrow();
});

test("disconnected and nonexistent MCP tools cannot become runnable plans", async () => {
  const base = { kind: "connector" as const, title: "test", answer: "", connectorCall: { connector: "mcp" as const, server: "missing", tool: "echo", arguments: {} } };
  expect(checkConnectorDecision(base, {}, []).kind).toBe("answer");
  const result = await runConnector({ runId: "removed", prompt: "test", call: base.connectorCall, mcpServers: [] }, undefined);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("isn't connected");
});

test("streamable HTTP MCP uses credentials, pagination and SSE responses", async () => {
  const seen: { method: string; session: string | null }[] = [];
  const server = httpFixture(async request => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    const message = await request.json() as any;
    seen.push({ method: message.method, session: request.headers.get("mcp-session-id") });
    if (!message.id) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: message.params.cursor ? "second" : "first" }], ...(message.params.cursor ? {} : { nextCursor: "page2" }) }
      : { content: [{ type: "text", text: "HTTP result" }] };
    const data = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    return message.method === "tools/call"
      ? new Response(`event: message\r\ndata: ${data}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json(JSON.parse(data), { headers: { "mcp-session-id": "fixture-session" } });
  });
  try {
    const config: McpServerConfig = { id: "http-fixture", name: "HTTP fixture", transport: "http", url: `http://127.0.0.1:${server.port}`, headers: { Authorization: "Bearer fixture" } };
    expect((await listTools(config)).map(tool => tool.name)).toEqual(["first", "second"]);
    expect((await callTool(config, "first", {})).text).toBe("HTTP result");
    expect(seen.find(item => item.method === "tools/call")?.session).toBe("fixture-session");
  } finally { closeAll(); server.stop(true); }
});

test("a server that times out is discarded, allowing the same configuration to recover", async () => {
  let slow = true, initialized = 0;
  const server = httpFixture(async request => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const message = await request.json() as any;
    if (!message.id) return new Response(null, { status: 202 });
    if (message.method === "initialize") initialized++;
    if (message.method === "tools/list" && slow) await Bun.sleep(100);
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "recovered" }] } });
  });
  try {
    const config: McpServerConfig = { id: "timeout", name: "Timeout fixture", transport: "http", url: `http://127.0.0.1:${server.port}` };
    await expect(listTools(config, 20)).rejects.toThrow();
    slow = false;
    expect((await listTools(config, 1000))[0].name).toBe("recovered");
    expect(initialized).toBe(2);
  } finally { closeAll(); server.stop(true); }
});

test("Stop cancels a connector call promptly and duplicate approval cannot call twice", async () => {
  const { stopConnector } = await import("../src/connectors");
  await listTools(stdio);
  const request = { runId: "cancel-fixture", prompt: "wait", call: { connector: "mcp" as const, server: stdio.id, tool: "echo", arguments: { delay: 1000 } }, mcpServers: [stdio] };
  const running = runConnector(request, undefined);
  const duplicate = await runConnector(request, undefined);
  expect(duplicate.ok).toBe(false);
  expect(duplicate.error).toContain("already running");
  await Bun.sleep(20);
  const start = Date.now();
  expect(stopConnector(request.runId)).toBe(true);
  const result = await running;
  expect(Date.now() - start).toBeLessThan(300);
  expect(result.ok).toBe(false);
  expect(result.error).toBe("stopped by you");
  expect(stopConnector(request.runId)).toBe(false);
  expect((await callTool(stdio, "echo", { message: "still connected" })).text).toContain("still connected");
});

test("a dead stdio server is restarted instead of serving its cached tools forever", async () => {
  await listTools(stdio);
  const first = JSON.parse((await callTool(stdio, "echo", {})).text);
  process.kill(first.pid, "SIGTERM");
  await Bun.sleep(30);
  expect((await listTools(stdio)).map(tool => tool.name)).toEqual(["echo"]);
  const second = JSON.parse((await callTool(stdio, "echo", {})).text);
  expect(second.pid).not.toBe(first.pid);
});

test("HTTP MCP negotiates the protocol version and rejects mismatched response ids", async () => {
  let invalid = false;
  const server = httpFixture(async request => {
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const message = await request.json() as any;
    if (!message.id) return new Response(null, { status: 202 });
    if (message.method !== "initialize") expect(request.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    return Response.json({ jsonrpc: "2.0", id: invalid ? message.id + 1 : message.id, result: message.method === "initialize" ? { protocolVersion: "2025-03-26" } : { tools: [{ name: "echo" }] } });
  });
  const config: McpServerConfig = { id: "negotiation", name: "Negotiation fixture", transport: "http", url: `http://127.0.0.1:${server.port}` };
  try {
    expect((await listTools(config))[0].name).toBe("echo");
    invalid = true;
    await expect(callTool(config, "echo", {})).rejects.toThrow("invalid response id");
  } finally { closeAll(); server.stop(true); }
});

test("every known Apify actor reaches the prompt with a valid example input and a cost", () => {
  const prompt = connectorPrompt({ apify: true }, []);
  const ids = KNOWN_ACTORS.map(actor => actor.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("harvestapi/linkedin-profile-scraper");
  for (const actor of KNOWN_ACTORS) {
    expect(actor.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(actor.cost.length).toBeGreaterThan(0);
    expect(() => JSON.parse(actor.input)).not.toThrow();
    expect(prompt).toContain(`· ${actor.id} — ${actor.use}. cost: ${actor.cost}. input: ${actor.input}`);
  }
  expect(connectorPrompt({ apify: false }, [])).not.toContain("Apify");
});

test("Apify execution passes credentials, input and the spending cap through to returned results", async () => {
  const server = httpFixture(async request => {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v2/acts/fixture~actor/run-sync-get-dataset-items");
    expect(url.searchParams.get("maxTotalChargeUsd")).toBe("0.25");
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
    expect(await request.json()).toEqual({ queries: "fixture" });
    return Response.json([{ title: "Fixture result", url: "https://example.com/fixture" }]);
  });
  try {
    const result = await runConnector({ runId: "apify-fixture", prompt: "find fixture", call: { connector: "apify", actor: "fixture/actor", input: { queries: "fixture" } }, apifyToken: "fixture-token", spendingLimit: 0.25 }, undefined);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1 result from fixture/actor");
    expect(result.output).toContain("Fixture result");
  } finally { server.stop(true); }
});

test("Apify falls back to the key the Mac put in the environment, and refuses plainly with none", async () => {
  const saved = process.env.APIFY_API_KEY;
  const server = httpFixture(async request => {
    expect(request.headers.get("authorization")).toBe("Bearer env-token");
    return Response.json([{ title: "From env" }]);
  });
  const request = { runId: "apify-env", prompt: "fixture", call: { connector: "apify" as const, actor: "fixture/actor", input: {} } };
  try {
    process.env.APIFY_API_KEY = "env-token";
    const result = await runConnector(request, undefined);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("From env");
    delete process.env.APIFY_API_KEY;
    const refused = await runConnector(request, undefined);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("Apify key");
  } finally {
    if (saved === undefined) delete process.env.APIFY_API_KEY; else process.env.APIFY_API_KEY = saved;
    server.stop(true);
  }
});

test("Apify failures reach the result and Stop aborts the pending HTTP request", async () => {
  const { stopConnector } = await import("../src/connectors");
  let wait = false, began!: () => void;
  const started = new Promise<void>(resolve => began = resolve);
  const server = httpFixture(async request => {
    if (!wait) return new Response("unauthorized", { status: 401 });
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      began();
    });
  });
  const request = { runId: "apify-failure", prompt: "fixture", call: { connector: "apify" as const, actor: "fixture/actor", input: {} }, apifyToken: "fixture-token" };
  try {
    const failed = await runConnector(request, undefined);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("rejected the key");
    wait = true;
    const running = runConnector(request, undefined);
    await started;
    expect(stopConnector(request.runId)).toBe(true);
    expect((await running).error).toBe("stopped by you");
  } finally { server.stop(true); }
});
