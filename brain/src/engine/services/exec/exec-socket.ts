import { randomUUID } from 'crypto';
import { mkdir, open, stat, writeFile } from 'fs/promises';
import { arch, platform } from 'os';
import { dirname, join, resolve } from 'path';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import {
  decodeExecFrame,
  encodeExecFrame,
  EXEC_DEFAULT_READ_BYTES,
  EXEC_ERROR_CODES,
  EXEC_FRAME,
  CODE_MODE_MCP_SERVER,
  EXEC_MAX_FRAME_BYTES,
  EXEC_PING_INTERVAL_MS,
  EXEC_PROTOCOL_VERSION,
  EXEC_SILENCE_TIMEOUT_MS,
  execRequestSchema,
  type ExecErrorBody,
  type ExecErrorCode,
  type ExecEvent,
  type ExecFileInfo,
  type ExecFrameType,
  type ExecJson,
  type ExecHello,
} from '@okidoki/shared';
import { ENGINE_ENV } from '../../engine-env';
import { getManagedPiMcpServers, managedMcpServerProcess } from '../../managers/managed-mcp-servers';
import { engineScriptProcess } from '../../managers/subagent-mcp-config';
import { pullRequestCheckService } from '../pull-request-check-service';
import { processRegistry, type ProcessListener } from './process-registry';

const BOOT_ID = randomUUID();
// Live output to a reader this far behind pauses; it resumes from the process buffer once the socket drains.
const MAX_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 100;

const path = z.string().min(1);
const schemas = {
  hello: z.object({ protocol: z.number().int() }),
  stat: z.object({ path }),
  read: z.object({ path, offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().max(EXEC_MAX_FRAME_BYTES / 2).optional() }),
  write: z.object({ path, append: z.boolean().optional() }),
  exec: execRequestSchema,
  attach: z.object({ processId: z.string(), offset: z.number().int().nonnegative().optional() }),
  kill: z.object({ processId: z.string() }),
  killThread: z.object({ threadId: z.string().min(1) }),
  list: z.object({ threadId: z.string().optional() }),
  input: z.object({ processId: z.string(), end: z.boolean().optional() }),
  mcpServers: z.object({}),
};

class ExecError extends Error {
  constructor(readonly code: ExecErrorCode, message: string, readonly path?: string) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, json: unknown): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ExecError('EINVAL', z.prettifyError(parsed.error));
  return parsed.data;
}

function resolvePath(target: string): string {
  if (target === '~' || target.startsWith('~/')) return join(ENGINE_ENV.HOME_DIR, target.slice(1));
  return resolve(ENGINE_ENV.WORKSPACE_ROOT, target);
}

async function mcpServerProcess(name: string) {
  if (name === CODE_MODE_MCP_SERVER) {
    const gateway = engineScriptProcess('codemode-mcp', []);
    return { file: gateway.command, args: gateway.args, env: undefined };
  }
  const entry = (await getManagedPiMcpServers())[name];
  if (!entry) throw new ExecError('ENOENT', `No MCP server named ${name}`);
  const { command, args, env } = managedMcpServerProcess(entry);
  return { file: command, args, env };
}

function toErrorBody(error: unknown): ExecErrorBody {
  if (error instanceof ExecError) return { code: error.code, message: error.message, path: error.path };
  if (!(error instanceof Error)) return { code: 'unknown', message: String(error) };
  const code = 'code' in error ? EXEC_ERROR_CODES.find((candidate) => candidate === error.code) : undefined;
  const path = 'path' in error && typeof error.path === 'string' ? error.path : undefined;
  return { code: code ?? 'unknown', message: error.message, path };
}

export function attachExecSocket(socket: WebSocket): void {
  const streams = new Map<number, { cancel: () => void; stop: () => void }>();
  let lastHeard = Date.now();
  const send = (type: ExecFrameType, id: number, json?: ExecJson, payload?: Uint8Array) => {
    if (socket.readyState === socket.OPEN) socket.send(encodeExecFrame(type, id, json, payload));
  };
  const sendEvent = (id: number, event: ExecEvent, payload?: Uint8Array) => send(EXEC_FRAME.event, id, event, payload);
  const liveness = setInterval(() => {
    if (Date.now() - lastHeard > EXEC_SILENCE_TIMEOUT_MS) socket.terminate();
    else send(EXEC_FRAME.ping, 0);
  }, EXEC_PING_INTERVAL_MS);

  const follow = (id: number, processId: string, offset: number, onCancel: (stop: () => void) => void) => {
    const managed = processRegistry.get(processId);
    if (!managed) throw new ExecError('ESRCH', `No process ${processId}. The engine forgets processes when it restarts.`);
    let next = offset;
    let paused: ReturnType<typeof setInterval> | undefined;
    let detach = () => {};
    const listener: ProcessListener = {
      output: (chunk) => {
        if (paused || chunk.offset + chunk.data.length <= next) return;
        if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
          detach();
          paused = setInterval(() => {
            if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) return;
            clearInterval(paused);
            paused = undefined;
            start();
          }, DRAIN_POLL_MS);
          return;
        }
        const data = chunk.offset < next ? chunk.data.subarray(next - chunk.offset) : chunk.data;
        sendEvent(id, { kind: 'output', stream: chunk.stream, offset: next }, data);
        next += data.length;
      },
      exit: (exit) => {
        stop();
        send(EXEC_FRAME.result, id, exit);
      },
    };
    const stop = () => {
      clearInterval(paused);
      paused = undefined;
      detach();
      streams.delete(id);
    };
    const start = () => {
      const skipped = Math.max(0, managed.bufferStart - next);
      if (skipped > 0) {
        sendEvent(id, { kind: 'skipped', offset: next, bytes: skipped });
        next += skipped;
      }
      detach = managed.attach(next, listener);
    };
    streams.set(id, { cancel: () => onCancel(stop), stop });
    start();
  };

  const handlers: Record<string, (id: number, json: Record<string, unknown>, payload: Uint8Array) => Promise<ExecJson | undefined>> = {
    hello: async (_id, json) => {
      parse(schemas.hello, json);
      return {
        protocol: EXEC_PROTOCOL_VERSION,
        version: ENGINE_ENV.OKIDOKI_SANDBOX_IMAGE_VERSION,
        os: platform(),
        arch: arch(),
        home: ENGINE_ENV.HOME_DIR,
        root: ENGINE_ENV.WORKSPACE_ROOT,
        bootId: BOOT_ID,
        features: Object.keys(schemas),
      } satisfies ExecHello;
    },
    stat: async (_id, json) => {
      const info = await stat(resolvePath(parse(schemas.stat, json).path));
      const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
      return { kind, size: info.size, mtimeMs: info.mtimeMs } satisfies ExecFileInfo;
    },
    read: async (id, json) => {
      const { path: target, offset = 0, length = EXEC_DEFAULT_READ_BYTES } = parse(schemas.read, json);
      const file = await open(resolvePath(target), 'r');
      try {
        const { size } = await file.stat();
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        send(EXEC_FRAME.result, id, { size }, buffer.subarray(0, bytesRead));
        return undefined;
      } finally {
        await file.close();
      }
    },
    write: async (_id, json, payload) => {
      const { path: target, append } = parse(schemas.write, json);
      const resolved = resolvePath(target);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, payload, { flag: append ? 'a' : 'w' });
      return { bytes: payload.length };
    },
    exec: async (id, json) => {
      const request = parse(schemas.exec, json);
      const cwd = resolvePath(request.cwd ?? '.');
      if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new ExecError('ENOENT', `Working directory not found: ${cwd}`, cwd);
      const [file, ...args] = request.argv ?? ['/bin/bash', request.login === false ? '-c' : '-lc', request.command ?? ''];
      const target = request.mcpServer
        ? { ...await mcpServerProcess(request.mcpServer), command: `mcp ${request.mcpServer}` }
        : { file, args, command: request.command ?? args.join(' ') };
      if (!request.mcpServer) await pullRequestCheckService.observeBranches().catch(() => {});
      const spawned = await processRegistry.spawn({ ...request, ...target, cwd });
      if (!spawned.ok) throw new ExecError('spawn_error', spawned.error.message);
      sendEvent(id, { kind: 'started', processId: spawned.data.id, pid: spawned.data.pid });
      follow(id, spawned.data.id, 0, () => spawned.data.kill('killed'));
      return undefined;
    },
    attach: async (id, json) => {
      const { processId, offset = 0 } = parse(schemas.attach, json);
      follow(id, processId, offset, (stop) => {
        stop();
        send(EXEC_FRAME.error, id, { code: 'aborted', message: 'Detached' } satisfies ExecErrorBody);
      });
      return undefined;
    },
    kill: async (_id, json) => {
      const { processId } = parse(schemas.kill, json);
      const managed = processRegistry.get(processId);
      if (!managed) throw new ExecError('ESRCH', `No process ${processId}`);
      managed.kill('killed');
      return {};
    },
    killThread: async (_id, json) => ({ killed: processRegistry.killThread(parse(schemas.killThread, json).threadId) }),
    list: async (_id, json) => ({ processes: processRegistry.list(parse(schemas.list, json).threadId) }),
    // Synchronous up to the write, so inputs reach stdin in the order they arrive.
    input: async (_id, json, payload) => {
      const { processId, end = false } = parse(schemas.input, json);
      if (!processRegistry.get(processId)?.input(payload, end)) throw new ExecError('ESRCH', `No running process ${processId} with open stdin`);
      return {};
    },
    mcpServers: async (_id, json) => {
      parse(schemas.mcpServers, json);
      const servers = Object.entries(await getManagedPiMcpServers());
      return { servers: servers.map(([name, entry]) => ({ name, ...(entry.requestTimeoutMs ? { timeoutMs: entry.requestTimeoutMs } : {}) })) };
    },
  };

  socket.on('message', (raw: RawData, isBinary) => {
    lastHeard = Date.now();
    const frame = isBinary && Buffer.isBuffer(raw) ? decodeExecFrame(raw) : null;
    if (!frame) {
      socket.close(1003, 'Expected binary exec frames');
      return;
    }
    if (frame.type === EXEC_FRAME.cancel) streams.get(frame.id)?.cancel();
    if (frame.type !== EXEC_FRAME.request) return;
    const handler = typeof frame.json.op === 'string' ? handlers[frame.json.op] : undefined;
    (handler ? handler(frame.id, frame.json, frame.payload) : Promise.reject(new ExecError('ENOTSUP', `Unknown op ${String(frame.json.op)}`)))
      .then((result) => result && send(EXEC_FRAME.result, frame.id, result))
      .catch((error: unknown) => send(EXEC_FRAME.error, frame.id, toErrorBody(error)));
  });
  socket.on('close', () => {
    clearInterval(liveness);
    for (const { stop } of streams.values()) stop();
  });
}
