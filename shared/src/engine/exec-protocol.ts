import { z } from 'zod';

export const EXEC_SOCKET_PATH = '/v1/exec/ws';
export const EXEC_PROTOCOL_VERSION = 1;
export const EXEC_PING_INTERVAL_MS = 5_000;
/** A side that hears nothing for this long drops the socket. Processes keep running. */
export const EXEC_SILENCE_TIMEOUT_MS = 20_000;
export const EXEC_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const EXEC_DEFAULT_READ_BYTES = 8 * 1024 * 1024;
export const EXEC_PROCESS_BUFFER_BYTES = 2 * 1024 * 1024;
export const EXEC_DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const EXEC_MAX_IDLE_TTL_MS = 24 * 60 * 60_000;

export const EXEC_FRAME = { request: 1, result: 2, error: 3, event: 4, cancel: 5, ping: 6 } as const;
export type ExecFrameType = (typeof EXEC_FRAME)[keyof typeof EXEC_FRAME];

interface ExecFrame {
  type: ExecFrameType;
  id: number;
  json: ExecJson;
  payload: Uint8Array;
}

const HEADER_BYTES = 9;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ExecJson = Record<string, unknown>;

/** `u8 type | u32 id | u32 jsonLength | json | payload`, big-endian; one frame per websocket message. */
export function encodeExecFrame(type: ExecFrameType, id: number, json: ExecJson = {}, payload?: Uint8Array): Uint8Array {
  const body = encoder.encode(JSON.stringify(json));
  const frame = new Uint8Array(HEADER_BYTES + body.length + (payload?.length ?? 0));
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, id);
  view.setUint32(5, body.length);
  frame.set(body, HEADER_BYTES);
  if (payload) frame.set(payload, HEADER_BYTES + body.length);
  return frame;
}

export function decodeExecFrame(data: Uint8Array): ExecFrame | null {
  if (data.length < HEADER_BYTES) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  const jsonLength = view.getUint32(5);
  if (type < EXEC_FRAME.request || type > EXEC_FRAME.ping || HEADER_BYTES + jsonLength > data.length) return null;
  try {
    const json: unknown = JSON.parse(decoder.decode(data.subarray(HEADER_BYTES, HEADER_BYTES + jsonLength)));
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
    return { type: type as ExecFrameType, id: view.getUint32(1), json: json as Record<string, unknown>, payload: data.subarray(HEADER_BYTES + jsonLength) };
  } catch {
    return null;
  }
}

export const EXEC_ERROR_CODES = [
  'ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EEXIST', 'EINVAL', 'EFBIG', 'ESRCH', 'ENOTSUP', 'spawn_error', 'aborted', 'lost', 'unknown',
] as const;
export type ExecErrorCode = (typeof EXEC_ERROR_CODES)[number];

export type ExecErrorBody = {
  code: ExecErrorCode;
  message: string;
  path?: string;
};

export interface ExecHello {
  protocol: number;
  version: string;
  os: string;
  arch: string;
  home: string;
  /** Where relative paths and a missing `cwd` resolve. */
  root: string;
  /** Changes when the daemon restarts, which forgets every process. */
  bootId: string;
  features: string[];
}

export interface ExecFileInfo {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

interface ExecReadResult {
  /** Size of the whole file, so a reader knows whether its range reached the end. */
  size: number;
}

export interface ExecWriteResult {
  bytes: number;
}

export type ExecStream = 'stdout' | 'stderr';

export const execRequestSchema = z.object({
  /** The thread that owns the process; ending the thread kills its processes. */
  threadId: z.string().min(1),
  label: z.string().max(200).optional(),
  /** Run through bash; `login` (default true) sources the login profile like Codex's `bash -lc`. */
  command: z.string().min(1).optional(),
  argv: z.array(z.string()).min(1).optional(),
  /** A workspace MCP server by name. The daemon resolves its command or URL and credentials, so callers never see them. */
  mcpServer: z.string().min(1).optional(),
  login: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Kill after this long, whoever is attached. */
  timeoutMs: z.number().int().positive().optional(),
  /** Kill after this long with nobody attached. */
  idleTtlMs: z.number().int().positive().max(EXEC_MAX_IDLE_TTL_MS).optional(),
  stdin: z.boolean().optional(),
}).refine((body) => [body.command, body.argv, body.mcpServer].filter((value) => value !== undefined).length === 1, { message: 'Pass exactly one of command, argv or mcpServer' });

export type ExecRequest = z.infer<typeof execRequestSchema>;

export type ExecStarted = {
  processId: string;
  pid: number;
};

/** The engine's code mode gateway, which a harness opens like any workspace MCP server. An engine from before it reports ENOENT. */
export const CODE_MODE_MCP_SERVER = 'okidoki-codemode';

export type ExecExitReason = 'exit' | 'timeout' | 'killed' | 'idle';

export type ExecExit = {
  exitCode: number;
  signal: string | null;
  reason: ExecExitReason;
};

/** Output from `offset` (bytes since the process started, per process, both streams together). */
export interface ExecOutputChunk {
  stream: ExecStream;
  offset: number;
  data: Uint8Array;
}

export interface ExecProcessInfo extends ExecStarted {
  threadId: string;
  label: string | null;
  command: string;
  startedAt: string;
  /** Offset after the last output byte. */
  outputBytes: number;
  /** Oldest offset still buffered; an attach from before it reports the gap as skipped. */
  bufferStart: number;
  exit: ExecExit | null;
}

export interface ExecMcpServer {
  name: string;
  timeoutMs?: number;
}

export type ExecEvent =
  | ({ kind: 'started' } & ExecStarted)
  | { kind: 'output'; stream: ExecStream; offset: number }
  | { kind: 'skipped'; offset: number; bytes: number };

const execStartedSchema = z.object({ processId: z.string(), pid: z.number() });
const execExitSchema = z.object({ exitCode: z.number(), signal: z.string().nullable(), reason: z.enum(['exit', 'timeout', 'killed', 'idle']) });

export const execReplySchemas = {
  hello: z.object({
    protocol: z.number(), version: z.string(), os: z.string(), arch: z.string(), home: z.string(), root: z.string(), bootId: z.string(), features: z.array(z.string()),
  }) satisfies z.ZodType<ExecHello>,
  stat: z.object({ kind: z.enum(['file', 'directory', 'symlink', 'other']), size: z.number(), mtimeMs: z.number() }) satisfies z.ZodType<ExecFileInfo>,
  read: z.object({ size: z.number() }) satisfies z.ZodType<ExecReadResult>,
  write: z.object({ bytes: z.number() }) satisfies z.ZodType<ExecWriteResult>,
  exit: execExitSchema satisfies z.ZodType<ExecExit>,
  kill: z.object({}).strip() satisfies z.ZodType<Record<string, never>>,
  killThread: z.object({ killed: z.number() }),
  input: z.object({}).strip() satisfies z.ZodType<Record<string, never>>,
  mcpServers: z.object({ servers: z.array(z.object({ name: z.string(), timeoutMs: z.number().optional() })) }) satisfies z.ZodType<{ servers: ExecMcpServer[] }>,
  list: z.object({
    processes: z.array(execStartedSchema.extend({
      threadId: z.string(), label: z.string().nullable(), command: z.string(), startedAt: z.string(), outputBytes: z.number(), bufferStart: z.number(), exit: execExitSchema.nullable(),
    })),
  }) satisfies z.ZodType<{ processes: ExecProcessInfo[] }>,
};

export const execEventSchema = z.discriminatedUnion('kind', [
  execStartedSchema.extend({ kind: z.literal('started') }),
  z.object({ kind: z.literal('output'), stream: z.enum(['stdout', 'stderr']), offset: z.number() }),
  z.object({ kind: z.literal('skipped'), offset: z.number(), bytes: z.number() }),
]) satisfies z.ZodType<ExecEvent>;

export const execErrorBodySchema = z.object({ code: z.enum(EXEC_ERROR_CODES), message: z.string(), path: z.string().optional() }) satisfies z.ZodType<ExecErrorBody>;
