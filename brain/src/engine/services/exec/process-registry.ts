import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { randomUUID } from 'crypto';
import { constants } from 'os';
import {
  createErrorResult,
  createSuccessResult,
  EXEC_DEFAULT_IDLE_TTL_MS,
  EXEC_PROCESS_BUFFER_BYTES,
  type ExecErrorCode,
  type ExecExit,
  type ExecExitReason,
  type ExecProcessInfo,
  type ExecStream,
  type Result,
} from '@okidoki/shared';
import { buildCodexAgentEnv } from '../../utils/codex-agent-env';

const KILL_GRACE_MS = 2_000;
// A command that backgrounds a server keeps our pipes open after it exits; stop waiting shortly after.
const EXIT_DRAIN_MS = 100;
const EXITED_RETENTION_MS = 10 * 60_000;

interface Chunk {
  stream: ExecStream;
  offset: number;
  data: Buffer;
}

export interface ProcessListener {
  output(chunk: Chunk): void;
  exit(exit: ExecExit): void;
}

interface SpawnOptions {
  threadId: string;
  label?: string;
  file: string;
  args: string[];
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  idleTtlMs?: number;
  stdin?: boolean;
}

class ManagedProcess {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly chunks: Chunk[] = [];
  private bufferedBytes = 0;
  outputBytes = 0;
  exit: ExecExit | null = null;
  private killReason: ExecExitReason | null = null;
  private readonly listeners = new Set<ProcessListener>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly options: SpawnOptions,
    private readonly child: ChildProcessByStdio<Writable, Readable, Readable>,
    private readonly onForget: () => void,
  ) {
    if (options.timeoutMs) this.timeoutTimer = setTimeout(() => this.kill('timeout'), options.timeoutMs);
    this.armIdleTimer();
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  get bufferStart(): number {
    return this.outputBytes - this.bufferedBytes;
  }

  info(): ExecProcessInfo {
    return {
      processId: this.id,
      pid: this.pid,
      threadId: this.options.threadId,
      label: this.options.label ?? null,
      command: this.options.command,
      startedAt: this.startedAt,
      outputBytes: this.outputBytes,
      bufferStart: this.bufferStart,
      exit: this.exit,
    };
  }

  append(stream: ExecStream, data: Buffer): void {
    const chunk = { stream, offset: this.outputBytes, data };
    this.outputBytes += data.length;
    this.chunks.push(chunk);
    this.bufferedBytes += data.length;
    while (this.bufferedBytes > EXEC_PROCESS_BUFFER_BYTES && this.chunks.length > 1) {
      this.bufferedBytes -= this.chunks[0].data.length;
      this.chunks.shift();
    }
    for (const listener of this.listeners) listener.output(chunk);
  }

  finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.exit) return;
    clearTimeout(this.timeoutTimer);
    this.exit = {
      exitCode: exitCode ?? 128 + (signal ? constants.signals[signal] : 0),
      signal,
      reason: this.killReason ?? 'exit',
    };
    for (const listener of this.listeners) listener.exit(this.exit);
    this.armIdleTimer();
  }

  attach(offset: number, listener: ProcessListener): () => void {
    for (const chunk of this.chunks) {
      if (chunk.offset + chunk.data.length <= offset) continue;
      const data = chunk.offset < offset ? chunk.data.subarray(offset - chunk.offset) : chunk.data;
      listener.output({ ...chunk, offset: Math.max(chunk.offset, offset), data });
    }
    if (this.exit) {
      listener.exit(this.exit);
      return () => {};
    }
    this.listeners.add(listener);
    clearTimeout(this.idleTimer);
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) this.armIdleTimer();
    };
  }

  input(data: Uint8Array, end: boolean): boolean {
    const stdin = this.child.stdin;
    if (this.exit || stdin.writableEnded) return false;
    if (data.length > 0) stdin.write(data);
    if (end) stdin.end();
    return true;
  }

  kill(reason: ExecExitReason): void {
    if (this.exit) return;
    this.killReason ??= reason;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-this.pid, signal);
      } catch {
        // The group already exited.
      }
    };
    signalGroup('SIGTERM');
    setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer);
    if (this.listeners.size > 0) return;
    this.idleTimer = this.exit
      ? setTimeout(this.onForget, EXITED_RETENTION_MS)
      : setTimeout(() => this.kill('idle'), this.options.idleTtlMs ?? EXEC_DEFAULT_IDLE_TTL_MS);
    this.idleTimer.unref();
  }
}

/** Processes outlive the socket that started them, so a later connection can attach to their output by id. */
class ProcessRegistry {
  private readonly processes = new Map<string, ManagedProcess>();

  spawn(options: SpawnOptions): Promise<Result<ManagedProcess, ExecErrorCode>> {
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: { ...buildCodexAgentEnv(), ...options.env },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A write racing the process's exit fails with EPIPE; the exit itself reports what happened.
    child.stdin.on('error', () => {});
    if (!options.stdin) child.stdin.end();
    return new Promise((resolve) => {
      child.once('error', (error) => resolve(createErrorResult({ code: 'spawn_error', message: error.message })));
      child.once('spawn', () => {
        const managed = new ManagedProcess(options, child, () => this.processes.delete(managed.id));
        this.processes.set(managed.id, managed);
        child.stdout.on('data', (data: Buffer) => managed.append('stdout', data));
        child.stderr.on('data', (data: Buffer) => managed.append('stderr', data));
        let drain: ReturnType<typeof setTimeout> | undefined;
        const settle = () => {
          clearTimeout(drain);
          managed.finish(child.exitCode, child.signalCode);
          child.stdout.destroy();
          child.stderr.destroy();
        };
        child.once('exit', () => {
          drain = setTimeout(settle, EXIT_DRAIN_MS);
        });
        child.once('close', settle);
        resolve(createSuccessResult(managed));
      });
    });
  }

  get(processId: string): ManagedProcess | undefined {
    return this.processes.get(processId);
  }

  list(threadId?: string): ExecProcessInfo[] {
    return [...this.processes.values()].filter((managed) => !threadId || managed.options.threadId === threadId).map((managed) => managed.info());
  }

  killThread(threadId: string): number {
    const running = [...this.processes.values()].filter((managed) => managed.options.threadId === threadId && !managed.exit);
    for (const managed of running) managed.kill('killed');
    return running.length;
  }
}

export const processRegistry = new ProcessRegistry();
