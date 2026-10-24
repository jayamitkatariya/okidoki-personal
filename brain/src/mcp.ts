import { spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import type { McpServerConfig, McpToolInfo } from "./types";

// A small Model Context Protocol client: stdio servers (a command we spawn) and streamable HTTP servers.
// Only what okidoki needs: initialize, list tools, call a tool.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "okidoki", version: "0.9.1" };

type JsonRpcResponse = { id?: number; result?: any; error?: { code: number; message: string } };

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements Transport {
  private proc: ChildProcess;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private exited: string | null = null;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(server: McpServerConfig) {
    const home = process.env.HOME ?? "";
    const extraPath = ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`];
    this.proc = spawn(server.command ?? "", server.args ?? [], {
      env: { ...process.env, PATH: [...extraPath, process.env.PATH ?? ""].join(delimiter), ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
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
    };
    this.proc.on("error", (error) => fail(`couldn't start ${server.command}: ${error.message}`));
    this.proc.on("exit", (code) => fail(`${server.name} exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`));
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
      if (typeof message.id !== "number") continue;
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  }

  private write(message: unknown) {
    if (this.exited) throw new Error(this.exited);
    this.proc.stdin?.write(JSON.stringify(message) + "\n");
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.get(id)?.reject(error as Error);
      }
    });
  }

  async notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  close() {
    this.proc.kill();
  }
}

class HttpTransport implements Transport {
  private nextId = 1;
  private sessionId: string | null = null;
  private negotiated = false;

  constructor(private server: McpServerConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.server.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.negotiated) headers["mcp-protocol-version"] = PROTOCOL_VERSION;
    return headers;
  }

  private async post(message: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const response = await fetch(this.server.url ?? "", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 401 || response.status === 403) throw new Error(`${this.server.name} rejected the credentials (${response.status})`);
    if (!response.ok && response.status !== 202) throw new Error(`${this.server.name} answered ${response.status}`);
    return response;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (method === "initialize") this.negotiated = true;
    const type = response.headers.get("content-type") ?? "";
    const message = type.includes("text/event-stream") ? await readEvent(response, id) : ((await response.json()) as JsonRpcResponse);
    if (message.error) throw new Error(message.error.message);
    return message.result;
  }

  async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, 10_000);
  }

  close() {
    if (!this.sessionId) return;
    // Polite session teardown; servers that don't support it just ignore the request.
    fetch(this.server.url ?? "", { method: "DELETE", headers: this.headers() }).catch(() => {});
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
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
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
  const key = configKey(server);
  const existing = connections.get(server.id);
  if (existing && existing.key === key) return existing;
  existing?.transport.close();
  const transport: Transport = server.transport === "http" ? new HttpTransport(server) : new StdioTransport(server);
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
    do {
      const page = await connection.transport.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      for (const tool of page?.tools ?? []) {
        tools.push({ name: String(tool.name), description: tool.description ? String(tool.description) : "", inputSchema: tool.inputSchema ?? {} });
      }
      cursor = page?.nextCursor;
    } while (cursor);
    connection.tools = tools;
    return tools;
  })();
  return withTimeout(work, timeoutMs, `${server.name} took too long to list its tools`);
}

export async function callTool(server: McpServerConfig, name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<{ text: string; isError: boolean }> {
  const connection = connect(server);
  await withTimeout(connection.ready, 30_000, `${server.name} didn't start`);
  const result = await connection.transport.request("tools/call", { name, arguments: args }, timeoutMs);
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

export function closeAll() {
  for (const connection of connections.values()) connection.transport.close();
  connections.clear();
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
