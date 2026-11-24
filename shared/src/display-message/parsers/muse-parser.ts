import { getUserMessage, getUserMessageId } from '../../agent-event-utils';
import type { AgentEvent } from '../../event';
import { isRecord } from '../../type-guards';
import type { DisplayMessage } from '../types';
import { COMPACTION_CONTENT } from '../constants';
import { applyToolInputEvent, type ToolInputEventState, createCallDisplayMessage, isToolInputQuestion, stringifyDisplayValue, upsertDisplayMessage } from './utils';

export function parseMuseEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const deltas = new Map<string, string>();
  const inputState: ToolInputEventState = { requests: new Map(), resolutions: new Map(), requestedAt: new Map() };

  for (const event of events) {
    const userContent = getUserMessage(event);
    if (userContent !== null) {
      if (userContent.trim()) messages.push({
        id: getUserMessageId(event) ?? `muse-user-${event.timestamp}`,
        type: 'user',
        content: userContent,
        timestamp: event.timestamp,
      });
      continue;
    }
    if (event.type === 'muse-error') {
      messages.push({
        id: `muse-error-${event.timestamp}`,
        type: 'error',
        message: typeof event.payload.message === 'string' ? event.payload.message : 'Muse failed',
        timestamp: event.timestamp,
      });
      continue;
    }
    if (event.type === 'muse-turn-completed' && isRecord(event.payload.error)) {
      messages.push({
        id: `muse-turn-error-${typeof event.payload.turnId === 'string' ? event.payload.turnId : event.timestamp}`,
        type: 'error',
        message: typeof event.payload.error.message === 'string' ? event.payload.error.message : 'Muse turn failed',
        timestamp: event.timestamp,
      });
      continue;
    }
    if (applyToolInputEvent(event, messages, 'muse', inputState, isToolInputQuestion)) continue;
    if (event.type === 'muse-item-delta' && typeof event.payload.itemId === 'string' && typeof event.payload.delta === 'string') {
      const field = typeof event.payload.field === 'string' ? event.payload.field : 'text';
      const key = `${event.payload.itemId}:${field}`;
      const content = `${deltas.get(key) ?? ''}${event.payload.delta}`;
      deltas.set(key, content);
      if (field === 'text') upsertDisplayMessage(messages, {
        id: `muse-agent-${event.payload.itemId}`,
        type: 'agent',
        content,
        timestamp: event.timestamp,
      });
      if (field.startsWith('summary')) upsertDisplayMessage(messages, {
        id: `muse-reasoning-${event.payload.itemId}`,
        type: 'reasoning',
        content,
        status: 'in_progress',
        timestamp: event.timestamp,
      });
      continue;
    }
    if (!['muse-item-started', 'muse-item-updated', 'muse-item-completed'].includes(event.type) || !isRecord(event.payload.item)) continue;
    const item = event.payload.item;
    if (typeof item.itemId !== 'string' || typeof item.kind !== 'string') continue;
    const terminal = item.status !== 'inProgress';
    if (item.kind === 'agentMessage' && typeof item.text === 'string' && item.text) {
      upsertDisplayMessage(messages, {
        id: `muse-agent-${item.itemId}`,
        type: 'agent',
        content: item.text,
        timestamp: typeof item.recordedAt === 'string' ? item.recordedAt : event.timestamp,
      });
    } else if (item.kind === 'reasoning') {
      const content = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === 'string').join('\n')
        : typeof item.text === 'string' ? item.text : '';
      if (content) upsertDisplayMessage(messages, {
        id: `muse-reasoning-${item.itemId}`,
        type: 'reasoning',
        content,
        status: terminal ? 'completed' : 'in_progress',
        timestamp: typeof item.recordedAt === 'string' ? item.recordedAt : event.timestamp,
      });
    } else if (item.kind === 'compaction') {
      upsertDisplayMessage(messages, {
        id: `muse-compaction-${item.itemId}`,
        type: 'reasoning',
        content: COMPACTION_CONTENT,
        status: item.status === 'failed' ? 'failed' : terminal ? 'completed' : 'in_progress',
        timestamp: typeof item.recordedAt === 'string' ? item.recordedAt : event.timestamp,
        completedAt: terminal ? event.timestamp : undefined,
      });
    } else if (item.kind === 'toolCall') {
      let input: unknown = item.args;
      if (typeof item.args === 'string') {
        try { input = JSON.parse(item.args); } catch {}
      }
      const message = createCallDisplayMessage({
        id: `muse-tool-${item.itemId}`,
        server: 'muse',
        tool: typeof item.tool === 'string' ? item.tool : 'tool',
        inputRequest: inputState.requests.get(item.itemId),
        input: isRecord(input) ? input : typeof input === 'string' ? input : undefined,
        output: typeof item.visibleOutput === 'string'
          ? item.visibleOutput
          : item.failureReason === undefined ? undefined : stringifyDisplayValue(item.failureReason),
        status: item.status === 'failed' || item.status === 'rejected' ? 'failed' : terminal ? 'completed' : 'in_progress',
        timestamp: typeof item.recordedAt === 'string' ? item.recordedAt : event.timestamp,
      });
      upsertDisplayMessage(messages, message);
    }
  }

  return messages;
}
