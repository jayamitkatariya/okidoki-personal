import type { AuthFallbackMessage, DisplayMessage, ErrorMessage, InterruptionMessage, ManagerEventNoticeMessage, UserMessage, UserMessageImage } from '../types';
import {
  AUTH_FALLBACK_EVENT_TYPE,
  CHAT_INTERRUPTED_EVENT_TYPE,
  CHAT_MESSAGE_REJECTED_EVENT_TYPE,
  CHAT_TURN_LOST_EVENT_TYPE,
  CHAT_TURN_LOST_MESSAGE,
  coerceAuthFallbackPayload,
  REJECTED_CODE_PAYLOAD_KEY,
  REJECTED_MESSAGE_ID_PAYLOAD_KEY,
  type AgentEvent,
} from '../../event';
import type { AgentProvider } from '../../agent';
import { CHAT_MESSAGE_REFUSED_ROW_CODES } from '../../types';
import { isManagerEventMessage, MANAGER_EVENT_TYPE, parseManagerEvents, stripManagerEventNotes } from '../../manager-events';
import type { ChatMessageSender, QueuedMessageInfo } from '../../engine/v1';
import { stripOkidokiInstructionBlock } from '../../prompts';
import { parseMessageOrigin } from '../../message-origin';
import { threadHandoffText } from '../../user-message-parser/chat-fork';
import { parseVideoSizes, stripAttachmentNote, withoutAttachmentPlaceholder } from '../../user-message-attachments';
import { excludeQueuedAcceptedEvents, getReplacedMessageId, getResentMessageId, parseTimestampMs } from '../../agent-event-utils';
import { USER_MESSAGE_MATCH_GRACE_PERIOD_MS } from '../constants';

import { insertDisplayMessageByTimestamp, INTERRUPTED_MESSAGE_REGEX } from './utils';
import { parseCodexEvents } from './codex-parser';
import { parseCursorEvents } from './cursor-parser';
import { parseOpencodeEvents } from './opencode-parser';
import { parseMuseEvents } from './muse-parser';
import { parseGeminiEvents } from './gemini-parser';
import { parsePiEvents } from './pi-parser';
import { parseOkidokiEvents } from './okidoki-parser';
import { parseClaudeEvents } from './claude-parser';

// A harness-native interruption marker (e.g. Claude's synthetic user message) and the
// engine's synthetic interruption event describe the same stop, so collapse them.
const INTERRUPTION_DEDUP_WINDOW_MS = 15_000;
// A Stop stamped this soon after a message it cancelled only looks later because two clocks stamped them. Any later and it stopped a newer run.
const STOP_CLOCK_SKEW_MS = 5_000;

export function parseAgentEvents(
  events: AgentEvent[],
  agentType: AgentProvider
): DisplayMessage[] {
  return withoutReplacedMessages(excludeQueuedAcceptedEvents(events, []), (segment) => withoutResentMessages(parseProviderEvents(segment, agentType), segment));
}

type ResendingMessage = Pick<QueuedMessageInfo, 'resendsMessageId' | 'senderUserId'>;

// A message sent again takes the place of the cancelled one it names from the moment it is sent, so one still waiting in line counts. Only a cancelled message can be named away, since the agent read every other one, and only by the person who sent it: a record that names no sender hides nothing.
function withoutResentMessages(messages: DisplayMessage[], events: AgentEvent[], waiting: readonly ResendingMessage[] = []): DisplayMessage[] {
  const resent = new Set<string>();
  for (const event of events) {
    const messageId = getResentMessageId(event);
    if (messageId && typeof event.payload.userId === 'string') resent.add(`${event.payload.userId}\n${messageId}`);
  }
  for (const { resendsMessageId, senderUserId } of waiting) {
    if (resendsMessageId && senderUserId) resent.add(`${senderUserId}\n${resendsMessageId}`);
  }
  return messages.filter((message) => !(message.type === 'user' && message.cancelled && message.senderUserId && resent.has(`${message.senderUserId}\n${message.id}`)));
}

function parseProviderEvents(events: AgentEvent[], agentType: AgentProvider, parentToolUseId?: string | null): DisplayMessage[] {
  if (agentType === 'codex') {
    return parseCodexEvents(events);
  }
  if (agentType === 'cursor') {
    return parseCursorEvents(events);
  }
  if (agentType === 'gemini') {
    return parseGeminiEvents(events);
  }
  if (agentType === 'muse') {
    return parseMuseEvents(events);
  }
  if (agentType === 'opencode') {
    return parseOpencodeEvents(events);
  }
  if (agentType === 'pi') {
    return parsePiEvents(events);
  }
  if (agentType === 'okidoki') {
    return parseOkidokiEvents(events);
  }
  return parseClaudeEvents(events, parentToolUseId);
}

export function parseDisplayMessages(
  events: AgentEvent[],
  agentType: AgentProvider,
  options: { filter?: boolean; parentToolUseId?: string | null; queue?: readonly ResendingMessage[] } = {},
): DisplayMessage[] {
  return withoutReplacedMessages(excludeQueuedAcceptedEvents(events, []), (segment) => {
    const parsedEvents = withoutResentMessages(parseProviderEvents(segment, agentType, options.parentToolUseId), segment, options.queue);
    const reconciledEvents: DisplayMessage[] = [];
    const firstIndexById = new Map<string, number>();
    for (const message of parsedEvents) {
      const index = message.type === 'user' ? firstIndexById.get(message.id) : undefined;
      if (index !== undefined) {
        reconciledEvents[index] = message;
        continue;
      }
      if (!firstIndexById.has(message.id)) firstIndexById.set(message.id, reconciledEvents.length);
      reconciledEvents.push(message);
    }
    if (options.filter === false) return reconciledEvents;
    return applyEngineNotices(
      applyInterruptions(filterDisplayMessages(reconciledEvents, agentType), segment),
      segment,
    );
  });
}

// Edits are only accepted while the chat is idle, so no turn spans one and each segment parses on its own.
function withoutReplacedMessages(events: AgentEvent[], parse: (segment: AgentEvent[]) => DisplayMessage[]): DisplayMessage[] {
  let kept: DisplayMessage[] = [];
  let start = 0;
  // An edit is recorded more than once (accepted, then the agent's copy); its first record is where it starts.
  const handled = new Set<string>();
  events.forEach((event, index) => {
    const replaced = getReplacedMessageId(event);
    if (replaced === null || handled.has(replaced)) return;
    handled.add(replaced);
    if (index === 0) return;
    kept.push(...parse(events.slice(start, index)));
    // Not loaded means it is on an older page, so everything loaded before the edit came after it.
    kept = kept.slice(0, Math.max(0, kept.findIndex(({ id }) => id === replaced)));
    start = index;
  });
  return start === 0 ? parse(events) : [...kept, ...parse(events.slice(start))];
}

function applyInterruptions(messages: DisplayMessage[], events: AgentEvent[]): DisplayMessage[] {
  const result = [...messages];

  for (const event of events) {
    if (event.type !== CHAT_INTERRUPTED_EVENT_TYPE) continue;
    const interruption: DisplayMessage = {
      id: `interruption-${event.timestamp}`,
      type: 'interruption',
      timestamp: event.timestamp,
      ...(event.payload.steered === true ? { steered: true } : {}),
    };
    insertDisplayMessageByTimestamp(result, interruption);
    // The app stamps a Stop and the worker stamps the messages it cancelled, so their times can swap; the Stop still ended the run above them.
    const at = result.indexOf(interruption);
    const stoppedMs = parseTimestampMs(event.timestamp);
    let to = at;
    for (let previous = result[to - 1]; previous?.type === 'user' && previous.cancelled && stoppedMs - parseTimestampMs(previous.timestamp) <= STOP_CLOCK_SKEW_MS; previous = result[to - 1]) to--;
    if (to < at) result.splice(to, 0, ...result.splice(at, 1));
  }

  let lastUserMs: number | null = null;
  let lastInterruption: InterruptionMessage | null = null;
  const finalized: DisplayMessage[] = [];
  for (const msg of result) {
    if (msg.type === 'user') {
      lastUserMs = parseTimestampMs(msg.timestamp);
      lastInterruption = null;
      finalized.push(msg);
      continue;
    }
    if (msg.type !== 'interruption') {
      finalized.push(msg);
      continue;
    }
    const ms = parseTimestampMs(msg.timestamp);
    if (lastInterruption && ms - parseTimestampMs(lastInterruption.timestamp) <= INTERRUPTION_DEDUP_WINDOW_MS) {
      if (msg.steered) lastInterruption.steered = true;
      continue;
    }
    lastInterruption = {
      ...msg,
      ...(lastUserMs !== null && ms >= lastUserMs ? { durationMs: ms - lastUserMs } : {}),
    };
    finalized.push(lastInterruption);
  }
  return finalized;
}

/**
 * Emitted for every agent, so they are injected here rather than in each provider parser.
 */
function applyEngineNotices(messages: DisplayMessage[], events: AgentEvent[]): DisplayMessage[] {
  const notices: Array<AuthFallbackMessage | ErrorMessage | ManagerEventNoticeMessage> = [];
  // An index into `events` would change every id when an earlier page is prepended, so notices at the same time are numbered among themselves.
  const sameTime = new Map<string, number>();
  const noticeId = (kind: string, timestamp: string) => {
    const id = `${kind}-${timestamp}`;
    const ordinal = sameTime.get(id) ?? 0;
    sameTime.set(id, ordinal + 1);
    return `${id}-${ordinal}`;
  };

  events.forEach((event) => {
    if (event.type === MANAGER_EVENT_TYPE) {
      const parsed = typeof event.payload.text === 'string' ? parseManagerEvents(event.payload.text) : null;
      if (parsed) notices.push({ id: noticeId('multitask-event', event.timestamp), type: 'multitask_event', events: parsed, timestamp: event.timestamp });
      return;
    }
    if (event.type === CHAT_MESSAGE_REJECTED_EVENT_TYPE) {
      notices.push({
        id: noticeId('message-rejected', event.timestamp),
        type: 'error',
        message: typeof event.payload.message === 'string' ? event.payload.message : 'Message was rejected',
        rejectedMessageId: typeof event.payload[REJECTED_MESSAGE_ID_PAYLOAD_KEY] === 'string' ? event.payload[REJECTED_MESSAGE_ID_PAYLOAD_KEY] : undefined,
        rejectedCode: CHAT_MESSAGE_REFUSED_ROW_CODES.find((code) => code === event.payload[REJECTED_CODE_PAYLOAD_KEY]),
        timestamp: event.timestamp,
      });
      return;
    }
    if (event.type === CHAT_TURN_LOST_EVENT_TYPE) {
      notices.push({
        id: noticeId('turn-lost', event.timestamp),
        type: 'error',
        message: CHAT_TURN_LOST_MESSAGE,
        timestamp: event.timestamp,
      });
      return;
    }
    if (event.type !== AUTH_FALLBACK_EVENT_TYPE) return;
    const payload = coerceAuthFallbackPayload(event.payload);
    if (!payload) return;
    notices.push({
      ...payload,
      id: noticeId('auth-fallback', event.timestamp),
      type: 'auth_fallback',
      timestamp: event.timestamp,
    });
  });

  if (notices.length === 0) return messages;

  const result = [...messages];
  for (const notice of notices) insertDisplayMessageByTimestamp(result, notice);
  return result;
}

function isCodexInitializationPrompt(message: DisplayMessage): boolean {
  return message.type === 'user' && stripOkidokiInstructionBlock(message.content).trim() === 'Hello';
}

export function createUserMessage(
  content: string,
  images?: UserMessageImage[],
): { message: UserMessage; timestamp: string } {
  const timestamp = new Date().toISOString();
  return {
    message: {
      id: `user-${Date.now()}`,
      type: 'user',
      content,
      images,
      timestamp,
    },
    timestamp,
  };
}

/**
 * Type guard to validate that a value is a well-formed backend agent event.
 * Use to filter raw events before passing to parseAgentEvents.
 */
export function isAgentBackendEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.timestamp === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null
  );
}

const strippedUserContents = new Map<string, ReturnType<typeof stripAttachmentNote>>();

/**
 * Apply post-processing to parsed display messages:
 * - Codex: filters out the initialization message pair (first user+agent exchange)
 */
function filterDisplayMessages(
  messages: DisplayMessage[],
  provider: AgentProvider
): DisplayMessage[] {
  let result = messages;

  // Codex: filter out initialization messages
  if (provider === 'codex') {
    const userMessages = result
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.type === 'user');

    if (userMessages.length >= 2 && isCodexInitializationPrompt(userMessages[0].msg)) {
      result = result.slice(userMessages[1].index);
    }
  }

  result = result.flatMap((msg): DisplayMessage[] => {
    if (msg.type !== 'user') return [msg];

    let stripped = strippedUserContents.get(msg.content);
    if (!stripped) {
      stripped = stripAttachmentNote(stripManagerEventNotes(msg.content));
      if (strippedUserContents.size >= 5_000) strippedUserContents.clear();
      strippedUserContents.set(msg.content, stripped);
    }
    const { content, files, walkthroughs, appshots, annotations } = stripped;

    if (!msg.cancelled && INTERRUPTED_MESSAGE_REGEX.test(content)) {
      return [{ id: msg.id, type: 'interruption', timestamp: msg.timestamp }];
    }

    const cleaned = withoutAttachmentPlaceholder(content, Boolean(msg.images?.length || files.length));
    if (cleaned.length === 0 && !msg.images?.length && files.length === 0 && walkthroughs.length === 0 && appshots.length === 0 && annotations.length === 0) return [];
    // Read before the strip above removes the instructions block that carries a workspace sender. A harness switch's handoff carries the message that switched it after the fork envelope.
    const origin = msg.cancelled ? null : parseMessageOrigin(threadHandoffText(msg.content) || msg.content);
    if (cleaned === msg.content && !origin && files.length === 0 && walkthroughs.length === 0 && appshots.length === 0 && annotations.length === 0) return [msg];
    return [{
      ...msg,
      content: cleaned,
      ...(origin ? { origin } : {}),
      ...(files.length > 0 ? { files, videoSizes: parseVideoSizes(msg.content) } : {}),
      ...(walkthroughs.length > 0 ? { walkthroughs } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(appshots.length > 0 ? { appshots } : {}),
    }];
  });

  return result;
}

// Codex records a sent message under `user-<id>`, while the sender and the optimistic copy use the plain id.
export function messageIdAliases(id: string): [string, string] {
  return [id, `user-${id}`];
}

export function sentMessageId(rowId: string): string {
  return rowId.startsWith('user-') ? rowId.slice('user-'.length) : rowId;
}

export function attachSendersToMessages(
  messages: DisplayMessage[],
  senders: ChatMessageSender[] | undefined
): DisplayMessage[] {
  if (!senders || senders.length === 0) {
    return messages;
  }

  const sendersByMessageId = new Map(senders.flatMap((sender) => sender.messageId
    ? messageIdAliases(sender.messageId).map((id) => [id, sender] as const)
    : []));
  const legacySenders = senders.filter((sender) => !sender.messageId);
  const userIndices: number[] = [];
  const attachSender = (message: DisplayMessage, sender: ChatMessageSender): DisplayMessage =>
    message.type === 'user' ? {
      ...message,
      // Markers are plain text a person can copy, so a recorded person always wins over a ship or check-in marker. A board answer is that person's own.
      origin: message.origin?.kind === 'board' ? message.origin : undefined,
      senderUserId: sender.senderUserId,
      senderEmail: sender.senderEmail,
      ...(sender.senderDisplayName ? { senderDisplayName: sender.senderDisplayName } : {}),
      ...(sender.senderAvatarUrl ? { senderAvatarUrl: sender.senderAvatarUrl } : {}),
    } : message;
  const matched = new Set<ChatMessageSender>();
  const next = messages.map((message) => {
    const sender = message.type === 'user' ? sendersByMessageId.get(message.id) : undefined;
    if (sender) matched.add(sender);
    return sender ? attachSender(message, sender) : message;
  });
  // Subagent updates have no sender; a guessed one would render them as a person's raw message.
  // A guess only fills in who sent a message: one from a ship or check-in, or one that already has a sender, keeps it, so a sender recorded before its own message arrives can't take another's.
  messages.forEach((message, index) => {
    if (message.type === 'user' && !message.origin && !message.senderUserId && !message.senderEmail && !sendersByMessageId.has(message.id) && !isManagerEventMessage(message.content)) {
      userIndices.push(index);
    }
  });

  const timestampSenders = senders.filter((sender) => sender.messageId && !matched.has(sender));
  for (const sender of timestampSenders) {
    const senderTime = parseTimestampMs(sender.recordedAt);
    if (!senderTime) continue;
    const match = userIndices
      .map((index) => ({ index, distance: Math.abs(parseTimestampMs(messages[index].timestamp) - senderTime) }))
      .filter(({ distance }) => distance <= USER_MESSAGE_MATCH_GRACE_PERIOD_MS)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!match) continue;
    next[match.index] = attachSender(next[match.index], sender);
    userIndices.splice(userIndices.indexOf(match.index), 1);
  }

  if (userIndices.length === 0 || legacySenders.length === 0) return next;

  const messagesOffset = Math.max(0, userIndices.length - legacySenders.length);
  const sendersOffset = Math.max(0, legacySenders.length - userIndices.length);
  const pairs = Math.min(userIndices.length, legacySenders.length);
  for (let i = 0; i < pairs; i += 1) {
    const sender = legacySenders[sendersOffset + i];
    if (!sender) continue;
    const messageIndex = userIndices[messagesOffset + i];
    next[messageIndex] = attachSender(next[messageIndex], sender);
  }
  return next;
}

// Re-export parsers for direct use if needed
export { codexPromptTurnId, parseCodexEvents } from './codex-parser';
export { parseCursorEvents } from './cursor-parser';
export { parseOpencodeEvents } from './opencode-parser';
export { parsePiEvents } from './pi-parser';
export { harnessEventToAgentEvent, harnessRetryToAgentEvent } from './okidoki-parser';
export { parseClaudeEvents, parseClaudeOrphanToolResults, readClaudeUserPrompt, isClaudeResultError, coerceClaudeResultPayload, stripAgentDiagnosticErrors, type ClaudeResultPayload } from './claude-parser';
export { parseMcpToolName } from './mcp';
export { skillNameFromFilePath, stringifyDisplayValue, isToolInputQuestion } from './utils';
