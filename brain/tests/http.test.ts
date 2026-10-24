import { test, expect } from "bun:test";
const token = crypto.randomUUID();
process.env.OKIDOKI_BRAIN_TOKEN = token;
// These cases assert the no-key path. A developer .env must not satisfy them.
delete process.env.ANTHROPIC_API_KEY;
const { handleRequest } = await import("../src/server");
const base = "http://127.0.0.1:4319";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
// Exercise the real HTTP handler and streamed Responses without binding a socket.
const fetch = (url: string, init?: RequestInit) => handleRequest(new Request(url, init));

test("sidecar rejects unauthenticated and browser-origin requests", async () => {
  expect((await fetch(base + "/health")).status).toBe(401);
  expect((await fetch(base + "/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "untrusted", kind: "terminal", commands: ["echo forbidden"] }) })).status).toBe(401);
  expect((await fetch(base + "/execute", { method: "POST", headers: { ...headers, origin: "https://example.com" }, body: "{}" })).status).toBe(401);
});

test("think and computer use refuse without an anthropic key", async () => {
  const think = await fetch(base + "/think", { method: "POST", headers, body: JSON.stringify({ text: "teach me figma" }) });
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

test("an approved plan streams output and success", async () => {
  const result = await fetch(base + "/execute", { method: "POST", headers, body: JSON.stringify({ runId: crypto.randomUUID(), kind: "terminal", commands: ["printf okidoki"] }) });
  expect(result.headers.get("content-type")).toBe("text/event-stream");
  const stream = await result.text();
  expect(stream).toContain("event: started");
  expect(stream).toContain("event: output");
  expect(stream).toContain("okidoki");
  expect(stream).toContain("event: done");
  expect(stream).toContain('"code":0');
  expect(stream).not.toContain("event: error");
});

test("teach grounding without a key returns no marks", async () => {
  const response = await fetch(base + "/teach/ground", {
    method: "POST",
    headers,
    body: JSON.stringify({ topic: "figma", say: "press F", stepIndex: 0, stepCount: 6, space: "screen" }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { marks: unknown[] };
  expect(body.marks).toEqual([]);
});

test("a live teach step needs a topic and refuses without a key", async () => {
  const missing = await fetch(base + "/teach/step", { method: "POST", headers, body: JSON.stringify({ log: [] }) });
  expect(missing.status).toBe(400);
  const response = await fetch(base + "/teach/step", {
    method: "POST",
    headers,
    body: JSON.stringify({ topic: "auto layout", app: "Figma", outline: ["press F"], log: [], stepNumber: 1, imageWidth: 0, imageHeight: 0 }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { step: unknown; usedModel: boolean; error?: string };
  expect(body.step).toBeNull();
  expect(body.usedModel).toBe(false);
  expect(body.error?.toLowerCase()).toContain("anthropic key");
});

test("a zoomed refine needs a crop and keeps the first guess without a key", async () => {
  const missing = await fetch(base + "/teach/refine", { method: "POST", headers, body: JSON.stringify({ describe: "frame tool" }) });
  expect(missing.status).toBe(400);
  const response = await fetch(base + "/teach/refine", {
    method: "POST",
    headers,
    body: JSON.stringify({ cropBase64: "aGk=", cropWidth: 680, cropHeight: 460, describe: "frame tool" }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { found: boolean };
  expect(body.found).toBe(false);
});

test("HTTP rejects malformed commands before opening an event stream", async () => {
  for (const body of [{}, { runId: "bad", kind: "terminal", commands: ["cat {{file}}"] }, { runId: "bad", kind: "terminal", commands: ["rm -rf /"] }]) {
    const response = await fetch(base + "/execute", { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
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

test("MCP toolbox discovery, reconnect, invocation and removal work through HTTP routes", async () => {
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

test("HTTP terminal controls pause, resume and stop the streamed job and its child", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "okidoki-http-stop-"));
  const runId = crypto.randomUUID();
  const post = (path: string, payload: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
  try {
    const response = await post("/execute", { runId, kind: "terminal", workingDirectory: dir, commands: ["sleep 5; touch later"] });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect((await (await post("/pause", { runId })).json() as any).paused).toBe(true);
    expect((await (await post("/resume", { runId })).json() as any).resumed).toBe(true);
    expect((await (await post("/stop", { runId })).json() as any).stopped).toBe(true);
    const events = await response.text();
    expect(events).toContain("event: cancelled");
    expect(events).not.toContain("event: done");
    expect(await Bun.file(join(dir, "later")).exists()).toBe(false);
  } finally { (await import("../src/executor")).stop(runId); await rm(dir, { recursive: true, force: true }); }
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
