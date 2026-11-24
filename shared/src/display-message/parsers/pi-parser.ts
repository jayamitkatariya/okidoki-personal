import type { AgentEvent } from '../../event';
import { getUserMessageId } from '../../agent-event-utils';
import { isRecord } from '../../type-guards';
import type { DisplayMessage, Status } from '../types';
import { formatInferenceError } from './inference-error';
import { createCallDisplayMessage, stringifyDisplayValue, upsertDisplayMessage } from './utils';

function nestedPayload(event: AgentEvent): Record<string, unknown> {
  return isRecord(event.payload.assistantMessageEvent) ? event.payload.assistantMessageEvent : event.payload;
}

function toolStatus(value: unknown): Status {
  return value === 'completed' || value === 'success' ? 'completed' : value === 'error' ? 'failed' : 'in_progress';
}

function assistantErrorMessage(value: unknown): string | null {
  if (!isRecord(value) || value.role !== 'assistant' || value.stopReason !== 'error') return null;
  const message = typeof value.errorMessage === 'string' && value.errorMessage
    ? value.errorMessage
    : 'Pi run failed';
  return formatInferenceError(message, {
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
    ...(typeof value.model === 'string' ? { model: value.model } : {}),
  });
}

export function parsePiEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const text = new Map<string, string>();
  const thinking = new Map<string, string>();
  let activeMessageId: string | null = null;

  for (const event of events) {
    if (event.type === 'event_msg' && event.payload.type === 'user_message' && typeof event.payload.message === 'string') {
      messages.push({ id: getUserMessageId(event) ?? `pi-user-${event.timestamp}-${messages.length}`, type: 'user', content: event.payload.message, timestamp: event.timestamp });
      if (typeof event.payload.skillName === 'string' && event.payload.skillName) {
        messages.push({
          id: `pi-skill-${event.timestamp}-${messages.length}`,
          type: 'skill',
          skillName: event.payload.skillName,
          status: 'completed',
          timestamp: event.timestamp,
        });
      }
      continue;
    }
    if (event.type === 'pi-error') {
      messages.push({ id: `pi-error-${event.timestamp}-${messages.length}`, type: 'error', message: formatInferenceError(String(event.payload.message ?? 'Pi run failed')), timestamp: event.timestamp });
      continue;
    }
    if (event.type === 'pi-message_end') {
      const message = isRecord(event.payload.message) ? event.payload.message : null;
      if (message?.role === 'assistant') {
        const id = typeof message.id === 'string' && message.id
          ? message.id
          : activeMessageId ?? `assistant-${event.timestamp}-${messages.length}`;
        if (Array.isArray(message.content)) {
          const thinkingParts: string[] = [];
          const textParts: string[] = [];
          for (const block of message.content) {
            if (!isRecord(block)) continue;
            if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
              thinkingParts.push(block.thinking);
            } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              textParts.push(block.text);
            }
          }
          if (thinkingParts.length > 0) {
            const content = thinkingParts.join('\n\n');
            upsertDisplayMessage(messages, { id: `pi-thinking-${id}`, type: 'reasoning', content, status: 'completed', timestamp: event.timestamp });
          }
          if (textParts.length > 0) {
            const content = textParts.join('\n\n');
            upsertDisplayMessage(messages, { id: `pi-${id}`, type: 'agent', content, timestamp: event.timestamp });
          }
        }
        activeMessageId = null;
      }
      const error = assistantErrorMessage(event.payload.message);
      if (error) {
        messages.push({ id: `pi-error-${event.timestamp}-${messages.length}`, type: 'error', message: error, timestamp: event.timestamp });
      }
      continue;
    }
    if (event.type === 'pi-message_update') {
      const payload = nestedPayload(event);
      const id = typeof payload.id === 'string' ? payload.id : activeMessageId ?? 'assistant';
      if (payload.type === 'text_delta' && typeof payload.delta === 'string') text.set(id, `${text.get(id) ?? ''}${payload.delta}`);
      if (payload.type === 'thinking_delta' && typeof payload.delta === 'string') thinking.set(id, `${thinking.get(id) ?? ''}${payload.delta}`);
      const textContent = text.get(id);
      const thinkingContent = thinking.get(id);
      if (textContent !== undefined) upsertDisplayMessage(messages, { id: `pi-${id}`, type: 'agent', content: textContent, timestamp: event.timestamp });
      if (thinkingContent !== undefined) upsertDisplayMessage(messages, { id: `pi-thinking-${id}`, type: 'reasoning', content: thinkingContent, status: 'in_progress', timestamp: event.timestamp });
      continue;
    }
    if (event.type === 'pi-message_start') {
      const message = isRecord(event.payload.message) ? event.payload.message : null;
      activeMessageId = typeof message?.id === 'string' ? message.id : `assistant-${event.timestamp}`;
      continue;
    }
    if (event.type === 'pi-tool_execution_start' || event.type === 'pi-tool_execution_update' || event.type === 'pi-tool_execution_end') {
      const payload = event.payload;
      const input = payload.args ?? payload.input;
      const id = typeof payload.toolCallId === 'string' ? payload.toolCallId : typeof payload.id === 'string' ? payload.id : `tool-${event.timestamp}`;
      const tool = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
      const messageId = `pi-tool-${id}`;
      const status = event.type === 'pi-tool_execution_end'
        ? toolStatus(payload.isError ? 'error' : 'completed')
        : 'in_progress';
      upsertDisplayMessage(messages, createCallDisplayMessage({
        id: messageId,
        server: 'pi',
        tool,
        input: isRecord(input) ? input : stringifyDisplayValue(input),
        output: event.type === 'pi-tool_execution_end'
          ? stringifyDisplayValue(payload.result ?? payload.error)
          : undefined,
        status,
        timestamp: event.timestamp,
      }));
    }
  }
  return messages;
}
