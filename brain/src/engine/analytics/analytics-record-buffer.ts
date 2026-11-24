import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
} from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ENGINE_DIR } from '../services/chat/history-paths';

const MAX_FAILED_RECORDS = 500;
const FLUSH_DEBOUNCE_MS = 15_000;
const MAX_UPLOADED_SEGMENTS = 50;
const UPLOADED_SUFFIX = '.uploaded';

export type AnalyticsRecordBufferFlushResult = {
  flushed: number;
  failed: number;
};

export interface AnalyticsRecordBufferOptions<T> {
  storageName: string;
  legacyStorageNames?: readonly string[];
  validate: (value: unknown) => value is T;
  upload: (records: T[]) => Promise<void>;
  getRecordId?: (record: T) => string | undefined;
  retainUploadedSegments?: boolean;
}

export class AnalyticsRecordBuffer<T> {
  private readonly liveFile: string;
  private readonly storageNames: readonly string[];
  private readonly segmentFilePatterns: readonly RegExp[];
  private readonly failedRecords: T[] = [];
  private readonly pendingAppends = new Set<Promise<void>>();
  private readonly recordIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeFlush: Promise<AnalyticsRecordBufferFlushResult> = Promise.resolve({
    flushed: 0,
    failed: 0,
  });

  constructor(private readonly options: AnalyticsRecordBufferOptions<T>) {
    this.storageNames = [
      options.storageName,
      ...(options.legacyStorageNames ?? []),
    ];
    this.liveFile = join(ENGINE_DIR, `${options.storageName}.jsonl`);
    this.segmentFilePatterns = this.storageNames.map(
      (storageName) => new RegExp(`^${storageName}\\.(\\d+)\\.jsonl$`),
    );
  }

  append(record: T, retry = false): void {
    const recordId = this.options.getRecordId?.(record);
    if (!retry && recordId) {
      if (this.recordIds.has(recordId)) return;
      this.recordIds.add(recordId);
    }

    const pending = mkdir(ENGINE_DIR, { recursive: true })
      .then(() => appendFile(this.liveFile, `${JSON.stringify(record)}\n`, 'utf-8'))
      .catch((error) => {
        console.error(
          `[${this.options.storageName}] Append failed, will retry on flush:`,
          error,
        );
        if (this.failedRecords.length < MAX_FAILED_RECORDS) this.failedRecords.push(record);
      });
    this.pendingAppends.add(pending);
    void pending.finally(() => this.pendingAppends.delete(pending));
  }

  readStoredRecords(): T[] {
    if (!existsSync(ENGINE_DIR)) return [];

    return readdirSync(ENGINE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && this.storageNames.some(
        (storageName) => entry.name === `${storageName}.jsonl`
          || entry.name.startsWith(`${storageName}.`) && (
            entry.name.endsWith('.jsonl')
            || entry.name.endsWith(`.jsonl${UPLOADED_SUFFIX}`)
          ),
      ))
      .map(({ name }) => name)
      .sort()
      .flatMap((name) => this.parseRecords(readFileSync(join(ENGINE_DIR, name), 'utf-8')))
      .map((record) => {
        const recordId = this.options.getRecordId?.(record);
        if (recordId) this.recordIds.add(recordId);
        return record;
      });
  }

  scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => {
        console.error(
          `[${this.options.storageName}] Scheduled flush failed, retrying on the next record:`,
          error,
        );
      });
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  flush(): Promise<AnalyticsRecordBufferFlushResult> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.activeFlush = this.activeFlush
      .catch(() => {})
      .then(() => this.runFlush());
    return this.activeFlush;
  }

  private async runFlush(): Promise<AnalyticsRecordBufferFlushResult> {
    for (const record of this.failedRecords.splice(0)) this.append(record, true);
    while (this.pendingAppends.size > 0) {
      await Promise.allSettled([...this.pendingAppends]);
    }

    for (const storageName of this.storageNames) {
      await rename(
        join(ENGINE_DIR, `${storageName}.jsonl`),
        join(ENGINE_DIR, `${storageName}.${Date.now()}.jsonl`),
      ).catch(() => {});
    }

    const entries = await readdir(ENGINE_DIR).catch(() => []);
    let flushed = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!this.segmentFilePatterns.some((pattern) => pattern.test(entry))) continue;
      try {
        await this.uploadSegment(join(ENGINE_DIR, entry));
        flushed++;
      } catch (error) {
        failed++;
        console.error(
          `[${this.options.storageName}] Segment upload failed, retained for retry:`,
          { entry, error },
        );
      }
    }

    const failedRecords = this.failedRecords.splice(0);
    if (failedRecords.length > 0) {
      try {
        await this.options.upload(failedRecords);
        flushed++;
      } catch (error) {
        failed++;
        this.failedRecords.unshift(...failedRecords.slice(0, MAX_FAILED_RECORDS));
        console.error(
          `[${this.options.storageName}] Failed records upload failed, retained for retry:`,
          error,
        );
      }
    }

    if (!this.options.retainUploadedSegments) {
      const uploaded = entries
        .filter((entry) => this.storageNames.some(
          (storageName) => entry.startsWith(`${storageName}.`),
        ) && entry.endsWith(UPLOADED_SUFFIX))
        .sort();
      for (const entry of uploaded.slice(0, -MAX_UPLOADED_SEGMENTS)) {
        await unlink(join(ENGINE_DIR, entry)).catch(() => {});
      }
    }

    return { flushed, failed };
  }

  private async uploadSegment(filePath: string): Promise<void> {
    const records = this.parseRecords(await readFile(filePath, 'utf-8'));
    if (records.length > 0) await this.options.upload(records);
    await rename(filePath, `${filePath}${UPLOADED_SUFFIX}`).catch(() => {});
  }

  private parseRecords(contents: string): T[] {
    return contents.split('\n').flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return this.options.validate(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }
}
