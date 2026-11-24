import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { isValidEngineLogSessionId } from '@okidoki/shared';
import { engineLogger, LOG_DIR } from '../utils/logger';
import { monolithRequest } from './monolith-service';

const MAX_ENGINE_LOG_FLUSH_SESSIONS = 10;
const MAX_ENGINE_LOG_FLUSH_BYTES = 5 * 1024 * 1024;
const ENGINE_LOG_FLUSH_TIMEOUT_MS = 20_000;

export async function flushAllEngineLogs(): Promise<{ flushed: number; skipped: number; failed: number }> {
  let flushed = 0;
  let skipped = 0;
  let failed = 0;
  const deadline = Date.now() + ENGINE_LOG_FLUSH_TIMEOUT_MS;

  await runBeforeDeadline((signal) => engineLogger.flush(signal), deadline);
  const files = await runBeforeDeadline(() => readdir(LOG_DIR), deadline).catch(() => []);
  const currentFilename = engineLogger.sessionId ? `${engineLogger.sessionId}.log` : null;
  const filenames = files.filter((filename) => {
    if (!filename.endsWith('.log')) return false;
    const sessionId = filename.slice(0, -'.log'.length);
    if (!isValidEngineLogSessionId(sessionId)) {
      skipped++;
      return false;
    }
    return true;
  }).sort((a, b) => {
    if (a === currentFilename) return -1;
    if (b === currentFilename) return 1;
    return b.localeCompare(a);
  });
  skipped += Math.max(0, filenames.length - MAX_ENGINE_LOG_FLUSH_SESSIONS);

  const candidates = (await Promise.all(filenames.slice(0, MAX_ENGINE_LOG_FLUSH_SESSIONS).map(async (filename) => {
    try {
      const sessionId = filename.slice(0, -'.log'.length);
      const filePath = join(LOG_DIR, filename);
      const fileStat = await runBeforeDeadline(() => stat(filePath), deadline);
      if (!fileStat.isFile()) {
        skipped++;
        return null;
      }
      return { sessionId, filename, filePath, fileStat };
    } catch (error) {
      failed++;
      engineLogger.error('[EngineLogUploader] upload failed:', { filename, error });
      return null;
    }
  }))).filter((candidate) => candidate !== null);

  const selected: (typeof candidates[number] & { offset: number; length: number })[] = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    const length = Math.min(candidate.fileStat.size, MAX_ENGINE_LOG_FLUSH_BYTES);
    if (
      selected.length >= MAX_ENGINE_LOG_FLUSH_SESSIONS
      || selectedBytes + length > MAX_ENGINE_LOG_FLUSH_BYTES
    ) {
      skipped++;
      continue;
    }
    selected.push({ ...candidate, offset: candidate.fileStat.size - length, length });
    selectedBytes += length;
  }

  for (const [index, candidate] of selected.entries()) {
    if (Date.now() >= deadline) {
      skipped += selected.length - index;
      break;
    }
    try {
      const content = await runBeforeDeadline(async (signal) => {
        if (candidate.length === 0) return Buffer.alloc(0);
        const chunks: Buffer[] = [];
        for await (const chunk of createReadStream(candidate.filePath, {
          start: candidate.offset,
          end: candidate.offset + candidate.length - 1,
          signal,
        })) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
      }, deadline);
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) {
        skipped += selected.length - index;
        break;
      }
      await uploadEngineLog({
        sessionId: candidate.sessionId,
        filename: candidate.filename,
        updatedAt: candidate.fileStat.mtime.toISOString(),
        content,
      }, timeoutMs);
      flushed++;
    } catch (error) {
      failed++;
      engineLogger.error('[EngineLogUploader] upload failed:', { filename: candidate.filename, error });
    }
  }

  return { flushed, skipped, failed };
}

function runBeforeDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return Promise.reject(new DOMException('engine log flush deadline exceeded', 'TimeoutError'));
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation(signal).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function uploadEngineLog(input: {
  sessionId: string;
  filename: string;
  updatedAt: string;
  content: Uint8Array;
}, timeoutMs: number): Promise<void> {
  const form = new FormData();
  form.append('session_id', input.sessionId);
  form.append('filename', input.filename);
  form.append('updated_at', input.updatedAt);
  form.append('file', new Blob([Uint8Array.from(input.content)], { type: 'text/plain' }), input.filename);

  const response = await monolithRequest('/v1/engine/logs', {
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
}
