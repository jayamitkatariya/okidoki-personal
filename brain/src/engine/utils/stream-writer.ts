import { createWriteStream, type WriteStream } from 'fs';

const DEFAULT_HIGH_WATER = 8 * 1024 * 1024; // 8 MB

export class StreamWriter {
  private stream: WriteStream | null = null;
  private backpressured = false;
  private droppedCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  open(path: string, highWaterMark = DEFAULT_HIGH_WATER): void {
    this.stream = createWriteStream(path, { flags: 'a', highWaterMark });
    this.stream.on('error', () => {
      this.stream = null;
    });
    this.stream.on('drain', () => {
      this.backpressured = false;
    });
  }

  write(line: string): boolean {
    if (!this.stream) return false;

    if (this.backpressured) {
      this.droppedCount++;
      this.scheduleDropWarning();
      return false;
    }

    const written = this.stream.write(line);
    if (!written) {
      this.backpressured = true;
    }
    return true;
  }

  flush(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stream) { resolve(); return; }
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      const s = this.stream;
      const onAbort = (): void => reject(signal?.reason);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      s.write('', (error) => {
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private scheduleDropWarning(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.droppedCount > 0 && this.stream) {
        this.stream.write(`[${new Date().toISOString()}] [WARN] Dropped ${this.droppedCount} log lines due to IO backpressure\n`);
        this.droppedCount = 0;
      }
    }, 2000);
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }
}
