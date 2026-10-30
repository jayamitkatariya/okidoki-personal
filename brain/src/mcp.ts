import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import type { McpServerConfig, McpToolInfo } from "./types";

// A small Model Context Protocol client: stdio servers (a command we spawn) and streamable HTTP servers.
// Only what okidoki needs: initialize, list tools, call a tool.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "okidoki", version: "0.9.1" };

/** The brain's own credentials stay with the brain: MCP servers don't inherit them. */
const PRIVATE_ENV = ["ANTHROPIC_API_KEY", "APIFY_API_KEY", "CARTESIA_API_KEY", "MOSS_PROJECT_ID", "MOSS_PROJECT_KEY",
  "OKIDOKI_SYNC_SECRET", "OKIDOKI_BRAIN_TOKEN", "OKIDOKI_BRAIN_PORT", "CONVEX_DEPLOY_KEY"];

export function hostEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of PRIVATE_ENV) delete env[name];
  return env;
}

type JsonRpcResponse = { id?: number; method?: string; result?: any; error?: { code: number; message: string } };

interface Transport {
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements Transport {
  private proc: ChildProcess;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private exited: string | null = null;
  private closed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(server: McpServerConfig, onExit: () => void) {
    const home = process.env.HOME ?? "";
    const extraPath = ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.opencode/bin`, `${home}/.hermes/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`, `${home}/bin`];
    this.proc = spawn((server.command ?? "").replace(/^~(?=\/)/, home), server.args ?? [], {
      env: { ...hostEnvironment(), PATH: [...extraPath, process.env.PATH ?? ""].join(delimiter), ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    const fail = (reason: string) => {
      this.exited = reason;
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
      onExit();
    };
    this.proc.on("error", (error) => fail(`couldn't start ${server.command}: ${error.message}`));
    this.proc.on("exit", (code) => fail(`${server.name} exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`));
    this.proc.stdin?.on("error", (error) => fail(`${server.name} closed its input: ${error.message}`));
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; skip anything that isn't JSON-RPC
      }
      if (!message || typeof message !== "object") continue;
      if (message.method) {
        if (message.id !== undefined) {
          try {
            this.write({ jsonrpc: "2.0", id: message.id, ...(message.method === "ping"
              ? { result: {} } : { error: { code: -32601, message: "Unsupported client method" } }) });
          } catch {}
        }
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else if (!Object.hasOwn(message, "result")) waiter.reject(new Error("Invalid JSON-RPC response"));
      else waiter.resolve(message.result);
    }
  }

  private write(message: unknown) {
    if (this.exited) throw new Error(this.exited);
    this.proc.stdin?.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Stopped by you" } }); } catch {}
        waiter?.reject(new Error("stopped by you"));
      };
      const timer = setTimeout(() => {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        waiter?.reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.get(id)?.reject(error as Error);
        this.pending.delete(id);
      }
    });
  }

  async notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.exited = "MCP connection closed";
    for (const { reject } of this.pending.values()) reject(new Error(this.exited));
    this.pending.clear();
    if (this.proc.pid) {
      try { process.kill(-this.proc.pid, "SIGTERM"); } catch { this.proc.kill(); }
      const timer = setTimeout(() => {
        try { process.kill(-this.proc.pid!, "SIGKILL"); } catch {}
      }, 750);
      timer.unref();
      this.proc.once("close", () => clearTimeout(timer));
    }
  }
}

class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private lifetime = new AbortController();

  constructor(private server: McpServerConfig) {}

  private headers(): Headers {
    const headers = new Headers(this.server.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    if (this.protocolVersion) headers.set("mcp-protocol-version", this.protocolVersion);
    return headers;
  }

  private async post(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.server.url ?? "", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 401 || response.status === 403) throw new Error(`${this.server.name} rejected the credentials (${response.status})`);
    if (!response.ok && response.status !== 202) throw new Error(`${this.server.name} answered ${response.status}`);
    return response;
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    const type = response.headers.get("content-type") ?? "";
    const message = type.includes("text/event-stream") ? await readEvent(response, id) : ((await response.json()) as JsonRpcResponse);
    if (!message || message.id !== id) throw new Error(`${this.server.name} returned an invalid response id`);
    if (message.error) throw new Error(message.error.message);
    if (!Object.hasOwn(message, "result")) throw new Error(`${this.server.name} returned an invalid JSON-RPC response`);
    if (method === "initialize") this.protocolVersion = message.result?.protocolVersion || PROTOCOL_VERSION;
    return message.result;
  }

  async notify(method: string, params?: unknown) {
    const response = await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, 10_000);
    await response.body?.cancel();
  }

  close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort(new Error("MCP connection closed"));
    if (!this.sessionId) return;
    // Polite session teardown; servers that don't support it just ignore the request.
    fetch(this.server.url ?? "", { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

// Reads a server-sent event stream until the JSON-RPC response with our id arrives.
async function readEvent(response: Response, id: number): Promise<JsonRpcResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty event stream");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (message.id === id) return message;
        } catch {}
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new Error("the server closed the stream without answering");
}

interface Connection {
  key: string;
  transport: Transport;
  ready: Promise<void>;
  tools?: McpToolInfo[];
}

const connections = new Map<string, Connection>();

// Same id with a changed command, url or secret means a new connection.
function configKey(server: McpServerConfig): string {
  return JSON.stringify([server.transport, server.command, server.args, server.url, server.env, server.headers]);
}

function connect(server: McpServerConfig): Connection {
  const invalid = validateMcpServer(server);
  if (invalid) throw new Error(invalid);
  const key = configKey(server);
  const existing = connections.get(server.id);
  if (existing && existing.key === key) return existing;
  existing?.transport.close();
  const transport: Transport = server.transport === "http" ? new HttpTransport(server) : new StdioTransport(server, () => {
    if (connections.get(server.id)?.transport === transport) connections.delete(server.id);
  });
  const ready = (async () => {
    await transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, 30_000);
    await transport.notify("notifications/initialized");
  })();
  const connection: Connection = { key, transport, ready };
  connections.set(server.id, connection);
  // A failed start shouldn't stick: drop it so the next call retries from scratch.
  ready.catch(() => {
    if (connections.get(server.id) === connection) connections.delete(server.id);
    transport.close();
  });
  return connection;
}

export async function listTools(server: McpServerConfig, timeoutMs = 30_000): Promise<McpToolInfo[]> {
  const connection = connect(server);
  if (connection.tools) return connection.tools;
  const work = (async () => {
    await connection.ready;
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await connection.transport.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      for (const tool of page?.tools ?? []) {
        tools.push({ name: String(tool.name), description: tool.description ? String(tool.description) : "", inputSchema: tool.inputSchema ?? {} });
      }
      cursor = page?.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error(`${server.name} repeated a tool-list cursor`);
      if (cursor) cursors.add(cursor);
    } while (cursor);
    connection.tools = tools;
    return tools;
  })();
  try {
    return await withTimeout(work, timeoutMs, `${server.name} took too long to list its tools`);
  } catch (error) {
    if (connections.get(server.id) === connection) forget(server.id);
    throw error;
  }
}

export async function callTool(server: McpServerConfig, name: string, args: Record<string, unknown>, timeoutMs = 120_000, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
  signal?.throwIfAborted();
  const connection = connect(server);
  await withTimeout(connection.ready, 30_000, `${server.name} didn't start`, signal);
  signal?.throwIfAborted();
  let result;
  try {
    result = await connection.transport.request("tools/call", { name, arguments: args }, timeoutMs, signal);
  } catch (error) {
    if (!signal?.aborted && connections.get(server.id) === connection) forget(server.id);
    throw error;
  }
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (block.type === "text") parts.push(String(block.text));
    else if (block.type === "resource" && block.resource?.text) parts.push(String(block.resource.text));
    else if (block.type === "image") parts.push("[image]");
  }
  if (!parts.length && result?.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return { text: parts.join("\n\n"), isError: Boolean(result?.isError) };
}

export function forget(id: string) {
  connections.get(id)?.transport.close();
  connections.delete(id);
}

/** The dashboard sends its complete enabled set, including an empty set when MCP is off. */
export function reconcile(servers: McpServerConfig[], reconnect = false) {
  const keep = new Set(servers.map(server => server.id));
  for (const id of connections.keys()) {
    if (reconnect || !keep.has(id)) forget(id);
  }
}

export function validateMcpServer(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "MCP server configuration required";
  const server = value as McpServerConfig;
  if (typeof server.id !== "string" || !server.id.trim() || typeof server.name !== "string" || !server.name.trim()) return "MCP server id and name required";
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || !server.command.trim() || server.command.includes("\0")) return "MCP command required";
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) return "MCP arguments must be strings";
  } else if (server.transport === "http") {
    try { if (!["http:", "https:"].includes(new URL(server.url ?? "").protocol)) return "MCP URL must use HTTP or HTTPS"; }
    catch { return "MCP server URL is invalid"; }
  } else return "MCP transport must be stdio or http";
  for (const pairs of [server.env, server.headers]) {
    if (pairs !== undefined && (!pairs || typeof pairs !== "object" || Array.isArray(pairs) || Object.values(pairs).some(value => typeof value !== "string"))) return "MCP environment and headers must contain strings";
  }
}

export function closeAll() {
  for (const connection of connections.values()) connection.transport.close();
  connections.clear();
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("stopped by you")); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
