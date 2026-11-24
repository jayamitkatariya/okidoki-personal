import { CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE, RESENT_MESSAGE_ID_PAYLOAD_KEY, USER_MESSAGE_ID_PAYLOAD_KEY, coerceClaudePartialMessagePayload, type AgentEvent } from '../../event';
import { getUserMessageId } from '../../agent-event-utils';
import type { HarnessEvent, HarnessLiveMessage } from '../../harness/types';
import { isRecord } from '../../type-guards';
import { COMPACTION_CONTENT } from '../constants';
import type { DisplayMessage, UserMessageImage } from '../types';
import { extractToolResultText } from '../task-accumulator';
import { formatInferenceError } from './inference-error';
import { createCallDisplayMessage, stringifyDisplayValue, upsertDisplayMessage, userMessageImages } from './utils';

const HARNESS_EVENT_TYPE_PREFIX = 'harness-';
const HARNESS_RETRY_EVENT_TYPE = 'harness-live-retry';

// Harness steps reach clients as the AgentEvents every chat history carries, so history and live deltas share the transport.
export function harnessEventToAgentEvent(event: HarnessEvent): AgentEvent {
  // Instructions are for the model; clients only render the message.
  const { instructionsHash: _instructionsHash, instructions: _instructions, errorNotificationTarget: _errorNotificationTarget, ...payload } = { instructionsHash: undefined, instructions: undefined, errorNotificationTarget: undefined, ...event.payload };
  return {
    timestamp: event.created_at,
    type: `${HARNESS_EVENT_TYPE_PREFIX}${event.type}`,
    payload: {
      ...(event.type === 'thread_origin' ? { kind: event.payload.kind, parentThreadId: event.payload.parentThreadId } : payload),
      seq: event.seq,
      ...((event.type === 'user_message' || event.type === 'cancelled_message') && event.payload.messageId ? { [USER_MESSAGE_ID_PAYLOAD_KEY]: event.payload.messageId } : {}),
      ...((event.type === 'user_message' || event.type === 'cancelled_message') && event.payload.resendsMessageId ? { [RESENT_MESSAGE_ID_PAYLOAD_KEY]: event.payload.resendsMessageId } : {}),
    },
  };
}

/** Never saved, so it only shows while it is the thread's latest news. */
export function harnessRetryToAgentEvent({ attempt, maxAttempts, reason }: Extract<HarnessLiveMessage, { type: 'retry' }>, timestamp: string): AgentEvent {
  return { timestamp, type: HARNESS_RETRY_EVENT_TYPE, payload: { attempt, maxAttempts, reason } };
}

// pi-ai blocks carry fields (`arguments`, `mimeType`) that MessageContentBlock doesn't, so they are read as plain records.
function contentBlocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function blockImages(blocks: Record<string, unknown>[]): UserMessageImage[] {
  return blocks.flatMap((block) => block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string'
    ? [{ type: 'image' as const, mediaType: block.mimeType, data: block.data }]
    : []);
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>, timestamp: string, result?: { output?: string; isError: boolean; exitCode?: number }): DisplayMessage {
  const status = !result ? 'in_progress' : result.isError ? 'failed' : 'completed';
  if (name === 'bash' && typeof args.command === 'string') {
    return { id, type: 'command', command: args.command, output: result?.output, ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}), status, timestamp };
  }
  if ((name === 'write' || name === 'edit') && typeof args.path === 'string') {
    return { id, type: 'file_change', changes: [{ path: args.path, kind: name === 'write' ? 'add' : 'update' }], status, timestamp };
  }
  if (name === 'web_search' && typeof args.query === 'string') {
    return { id, type: 'web_search', query: args.query, status, timestamp };
  }
  if (name === 'spawn_agent') {
    const spawned: unknown = result?.output ? (() => { try { return JSON.parse(result.output); } catch { return null; } })() : null;
    return { id, type: 'subagent', toolUseId: id, description: typeof args.title === 'string' ? args.title : 'Okidoki subagent', prompt: typeof args.prompt === 'string' ? args.prompt : '', subagentType: 'okidoki', model: isRecord(spawned) && typeof spawned.model === 'string' ? spawned.model : typeof args.model === 'string' ? args.model : undefined, receiverThreadIds: isRecord(spawned) && typeof spawned.agentId === 'string' ? [spawned.agentId] : undefined, status: result?.isError ? 'failed' : 'in_progress', nestedEvents: [], timestamp };
  }
  return createCallDisplayMessage({ id, server: 'okidoki', tool: name, input: args, output: result?.output, status, timestamp });
}

export function parseOkidokiEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const toolCalls = new Map<string, { name: string; args: Record<string, unknown>; timestamp: string }>();
  // Partials are stamped when their stream starts, and a stream's reply, error or end of turn is saved after it ends, so a partial no newer
  // than the latest of those has ended, whatever order the client sorted them in. A thread streams one call at a time, so an older
  // partial than the newest is an attempt that was dropped and retried.
  const latestMs = (types: string[]) => Math.max(0, ...events.filter((event) => types.includes(event.type)).map((event) => Date.parse(event.timestamp)));
  const streamEndedMs = latestMs(['assistant_message', 'error', 'status'].map((type) => `${HARNESS_EVENT_TYPE_PREFIX}${type}`));
  const livePartialMs = latestMs([CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE]);
  const retryMs = latestMs([HARNESS_RETRY_EVENT_TYPE]);

  events.forEach((event) => {
    const { payload, timestamp } = event;
    const message = isRecord(payload.message) ? payload.message : {};
    switch (event.type) {
      // The client's copy of a sent prompt, shown until the worker saves it under the same message id.
      case 'event_msg': {
        if (payload.type !== 'user_message' || typeof payload.message !== 'string') return;
        const images = userMessageImages(payload.images);
        messages.push({ id: getUserMessageId(event) ?? `okidoki-pending-${timestamp}`, type: 'user', content: payload.message, ...(images ? { images } : {}), timestamp });
        return;
      }
      case `${HARNESS_EVENT_TYPE_PREFIX}cancelled_message`:
      case `${HARNESS_EVENT_TYPE_PREFIX}user_message`: {
        if (isRecord(payload.agentOutcome)) {
          messages.push({ id: `okidoki-peer-${String(payload.seq)}`, type: 'peer_message', direction: 'received', chat: typeof payload.agentOutcome.agentId === 'string' ? payload.agentOutcome.agentId : undefined, content: extractToolResultText(message.content), timestamp });
          for (const item of messages) {
            if (item.type === 'subagent' && item.receiverThreadIds?.includes(String(payload.agentOutcome.agentId))) {
              item.status = payload.agentOutcome.status === 'completed' ? 'completed' : payload.agentOutcome.status === 'help' ? 'in_progress' : 'failed';
              item.output = typeof payload.agentOutcome.response === 'string' ? payload.agentOutcome.response : undefined;
            }
          }
          return;
        }
        const images = blockImages(contentBlocks(message.content));
        const messageId = payload[USER_MESSAGE_ID_PAYLOAD_KEY];
        messages.push({
          id: typeof messageId === 'string' ? messageId : `okidoki-user-${String(payload.seq)}`,
          type: 'user',
          content: extractToolResultText(message.content),
          ...(images.length ? { images } : {}),
          // Okidoki history lists no senders, and only the sender is offered Send again. Sent messages stay without one: a subagent's assignment carries its owner's id.
          ...(event.type === `${HARNESS_EVENT_TYPE_PREFIX}cancelled_message` ? { cancelled: true, ...(typeof payload.userId === 'string' ? { senderUserId: payload.userId } : {}) } : {}),
          timestamp,
        });
        return;
      }
      case `${HARNESS_EVENT_TYPE_PREFIX}assistant_message`: {
        contentBlocks(message.content).forEach((block, blockIndex) => {
          const id = `okidoki-${String(payload.seq)}-${blockIndex}`;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) messages.push({ id, type: 'agent', content: block.text, timestamp });
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) messages.push({ id, type: 'reasoning', content: block.thinking, status: 'completed', timestamp });
          if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
            const call = { name: block.name, args: isRecord(block.arguments) ? block.arguments : {}, timestamp };
            toolCalls.set(block.id, call);
            messages.push(toolCallMessage(`okidoki-tool-${block.id}`, call.name, call.args, timestamp));
          }
        });
        if (message.stopReason === 'error') {
          messages.push({
            id: `okidoki-error-${String(payload.seq)}`,
            type: 'error',
            message: formatInferenceError(typeof message.errorMessage === 'string' && message.errorMessage ? message.errorMessage : 'The model request failed', {
              ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
              ...(typeof message.model === 'string' ? { model: message.model } : {}),
            }),
            timestamp,
          });
        }
        return;
      }
      case `${HARNESS_EVENT_TYPE_PREFIX}tool_result`: {
        if (typeof message.toolCallId !== 'string') return;
        const call = toolCalls.get(message.toolCallId) ?? { name: typeof message.toolName === 'string' ? message.toolName : 'tool', args: {}, timestamp };
        const exitCode = isRecord(message.details) && typeof message.details.exitCode === 'number' ? message.details.exitCode : undefined;
        upsertDisplayMessage(messages, toolCallMessage(`okidoki-tool-${message.toolCallId}`, call.name, call.args, call.timestamp, {
          output: extractToolResultText(message.content) || undefined,
          isError: message.isError === true,
          exitCode,
        }));
        return;
      }
      case `${HARNESS_EVENT_TYPE_PREFIX}compaction`:
        messages.push({ id: `okidoki-compaction-${String(payload.seq)}`, type: 'reasoning', content: COMPACTION_CONTENT, status: 'completed', timestamp, completedAt: timestamp });
        return;
      case `${HARNESS_EVENT_TYPE_PREFIX}error`:
        messages.push({ id: `okidoki-error-${String(payload.seq)}`, type: 'error', message: stringifyDisplayValue(payload.message) ?? 'The agent stopped with an error', timestamp });
        return;
      case HARNESS_RETRY_EVENT_TYPE: {
        const at = Date.parse(timestamp);
        if (at < retryMs || at <= streamEndedMs || at < livePartialMs || typeof payload.attempt !== 'number' || typeof payload.maxAttempts !== 'number') return;
        messages.push({
          id: 'okidoki-retry',
          type: 'capacity_retry',
          attempt: payload.attempt,
          maxAttempts: payload.maxAttempts,
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
          status: 'in_progress',
          timestamp,
        });
        return;
      }
      case CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE: {
        const partial = coerceClaudePartialMessagePayload(payload);
        if (!partial || Date.parse(event.timestamp) <= Math.max(streamEndedMs, retryMs) || Date.parse(event.timestamp) < livePartialMs) return;
        if (partial.thinking) upsertDisplayMessage(messages, { id: `okidoki-partial-${partial.streamId}-thinking`, type: 'reasoning', content: partial.thinking, status: 'in_progress', timestamp });
        if (partial.text) upsertDisplayMessage(messages, { id: `okidoki-partial-${partial.streamId}`, type: 'agent', content: partial.text, timestamp });
        return;
      }
    }
  });
  return messages;
}
