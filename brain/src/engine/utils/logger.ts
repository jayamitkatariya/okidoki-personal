import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { format } from 'util';
import { randomBytes } from 'crypto';
import { StreamWriter } from './stream-writer';

export const LOG_DIR = join(process.env.OKIDOKI_ENGINE_STATE_DIR ?? join(homedir(), '.okidoki'), 'logs');

class EngineLogger {
  private _sessionId: string | null = null;
  private patched = false;
  private writer = new StreamWriter();

  get sessionId(): string | null {
    return this._sessionId;
  }

  async initialize(): Promise<void> {
    await mkdir(LOG_DIR, { recursive: true });

    this._sessionId = this.createSessionId();
    const logPath = join(LOG_DIR, `${this._sessionId}.log`);

    await writeFile(logPath, `=== Okidoki Engine Session ${this._sessionId} ===\n`, 'utf-8');
    this.writer.open(logPath);
    this.patchConsole();
    this.log('INFO', `Engine logging initialized at ${logPath}`);
  }

  private patchConsole(): void {
    if (this.patched) return;
    this.patched = true;

    console.log = (...args: unknown[]) => {
      this.log('INFO', format(...args));
    };
    console.info = (...args: unknown[]) => {
      this.log('INFO', format(...args));
    };
    console.warn = (...args: unknown[]) => {
      this.log('WARN', format(...args));
    };
    console.error = (...args: unknown[]) => {
      this.log('ERROR', format(...args));
    };
    console.debug = (...args: unknown[]) => {
      this.log('DEBUG', format(...args));
    };
  }

  private log(level: string, message: string): void {
    this.writer.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
  }

  flush(signal?: AbortSignal): Promise<void> {
    return this.writer.flush(signal);
  }

  error(...args: unknown[]): void {
    this.log('ERROR', format(...args));
  }

  private createSessionId(): string {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const suffix = randomBytes(3).toString('hex');
    return `${timestamp}-${suffix}`;
  }
}

export const engineLogger = new EngineLogger();
