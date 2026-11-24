import { isCodexAspTranscript, type ChatHistoryRecordRange, type CodexAspTranscript } from './engine/v1';
import { isRecord } from './type-guards';

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const MAX_SOURCE_PAGE_BYTES = 4 * 1024 * 1024;
const SOURCE_RANGE_BYTES = 256 * 1024;
export const CHAT_HISTORY_PAGE_MAX_BYTES = 1024 * 1024;

async function readExactRange(
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>,
  startByte: number,
  endByte: number,
  error: string,
): Promise<Uint8Array> {
  const bytes = await readRange(startByte, endByte);
  if (bytes.length !== endByte - startByte) throw new Error(error);
  return bytes;
}

function forEachJsonlRecord(
  bytes: Uint8Array,
  lineStart: number,
  offset: number,
  visit: (value: unknown, record: ChatHistoryRecordRange) => void,
): number {
  for (let lineEnd = bytes.indexOf(10, lineStart); lineEnd !== -1; lineEnd = bytes.indexOf(10, lineStart)) {
    try {
      visit(JSON.parse(decoder.decode(bytes.subarray(lineStart, lineEnd))), { offset: offset + lineStart, length: lineEnd - lineStart });
    } catch {}
    lineStart = lineEnd + 1;
  }
  return lineStart;
}

export async function readJsonlPage<T>(args: {
  size: number;
  limit: number;
  maxBytes?: number;
  turns?: { count: number; maxItems: number; turnId: (item: T) => string | undefined };
  before?: string | null;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
  parse: (value: unknown, record: ChatHistoryRecordRange) => T | undefined;
}): Promise<{ items: T[]; before: string | null }> {
  const maxBytes = args.maxBytes ?? Infinity;
  // A page holds up to maxBytes of records, so a smaller first read only costs a round trip on a remote store.
  const rangeBytes = Number.isFinite(maxBytes) ? Math.min(maxBytes, MAX_SOURCE_PAGE_BYTES) : SOURCE_RANGE_BYTES;
  const itemLimit = args.turns?.maxItems ?? args.limit;
  const turnIds = new Set<string>();
  let endByte = args.size;
  if (args.before === null) endByte = 0;
  else if (args.before !== undefined) {
    endByte = /^(0|[1-9]\d*)$/.test(args.before) ? Number(args.before) : Number.NaN;
  }
  if (!Number.isSafeInteger(endByte)
    || endByte < 0
    || endByte > args.size
    || !Number.isSafeInteger(args.limit)
    || args.limit < 1) {
    throw new RangeError('Invalid JSONL page');
  }

  let startByte = endByte;
  let head: Uint8Array = new Uint8Array();
  let headTerminated = false;
  let lineBreaks = 0;
  let endsWithLineBreak = false;
  const pages: Array<Array<{ item: T; startByte: number; bytes: number }>> = [];
  const recordStarts: number[][] = [];
  let itemCount = 0;
  let itemBytes = 0;
  // A trailing newline alone cannot delimit the record at the start of a byte range.
  while (startByte > 0
    && (recordStarts.flat().length < args.limit
      || (itemCount < itemLimit && itemBytes < maxBytes && turnIds.size <= (args.turns?.count ?? Infinity)))
    && (endByte - startByte < MAX_SOURCE_PAGE_BYTES
      || lineBreaks - (endsWithLineBreak ? 1 : 0) === 0)) {
    const read = endByte - startByte;
    const nextStartByte = Math.max(0, startByte - (read < MAX_SOURCE_PAGE_BYTES
      ? Math.min(Math.max(rangeBytes, read), MAX_SOURCE_PAGE_BYTES - read)
      : SOURCE_RANGE_BYTES));
    const chunk = await readExactRange(
      args.readRange,
      nextStartByte,
      startByte,
      'Incomplete JSONL page read',
    );
    if (startByte === endByte) endsWithLineBreak = chunk[chunk.length - 1] === 10;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) lineBreaks++;
    const bytes: Uint8Array = new Uint8Array(chunk.length + head.length + (headTerminated ? 1 : 0));
    bytes.set(chunk);
    bytes.set(head, chunk.length);
    if (headTerminated) bytes[bytes.length - 1] = 10;
    startByte = nextStartByte;
    const firstLineEnd = bytes.indexOf(10);
    const page: Array<{ item: T; startByte: number; bytes: number }> = [];
    const pageRecordStarts: number[] = [];
    forEachJsonlRecord(bytes, startByte > 0 ? firstLineEnd + 1 : 0, startByte, (value, record) => {
      pageRecordStarts.push(record.offset);
      const item = args.parse(value, record);
      // A record the parser rewrote is sent in its new form, so that is what it costs.
      if (item === undefined) return;
      const itemSize = item === value ? record.length : encoder.encode(JSON.stringify(item)).byteLength;
      page.push({ item, startByte: record.offset, bytes: itemSize });
      itemBytes += itemSize;
      const turnId = args.turns?.turnId(item);
      if (turnId !== undefined) turnIds.add(turnId);
    });
    head = firstLineEnd === -1 ? bytes : bytes.subarray(0, startByte > 0 ? firstLineEnd : 0);
    headTerminated = firstLineEnd !== -1;
    pages.push(page);
    recordStarts.push(pageRecordStarts);
    itemCount += page.length;
  }

  const candidates = pages.reverse().flat();
  const fits = (first: number, bytes: number, limit: number) =>
    first === candidates.length || (candidates.length - first < limit && bytes + candidates[first - 1].bytes <= maxBytes);
  let first = candidates.length;
  let selectedBytes = 0;
  if (args.turns) {
    const included = new Set<string>();
    let turnStart = -1;
    while (first > 0 && fits(first, selectedBytes, args.turns.maxItems)) {
      const turnId = args.turns.turnId(candidates[first - 1].item);
      if (turnId !== undefined && !included.has(turnId) && included.size === args.turns.count) break;
      first--;
      selectedBytes += candidates[first].bytes;
      if (turnId !== undefined) {
        included.add(turnId);
        turnStart = first;
      }
    }
    first = turnStart === -1 ? candidates.length : turnStart;
  }
  if (first === candidates.length) {
    selectedBytes = 0;
    while (first > 0 && fits(first, selectedBytes, itemLimit)) {
      first--;
      selectedBytes += candidates[first].bytes;
    }
  }
  // Starting a turn page at a prompt saves clients a fetch of the older page just to show that turn.
  const records = recordStarts.reverse().flat();
  const floor = records[Math.max(0, records.length - args.limit)] ?? Infinity;
  let floorFirst = first;
  while (floorFirst > 0 && candidates[floorFirst - 1].startByte >= floor) floorFirst--;
  if (args.turns && floorFirst < first) {
    const { turnId } = args.turns;
    const startsTurn = (index: number) => turnId(candidates[index].item) !== undefined || (index === 0 && startByte === 0);
    let start = floorFirst;
    while (start > 0 && !startsTurn(start)) start--;
    const bytes = candidates.slice(start, first).reduce((sum, candidate) => sum + candidate.bytes, selectedBytes);
    if (!startsTurn(start) || bytes > maxBytes) {
      start = floorFirst;
      while (start < first && !startsTurn(start)) start++;
    }
    floorFirst = start;
  }
  first = floorFirst;
  const selected = candidates.slice(first);
  const firstCompleteLine = headTerminated ? head.length + 1 : 0;
  let before = 0;
  if (first > 0 || itemCount >= itemLimit || itemBytes >= maxBytes) before = selected[0].startByte;
  else if (startByte > 0) {
    const nextBefore = startByte + firstCompleteLine;
    before = nextBefore < endByte ? nextBefore : startByte;
  }
  return {
    items: selected.map(({ item }) => item),
    before: before > 0 ? String(before) : null,
  };
}

// Past this, a catch-up read costs more than a fresh latest page.
const MAX_APPENDED_BYTES = 4 * 1024 * 1024;

/**
 * Records appended to an append-only JSONL file after byte offset `after`, or null when the
 * offset isn't a record boundary of this file (or is too far behind) and the caller should
 * serve a latest page instead.
 */
/** The first records of the file, from at most one page of bytes; a first record larger than that returns none. */
export async function readJsonlHead<T>(args: {
  size: number;
  limit: number;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
  parse: (value: unknown, record: ChatHistoryRecordRange) => T | undefined;
}): Promise<T[]> {
  const bytes = await readExactRange(args.readRange, 0, Math.min(args.size, CHAT_HISTORY_PAGE_MAX_BYTES), 'Incomplete JSONL head read');
  const items: T[] = [];
  forEachJsonlRecord(bytes, 0, 0, (value, record) => {
    if (items.length >= args.limit) return;
    const item = args.parse(value, record);
    if (item !== undefined) items.push(item);
  });
  return items;
}

export async function readJsonlAppended<T>(args: {
  size: number;
  after: string;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
  parse: (value: unknown, record: ChatHistoryRecordRange) => T | undefined;
}): Promise<{ items: T[]; after: string } | null> {
  const start = /^(0|[1-9]\d*)$/.test(args.after) ? Number(args.after) : Number.NaN;
  if (!Number.isSafeInteger(start) || start > args.size || args.size - start > MAX_APPENDED_BYTES) return null;
  if (start === args.size) return { items: [], after: args.after };
  // Reading from the byte before `start` proves it ends a record.
  const from = Math.max(0, start - 1);
  const bytes = await readExactRange(args.readRange, from, args.size, 'Incomplete JSONL append read');
  if (start > 0 && bytes[0] !== 10) return null;
  const items: T[] = [];
  const end = forEachJsonlRecord(bytes, start - from, from, (value, record) => {
    const item = args.parse(value, record);
    if (item !== undefined) items.push(item);
  });
  return { items, after: String(from + end) };
}

export const FORWARD_RANGE_BYTES = 4 * 1024 * 1024;

export async function readJsonlForward<T>(args: {
  size: number;
  from: number;
  maxBytes?: number;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
  parse: (value: unknown, record: ChatHistoryRecordRange) => T | undefined;
}): Promise<{ items: T[]; after: number | null } | null> {
  if (!Number.isSafeInteger(args.from) || args.from < 0 || args.from > args.size) return null;
  const items: T[] = [];
  let keptBytes = 0;
  // Reading from the byte before `from` proves it ends a record.
  let offset = Math.max(0, args.from - 1);
  const pageEnd = offset + (args.maxBytes ?? FORWARD_RANGE_BYTES);
  let lineStart = args.from - offset;
  let carry = new Uint8Array();
  for (let start = offset; start < args.size; start += FORWARD_RANGE_BYTES) {
    const chunk = await readExactRange(args.readRange, start, Math.min(args.size, start + FORWARD_RANGE_BYTES), 'Incomplete JSONL read');
    const bytes = new Uint8Array(carry.length + chunk.length);
    bytes.set(carry);
    bytes.set(chunk, carry.length);
    if (lineStart === 1 && bytes[0] !== 10) return null;
    const end = forEachJsonlRecord(bytes, lineStart, offset, (value, record) => {
      const item = args.parse(value, record);
      if (item === undefined) return;
      items.push(item);
      keptBytes += record.length;
    });
    if (end > lineStart && start + FORWARD_RANGE_BYTES < args.size && (start + FORWARD_RANGE_BYTES >= pageEnd || keptBytes >= FORWARD_RANGE_BYTES)) {
      return { items, after: offset + end };
    }
    carry = bytes.subarray(end);
    offset += end;
    lineStart = 0;
  }
  return { items, after: null };
}

export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export async function readJsonlRecord(args: {
  size: number;
  record: ChatHistoryRecordRange;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}): Promise<unknown> {
  const { offset, length } = args.record;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
    || length > MAX_RECORD_BYTES || offset + length >= args.size) return undefined;
  // The bytes on either side prove the range starts and ends a line.
  const from = Math.max(0, offset - 1);
  const bytes = await readExactRange(args.readRange, from, offset + length + 1, 'Incomplete JSONL record read');
  if ((offset > 0 && bytes[0] !== 10) || bytes[bytes.length - 1] !== 10) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes.subarray(offset - from, bytes.length - 1)));
  } catch {
    return undefined;
  }
}

export interface ChatTranscriptHistoryIndex {
  version: 2;
  sourceSize: number;
  removedMessageIds?: string[];
  subagentIndexSize?: number;
  codexAspTranscript?: {
    threadId: string;
    updatedAt: string;
    size: number;
  };
}

export function parseChatTranscriptHistoryIndex(value: unknown): ChatTranscriptHistoryIndex | undefined {
  if (!isRecord(value)
    || value.version !== 2
    || !isNonNegativeInteger(value.sourceSize)) return undefined;
  const removedMessageIds = Array.isArray(value.removedMessageIds)
    ? value.removedMessageIds.filter((id): id is string => typeof id === 'string')
    : [];
  const subagentIndexSize = isNonNegativeInteger(value.subagentIndexSize) && value.subagentIndexSize > 0 ? { subagentIndexSize: value.subagentIndexSize } : {};
  if (value.codexAspTranscript === undefined) {
    return { version: 2, sourceSize: value.sourceSize, ...(removedMessageIds.length ? { removedMessageIds } : {}), ...subagentIndexSize };
  }
  if (!isRecord(value.codexAspTranscript)
    || typeof value.codexAspTranscript.threadId !== 'string'
    || typeof value.codexAspTranscript.updatedAt !== 'string'
    || !isNonNegativeInteger(value.codexAspTranscript.size)) return undefined;
  return {
    version: 2,
    sourceSize: value.sourceSize,
    ...(removedMessageIds.length ? { removedMessageIds } : {}),
    ...subagentIndexSize,
    codexAspTranscript: {
      threadId: value.codexAspTranscript.threadId,
      updatedAt: value.codexAspTranscript.updatedAt,
      size: value.codexAspTranscript.size,
    },
  };
}

export function getChatTranscriptHistorySize(index: ChatTranscriptHistoryIndex): number {
  return index.codexAspTranscript?.size ?? 0;
}

export async function readCodexAspTurnPage(args: {
  index: ChatTranscriptHistoryIndex;
  limit: number;
  before?: string | null;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}): Promise<{ transcript: CodexAspTranscript | null; before: string | null }> {
  const metadata = args.index.codexAspTranscript;
  if (!metadata || args.before === null) return { transcript: null, before: null };
  const page = await readJsonlPage({
    size: metadata.size,
    limit: args.limit,
    before: args.before,
    readRange: args.readRange,
    parse: (value) => {
      const transcript = { threadId: metadata.threadId, updatedAt: metadata.updatedAt, turns: [value] };
      return isCodexAspTranscript(transcript) ? transcript.turns[0] : undefined;
    },
  });
  return {
    transcript: page.items.length > 0
      ? { threadId: metadata.threadId, updatedAt: metadata.updatedAt, turns: page.items }
      : null,
    before: page.before,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
