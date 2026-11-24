import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import { z } from 'zod';
import { createErrorResult, createSuccessResult, type CreateTerminalSessionRequest, type Result, type TerminalSession, type TerminalSocketCommand } from '@okidoki/shared';

const MAX_REPLAY_CHARS = 1024 * 1024;
const MAX_TERMINAL_SESSIONS = 8;
const MAX_PENDING_INPUT = 64;

export const terminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
}) satisfies z.ZodType<CreateTerminalSessionRequest>;

export const terminalCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  terminalSizeSchema.extend({ type: z.literal('resize') }),
]) satisfies z.ZodType<TerminalSocketCommand>;

interface ManagedTerminal extends TerminalSession {
  pty: IPty;
  replay: string;
  subscribers: Set<(data: string) => void>;
  inputGeneration: number;
  nextInputSequence: number;
  pendingInput: Map<number, string>;
}

export class TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private nextTitleNumber = 1;

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => this.publicSession(session));
  }

  create(cwd: string, cols: number, rows: number): Result<TerminalSession, 'limit'> {
    if (this.sessions.size >= MAX_TERMINAL_SESSIONS) {
      return createErrorResult({
        message: `Terminal session limit reached (${MAX_TERMINAL_SESSIONS})`,
        code: 'limit',
      });
    }
    const id = randomUUID();
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
    const session: ManagedTerminal = {
      id,
      title: `Terminal ${this.nextTitleNumber++}`,
      createdAt: new Date().toISOString(),
      exited: false,
      pty,
      replay: '',
      subscribers: new Set(),
      inputGeneration: -1,
      nextInputSequence: 0,
      pendingInput: new Map(),
    };
    this.sessions.set(id, session);
    pty.onData((data) => {
      session.replay = (session.replay + data).slice(-MAX_REPLAY_CHARS);
      for (const subscriber of session.subscribers) subscriber(data);
    });
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      const data = `\r\n\x1b[2m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
      session.replay = (session.replay + data).slice(-MAX_REPLAY_CHARS);
      for (const subscriber of session.subscribers) subscriber(data);
    });
    return createSuccessResult(this.publicSession(session));
  }

  write(id: string, data: string, generation: number, sequence: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    if (generation < session.inputGeneration) return true;
    if (generation > session.inputGeneration) {
      session.inputGeneration = generation;
      session.nextInputSequence = 0;
      session.pendingInput.clear();
    }
    if (sequence < session.nextInputSequence) return true;
    session.pendingInput.set(sequence, data);
    // Input POSTs are fire-and-forget and never retried, so a dropped request leaves a
    // permanent gap that would buffer all later input forever. Once the backlog is large
    // enough that the missing sequence is clearly lost, skip past it to stay responsive.
    if (session.pendingInput.size > MAX_PENDING_INPUT) {
      session.nextInputSequence = Math.min(...session.pendingInput.keys());
    }
    let pendingInput;
    while ((pendingInput = session.pendingInput.get(session.nextInputSequence)) !== undefined) {
      session.pty.write(pendingInput);
      session.pendingInput.delete(session.nextInputSequence++);
    }
    return true;
  }

  command(id: string, command: TerminalSocketCommand): void {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    if (command.type === 'input') session.pty.write(command.data);
    else session.pty.resize(command.cols, command.rows);
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    session.pty.resize(cols, rows);
    return true;
  }

  subscribe(id: string, subscriber: (data: string) => void): { replay: string; unsubscribe: () => void } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.subscribers.add(subscriber);
    return {
      replay: session.replay,
      unsubscribe: () => session.subscribers.delete(subscriber),
    };
  }

  delete(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (!session.exited) session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  private publicSession(session: ManagedTerminal): TerminalSession {
    const {
      pty: _pty,
      replay: _replay,
      subscribers: _subscribers,
      inputGeneration: _inputGeneration,
      nextInputSequence: _nextInputSequence,
      pendingInput: _pendingInput,
      ...value
    } = session;
    return value;
  }
}

export const terminalService = new TerminalService();
