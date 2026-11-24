import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync } from 'fs';
import { open, rename, type FileHandle } from 'fs/promises';
import { dirname } from 'path';
import { StringDecoder } from 'string_decoder';
import type {
  AgentEvent,
  ChatHistoryPageParams,
  ChatHistoryRecordRange,
  ChatSubagentHistoryResponse,
  CodexAspTranscriptItem,
} from '@okidoki/shared';
import {
  ChatSubagentIndex,
  CODEX_HISTORY_FORMAT_EVENT_TYPE,
  CODEX_ITEM_EVENT_TYPE,
  CodexHistoryEventFolder,
  codexHistoryFormatEvent,
  codexItemFromEvent,
  createChatHistoryCursor,
  parseAgentEventJsonlLine,
  parseChatHistoryCursor,
  readChatHistoryAppended,
  readChatHistoryHead,
  readChatHistoryPage,
  readChatHistoryRecord,
  readChatSubagentHistory,
} from '@okidoki/shared';

const MIGRATION_FLUSH_CHARS = 1 << 20;
const WRITE_RETRY_DELAYS_MS = [100, 400, 1500, 3000, 5000];
const NEWLINE = Buffer.from('\n');
const READ_CHUNK_BYTES = 1 << 18;
// A sync adds about 3 ms on a sandbox disk, and streamed text is one record per token.
const STREAM_SYNC_DELAY_MS = 50;

interface QueuedRecord {
  bytes: Buffer;
  stream: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  synced: () => void;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

/** A log held open with the end a reader may go up to, so both always belong to the same file. */
export interface OpenedLog {
  file: FileHandle;
  size: number;
  swaps?: number;
}

export function fileRangeReader(file: FileHandle): (startByte: number, endByte: number) => Promise<Uint8Array> {
  return async (startByte, endByte) => {
    const bytes = Buffer.allocUnsafe(endByte - startByte);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, startByte);
    return bytes.subarray(0, bytesRead);
  };
}

/** A log file no chat is writing, opened up to its size on disk. */
export async function openWholeLog(path: string): Promise<OpenedLog | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    return { file, size: (await file.stat()).size };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** A chat's log. One object per file: it owns where each record goes, so a second one on the same file would write over it. */
export class CodexHistoryFile {
  private queued: QueuedRecord[] = [];
  private writing: Promise<void> | null = null;
  private taken: Promise<void> = Promise.resolve();
  // Every byte before this is on disk. Reads and the position clients are told stop here, so nothing outside the engine ever sees an offset a crash could take back.
  private flushedEnd = 0;
  // Stream records between the flushed end and here are written but not yet synced: a machine crash can take them back, so no position reaches them.
  private writtenEnd = 0;
  private unsynced: QueuedRecord[] = [];
  private syncDue = false;
  private syncTimer: NodeJS.Timeout | null = null;
  private nextOffset = 0;
  latestRecordedAt = 0;
  // The file ends in a record with no newline (a write cut short): the next batch starts with one, so readers lose that fragment alone.
  private tornTail = false;
  // Part of a dropped batch may have reached the disk. Until the file is cut back to the flushed end, a crash would bring those records back.
  private cutPending = false;
  // Set while a rewritten file takes the old one's place, so a read never pairs one file with the other's flushed end.
  private swapping: Promise<void> | null = null;
  // Goes up when a swap starts and again when the offsets become the rewritten file's: an open that began before a swap and
  // returned after it holds the old file, and an offset taken while the swap was under way is still the old file's.
  private swaps = 0;
  private subagentIndex: Promise<{ swaps: number; index: ChatSubagentIndex } | null> = Promise.resolve(null);

  constructor(private readonly filePath: string, private readonly isStream: (event: AgentEvent) => boolean = () => false) {
    try {
      const file = openSync(filePath, 'r');
      try {
        this.flushedEnd = fstatSync(file).size;
        const last = Buffer.alloc(1);
        this.tornTail = this.flushedEnd > 0 && readSync(file, last, 0, 1, this.flushedEnd - 1) === 1 && last[0] !== NEWLINE[0];
      } finally {
        closeSync(file);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.writtenEnd = this.flushedEnd;
    this.nextOffset = this.firstFreeOffset();
  }

  get historyEnd(): number {
    return this.flushedEnd;
  }

  /** Where the next record will start. Not yet on disk, so it stays inside the engine. */
  get end(): number {
    return this.nextOffset;
  }

  get swapCount(): number {
    return this.swaps;
  }

  record(event: AgentEvent): { at: number; written: Promise<void> } {
    const recordedAt = Date.parse(event.timestamp);
    if (recordedAt > this.latestRecordedAt) this.latestRecordedAt = recordedAt;
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    const at = this.nextOffset;
    this.nextOffset += bytes.length;
    const synced = Promise.withResolvers<void>();
    this.taken = synced.promise;
    const written = new Promise<void>((resolve, reject) => {
      this.queued.push({ bytes, stream: this.isStream(event), resolve, reject, synced: synced.resolve });
    });
    // A dropped record rejects, also for a caller that does not wait for it.
    written.catch(() => {});
    this.writing ??= this.writeQueued();
    return { at, written };
  }

  /** Settles once every record taken so far is on disk or dropped. */
  flush(): Promise<void> {
    if (this.writing || this.queued.length > 0 || this.writtenEnd > this.flushedEnd) this.syncNow();
    return this.taken;
  }

  private syncNow(): void {
    this.syncDue = true;
    this.writing ??= this.writeQueued();
  }

  private firstFreeOffset(): number {
    return this.flushedEnd + (this.tornTail ? NEWLINE.length : 0);
  }

  private async writeQueued(): Promise<void> {
    try {
      while (this.queued.length > 0 || this.syncDue) {
        const batch = this.queued.splice(0);
        const sync = this.syncDue || batch.some((record) => !record.stream);
        this.syncDue = false;
        if (batch.length === 0 && this.writtenEnd === this.flushedEnd) continue;
        const startsLine = this.tornTail && this.writtenEnd === this.flushedEnd && batch.length > 0;
        const bytes = Buffer.concat([...(startsLine ? [NEWLINE] : []), ...batch.map((record) => record.bytes)]);
        try {
          await this.write(bytes, sync);
        } catch (error) {
          // Records taken behind the batch were placed after it, so they go with it, and so does stream text not yet synced.
          const dropped = [...batch, ...this.queued.splice(0)];
          console.error(`[CodexHistoryFile] Dropped ${dropped.length} records that could not be written:`, error);
          this.writtenEnd = this.flushedEnd;
          this.nextOffset = this.firstFreeOffset();
          this.cutPending = true;
          await this.cutToFlushedEnd().catch(() => {});
          for (const record of this.unsynced.splice(0)) record.synced();
          for (const record of dropped) {
            record.reject(error);
            record.synced();
          }
          continue;
        }
        this.writtenEnd += bytes.length;
        this.unsynced.push(...batch);
        if (sync) {
          if (this.syncTimer) clearTimeout(this.syncTimer);
          this.syncTimer = null;
          this.tornTail = false;
          this.flushedEnd = this.writtenEnd;
          for (const record of this.unsynced.splice(0)) record.synced();
        } else {
          this.syncTimer ??= setTimeout(() => {
            this.syncTimer = null;
            this.syncNow();
          }, STREAM_SYNC_DELAY_MS).unref();
        }
        for (const record of batch) record.resolve();
      }
    } finally {
      this.writing = null;
    }
  }

  private async write(bytes: Buffer, sync: boolean): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (this.cutPending) await this.cutToFlushedEnd();
        const file = await open(this.filePath, constants.O_WRONLY | constants.O_CREAT);
        try {
          for (let written = 0; written < bytes.length;) {
            written += (await file.write(bytes, written, bytes.length - written, this.writtenEnd + written)).bytesWritten;
          }
          if (sync) await file.datasync();
        } finally {
          await file.close();
        }
        return;
      } catch (error) {
        const delay = WRITE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async cutToFlushedEnd(): Promise<void> {
    const file = await open(this.filePath, constants.O_WRONLY | constants.O_CREAT);
    try {
      await file.truncate(this.flushedEnd);
      await file.datasync();
    } finally {
      await file.close();
    }
    this.cutPending = false;
  }

  /**
   * Rewrites a file that still holds legacy Codex transcript records as plain
   * item events, once. The file is read line by line: a long-lived chat can
   * exceed the largest string V8 will hold. The rewritten file starts with a
   * format marker so later starts only read that first line.
   */
  async ensureItemEventFormat(): Promise<void> {
    await this.flush();
    const firstLine = await this.readFirstLine();
    if (firstLine === null) {
      await this.record(codexHistoryFormatEvent()).written;
      return;
    }
    if (parseAgentEventJsonlLine(firstLine)?.type === CODEX_HISTORY_FORMAT_EVENT_TYPE) return;
    // `flush` only covers the records taken before it was called; a write that started since would run beside the rewrite,
    // and stream text not yet synced would be left out of it.
    while (this.writing || this.writtenEnd > this.flushedEnd) {
      this.syncNow();
      await this.writing;
    }
    const rewrite = this.rewriteAsItemEvents();
    this.writing = rewrite.then(() => this.writeQueued(), () => this.writeQueued());
    this.taken = this.writing;
    await rewrite;
  }

  private async rewriteAsItemEvents(): Promise<void> {
    const events = await this.loadAll();
    const rewritten = `${this.filePath}.migrating`;
    const handle = await open(rewritten, 'w');
    let size = 0;
    try {
      let pending = '';
      for (const event of [codexHistoryFormatEvent(), ...events]) {
        pending += `${JSON.stringify(event)}\n`;
        if (pending.length >= MIGRATION_FLUSH_CHARS) {
          size += (await handle.write(pending)).bytesWritten;
          pending = '';
        }
      }
      if (pending) size += (await handle.write(pending)).bytesWritten;
      await handle.datasync();
    } finally {
      await handle.close();
    }
    const swap = rename(rewritten, this.filePath);
    this.swapping = swap.then(() => {}, () => {});
    this.swaps += 1;
    try {
      await swap;
      this.flushedEnd = size;
      this.writtenEnd = size;
      this.tornTail = false;
      this.nextOffset = size + this.queued.reduce((total, record) => total + record.bytes.length, 0);
      this.swaps += 1;
    } finally {
      this.swapping = null;
    }
  }

  /**
   * Newest event of `type`, scanning the whole file so a value older than the
   * most recent page is still found. Streams line by line and retains only the
   * match, so history size does not bound memory.
   */
  async findLastEventOfType(type: string): Promise<AgentEvent | null> {
    return this.findLastEvent(type, (event) => event.type === type);
  }

  async findLastEvent(needle: string, matches: (event: AgentEvent) => boolean): Promise<AgentEvent | null> {
    let found: AgentEvent | null = null;
    for await (const event of this.eventsFrom(0, [needle])) {
      if (matches(event)) found = event;
    }
    return found;
  }

  async *eventsFrom(start: number, needles: string[]): AsyncGenerator<AgentEvent> {
    const opened = await this.openAtFlushedEnd();
    if (!opened) return;
    try {
      for await (const line of this.lines(opened, start)) {
        if (!needles.some((needle) => line.includes(needle))) continue;
        const event = parseAgentEventJsonlLine(line);
        if (event) yield event;
      }
    } finally {
      await opened.file.close();
    }
  }

  async findSubagentItems(): Promise<Map<string, { turnId: string; item: Extract<CodexAspTranscriptItem, { type: 'subagent' }> }>> {
    const found = new Map<string, { turnId: string; item: Extract<CodexAspTranscriptItem, { type: 'subagent' }> }>();
    for await (const event of this.eventsFrom(0, ['"subagent"'])) {
      const payload = event.type === CODEX_ITEM_EVENT_TYPE ? codexItemFromEvent(event) : null;
      if (payload?.item.type === 'subagent') found.set(payload.item.id, { turnId: payload.turnId, item: payload.item });
    }
    return found;
  }

  async loadAll(): Promise<AgentEvent[]> {
    const folder = new CodexHistoryEventFolder();
    const opened = await this.openAtFlushedEnd();
    if (!opened) return folder.finish();
    try {
      for await (const line of this.lines(opened, 0)) {
        const event = parseAgentEventJsonlLine(line);
        if (event) folder.push(event);
      }
    } finally {
      await opened.file.close();
    }
    return folder.finish();
  }

  async loadEventsPage(
    page: ChatHistoryPageParams,
  ): Promise<Pick<ChatSubagentHistoryResponse, 'events' | 'beforeCursor' | 'afterCursor' | 'appendsAfter' | 'userTurns' | 'subagentsCursor' | 'fromStart'>> {
    // Text is announced before it is synced and a read ends at the synced end: synced first, a page holds every record announced before it was asked for.
    if (this.writtenEnd > this.flushedEnd) await this.flush();
    if (page.subagents && (page.subagentList || page.subagentId !== undefined)) {
      const read = await this.read(async (size, readRange, swaps) => {
        const index = await this.indexSubagents(size, readRange, swaps);
        return index.read({ size, compact: page.compact, cursor: page.subagentsCursor, subagentId: page.subagentId, readRange });
      });
      if (read === null && page.subagentsCursor !== undefined) throw new RangeError('Invalid chat history cursor');
      return { events: read?.events ?? [], beforeCursor: null, ...(read?.cursor ? { subagentsCursor: read.cursor } : {}) };
    }
    if (page.subagents) {
      const read = await this.read((size, readRange) => readChatSubagentHistory({ size, compact: page.compact, cursor: page.subagentsCursor, readRange }));
      if (read === null && page.subagentsCursor !== undefined) throw new RangeError('Invalid chat history cursor');
      return { events: read?.events ?? [], beforeCursor: null, ...(read?.cursor ? { subagentsCursor: read.cursor } : {}) };
    }
    if (page.limit === undefined) return { events: await this.loadAll() };
    if (page.fromStart) {
      const { limit } = page;
      const events = await this.read((size, readRange) => readChatHistoryHead({ size, limit, compact: page.compact, readRange }));
      return { events: events ?? [], beforeCursor: null, fromStart: true };
    }
    const cursor = parseChatHistoryCursor(page.beforeCursor);
    if (page.beforeCursor !== undefined && cursor?.mode !== 'range') throw new RangeError('Invalid chat history cursor');
    if (cursor?.events === null) return { events: [], beforeCursor: null };
    const { limit } = page;
    return await this.read(async (size, readRange) => {
      if (page.afterCursor !== undefined && cursor === undefined) {
        const appended = await readChatHistoryAppended({ size, after: page.afterCursor, compact: page.compact, readRange });
        if (appended) return { events: appended.items, afterCursor: appended.after, appendsAfter: page.afterCursor };
      }
      const result = await readChatHistoryPage({
        size,
        limit,
        userTurns: page.userTurns,
        compact: page.compact,
        before: cursor?.events,
        readRange,
      });
      return {
        events: result.items,
        beforeCursor: createChatHistoryCursor({ events: result.before, turns: null }),
        ...(cursor === undefined ? { afterCursor: String(size) } : {}),
        ...(page.userTurns ? { userTurns: page.userTurns } : {}),
      };
    }) ?? { events: [], beforeCursor: null };
  }

  async readRecord(record: ChatHistoryRecordRange): Promise<AgentEvent | undefined> {
    return await this.read((size, readRange) => readChatHistoryRecord({ size, record, readRange })) ?? undefined;
  }

  private async read<T>(
    use: (size: number, readRange: (startByte: number, endByte: number) => Promise<Uint8Array>, swaps: number) => Promise<T>,
  ): Promise<T | null> {
    const opened = await this.openAtFlushedEnd();
    if (!opened) return null;
    const { file, size, swaps } = opened;
    try {
      return await use(size, fileRangeReader(file), swaps);
    } finally {
      await file.close();
    }
  }

  async subagentIndexOf(opened: OpenedLog): Promise<ChatSubagentIndex | null> {
    return opened.swaps === undefined ? null : this.indexSubagents(opened.size, fileRangeReader(opened.file), opened.swaps);
  }

  /** One read extends the index at a time; a rewritten file starts a new one. */
  private indexSubagents(size: number, readRange: (startByte: number, endByte: number) => Promise<Uint8Array>, swaps: number): Promise<ChatSubagentIndex> {
    const extended = this.subagentIndex.catch(() => null).then(async (current) => {
      const kept = current?.swaps === swaps ? current : null;
      // Indexes keep growing with the file a later read opened, which this one's size never reaches past.
      if (kept && (kept.index.end >= size || await kept.index.extend(size, readRange))) return kept;
      const index = new ChatSubagentIndex();
      if (!await index.extend(size, readRange)) throw new Error('Chat history does not end in a record');
      return { swaps, index };
    });
    this.subagentIndex = extended;
    return extended.then(({ index }) => index);
  }

  async openAtFlushedEnd(): Promise<(OpenedLog & { swaps: number }) | null> {
    for (;;) {
      await this.swapping;
      const { swaps } = this;
      let file;
      try {
        file = await open(this.filePath, 'r');
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
      if (!this.swapping && this.swaps === swaps) return { file, size: this.flushedEnd, swaps };
      await file.close();
    }
  }

  private async *lines({ file, size }: OpenedLog, start: number): AsyncGenerator<string> {
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let rest = '';
    for (let at = start; at < size;) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - at), at);
      if (bytesRead === 0) break;
      at += bytesRead;
      const lines = (rest + decoder.write(chunk.subarray(0, bytesRead))).split('\n');
      rest = lines.pop() ?? '';
      yield* lines;
    }
    rest += decoder.end();
    if (rest) yield rest;
  }

  private async readFirstLine(): Promise<string | null> {
    let file;
    try {
      file = await open(this.filePath, 'r');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    try {
      const bytes = Buffer.allocUnsafe(4096);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead === 0) return null;
      const text = bytes.subarray(0, bytesRead).toString('utf-8');
      const newline = text.indexOf('\n');
      return newline === -1 ? text : text.slice(0, newline);
    } finally {
      await file.close();
    }
  }
}
