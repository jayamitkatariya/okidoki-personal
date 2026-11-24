import { EventEmitter } from 'node:events';
import type { ClientRequest, RequestId, ServerNotification, ServerRequest } from '@okidoki/shared/codex-asp-types';

export type AspNotification = ServerNotification;
export type AspServerRequest = ServerRequest;

interface AspClientOptions {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  jsonRpcVersion?: '2.0';
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: ClientRequest['method'] | string;
  timer: NodeJS.Timeout | null;
}

type AspEventMap = {
  notification: (notification: AspNotification) => void;
  serverRequest: (request: AspServerRequest) => void;
  dispose: (reason: Error) => void;
};

type RpcRecord = Record<string, unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function hasOwn(record: RpcRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export class AspRequestTimeoutError extends Error {}
export class AspResponseError extends Error {}

export class AspClient {
  private readonly stdin: NodeJS.WritableStream;
  private readonly stdout: NodeJS.ReadableStream;
  private readonly jsonRpcVersion?: '2.0';
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private lineBuffer = '';
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  constructor(options: AspClientOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.jsonRpcVersion = options.jsonRpcVersion;
    this.stdout.setEncoding('utf8');
    this.stdout.on('data', this.handleStdoutData);
    this.stdin.on('error', this.handleStdinError);
  }

  on(event: 'notification', listener: AspEventMap['notification']): void;
  on(event: 'serverRequest', listener: AspEventMap['serverRequest']): void;
  on(event: 'dispose', listener: AspEventMap['dispose']): void;
  on<TEvent extends keyof AspEventMap>(event: TEvent, listener: AspEventMap[TEvent]): void {
    this.emitter.on(event, listener);
  }

  off(event: 'notification', listener: AspEventMap['notification']): void;
  off(event: 'serverRequest', listener: AspEventMap['serverRequest']): void;
  off(event: 'dispose', listener: AspEventMap['dispose']): void;
  off<TEvent extends keyof AspEventMap>(event: TEvent, listener: AspEventMap[TEvent]): void {
    this.emitter.off(event, listener);
  }

  async request<TResult = unknown>(
    method: ClientRequest['method'] | string,
    params: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<TResult> {
    if (this.disposed) {
      throw new Error(`Cannot send ${method}: ASP client disposed`);
    }

    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new AspRequestTimeoutError(`ASP request timed out for ${method}`));
        }, timeoutMs)
        : null;

      this.pending.set(id, { resolve, reject, method, timer });
    });

    this.write({ method, id, params });
    return promise as Promise<TResult>;
  }

  notify(method: ClientRequest['method'] | string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      this.write(params === undefined ? { method } : { method, params });
    } catch (error) {
      console.warn(`[AspClient] Failed to send notification ${method}:`, error);
    }
  }

  respond(id: RequestId, result: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      this.write({ id, result });
    } catch (error) {
      console.warn(`[AspClient] Failed to send response ${String(id)}:`, error);
    }
  }

  reject(id: RequestId, code: number, message: string, data?: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      this.write({
        id,
        error: {
          code,
          message,
          ...(data !== undefined ? { data } : {}),
        },
      });
    } catch (error) {
      console.warn(`[AspClient] Failed to send error response ${String(id)}:`, error);
    }
  }

  dispose(reason = new Error('ASP client disposed')): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stdout.off('data', this.handleStdoutData);
    this.stdin.removeListener('error', this.handleStdinError);
    for (const [id, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(new Error(`${reason.message} while waiting for ${pending.method}`));
      this.pending.delete(id);
    }
    this.lineBuffer = '';
    this.emitter.emit('dispose', reason);
    this.emitter.removeAllListeners();
  }

  private readonly handleStdoutData = (chunk: string | Buffer): void => {
    this.lineBuffer += chunk.toString();

    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  };

  private readonly handleStdinError = (error: Error): void => {
    this.dispose(new Error(`ASP stdin error: ${error.message}`));
  };

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      console.warn('[AspClient] Failed to parse ASP JSON line:', error);
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[AspClient] Ignoring non-object ASP message');
      return;
    }
    const message = parsed as RpcRecord;

    const hasRequestId = typeof message.id === 'number' || typeof message.id === 'string';

    if (hasRequestId && (hasOwn(message, 'result') || hasOwn(message, 'error'))) {
      this.handleResponse(message);
      return;
    }

    if (hasRequestId && typeof message.method === 'string') {
      this.emitter.emit('serverRequest', message as AspServerRequest);
      return;
    }

    if (!hasOwn(message, 'id') && typeof message.method === 'string') {
      this.emitter.emit('notification', message as AspNotification);
    }
  }

  private handleResponse(message: RpcRecord): void {
    if (typeof message.id !== 'number') {
      console.warn('[AspClient] Ignoring response with non-numeric request id');
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      console.warn(`[AspClient] Ignoring response for unknown request id ${message.id}`);
      return;
    }

    this.pending.delete(message.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if (hasOwn(message, 'error')) {
      pending.reject(this.createRpcError(pending.method, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private createRpcError(method: string, error: unknown): Error {
    if (typeof error !== 'object' || error === null || Array.isArray(error)) {
      return new AspResponseError(`ASP request failed for ${method}`);
    }
    const rpcError = error as RpcRecord;

    const code = typeof rpcError.code === 'number' ? ` ${rpcError.code}` : '';
    const message = typeof rpcError.message === 'string' ? rpcError.message : 'Unknown ASP error';
    const data = hasOwn(rpcError, 'data') ? ` data=${JSON.stringify(rpcError.data)}` : '';
    return new AspResponseError(`ASP request failed for ${method}:${code} ${message}${data}`);
  }

  private write(message: RpcRecord): void {
    try {
      this.stdin.write(`${JSON.stringify(this.jsonRpcVersion ? { jsonrpc: this.jsonRpcVersion, ...message } : message)}\n`, (error?: Error | null) => {
        if (error) {
          this.dispose(new Error(`ASP write failed: ${error.message}`));
        }
      });
    } catch (error) {
      const writeError = error instanceof Error ? error : new Error('ASP write failed');
      this.dispose(writeError);
      throw writeError;
    }
  }
}
