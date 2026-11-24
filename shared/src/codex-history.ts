import type { AgentEvent } from './event';
import { safeJsonParse } from './json';
import { extractManagerEvents } from './manager-events';
import {
  ACCEPTED_USER_MESSAGE_SOURCE,
  CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE,
  CODEX_HISTORY_FORMAT_EVENT_TYPE,
  CODEX_ITEM_EVENT_TYPE,
} from './event';
import {
  applyCodexAspTranscriptDelta,
  codexItemFromEvent,
  codexTranscriptToEvents,
  isCodexAspTranscript,
  isCodexAspTranscriptDelta,
  type ChatHistoryOmittedBody,
  type ChatHistoryRecordRange,
  type ChatHistoryResponse,
  type CodexAspTranscript,
} from './engine/v1';
import { getEventTimestampMs, getReplacedMessageId, getUserMessage, getUserMessageId, parseAgentEventJsonl, type ParseAgentEventJsonlOptions } from './agent-event-utils';
import { CHAT_HISTORY_PAGE_MAX_BYTES, FORWARD_RANGE_BYTES, MAX_RECORD_BYTES, readJsonlAppended, readJsonlForward, readJsonlHead, readJsonlPage, readJsonlRecord } from './chat-transcript-pages';
import { CLAUDE_SUBAGENT_TOOL_NAMES, coerceBackgroundTaskPayload, extractToolResultText, isAgentBackendEvent, normalizeContentBlocks } from './display-message';
import { isRecord } from './type-guards';
import { userMessageImageHash } from './user-message-images';

function isChatHistoryEvent(value: unknown): value is AgentEvent {
  return isAgentBackendEvent(value)
    && value.type !== CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE
    && value.type !== CODEX_HISTORY_FORMAT_EVENT_TYPE;
}

const UNRENDERED_CLAUDE_SYSTEM_SUBTYPES: ReadonlySet<unknown> = new Set(['init', 'commands_changed', 'session_state_changed']);
const UNRENDERED_PI_EVENT_TYPES: ReadonlySet<string> = new Set([
  'pi-message_start',
  'pi-message_update',
  'pi-tool_execution_update',
  'pi-agent_start',
  'pi-agent_end',
  'pi-agent_settled',
  'pi-turn_start',
  'pi-turn_end',
  'pi-queue_update',
  'pi-entry_appended',
  'pi-session_info_changed',
  'pi-thinking_level_changed',
  'pi-compaction_start',
  'pi-compaction_end',
  'pi-auto_retry_start',
  'pi-auto_retry_end',
]);

function toChatHistoryPageEvent(value: unknown): AgentEvent | undefined {
  if (!isChatHistoryEvent(value)) return undefined;
  const { payload } = value;
  if (UNRENDERED_PI_EVENT_TYPES.has(value.type)) return undefined;
  if (value.type === 'pi-message_end' && isRecord(payload.message) && payload.message.role !== 'assistant') {
    return undefined;
  }
  if (value.type === 'claude-system' && (UNRENDERED_CLAUDE_SYSTEM_SUBTYPES.has(payload.subtype)
    || (payload.subtype === 'status' && payload.status !== 'compacting' && payload.compact_result === undefined))) {
    return undefined;
  }
  // Older engines stored the SDK's raw copy of every tool result next to the one in `message`.
  if (value.type === 'claude-user' && 'tool_use_result' in payload) {
    const { tool_use_result: _duplicate, ...rest } = payload;
    return { ...value, payload: rest };
  }
  return value;
}

// Bounds parse and render work for turns made of thousands of small tool calls.
export const CHAT_HISTORY_TURN_PAGE_MAX_EVENTS = 1_000;

/** Engines record a prompt more than once (accepted, started, Claude's own echo), always under its message id. A queued prompt is accepted inside the running turn, so only the later copies mark where its turn starts. */
export function getChatHistoryTurnId(event: AgentEvent): string | undefined {
  if (event.payload.source === ACCEPTED_USER_MESSAGE_SOURCE) return undefined;
  if (getUserMessage(event) !== null) return getUserMessageId(event) ?? event.timestamp;
  return event.type === 'claude-user' ? getUserMessageId(event) ?? undefined : undefined;
}

const COMPACT_BODY_MAX_BYTES = 2 * 1024;
const COMPACT_PREVIEW_CHARS = 1024;

// Transcripts read fields out of these (a spawned subagent's chat id, a wait's subagent events), so a preview breaks them.
function isStructuredToolOutput(text: string): boolean {
  if (extractManagerEvents(text).length > 0) return true;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  return safeJsonParse<unknown>(trimmed, undefined) !== undefined;
}

/** Without a `record` (a live event, not read from the file) the bodies keep only a preview, with no marker to fetch the rest by. */
export function compactChatHistoryEvent(event: AgentEvent, record?: ChatHistoryRecordRange): AgentEvent {
  let compacted = false;
  const sizeOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value ?? '')).length;
  const omit = (value: unknown): { okidokiOmitted?: ChatHistoryOmittedBody } | undefined => {
    const bytes = sizeOf(value);
    if (bytes <= COMPACT_BODY_MAX_BYTES) return undefined;
    compacted = true;
    return record ? { okidokiOmitted: { record, bytes } } : {};
  };
  const compactImage = (image: unknown) => {
    if (!isRecord(image)) return image;
    if (isRecord(image.source) && typeof image.source.data === 'string') {
      const omitted = omit(image.source.data);
      return omitted ? { ...image, source: { ...image.source, data: '' }, ...omitted } : image;
    }
    if (typeof image.data !== 'string') return image;
    const omitted = omit(image.data);
    return omitted ? { ...image, data: '', dataHash: userMessageImageHash({ data: image.data }, image), ...omitted } : image;
  };
  const { payload } = event;
  let next: Record<string, unknown> = payload;
  if (event.type === 'claude-user' && isRecord(payload.message) && Array.isArray(payload.message.content)) {
    next = {
      ...payload,
      message: {
        ...payload.message,
        content: payload.message.content.map((block: unknown) => {
          if (!isRecord(block)) return block;
          if (block.type === 'image') return compactImage(block);
          if (block.type !== 'tool_result') return block;
          const text = extractToolResultText(block.content);
          if (isStructuredToolOutput(text)) return block;
          const omitted = omit(text);
          const images = Array.isArray(block.content) ? block.content.filter((part: unknown) => isRecord(part) && part.type === 'image') : [];
          if (!omitted && images.length === 0) return block;
          const preview = omitted ? text.slice(0, COMPACT_PREVIEW_CHARS) : text;
          return {
            ...block,
            content: images.length > 0 ? [...(preview ? [{ type: 'text', text: preview }] : []), ...images.map(compactImage)] : preview,
            ...omitted,
          };
        }),
      },
    };
  } else if (event.type === 'event_msg' && Array.isArray(payload.images)) {
    next = { ...payload, images: payload.images.map(compactImage) };
  } else if (isRecord(payload.item)) {
    const { item } = payload;
    const omitted = typeof item.output === 'string' && !isStructuredToolOutput(item.output) ? omit(item.output) : undefined;
    next = {
      ...payload,
      item: {
        ...item,
        ...(omitted ? { output: extractToolResultText(item.output).slice(0, COMPACT_PREVIEW_CHARS), ...omitted } : {}),
        ...(Array.isArray(item.images) ? { images: item.images.map(compactImage) } : {}),
      },
    };
  }
  return compacted ? { ...event, payload: next } : event;
}

function chatHistoryRecordParser(compact: boolean | undefined) {
  return (value: unknown, record: ChatHistoryRecordRange) => {
    const event = toChatHistoryPageEvent(value);
    return event && compact ? compactChatHistoryEvent(event, record) : event;
  };
}

export function readChatHistoryPage({ userTurns, compact, ...args }: {
  size: number;
  limit: number;
  userTurns?: number;
  compact?: boolean;
  before?: string | null;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}) {
  return readJsonlPage({
    ...args,
    maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES,
    turns: userTurns ? { count: userTurns, maxItems: CHAT_HISTORY_TURN_PAGE_MAX_EVENTS, turnId: getChatHistoryTurnId } : undefined,
    parse: chatHistoryRecordParser(compact),
  });
}

export function readChatHistoryHead({ compact, ...args }: {
  size: number;
  limit: number;
  compact?: boolean;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}) {
  return readJsonlHead({ ...args, parse: chatHistoryRecordParser(compact) });
}

export function readChatHistoryAppended({ compact, ...args }: {
  size: number;
  after: string;
  compact?: boolean;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}) {
  return readJsonlAppended({ ...args, parse: chatHistoryRecordParser(compact) });
}

export async function readChatHistoryRecord(args: {
  size: number;
  record: ChatHistoryRecordRange;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}): Promise<AgentEvent | undefined> {
  return toChatHistoryPageEvent(await readJsonlRecord(args));
}

export function codexHistoryFormatEvent(): AgentEvent {
  return { timestamp: new Date().toISOString(), type: CODEX_HISTORY_FORMAT_EVENT_TYPE, payload: { version: 2 } };
}

/** Stable, so events with equal timestamps keep their relative order. */
function chronological(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => getEventTimestampMs(a) - getEventTimestampMs(b));
}

/**
 * Folds a Codex history that may still contain legacy transcript records into
 * plain item events. Records can be pushed one at a time, so callers can stream
 * a file that is too large to hold as one string.
 */
export class CodexHistoryEventFolder {
  private readonly events: AgentEvent[] = [];
  private readonly transcripts = new Map<string, CodexAspTranscript>();

  push(event: AgentEvent): void {
    if (event.type === CODEX_HISTORY_FORMAT_EVENT_TYPE) return;
    if (event.type !== CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE) {
      this.events.push(event);
      return;
    }
    const delta = event.payload.transcriptDelta;
    const transcript = isCodexAspTranscriptDelta(delta)
      ? applyCodexAspTranscriptDelta(this.transcripts.get(delta.threadId) ?? null, delta)
      : isCodexAspTranscript(event.payload.transcript) ? event.payload.transcript : null;
    if (transcript) this.transcripts.set(transcript.threadId, transcript);
  }

  finish(): AgentEvent[] {
    return chronological([...this.events, ...[...this.transcripts.values()].flatMap(codexTranscriptToEvents)]);
  }
}

/** Engines that predate item events still send codexAspTranscript; fold it in so callers read only events. */
export function withCodexTranscriptAsEvents(history: ChatHistoryResponse): ChatHistoryResponse {
  const { codexAspTranscript, turnsStartIndex: _turnsStartIndex, ...rest } = history;
  if (!codexAspTranscript) return rest;
  return { ...rest, events: chronological([...rest.events, ...codexTranscriptToEvents(codexAspTranscript)]) };
}

export function parseCodexHistoryEvents(content: string, options?: ParseAgentEventJsonlOptions): AgentEvent[] {
  const folder = new CodexHistoryEventFolder();
  for (const event of parseAgentEventJsonl(content, options)) folder.push(event);
  return folder.finish();
}

// Prompts are kept so an edit still drops the sub-agents it discarded.
function createSubagentHistoryFilter(spawnIds: Set<string>, onSpawn?: (id: string) => void): (event: AgentEvent) => string | boolean {
  return (event) => {
    const { type, payload } = event;
    if (typeof payload.parent_tool_use_id === 'string') return payload.parent_tool_use_id;
    if (getUserMessageId(event) !== null || getReplacedMessageId(event) !== null) return true;
    if (type === CODEX_ITEM_EVENT_TYPE) return codexItemFromEvent(event)?.item.type === 'subagent';
    if (coerceBackgroundTaskPayload(payload)) return true;
    const blocks = normalizeContentBlocks(isRecord(payload.message) ? payload.message.content : undefined);
    if (type === 'claude-assistant') {
      const spawns = blocks.filter((block) => block.type === 'tool_use' && block.id && CLAUDE_SUBAGENT_TOOL_NAMES.has(block.name ?? ''));
      for (const block of spawns) {
        if (!block.id) continue;
        spawnIds.add(block.id);
        onSpawn?.(block.id);
      }
      return spawns.length > 0;
    }
    if (type !== 'claude-user') return false;
    const results = blocks.filter((block) => block.type === 'tool_result' && spawnIds.has(block.tool_use_id ?? ''));
    for (const block of results) if (block.tool_use_id) spawnIds.delete(block.tool_use_id);
    return results.length > 0;
  };
}

// Replaying a workflow agent's unchanged entry changes nothing, so after a task's first snapshot only changed agents are kept.
function createTaskProgressFilter(): (event: AgentEvent) => string[] | null | false {
  const tasks = new Set<string>();
  const agents = new Map<string, string>();
  return (event) => {
    const task = coerceBackgroundTaskPayload(event.payload);
    if (!task) return null;
    const changed = (task.workflowAgents ?? []).filter((agent) => {
      const value = JSON.stringify(agent);
      const same = agents.get(agent.agentId) === value;
      agents.set(agent.agentId, value);
      return !same;
    }).map((agent) => agent.agentId);
    const first = !tasks.has(task.taskId);
    tasks.add(task.taskId);
    if (task.subtype !== 'task_progress' || first) return null;
    return changed.length > 0 && changed;
  };
}

function keepWorkflowAgents(event: AgentEvent, agentIds: string[] | null): AgentEvent {
  if (!agentIds) return event;
  const agents = coerceBackgroundTaskPayload(event.payload)?.workflowAgents?.filter((agent) => agentIds.includes(agent.agentId)) ?? [];
  return { ...event, payload: { ...event.payload, workflow_progress: agents.map((agent) => ({ type: 'workflow_agent', ...agent })) } };
}

function parseSubagentHistoryCursor(cursor: string | undefined): { offset: number; spawns: string[]; inIndexFile: boolean } | null {
  const parsed = cursor === undefined ? { offset: 0, spawns: [] } : safeJsonParse<unknown>(cursor, null);
  if (!isRecord(parsed) || typeof parsed.offset !== 'number' || !Array.isArray(parsed.spawns) || !parsed.spawns.every((id): id is string => typeof id === 'string')) return null;
  return { offset: parsed.offset, spawns: parsed.spawns, inIndexFile: parsed.inIndexFile === true };
}

const subagentHistoryCursor = (offset: number, spawns: string[] = [], inIndexFile = false) => JSON.stringify({ offset, spawns, ...(inIndexFile ? { inIndexFile } : {}) });

// List and single sub-agent reads scan further per page, since they keep only a few records.
const SUBAGENT_LIST_PAGE_SOURCE_BYTES = 64 * 1024 * 1024;

// Sub-agents can be spawned anywhere in a chat, so the cursor carries spawns still waiting for their result into later pages.
export async function readChatSubagentHistory({ size, compact, cursor, list, subagentId, readRange }: {
  size: number;
  compact?: boolean;
  cursor?: string;
  list?: boolean;
  subagentId?: string;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}): Promise<{ events: AgentEvent[]; cursor: string | null; subagentCursors?: Record<string, string> } | null> {
  const parsed = parseSubagentHistoryCursor(cursor);
  if (!parsed || parsed.inIndexFile) return null;
  const spawnIds = new Set(parsed.spawns);
  const subagentCursors: Record<string, string> = {};
  let spawnOffset = 0;
  // A sub-agent's own transcript starts after its spawn, so its read can start there.
  const keep = createSubagentHistoryFilter(spawnIds, list ? (id) => { subagentCursors[id] = subagentHistoryCursor(spawnOffset); } : undefined);
  const progress = list ? createTaskProgressFilter() : undefined;
  const page = await readJsonlForward({
    size,
    from: parsed.offset,
    maxBytes: list || subagentId !== undefined ? SUBAGENT_LIST_PAGE_SOURCE_BYTES : undefined,
    readRange,
    parse: (value, record) => {
      const event = toChatHistoryPageEvent(value);
      if (!event) return undefined;
      spawnOffset = record.offset;
      const kept = keep(event);
      if (subagentId !== undefined ? kept !== subagentId : list ? kept !== true : kept === false) return undefined;
      const agents = progress ? progress(event) : null;
      if (agents === false) return undefined;
      const listed = keepWorkflowAgents(event, agents);
      return compact ? compactChatHistoryEvent(listed, record) : listed;
    },
  });
  if (!page) return null;
  return {
    events: page.items,
    cursor: page.after === null ? null : subagentHistoryCursor(page.after, [...spawnIds]),
    ...(list ? { subagentCursors } : {}),
  };
}

export class ChatSubagentIndex {
  end = 0;
  private readonly listed: { record: ChatHistoryRecordRange; agents: string[] | null }[] = [];
  private readonly transcripts = new Map<string, ChatHistoryRecordRange[]>();
  private readonly spawns = new Map<string, number>();
  private at = 0;
  private readonly keep = createSubagentHistoryFilter(new Set(), (id) => this.spawns.set(id, this.at));
  private readonly progress = createTaskProgressFilter();

  async extend(size: number, readRange: (startByte: number, endByte: number) => Promise<Uint8Array>): Promise<boolean> {
    while (this.end < size) {
      const page = await readJsonlForward({
        size,
        from: this.end,
        readRange,
        parse: (value, record) => {
          const event = toChatHistoryPageEvent(value);
          this.at = record.offset;
          const kept = event && this.keep(event);
          if (kept === true) {
            const agents = this.progress(event);
            if (agents !== false) this.listed.push({ record, agents });
          } else if (typeof kept === 'string') {
            const records = this.transcripts.get(kept);
            if (records) records.push(record);
            else this.transcripts.set(kept, [record]);
          }
          return undefined;
        },
      });
      if (!page) return false;
      this.end = page.after ?? size;
    }
    return true;
  }

  async read({ size, compact, cursor, subagentId, readRange }: {
    size: number;
    compact?: boolean;
    cursor?: string;
    subagentId?: string;
    readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
  }): Promise<{ events: AgentEvent[]; cursor: string | null } | null> {
    const parsed = parseSubagentHistoryCursor(cursor);
    // An index file cursor comes from a saved transcript read before the workspace woke; refusing it makes the client start over.
    if (!parsed || parsed.inIndexFile) return null;
    const records = subagentId === undefined ? this.listed : (this.transcripts.get(subagentId) ?? []).map((record) => ({ record, agents: null }));
    let index = records.findIndex(({ record }) => record.offset >= parsed.offset);
    if (index === -1) index = records.length;
    const events: AgentEvent[] = [];
    let keptBytes = 0;
    // A reader that opened the log before it grew stops at the end it was given.
    for (; index < records.length && records[index].record.offset + records[index].record.length < size && keptBytes < FORWARD_RANGE_BYTES; index++) {
      const { record, agents } = records[index];
      const event = toChatHistoryPageEvent(await readJsonlRecord({ size, record, readRange }));
      const listed = event && keepWorkflowAgents(event, agents);
      if (listed) events.push(compact ? compactChatHistoryEvent(listed, record) : listed);
      keptBytes += listed && agents ? new TextEncoder().encode(JSON.stringify(listed)).length : record.length;
    }
    const next = records[index]?.record;
    return { events, cursor: next && next.offset + next.length < size ? subagentHistoryCursor(next.offset) : null };
  }

  async toFile(size: number, readRange: (startByte: number, endByte: number) => Promise<Uint8Array>): Promise<string> {
    // read() skips records too big to read whole, which the scan this file stands in for keeps.
    if (this.listed.some(({ record }) => record.offset + record.length < size && record.length > MAX_RECORD_BYTES)) throw new Error('A listed record is too big for a sub-agent index file');
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.read({ size, compact: true, cursor, readRange });
      if (!page) throw new Error('Sub-agent index read failed');
      for (const event of page.events) lines.push(JSON.stringify(event));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    const spans: SubagentIndexHeader['spans'] = {};
    for (const [id, records] of this.transcripts) {
      const saved = records.filter((record) => record.offset + record.length < size);
      const last = saved.at(-1);
      if (last) spans[id] = [saved[0].offset, last.offset + last.length + 1];
    }
    const header: SubagentIndexHeader = {
      version: SUBAGENT_INDEX_FILE_VERSION,
      sourceSize: size,
      spans,
      spawns: Object.fromEntries([...this.spawns].filter(([, offset]) => offset < size)),
    };
    return `${[JSON.stringify(header), ...lines].join('\n')}\n`;
  }
}

const SUBAGENT_INDEX_FILE_VERSION = 1;

interface SubagentIndexHeader {
  version: typeof SUBAGENT_INDEX_FILE_VERSION;
  sourceSize: number;
  /** Where each sub-agent's own events lie in the transcript: from its first record to just past its last one's newline. */
  spans: Record<string, [number, number]>;
  spawns: Record<string, number>;
}

async function readSubagentIndexHeader(size: number, readIndex: (startByte: number, endByte: number) => Promise<Uint8Array>) {
  for (let end = Math.min(size, 1 << 20); ; end = Math.min(size, end * 4)) {
    const bytes = await readIndex(0, end);
    const newline = bytes.indexOf(10);
    if (newline !== -1) {
      const header = safeJsonParse<unknown>(new TextDecoder().decode(bytes.subarray(0, newline)), null);
      if (!isRecord(header) || header.version !== SUBAGENT_INDEX_FILE_VERSION || typeof header.sourceSize !== 'number' || !isRecord(header.spans) || !isRecord(header.spawns)) return null;
      return {
        sourceSize: header.sourceSize,
        spans: new Map(Object.entries(header.spans).filter((entry): entry is [string, [number, number]] => (
          Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every(Number.isSafeInteger)
        ))),
        spawns: Object.entries(header.spawns).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1])),
        end: newline + 1,
      };
    }
    if (end === size) return null;
  }
}

/**
 * A compact list or single sub-agent read of a saved transcript through its sub-agent index file. Undefined when the file can't
 * answer it (a full read, a cursor from a scan, or a file for other bytes), so the caller scans instead.
 */
export async function readChatSubagentIndexFile({ size, sourceSize, compact, cursor, list, subagentId, readIndex, readRange }: {
  size: number;
  sourceSize: number;
  compact?: boolean;
  cursor?: string;
  list?: boolean;
  subagentId?: string;
  readIndex: (startByte: number, endByte: number) => Promise<Uint8Array>;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}): Promise<{ events: AgentEvent[]; cursor: string | null; subagentCursors?: Record<string, string> } | null | undefined> {
  const parsed = parseSubagentHistoryCursor(cursor);
  if (!parsed) return null;
  if (subagentId === undefined && (!list || !compact || (cursor !== undefined && !parsed.inIndexFile))) return undefined;
  const listPage = async (from: number, subagentCursors?: Record<string, string>) => {
    const page = await readJsonlForward({ size, from, readRange: readIndex, parse: (value) => isChatHistoryEvent(value) ? value : undefined });
    return page && { events: page.items, cursor: page.after === null ? null : subagentHistoryCursor(page.after, [], true), ...(subagentCursors ? { subagentCursors } : {}) };
  };
  if (parsed.inIndexFile) return subagentId === undefined ? listPage(parsed.offset) : null;
  const header = await readSubagentIndexHeader(size, readIndex);
  if (!header || header.sourceSize !== sourceSize) return undefined;
  if (subagentId === undefined) {
    return listPage(header.end, Object.fromEntries(header.spawns.map(([id, offset]) => [id, subagentHistoryCursor(offset)])));
  }
  const span = header.spans.get(subagentId);
  if (!span || Math.max(parsed.offset, span[0]) >= span[1]) return { events: [], cursor: null };
  const page = await readJsonlForward({
    size: span[1],
    from: Math.max(parsed.offset, span[0]),
    maxBytes: SUBAGENT_LIST_PAGE_SOURCE_BYTES,
    readRange,
    parse: (value, record): AgentEvent | undefined => {
      const event = toChatHistoryPageEvent(value);
      if (event?.payload.parent_tool_use_id !== subagentId) return undefined;
      return compact ? compactChatHistoryEvent(event, record) : event;
    },
  });
  return page && { events: page.items, cursor: page.after === null ? null : subagentHistoryCursor(page.after) };
}
