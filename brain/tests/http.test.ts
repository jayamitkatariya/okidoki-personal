import { test, expect } from "bun:test";
import { fakeAPI, systemText } from "./fixtures/fake-api";
const token = crypto.randomUUID();
process.env.OKIDOKI_BRAIN_TOKEN = token;
// These cases assert the no-key path. A developer .env must not satisfy them.
delete process.env.ANTHROPIC_API_KEY;
const { handleRequest } = await import("../src/server");
const base = "http://127.0.0.1:4329";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
// Exercise the real HTTP handler and streamed Responses without binding a socket.
const fetch = (url: string, init?: RequestInit) => handleRequest(new Request(url, init));

test("sidecar rejects unauthenticated and browser-origin requests", async () => {
  expect((await fetch(base + "/health")).status).toBe(401);
  expect((await fetch(base + "/think", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "open figma" }) })).status).toBe(401);
  expect((await fetch(base + "/think", { method: "POST", headers: { ...headers, origin: "https://example.com" }, body: "{}" })).status).toBe(401);
});

test("think and computer use refuse without an anthropic key", async () => {
  const think = await fetch(base + "/think", { method: "POST", headers, body: JSON.stringify({ text: "how do i use figma" }) });
  expect(think.ok).toBe(true);
  const thought = await think.json() as { decision: { kind: string; answer: string }; usedModel: boolean };
  expect(thought.usedModel).toBe(false);
  expect(thought.decision.kind).toBe("answer");
  expect(thought.decision.answer.toLowerCase()).toContain("isn't available");
  const drive = await fetch(base + "/computer", { method: "POST", headers, body: JSON.stringify({ goal: "open figma", step: 0, history: [] }) });
  expect(drive.ok).toBe(true);
  const acted = await drive.json() as { action: { type: string; reason?: string }; usedModel: boolean };
  expect(acted.usedModel).toBe(false);
  expect(acted.action.type).toBe("fail");
  expect(acted.action.reason?.toLowerCase()).toContain("isn't available");
});

test("/think never hands a task to a coding agent or a shell job", async () => {
  const text = "can you use hermes agent in terminal to find my bridge presentation pptx file";
  const response = await fetch(base + "/think", { method: "POST", headers, body: JSON.stringify({ text }) });
  expect(response.ok).toBe(true);
  const thought = await response.json() as { decision: { kind: string; commands?: string[] }; usedModel: boolean };
  expect(thought.usedModel).toBe(false);
  expect(thought.decision.kind).toBe("answer");
  expect(thought.decision.commands).toBeUndefined();
});

test("the removed terminal, toolbox and teach routes are gone", async () => {
  for (const [method, path] of [
    ["POST", "/execute"], ["POST", "/pause"], ["POST", "/resume"], ["GET", "/tools"], ["GET", "/tools/find?q=zip"],
    ["POST", "/teach/ground"], ["POST", "/teach/step"], ["POST", "/teach/refine"], ["POST", "/teach/concept/stream"], ["POST", "/teach/concept/follow"],
  ]) {
    const response = await fetch(base + path, { method, headers, body: method === "POST" ? JSON.stringify({ runId: "x", topic: "figma" }) : undefined });
    expect([path, response.status]).toEqual([path, 404]);
  }
  const health = await (await fetch(base + "/health", { headers })).json() as Record<string, unknown>;
  expect(health.ok).toBe(true);
  expect(health.tools).toBeUndefined();
  expect(health.agents).toBeUndefined();
});

test("malformed connector requests are rejected before invoking a service", async () => {
  for (const payload of [null, {}, { runId: "job", call: { connector: "unknown" } }, { runId: "job", call: { connector: "mcp", server: "missing" } }, { runId: "job", call: { connector: "apify", actor: "" } }]) {
    const response = await fetch(base + "/connector/run", { method: "POST", headers, body: JSON.stringify(payload) });
    expect(response.status).toBe(400);
  }
});

test("the Apify key check uses the request token, then the environment, and never calls out with neither", async () => {
  const saved = process.env.APIFY_API_KEY;
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ data: { username: "fixture" } });
  }) as typeof globalThis.fetch;
  const check = (body: unknown) => fetch(base + "/apify/check", { method: "POST", headers, body: JSON.stringify(body) });
  try {
    delete process.env.APIFY_API_KEY;
    const none = await (await check({})).json() as { ok: boolean; error?: string };
    expect(none.ok).toBe(false);
    expect(none.error).toContain("No Apify key");
    expect(seen).toEqual([]);
    process.env.APIFY_API_KEY = "env-token";
    expect((await (await check({})).json() as { ok: boolean }).ok).toBe(true);
    expect((await (await check({ token: "given-token" })).json() as { ok: boolean }).ok).toBe(true);
    expect(seen).toEqual(["Bearer env-token", "Bearer given-token"]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.APIFY_API_KEY; else process.env.APIFY_API_KEY = saved;
  }
});

test("MCP discovery, reconnect, invocation and removal work through HTTP routes", async () => {
  const server = { id: "http-route-fixture", name: "Route fixture", transport: "stdio", command: process.execPath, args: [new URL("fixtures/mcp-server.ts", import.meta.url).pathname] };
  const post = (path: string, payload: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
  try {
    const discovery = await (await post("/mcp/tools", { servers: [server], reconnect: true })).json() as any;
    expect(discovery.servers[0].ok).toBe(true);
    expect(discovery.servers[0].tools[0].name).toBe("echo");
    const run = await (await post("/connector/run", { runId: "route-echo", prompt: "echo", call: { connector: "mcp", server: server.id, tool: "echo", arguments: { message: "route output" } }, mcpServers: [server] })).json() as any;
    expect(run.ok).toBe(true);
    expect(run.output).toContain("route output");
    const pid = JSON.parse(run.output).pid;
    expect((await post("/mcp/tools", { servers: [] })).ok).toBe(true);
    await Bun.sleep(30);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { (await import("../src/mcp")).closeAll(); }
});

test("bad MCP configurations cannot close working connections or produce ambiguous status ids", async () => {
  for (const servers of [[null], [{ id: "bad", name: "bad", transport: "other" }], [{ id: "bad", name: "bad", transport: "stdio", command: "node", args: [42] }], [{ id: "bad", name: "bad", transport: "http", url: "file:///tmp/mcp" }]]) {
    const response = await fetch(base + "/mcp/tools", { method: "POST", headers, body: JSON.stringify({ servers }) });
    expect(response.status).toBe(400);
  }
  const server = { id: "duplicate", name: "fixture", transport: "stdio", command: "node" };
  expect((await fetch(base + "/mcp/tools", { method: "POST", headers, body: JSON.stringify({ servers: [server, server] }) })).status).toBe(400);
});

test("connector Stop works through the same dashboard control endpoint", async () => {
  const server = { id: "stop-route", name: "Stop fixture", transport: "stdio", command: process.execPath, args: [new URL("fixtures/mcp-server.ts", import.meta.url).pathname] };
  const post = (path: string, payload: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
  try {
    await post("/mcp/tools", { servers: [server] });
    const running = post("/connector/run", { runId: "route-stop", prompt: "wait", call: { connector: "mcp", server: server.id, tool: "echo", arguments: { delay: 1000 } }, mcpServers: [server] });
    expect((await (await post("/stop", { runId: "route-stop" })).json() as any).stopped).toBe(true);
    expect((await (await running).json() as any).error).toBe("stopped by you");
  } finally { (await import("../src/mcp")).closeAll(); }
});

test("/memory/status reports the index by kind, so the dashboard can show what Moss holds", async () => {
  const response = await fetch(base + "/memory/status", { headers });
  expect(response.ok).toBe(true);
  const status = await response.json() as { ready: boolean; documents: number; notes: number; messages: number; runs: number; skills: number; lastSyncAt?: string; error?: string };
  // No Moss credentials in tests: the index is off, and says so without an error.
  expect(status.ready).toBe(false);
  expect(status.documents).toBe(0);
  expect(status.notes + status.messages + status.runs + status.skills).toBe(status.documents);
  expect(status.lastSyncAt).toBeUndefined();
  const sync = await fetch(base + "/memory/sync", { method: "POST", headers, body: JSON.stringify({ memories: [] }) });
  expect(sync.status).toBe(400);
});

test("a body that isn't JSON, or isn't an object, is a 400 with a reason — never a stack trace", async () => {
  for (const path of ["/stop", "/mcp/forget", "/apify/check"]) {
    const broken = await fetch(`http://localhost${path}`, { method: "POST", headers, body: "{bad" });
    expect([path, broken.status]).toEqual([path, 400]);
    expect(((await broken.json()) as { error: string }).error).toContain("JSON");
    const bare = await fetch(`http://localhost${path}`, { method: "POST", headers, body: "null" });
    expect([path, bare.status]).toEqual([path, 400]);
    const missing = await fetch(`http://localhost${path}`, { method: "POST", headers, body: "{}" });
    // {} is an object; the route then says which field it wanted (apify/check falls back to the environment)
    expect([path, missing.status]).toEqual([path, path === "/apify/check" ? 200 : 400]);
  }
});
