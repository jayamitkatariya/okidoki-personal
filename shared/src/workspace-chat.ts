import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  areSameUserMessageEvents,
  excludeQueuedAcceptedEvents,
  getEventTimestampMs,
  getRemovedMessageIds,
  getUserMessage,
  getUserMessageId,
} from './agent-event-utils';
import { extractToolResultText } from './display-message/task-accumulator';
import {
  createChatHistoryCursor,
  getTerminalChatProcessing,
  type ChatHistoryResponse,
  type ChatMessageSender,
  type ChatQueueResponse,
  type ChatSummary,
  type EngineEvent,
  type ListChatsResponse,
  type SendChatMessageRequest,
} from './engine/v1';
import type { EngineEnvironmentDetails } from './engine/environment';
import { newestChatFirst } from './engine/types';
import {
  ACCEPTED_USER_MESSAGE_SOURCE,
  CHAT_GOAL_EVENT_TYPE,
  CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE,
  CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE,
  CODEX_ITEM_PARTIAL_EVENT_TYPE,
  coerceChatGoalPayload,
  QUEUED_MESSAGE_REMOVED_EVENT_TYPE,
  getEventStreamId,
  type AgentEvent,
} from './event';
import { areUserMessagesWithinMatchWindow } from './user-message-matching';
import { isRecord } from './type-guards';
import { PERSISTED_QUERY_HASHES } from './persisted-query-hashes';
import { getGoalCommand, isCompactCommand } from './slash-commands';

export const WORKSPACE_EVENTS_SKIP_PARTIALS_PARAM = 'skipPartials';
export const WORKSPACE_EVENTS_HEARTBEAT_HEADER = 'Okidoki-Heartbeat-Ms';
export const WORKSPACE_EVENTS_HEARTBEAT_MS = 2_000;

export const isPartialSnapshotEvent = (event: AgentEvent) =>
  event.type === CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE || event.type === CODEX_ITEM_PARTIAL_EVENT_TYPE;

export type PersistedQuerySchemas = { workspaceChats: ListChatsResponse };
export const WORKSPACE_CHATS_QUERY_ROOT = `workspace-chats:${PERSISTED_QUERY_HASHES.workspaceChats}`;

export const workspaceChatKeys = {
  chats: (workspaceId: string | null | undefined) => [WORKSPACE_CHATS_QUERY_ROOT, workspaceId] as const,
  allChats: (workspaceId: string | null | undefined) =>
    ['workspace-all-chats', workspaceId] as const,
  histories: (workspaceId: string | null | undefined) => ['chat-history', workspaceId] as const,
  history: (workspaceId: string | null | undefined, chatId: string | null | undefined) =>
    ['chat-history', workspaceId, chatId] as const,
  queues: (workspaceId: string | null | undefined) => ['chat-queue', workspaceId] as const,
  queue: (workspaceId: string | null | undefined, chatId: string | null | undefined) =>
    ['chat-queue', workspaceId, chatId] as const,
};

export const WORKSPACE_CHATS_STALE_TIME_MS = 60_000;

export function workspaceChatsQueryOptions({
  workspaceId,
  fetchChats,
  enabled = true,
  staleTime = WORKSPACE_CHATS_STALE_TIME_MS,
}: {
  workspaceId: string | null | undefined;
  fetchChats: () => Promise<ListChatsResponse>;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: workspaceChatKeys.chats(workspaceId),
    queryFn: fetchChats,
    enabled: Boolean(workspaceId) && enabled,
    staleTime,
  });
}

export function allWorkspaceChatsQueryOptions({
  workspaceId,
  fetchChats,
  enabled = true,
  staleTime = 10_000,
}: {
  workspaceId: string | null | undefined;
  fetchChats: () => Promise<ListChatsResponse>;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: workspaceChatKeys.allChats(workspaceId),
    queryFn: fetchChats,
    enabled: Boolean(workspaceId) && enabled,
    staleTime,
  });
}

export function upsertWorkspaceChat(chats: ChatSummary[], chat: ChatSummary): ChatSummary[] {
  const existingIndex = chats.findIndex((item) => item.id === chat.id);
  if (existingIndex === -1) {
    return [chat, ...chats].sort(newestChatFirst);
  }

  const next = [...chats];
  next[existingIndex] = chat;
  return next.sort(newestChatFirst);
}

export function patchWorkspaceChat(
  chats: ChatSummary[],
  chatId: string,
  patch: Partial<
    Pick<ChatSummary, 'processing' | 'awaitingInput' | 'isAuthRetrying' | 'mayBeReconnecting' | 'updatedAt' | 'displayName'>
  >,
  shouldPatch: (chat: ChatSummary) => boolean = () => true,
): ChatSummary[] {
  let changed = false;
  const next = chats.map((chat) => {
    if (chat.id !== chatId || !shouldPatch(chat)) return chat;
    changed = true;
    return { ...chat, ...patch };
  });
  return changed ? next.sort(newestChatFirst) : chats;
}

export function upsertCachedWorkspaceChat(
  queryClient: QueryClient,
  workspaceId: string,
  chat: ChatSummary,
  replaceChatId?: string,
): void {
  queryClient.setQueryData<ListChatsResponse>(workspaceChatKeys.chats(workspaceId), (current) => ({
    ...(current ?? {}),
    chats: upsertWorkspaceChat(
      replaceChatId
        ? (current?.chats ?? []).filter((candidate) => candidate.id !== replaceChatId)
        : (current?.chats ?? []),
      chat,
    ),
  }));
}

export function removeCachedWorkspaceChat(
  queryClient: QueryClient,
  workspaceId: string,
  chatId: string,
): void {
  queryClient.setQueryData<ListChatsResponse>(workspaceChatKeys.chats(workspaceId), (current) =>
    current
      ? {
          ...current,
          chats: current.chats.filter((candidate) => candidate.id !== chatId),
        }
      : current,
  );
}

function isAcceptedUserMessage(event: AgentEvent): boolean {
  return getUserMessage(event) !== null && event.payload.source === ACCEPTED_USER_MESSAGE_SOURCE;
}

function getComparableUserMessage(event: AgentEvent): string | null {
  const message = getUserMessage(event);
  if (message !== null) return message;
  const payloadMessage = event.payload.message;
  if (
    event.type !== 'claude-user'
    || typeof payloadMessage !== 'object'
    || payloadMessage === null
    || !('content' in payloadMessage)
  ) {
    return null;
  }
  return extractToolResultText(payloadMessage.content) || null;
}

function areDuplicateUserMessages(a: AgentEvent, b: AgentEvent): boolean {
  if (areSameUserMessageEvents(a, b)) return true;
  const { userMessageId: aId, userMessage: aMessage } = workspaceChatEventSignals(a);
  const { userMessageId: bId, userMessage: bMessage } = workspaceChatEventSignals(b);
  if (aId !== null && bId !== null && aId !== bId) return false;
  if (!aMessage || aMessage !== bMessage) return false;

  const aAccepted = isAcceptedUserMessage(a);
  const bAccepted = isAcceptedUserMessage(b);
  return aAccepted !== bAccepted
    ? areUserMessagesWithinMatchWindow(
        { content: aMessage, timestamp: a.timestamp },
        { content: bMessage, timestamp: b.timestamp },
      )
    : false;
}

// Merges reuse event objects, so each event's signals are computed once instead of on every live update.
const eventSignalsCache = new WeakMap<AgentEvent, WorkspaceChatEventSignals>();

// The signals that make two events duplicates, and the timestamp that orders
// them. Both the pairwise predicate and the indexed merge below read them from
// here, so a change to the rules cannot apply to only one of the two.
interface WorkspaceChatEventSignals {
  streamId: string | null;
  json: string;
  userMessage: string | null;
  userMessageId: string | null;
  timestampMs: number;
}

// A compact page's copy of a tool result and the full one the live stream delivered are the same event.
function claudeToolResultId(event: AgentEvent): string | null {
  if (event.type !== 'claude-user') return null;
  const { message } = event.payload;
  const content = isRecord(message) ? message.content : undefined;
  const result = Array.isArray(content) ? content.find((block) => isRecord(block) && block.type === 'tool_result') : undefined;
  return isRecord(result) && typeof result.tool_use_id === 'string' ? `tool_result:${result.tool_use_id}` : null;
}

function workspaceChatEventSignals(event: AgentEvent): WorkspaceChatEventSignals {
  let signals = eventSignalsCache.get(event);
  if (signals === undefined) {
    signals = {
      streamId: getEventStreamId(event) ?? claudeToolResultId(event),
      json: JSON.stringify(event),
      userMessage: getComparableUserMessage(event),
      userMessageId: event.type === QUEUED_MESSAGE_REMOVED_EVENT_TYPE ? null : getUserMessageId(event),
      timestampMs: getEventTimestampMs(event),
    };
    eventSignalsCache.set(event, signals);
  }
  return signals;
}

export function areDuplicateWorkspaceChatEvents(a: AgentEvent, b: AgentEvent): boolean {
  const aSignals = workspaceChatEventSignals(a);
  const bSignals = workspaceChatEventSignals(b);
  return (
    (aSignals.streamId !== null && aSignals.streamId === bSignals.streamId)
    || aSignals.json === bSignals.json
    || areDuplicateUserMessages(a, b)
  );
}

// Index over those same signals, so merging stays linear instead of rescanning
// the whole transcript for every incoming event.
interface MergeIndex {
  byStreamId: Map<string, number>;
  byJson: Map<string, number>;
  byUserMessageId: Map<string, number>;
  byUserMessage: Map<string, { position: number; event: AgentEvent }[]>;
}

// The index a merge leaves, kept for the array it returned so a delta that only appends indexes just its own events.
const mergeIndexes = new WeakMap<readonly AgentEvent[], { index: MergeIndex; latestMs: number; removedIds: ReadonlySet<string> }>();

const emptyIndex = (): MergeIndex => ({
  byStreamId: new Map(),
  byJson: new Map(),
  byUserMessageId: new Map(),
  byUserMessage: new Map(),
});

function indexMergedEvent(index: MergeIndex, event: AgentEvent, position: number): void {
  const { streamId, json, userMessage, userMessageId } = workspaceChatEventSignals(event);
  if (streamId !== null && !index.byStreamId.has(streamId)) {
    index.byStreamId.set(streamId, position);
  }
  if (!index.byJson.has(json)) index.byJson.set(json, position);
  if (userMessageId !== null && !index.byUserMessageId.has(userMessageId)) {
    index.byUserMessageId.set(userMessageId, position);
  }
  if (userMessage !== null) {
    const bucket = index.byUserMessage.get(userMessage);
    if (!bucket) {
      index.byUserMessage.set(userMessage, [{ position, event }]);
      return;
    }
    const insertAt = bucket.findIndex((entry) => entry.position > position);
    bucket.splice(insertAt === -1 ? bucket.length : insertAt, 0, { position, event });
  }
}

// Replacements must not leave the replaced event in the index: a stale
// accepted-message entry can claim later provider events that the current
// occupant of the position would not match.
function unindexEvent(index: MergeIndex, previous: AgentEvent, position: number): void {
  const { streamId, json, userMessage, userMessageId } = workspaceChatEventSignals(previous);
  if (streamId !== null && index.byStreamId.get(streamId) === position) {
    index.byStreamId.delete(streamId);
  }
  if (index.byJson.get(json) === position) index.byJson.delete(json);
  if (userMessageId !== null && index.byUserMessageId.get(userMessageId) === position) {
    index.byUserMessageId.delete(userMessageId);
  }
  if (userMessage !== null) {
    const bucket = index.byUserMessage.get(userMessage) ?? [];
    const entryIndex = bucket.findIndex((entry) => entry.position === position);
    if (entryIndex !== -1) bucket.splice(entryIndex, 1);
    if (bucket.length === 0) {
      index.byUserMessage.delete(userMessage);
    }
  }
}

// First-match semantics: the earliest merged position where any duplicate
// signal fires.
function findDuplicatePosition(index: MergeIndex, event: AgentEvent): number {
  const { streamId, json, userMessage, userMessageId } = workspaceChatEventSignals(event);
  let match = -1;
  const consider = (position: number | undefined) => {
    if (position !== undefined && (match === -1 || position < match)) match = position;
  };
  if (streamId !== null) consider(index.byStreamId.get(streamId));
  consider(index.byJson.get(json));
  if (userMessageId !== null) consider(index.byUserMessageId.get(userMessageId));
  if (userMessage !== null) {
    for (const entry of index.byUserMessage.get(userMessage) ?? []) {
      if (areDuplicateUserMessages(entry.event, event)) {
        consider(entry.position);
        break;
      }
    }
  }
  return match;
}

/** Marks an event the client cache saved as a preview because it was too big; any fresh copy of it takes its place. */
export const CACHE_PLACEHOLDER_PAYLOAD_KEY = 'okidokiCachePlaceholder';

export function mergeWorkspaceChatHistoryEvents(
  primary: AgentEvent[],
  supplemental: AgentEvent[],
  removedMessageIds: readonly string[] = [],
): AgentEvent[] {
  // A live stream's next flush only takes its slot, so it skips indexing and re-sorting the whole transcript. Without
  // removals or a user-message signal, the stream id's first slot is the full merge's only match.
  const [flush] = supplemental;
  const flushStreamId = supplemental.length === 1 && removedMessageIds.length === 0 ? getEventStreamId(flush) : null;
  const cached = mergeIndexes.get(primary);
  if (flushStreamId !== null && getUserMessageId(flush) === null && getComparableUserMessage(flush) === null) {
    const slot = cached ? cached.index.byStreamId.get(flushStreamId) ?? -1 : primary.findIndex((event) => getEventStreamId(event) === flushStreamId);
    if (slot !== -1 && (cached ? cached.removedIds.size === 0 : !primary.some((event) => event.type === QUEUED_MESSAGE_REMOVED_EVENT_TYPE))) {
      const merged = [...primary];
      merged[slot] = flush;
      if (cached) {
        mergeIndexes.delete(primary);
        unindexEvent(cached.index, primary[slot], slot);
        indexMergedEvent(cached.index, flush, slot);
        mergeIndexes.set(merged, { ...cached, latestMs: Math.max(cached.latestMs, workspaceChatEventSignals(flush).timestampMs || 0) });
      }
      return merged;
    }
  }
  const removed = new Set(removedMessageIds);
  for (const messageId of cached?.removedIds ?? primary.flatMap(getRemovedMessageIds)) removed.add(messageId);
  for (const event of supplemental) {
    for (const messageId of getRemovedMessageIds(event)) removed.add(messageId);
  }
  if (removed.size > 0) {
    if (!cached || [...removed].some((messageId) => !cached.removedIds.has(messageId))) {
      const kept = excludeQueuedAcceptedEvents(primary, [], [...removed]);
      if (kept.length !== primary.length) primary = kept;
    }
    supplemental = excludeQueuedAcceptedEvents(supplemental, [], [...removed]);
  }
  if (supplemental.length === 0) return [...primary];
  const merged: Array<AgentEvent | null> = [...primary];
  // Taken, not shared: this merge edits the index in place, which would leave it wrong for the array it came from.
  const kept = mergeIndexes.get(primary);
  mergeIndexes.delete(primary);
  const index = kept?.index ?? emptyIndex();
  let latestMs = kept?.latestMs ?? 0;
  if (!kept) {
    for (let position = 0; position < primary.length; position++) {
      indexMergedEvent(index, primary[position], position);
      latestMs = Math.max(latestMs, workspaceChatEventSignals(primary[position]).timestampMs || 0);
    }
  }
  // Events new to the transcript are held back and indexed on their own so a
  // later supplemental event (the next flush of the same partial stream, a
  // re-sent accepted prompt) still replaces its earlier sibling.
  const additions: Array<AgentEvent | null> = [];
  const additionsIndex = emptyIndex();
  const addEvent = (event: AgentEvent) => {
    indexMergedEvent(additionsIndex, event, additions.length);
    additions.push(event);
  };
  for (const event of supplemental) {
    let list = merged;
    let listIndex = index;
    let position = findDuplicatePosition(index, event);
    if (position === -1) {
      list = additions;
      listIndex = additionsIndex;
      position = findDuplicatePosition(additionsIndex, event);
    }
    const previous = position === -1 ? null : list[position];
    if (!previous) {
      // The server runs an accepted prompt after everything the chat already shows, even when it was submitted before the last of that arrived.
      // Only a prompt inside the span the transcript covers, with no later prompt and nothing new after it, is one still waiting to run; an old one a wider read brings in keeps its place.
      const ms = getEventTimestampMs(event);
      const latest = primary.at(-1);
      const waiting = isAcceptedUserMessage(event) && latest !== undefined
        && ms >= getEventTimestampMs(primary[0]) && ms < getEventTimestampMs(latest)
        && !primary.some((other) => workspaceChatEventSignals(other).userMessageId !== null && getEventTimestampMs(other) > ms)
        && !supplemental.some((other) => getEventTimestampMs(other) > ms && findDuplicatePosition(index, other) === -1);
      addEvent(waiting ? { ...event, timestamp: latest.timestamp } : event);
      continue;
    }
    const messageId = getUserMessageId(event);
    if (isAcceptedUserMessage(previous) && !isAcceptedUserMessage(event)) {
      // The accepted placeholder is stamped when the prompt was submitted,
      // which for a prompt queued behind a running turn is mid-turn. The
      // transcript copy marks where the turn started, so it takes that place.
      list[position] = null;
      unindexEvent(listIndex, previous, position);
      addEvent(event);
    } else if (
      (getEventStreamId(event) !== null || (messageId !== null && messageId === getUserMessageId(previous)) || previous.payload[CACHE_PLACEHOLDER_PAYLOAD_KEY] === true)
      // An identical refetched copy keeps the cached object, whose identity the transcript parsers cache on.
      && workspaceChatEventSignals(event).json !== workspaceChatEventSignals(previous).json
    ) {
      list[position] = event;
      unindexEvent(listIndex, previous, position);
      indexMergedEvent(listIndex, event, position);
    }
  }
  const added = additions.filter((event): event is AgentEvent => event !== null);
  // A replacement can move the transcript's latest time later than anything the index has seen.
  const addedSet = new Set(added);
  for (const event of supplemental) if (!addedSet.has(event)) latestMs = Math.max(latestMs, workspaceChatEventSignals(event).timestampMs || 0);
  // Nothing left the transcript and every new event sorts after it, so they append and every position the index holds stays right.
  const result = merged.filter((event): event is AgentEvent => event !== null);
  if (result.length === merged.length && added.every((event) => !(workspaceChatEventSignals(event).timestampMs < latestMs))) {
    for (const event of [...added].sort((a, b) => workspaceChatEventSignals(a).timestampMs - workspaceChatEventSignals(b).timestampMs)) {
      indexMergedEvent(index, event, result.length);
      latestMs = Math.max(latestMs, workspaceChatEventSignals(event).timestampMs || 0);
      result.push(event);
    }
    mergeIndexes.set(result, { index, latestMs, removedIds: removed });
    return result;
  }
  return insertChronologically(result, added);
}

// A refetch can heal a gap in the middle of the cached transcript (a turn that
// outran the newest page while the event stream was down), so new events take
// their place by timestamp instead of landing after newer live events. Ties
// keep the existing event first.
function insertChronologically(existing: AgentEvent[], additions: AgentEvent[]): AgentEvent[] {
  const timestampMs = (event: AgentEvent) => workspaceChatEventSignals(event).timestampMs;
  const sorted = [...additions].sort((a, b) => timestampMs(a) - timestampMs(b));
  const result: AgentEvent[] = [];
  let next = 0;
  for (const event of existing) {
    const ms = timestampMs(event);
    while (next < sorted.length && timestampMs(sorted[next]) < ms) result.push(sorted[next++]);
    result.push(event);
  }
  result.push(...sorted.slice(next));
  return result;
}

function isSameChatSender(a: ChatMessageSender, b: ChatMessageSender): boolean {
  if (a.messageId && b.messageId) return a.messageId === b.messageId;
  return a.senderUserId === b.senderUserId && a.recordedAt === b.recordedAt;
}

function applyTurnMetadataToHistory(
  queryClient: QueryClient,
  workspaceId: string,
  chatId: string,
  sender: ChatMessageSender | undefined,
  event: AgentEvent | undefined,
): void {
  if (!sender && !event) return;
  // A history begun from this event alone has no file position; the first positioned delta starts it and pages this in.
  queryClient.setQueryData<ChatHistoryResponse>(
    workspaceChatKeys.history(workspaceId, chatId),
    (current) => current && {
      ...current,
      historyVersion: undefined,
      events: event
        ? mergeWorkspaceChatHistoryEvents(current.events, [event], current.removedMessageIds)
        : current.events,
      senders: sender
        ? [
            ...(current.senders ?? []).filter(
              (candidate) => !isSameChatSender(candidate, sender),
            ),
            sender,
          ]
        : current.senders,
    },
  );
}

type ChatListUpdate = (current: ListChatsResponse | undefined, includeChildren: boolean) => ListChatsResponse | undefined;

const chatListUpdatesByRead = new WeakMap<Promise<unknown>, ChatListUpdate[]>();

// A list read sent before an event lands after it with the older list, and an open stream may send nothing more to correct it,
// so the event's update runs again once that read lands. A first load gets the events the same way. The updates land as one write
// so subscribers never see a state older than the latest event.
export function updateChatLists(queryClient: QueryClient, workspaceId: string, update: ChatListUpdate): void {
  for (const [queryKey, includeChildren] of [[workspaceChatKeys.chats(workspaceId), false], [workspaceChatKeys.allChats(workspaceId), true]] as const) {
    queryClient.setQueryData<ListChatsResponse>(queryKey, (current) => update(current, includeChildren));
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    const reading = query?.state.fetchStatus === 'fetching' ? query.promise : undefined;
    if (!reading) continue;
    const updates = chatListUpdatesByRead.get(reading);
    if (updates) {
      updates.push(update);
      continue;
    }
    chatListUpdatesByRead.set(reading, [update]);
    const replay = () => queryClient.setQueryData<ListChatsResponse>(queryKey, (current) =>
      (chatListUpdatesByRead.get(reading) ?? []).reduce((list, pending) => pending(list, includeChildren), current));
    // A failed or cancelled read leaves the list as the events wrote it, so only a read that lands is corrected.
    void reading.then(replay, () => {});
  }
}

const patchChatList = (
  current: ListChatsResponse | undefined,
  chatId: string,
  patch: Parameters<typeof patchWorkspaceChat>[2],
  shouldPatch?: Parameters<typeof patchWorkspaceChat>[3],
) =>
  current
    ? {
        ...current,
        chats: patchWorkspaceChat(current.chats, chatId, patch, shouldPatch),
        deletedChats: current.deletedChats
          ? patchWorkspaceChat(current.deletedChats, chatId, patch, shouldPatch)
          : current.deletedChats,
      }
    : current;

export function patchCachedWorkspaceChats(
  queryClient: QueryClient,
  workspaceId: string,
  chatId: string,
  patch: Parameters<typeof patchWorkspaceChat>[2],
  shouldPatch?: Parameters<typeof patchWorkspaceChat>[3],
): void {
  for (const queryKey of [
    workspaceChatKeys.chats(workspaceId),
    workspaceChatKeys.allChats(workspaceId),
  ]) {
    queryClient.setQueryData<ListChatsResponse>(queryKey, (current) => patchChatList(current, chatId, patch, shouldPatch));
  }
}

export type WorkspaceChatEventResult =
  | 'chat-list-changed'
  | 'queue-changed'
  | 'turn-delta'
  | 'turn-completed';

type WorkspaceChatDeltaEvent = Extract<EngineEvent, { type: 'chat.turn.delta' }>;

export function applyWorkspaceChatDeltas(
  queryClient: QueryClient,
  workspaceId: string,
  deltas: WorkspaceChatDeltaEvent[],
): 'turn-delta' | 'queue-changed' {
  let result: 'turn-delta' | 'queue-changed' = 'turn-delta';
  const byChat = new Map<string, { events: AgentEvent[]; firstHistoryEnd?: number; historyEnd?: number }>();
  for (const delta of deltas) {
    if (delta.payload.event.type === CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE) continue;
    const chat = byChat.get(delta.payload.chatId) ?? { events: [] };
    chat.events.push(delta.payload.event);
    if (delta.payload.historyEnd !== undefined) {
      chat.firstHistoryEnd ??= delta.payload.historyEnd;
      chat.historyEnd = delta.payload.historyEnd;
    }
    byChat.set(delta.payload.chatId, chat);
  }
  for (const [chatId, { events, firstHistoryEnd, historyEnd }] of byChat) {
    const eventRemovedMessageIds = events.flatMap(getRemovedMessageIds);
    const goalEvent = events.findLast((event) => event.type === CHAT_GOAL_EVENT_TYPE);
    queryClient.setQueryData<ChatHistoryResponse>(workspaceChatKeys.history(workspaceId, chatId), (current) => ({
      // Events published from a history position on are all delivered live, so a history begun from
      // positioned deltas is the file's tail and pages older events from where the first one sat.
      ...(current ?? {
        thread_id: null,
        ...(firstHistoryEnd !== undefined ? { beforeCursor: createChatHistoryCursor({ events: firstHistoryEnd > 0 ? String(firstHistoryEnd) : null, turns: null }) } : {}),
      }),
      ...(historyEnd !== undefined && (!current || current.afterCursor !== undefined)
        ? { afterCursor: String(Math.max(historyEnd, Number(current?.afterCursor) || 0)) }
        : {}),
      historyVersion: undefined,
      events: mergeWorkspaceChatHistoryEvents(current?.events ?? [], events, current?.removedMessageIds),
      removedMessageIds: eventRemovedMessageIds.length
        ? [...new Set([...(current?.removedMessageIds ?? []), ...eventRemovedMessageIds])]
        : current?.removedMessageIds,
      goal: goalEvent ? coerceChatGoalPayload(goalEvent.payload) : current?.goal,
    }));
    const leftQueue = new Set(events.flatMap((event) => {
      if (event.type !== QUEUED_MESSAGE_REMOVED_EVENT_TYPE) return getUserMessageId(event) ?? [];
      result = 'queue-changed';
      return getRemovedMessageIds(event);
    }));
    if (leftQueue.size > 0) {
      queryClient.setQueryData<ChatQueueResponse>(
        workspaceChatKeys.queue(workspaceId, chatId),
        (current) => current
          ? { ...current, queue: current.queue.filter((message) => !leftQueue.has(message.id)) }
          : current,
      );
    }
  }
  return result;
}

export function applyWorkspaceChatEvent(
  queryClient: QueryClient,
  workspaceId: string,
  event: EngineEvent,
  options: { skipRootChatUpsert?: boolean } = {},
): WorkspaceChatEventResult | null {
  if (event.type === 'chat.created' || event.type === 'chat.updated') {
    const chat = event.payload.chat;
    updateChatLists(queryClient, workspaceId, (current, includeChildren) => {
      if (includeChildren) {
        return current && {
          ...current,
          chats: upsertWorkspaceChat(current.chats, chat),
          deletedChats: current.deletedChats?.filter((item) => item.id !== chat.id),
        };
      }
      if (chat.parentChatId !== null || options.skipRootChatUpsert) return current;
      return {
        ...(current ?? {}),
        chats: upsertWorkspaceChat(current?.chats ?? [], chat),
        deletedChats: (current?.deletedChats ?? []).filter((item) => item.id !== chat.id),
      };
    });
    return 'chat-list-changed';
  }

  if (event.type === 'chat.deleted') {
    const deletedChat = event.payload.chat;
    updateChatLists(queryClient, workspaceId, (current, includeChildren) =>
      current && {
        ...current,
        chats: current.chats.filter((chat) => chat.id !== event.payload.chatId),
        deletedChats: [
          ...(deletedChat?.deletedAt && (includeChildren || deletedChat.parentChatId === null) ? [deletedChat] : []),
          ...(current.deletedChats ?? []).filter((chat) => chat.id !== event.payload.chatId),
        ],
      });
    queryClient.removeQueries({
      queryKey: workspaceChatKeys.history(workspaceId, event.payload.chatId),
    });
    return 'chat-list-changed';
  }

  if (event.type === 'chat.turn.accepted') {
    if (event.payload.queued) {
      queryClient.invalidateQueries({
        queryKey: workspaceChatKeys.queue(workspaceId, event.payload.chatId),
      });
      return 'queue-changed';
    }

    applyTurnMetadataToHistory(
      queryClient,
      workspaceId,
      event.payload.chatId,
      event.payload.sender,
      event.payload.event,
    );
    updateChatLists(queryClient, workspaceId, (current) => patchChatList(current, event.payload.chatId, { processing: true, awaitingInput: false, updatedAt: event.ts }));
    return 'chat-list-changed';
  }

  if (event.type === 'chat.turn.started') {
    const acceptedEvent = event.payload.event;
    applyTurnMetadataToHistory(
      queryClient,
      workspaceId,
      event.payload.chatId,
      event.payload.sender,
      acceptedEvent,
    );
    queryClient.setQueryData<ChatQueueResponse>(
      workspaceChatKeys.queue(workspaceId, event.payload.chatId),
      (current) =>
        current
          ? {
              ...current,
              queue: current.queue.filter((message) => message.id !== event.payload.messageId),
            }
          : current,
    );
    queryClient.invalidateQueries({
      queryKey: workspaceChatKeys.queue(workspaceId, event.payload.chatId),
    });
    updateChatLists(queryClient, workspaceId, (current) => patchChatList(current, event.payload.chatId, { processing: true, awaitingInput: false, updatedAt: event.ts }));
    if (!acceptedEvent) {
      const history = queryClient.getQueryData<ChatHistoryResponse>(
        workspaceChatKeys.history(workspaceId, event.payload.chatId),
      );
      if (!history?.events.some(
        (candidate) => getUserMessageId(candidate) === event.payload.messageId,
      )) {
        queryClient.invalidateQueries({
          queryKey: workspaceChatKeys.history(workspaceId, event.payload.chatId),
        });
      }
    }
    return 'chat-list-changed';
  }

  if (event.type === 'chat.turn.delta') return applyWorkspaceChatDeltas(queryClient, workspaceId, [event]);

  if (event.type === 'chat.turn.completed' || event.type === 'chat.interrupted') {
    updateChatLists(queryClient, workspaceId, (current) => patchChatList(current, event.payload.chatId, {
      processing: getTerminalChatProcessing(event),
      awaitingInput: false,
      isAuthRetrying: false,
      mayBeReconnecting: false,
      updatedAt: event.ts,
    }));
    queryClient.invalidateQueries({
      queryKey: workspaceChatKeys.history(workspaceId, event.payload.chatId),
    });
    queryClient.invalidateQueries({
      queryKey: workspaceChatKeys.queue(workspaceId, event.payload.chatId),
    });
    queryClient.invalidateQueries({
      queryKey: workspaceChatKeys.allChats(workspaceId),
    });
    return 'turn-completed';
  }

  return null;
}

export function canUseCodexUltrafast(provider: string | undefined, model: string | undefined, details: EngineEnvironmentDetails | undefined): boolean {
  return provider === 'codex' && Boolean(model && details?.codexUltrafastModels?.includes(model));
}

// What each harness can fold into a running turn: goal commands and Codex's /compact start their own turn, and Cursor steers text only.
export function canSteerMessage(provider: string | undefined, request: Pick<SendChatMessageRequest, 'message' | 'goalMode' | 'images'>): boolean {
  if (provider === 'cursor') return !request.images?.length;
  if (provider === 'pi') return !request.message.trimStart().startsWith('/');
  if (provider !== 'claude' && provider !== 'codex') return false;
  return !getGoalCommand(request.message, request.goalMode) && !(provider === 'codex' && isCompactCommand(request.message));
}

/** A workspace whose engine has not reported yet runs a current image. */
export function supportsAgentProvider(provider: string, details: EngineEnvironmentDetails | undefined): boolean {
  return provider !== 'gemini' || !details || details.geminiAuthMethod !== undefined;
}

export function supportsMidTurnSteering(provider: string | undefined, details: EngineEnvironmentDetails | undefined): boolean {
  return Boolean(
    (provider === 'codex' && details?.supportsMidTurnSteering)
    || (provider === 'claude' && details?.supportsClaudeMidTurnSteering)
    || (provider === 'cursor' && details?.supportsCursorMidTurnSteering)
    || (provider === 'pi' && details?.supportsPiMidTurnSteering)
    || provider === 'gemini',
  );
}
