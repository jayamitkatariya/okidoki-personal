import type { AgentEvent } from './event';
import {
  ACCEPTED_USER_MESSAGE_SOURCE,
  CODEX_ASP_ITEM_ID_PAYLOAD_KEY,
  QUEUED_MESSAGE_REMOVED_EVENT_TYPE,
  REFUSED_COPY_MESSAGE_ID_PREFIX,
  REMOVED_MESSAGE_IDS_PAYLOAD_KEY,
  REPLACED_MESSAGE_ID_PAYLOAD_KEY,
  RESENT_MESSAGE_ID_PAYLOAD_KEY,
  USER_MESSAGE_ID_PAYLOAD_KEY,
} from './event';
import { isAgentBackendEvent } from './display-message';
import { areUserMessagesWithinMatchWindow, parseTimestampMs } from './user-message-matching';
export { parseTimestampMs } from './user-message-matching';

export function getUserMessage(event: AgentEvent): string | null {
  return event.type === 'event_msg'
    && event.payload.type === 'user_message'
    && typeof event.payload.message === 'string'
    ? event.payload.message
    : null;
}

export function getUserMessageId(event: AgentEvent): string | null {
  const messageId = event.payload[USER_MESSAGE_ID_PAYLOAD_KEY];
  return typeof messageId === 'string' ? messageId : null;
}

// A refused copy is nothing the agent saw, so a message that names one replaces nothing: the thread goes on, and the server takes the copy out itself.
export function getReplacedMessageId(event: AgentEvent): string | null {
  const messageId = event.payload[REPLACED_MESSAGE_ID_PAYLOAD_KEY];
  return typeof messageId === 'string' && !messageId.startsWith(REFUSED_COPY_MESSAGE_ID_PREFIX) && !messageId.startsWith(`user-${REFUSED_COPY_MESSAGE_ID_PREFIX}`) ? messageId : null;
}

export function getResentMessageId(event: AgentEvent): string | null {
  const messageId = event.payload[RESENT_MESSAGE_ID_PAYLOAD_KEY];
  return typeof messageId === 'string' ? messageId : null;
}

// A resend is named after the cancelled message it sends again, so a second press from any tab or device is the same message to the server.
export function resendMessageId(cancelledMessageId: string): string {
  return `${cancelledMessageId}-again`;
}

export function getRemovedMessageIds(event: AgentEvent): string[] {
  if (event.type !== QUEUED_MESSAGE_REMOVED_EVENT_TYPE) return [];
  const messageIds = event.payload[REMOVED_MESSAGE_IDS_PAYLOAD_KEY];
  if (Array.isArray(messageIds)) return messageIds.filter((id): id is string => typeof id === 'string');
  const messageId = getUserMessageId(event);
  return messageId ? [messageId] : [];
}

export function getUserMessageItemId(event: AgentEvent): string | null {
  const itemId = event.payload[CODEX_ASP_ITEM_ID_PAYLOAD_KEY];
  return typeof itemId === 'string' ? itemId : null;
}

// A prompt still in the provider queue belongs in the queue panel, not the
// transcript. Older engines can briefly report a just-queued prompt in history
// too — their post-turn completion hook clears turn state before the queue
// drains — so both web and mobile drop accepted-source events whose id is queued.
// Removal records stay in history so refetches and older pages cannot resurrect
// a canceled prompt, even if its acceptance finishes after the removal.
export function excludeQueuedAcceptedEvents<T extends AgentEvent>(
  events: readonly T[],
  queue: readonly { id: string }[],
  removedMessageIds: readonly string[] = [],
): T[] {
  const queuedMessageIds = new Set([...queue.map((message) => message.id), ...removedMessageIds]);
  for (const event of events) {
    for (const messageId of getRemovedMessageIds(event)) queuedMessageIds.add(messageId);
  }
  return events.filter((event) =>
    event.payload.source !== ACCEPTED_USER_MESSAGE_SOURCE
    || !queuedMessageIds.has(getUserMessageId(event) ?? ''));
}

export function getEventTimestampMs(event: AgentEvent): number {
  return parseTimestampMs(event.timestamp);
}

export function areSameUserMessageEvents(a: AgentEvent, b: AgentEvent): boolean {
  const aMessage = getUserMessage(a);
  const bMessage = getUserMessage(b);
  if (!aMessage || !bMessage) return false;

  const aMessageId = getUserMessageId(a);
  const bMessageId = getUserMessageId(b);
  if (aMessageId || bMessageId) return aMessageId === bMessageId;

  if (aMessage !== bMessage) return false;

  const aItemId = getUserMessageItemId(a);
  const bItemId = getUserMessageItemId(b);
  if (aItemId || bItemId) return aItemId === bItemId;

  return areUserMessagesWithinMatchWindow(
    { content: aMessage, timestamp: a.timestamp },
    { content: bMessage, timestamp: b.timestamp },
  );
}

export interface ParseAgentEventJsonlOptions {
  onInvalidLine?: (input: { line: string; error?: unknown }) => void;
}

export function parseAgentEventJsonlLine(
  line: string,
  options: ParseAgentEventJsonlOptions = {},
): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isAgentBackendEvent(parsed)) return parsed;
    options.onInvalidLine?.({ line: trimmed });
  } catch (error) {
    options.onInvalidLine?.({ line: trimmed, error });
  }
  return null;
}

export function parseAgentEventJsonl(
  content: string,
  options: ParseAgentEventJsonlOptions = {},
): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const line of content.split('\n')) {
    const event = parseAgentEventJsonlLine(line, options);
    if (event) events.push(event);
  }

  return events;
}
