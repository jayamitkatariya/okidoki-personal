import type { z } from 'zod';
import { createErrorResult, createSuccessResult, type Result } from '../result';
import {
  decodeExecFrame,
  encodeExecFrame,
  EXEC_FRAME,
  EXEC_PING_INTERVAL_MS,
  EXEC_PROTOCOL_VERSION,
  EXEC_SILENCE_TIMEOUT_MS,
  EXEC_SOCKET_PATH,
  execErrorBodySchema,
  execEventSchema,
  execReplySchemas,
  type ExecErrorCode,
  type ExecEvent,
  type ExecExit,
  type ExecFileInfo,
  type ExecHello,
  type ExecMcpServer,
  type ExecJson,
  type ExecOutputChunk,
  type ExecProcessInfo,
  type ExecRequest,
  type ExecStarted,
  type ExecWriteResult,
} from './exec-protocol';

/** Node's and Bun's `WebSocket` take headers as a second argument; browsers cannot send them. */
type ExecWebSocketConstructor = new (url: string, options: { headers: Record<string, string> }) => WebSocket;

interface ExecClientOptions {
  url: string;
  headers: Record<string, string>;
  WebSocket?: ExecWebSocketConstructor;
}

interface ExecStreamOptions {
  onStart?: (started: ExecStarted) => void;
  onOutput?: (chunk: ExecOutputChunk) => void;
  /** Output that left the process's buffer before this client read it. */
  onSkipped?: (bytes: number) => void;
  /** Aborting `exec` kills the process; aborting `attach` only detaches. */
  signal?: AbortSignal;
}

type ExecResult<T> = Result<T, ExecErrorCode>;
interface Reply {
  json: Record<string, unknown>;
  payload: Uint8Array;
}
interface Connection {
  socket: WebSocket;
  pending: Map<number, Pending>;
}
interface Pending {
  resolve: (reply: ExecResult<Reply>) => void;
  onEvent?: (event: ExecEvent, payload: Uint8Array) => void;
}

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
// Long enough to ride out a worker's network blip or a VM waking from sleep.
const RECONNECT_GIVE_UP_MS = 2 * 60_000;
const encoder = new TextEncoder();

function parseReply<T>(schema: z.ZodType<T>, json: unknown): ExecResult<T> {
  const parsed = schema.safeParse(json);
  return parsed.success ? createSuccessResult(parsed.data) : createErrorResult({ code: 'unknown', message: `Malformed reply from the exec daemon: ${parsed.error.message}` });
}

const lost = (message: string) => createErrorResult<ExecErrorCode>({ code: 'lost', message });

/**
 * One multiplexed connection to an exec daemon. Requests run in parallel; the socket opens on first use and again
 * after it drops. Exec and attach streams survive a drop: they re-attach by process id from the last offset they saw.
 */
export class ExecClient {
  private connection: Promise<Connection> | null = null;
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: ExecClientOptions) {}

  hello(): Promise<ExecResult<ExecHello>> {
    return this.call('hello', { protocol: EXEC_PROTOCOL_VERSION }, execReplySchemas.hello);
  }

  stat(path: string): Promise<ExecResult<ExecFileInfo>> {
    return this.call('stat', { path }, execReplySchemas.stat);
  }

  /** Reads a byte range (default: from the start, up to 8 MiB). `size` is the whole file's. */
  async readFile(path: string, range: { offset?: number; length?: number } = {}): Promise<ExecResult<{ data: Uint8Array; size: number }>> {
    const reply = await this.request('read', { path, ...range });
    if (!reply.ok) return reply;
    const json = parseReply(execReplySchemas.read, reply.data.json);
    return json.ok ? createSuccessResult({ data: reply.data.payload, size: json.data.size }) : json;
  }

  /** Creates missing parent directories. */
  writeFile(path: string, content: string | Uint8Array, options: { append?: boolean } = {}): Promise<ExecResult<ExecWriteResult>> {
    return this.call('write', { path, ...options }, execReplySchemas.write, typeof content === 'string' ? encoder.encode(content) : content);
  }

  /** Runs a process that outlives this connection; resolves when it exits. */
  exec(request: ExecRequest, options: ExecStreamOptions = {}): Promise<ExecResult<ExecExit>> {
    return this.stream({ op: 'exec', ...request }, null, 0, options);
  }

  attach(processId: string, options: ExecStreamOptions & { offset?: number } = {}): Promise<ExecResult<ExecExit>> {
    return this.stream(null, processId, options.offset ?? 0, options);
  }

  kill(processId: string): Promise<ExecResult<Record<string, never>>> {
    return this.call('kill', { processId }, execReplySchemas.kill);
  }

  input(processId: string, data: string | Uint8Array, end = false): Promise<ExecResult<Record<string, never>>> {
    return this.call('input', { processId, end }, execReplySchemas.input, typeof data === 'string' ? encoder.encode(data) : data);
  }

  /** The workspace's MCP servers, by name only: their commands, URLs and credentials stay on the VM. */
  async mcpServers(): Promise<ExecResult<ExecMcpServer[]>> {
    const reply = await this.call('mcpServers', {}, execReplySchemas.mcpServers);
    return reply.ok ? createSuccessResult(reply.data.servers) : reply;
  }

  async killThread(threadId: string): Promise<ExecResult<number>> {
    const reply = await this.call('killThread', { threadId }, execReplySchemas.killThread);
    return reply.ok ? createSuccessResult(reply.data.killed) : reply;
  }

  async list(threadId?: string): Promise<ExecResult<ExecProcessInfo[]>> {
    const reply = await this.call('list', { threadId }, execReplySchemas.list);
    return reply.ok ? createSuccessResult(reply.data.processes) : reply;
  }

  /** Closes the socket. Processes keep running. */
  close(): void {
    this.closed = true;
    void this.connection?.then(({ socket }) => socket.close(), () => {});
    this.connection = null;
  }

  private async call<T>(op: string, json: ExecJson, schema: z.ZodType<T>, payload?: Uint8Array): Promise<ExecResult<T>> {
    const reply = await this.request(op, json, { payload });
    return reply.ok ? parseReply(schema, reply.data.json) : reply;
  }

  private async stream(start: (ExecRequest & { op: 'exec' }) | null, processId: string | null, offset: number, options: ExecStreamOptions): Promise<ExecResult<ExecExit>> {
    let next = offset;
    let id = processId;
    let lostSince: number | null = null;
    for (let attempt = 0; ; attempt++) {
      const body = id ? { op: 'attach', processId: id, offset: next } : start;
      if (!body) return createErrorResult({ code: 'EINVAL', message: 'Nothing to run' });
      const reply = await this.request(body.op, body, {
        signal: options.signal,
        onEvent: (event, payload) => {
          if (event.kind === 'started') {
            id = event.processId;
            options.onStart?.({ processId: event.processId, pid: event.pid });
          } else if (event.kind === 'skipped') {
            options.onSkipped?.(event.bytes);
            next = event.offset + event.bytes;
          } else if (event.offset + payload.length > next) {
            const data = payload.subarray(Math.max(0, next - event.offset));
            options.onOutput?.({ stream: event.stream, offset: next, data });
            next += data.length;
          }
        },
      });
      if (reply.ok) return parseReply(execReplySchemas.exit, reply.data.json);
      // Lost before the daemon named the process: whether it started is unknown; `list(threadId)` tells.
      if (reply.error.code !== 'lost' || !id || this.closed) return reply;
      if (options.signal?.aborted) {
        if (start) await this.kill(id);
        return createErrorResult({ code: 'aborted', message: 'Aborted while disconnected' });
      }
      lostSince ??= Date.now();
      if (Date.now() - lostSince > RECONNECT_GIVE_UP_MS) return reply;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]));
    }
  }

  private async request(op: string, json: ExecJson, extra: { payload?: Uint8Array; signal?: AbortSignal; onEvent?: Pending['onEvent'] } = {}): Promise<ExecResult<Reply>> {
    if (extra.signal?.aborted) return createErrorResult({ code: 'aborted', message: 'Aborted' });
    let connection: Connection;
    try {
      connection = await this.connect();
    } catch (error) {
      return lost(error instanceof Error ? error.message : String(error));
    }
    const { socket, pending } = connection;
    const id = this.nextId++;
    const done = new Promise<ExecResult<Reply>>((resolve) => pending.set(id, { resolve, onEvent: extra.onEvent }));
    const cancel = () => {
      if (socket.readyState === socket.OPEN) socket.send(encodeExecFrame(EXEC_FRAME.cancel, id));
    };
    extra.signal?.addEventListener('abort', cancel, { once: true });
    socket.send(encodeExecFrame(EXEC_FRAME.request, id, { ...json, op }, extra.payload));
    const reply = await done;
    extra.signal?.removeEventListener('abort', cancel);
    return reply;
  }

  private connect(): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error('Client closed'));
    if (this.connection) return this.connection;
    const pending = new Map<number, Pending>();
    const connection = new Promise<Connection>((resolve, reject) => {
      const url = new URL(EXEC_SOCKET_PATH, this.options.url.replace(/^http/, 'ws'));
      const Constructor = this.options.WebSocket ?? (globalThis.WebSocket as unknown as ExecWebSocketConstructor);
      const socket = new Constructor(url.toString(), { headers: this.options.headers });
      socket.binaryType = 'arraybuffer';
      let lastHeard = Date.now();
      let dropped = false;
      const liveness = setInterval(() => {
        if (Date.now() - lastHeard > EXEC_SILENCE_TIMEOUT_MS) drop('No reply from the exec daemon');
        else if (socket.readyState === socket.OPEN) socket.send(encodeExecFrame(EXEC_FRAME.ping, 0));
      }, EXEC_PING_INTERVAL_MS);
      // Settles this socket's requests at once, without waiting for a close handshake a dead link never finishes.
      const drop = (reason: string) => {
        if (dropped) return;
        dropped = true;
        clearInterval(liveness);
        if (this.connection === connection) this.connection = null;
        socket.close();
        reject(new Error(reason));
        for (const request of pending.values()) request.resolve(lost(reason));
        pending.clear();
      };
      socket.addEventListener('open', () => resolve({ socket, pending }));
      socket.addEventListener('close', (event) => drop(`Exec socket closed (${event.code})`));
      socket.addEventListener('error', () => drop('Exec socket failed'));
      socket.addEventListener('message', (event) => {
        lastHeard = Date.now();
        const frame = event.data instanceof ArrayBuffer ? decodeExecFrame(new Uint8Array(event.data)) : null;
        const request = frame && pending.get(frame.id);
        if (!frame || !request) return;
        if (frame.type === EXEC_FRAME.event) {
          const event = execEventSchema.safeParse(frame.json);
          if (event.success) request.onEvent?.(event.data, frame.payload);
          return;
        }
        pending.delete(frame.id);
        request.resolve(frame.type === EXEC_FRAME.result
          ? createSuccessResult({ json: frame.json, payload: frame.payload })
          : createErrorResult(execErrorBodySchema.safeParse(frame.json).data ?? { code: 'unknown', message: 'Malformed error from the exec daemon' }));
      });
    });
    this.connection = connection;
    return connection;
  }
}
