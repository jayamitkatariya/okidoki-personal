import { USER_MESSAGE_ID_PAYLOAD_KEY, type AgentEvent } from '../../event';
import { isRecord } from '../../type-guards';
import type { DisplayMessage, Status } from '../types';
import { formatInferenceError } from './inference-error';
import { applyToolInputEvent, createCallDisplayMessage, isToolInputQuestion, stringifyDisplayValue, upsertDisplayMessage, type ToolInputEventState } from './utils';

function timestampFromMs(value: unknown, fallback: string): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : fallback;
}

function partFromEvent(event: AgentEvent): Record<string, unknown> | null {
  return isRecord(event.payload.part) ? event.payload.part : null;
}

function toolStatus(status: unknown): Status {
  return status === 'completed'
    ? 'completed'
    : status === 'error'
      ? 'failed'
      : 'in_progress';
}

function assistantError(info: unknown): string | null {
  if (!isRecord(info) || !isRecord(info.error)) return null;
  const data = isRecord(info.error.data) ? info.error.data : null;
  const message = typeof data?.message === 'string'
    ? data.message
    : typeof info.error.message === 'string'
      ? info.error.message
      : stringifyDisplayValue(info.error) ?? 'Opencode run failed';
  // User interruptions surface as MessageAbortedError; "request failed" framing would mislead.
  if (info.error.name === 'MessageAbortedError') return message;
  return formatInferenceError(message, {
    ...(typeof info.providerID === 'string' ? { provider: info.providerID } : {}),
    ...(typeof info.modelID === 'string' ? { model: info.modelID } : {}),
    ...(typeof data?.statusCode === 'number' ? { status: data.statusCode } : {}),
    ...(typeof data?.isRetryable === 'boolean' ? { retryable: data.isRetryable } : {}),
    ...(typeof data?.responseBody === 'string' ? { detail: data.responseBody } : {}),
  });
}

interface StreamedPart {
  id: string;
  type: 'text' | 'reasoning';
  text: string;
  completed: boolean;
  timestamp: string;
}

export function parseOpencodeEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const inputState: ToolInputEventState = { requests: new Map(), resolutions: new Map(), requestedAt: new Map() };
  // OpenCode streams a part's text as deltas between the part's first and last update.
  const streamedParts = new Map<string, StreamedPart>();
  const upsertStreamedPart = ({ id, type, text, completed, timestamp }: StreamedPart) => {
    if (!text.trim()) return;
    upsertDisplayMessage(messages, type === 'text'
      ? { id, type: 'agent', content: text, timestamp }
      : { id, type: 'reasoning', content: text, status: completed ? 'completed' : 'in_progress', timestamp });
  };

  for (const event of events) {
    if (event.type === 'event_msg' && event.payload.type === 'user_message') {
      const message = event.payload.message;
      if (typeof message === 'string' && message.trim()) {
        const messageId = event.payload[USER_MESSAGE_ID_PAYLOAD_KEY];
        messages.push({
          id: typeof messageId === 'string' ? messageId : `opencode-user-${event.timestamp}`,
          type: 'user',
          content: message,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type === 'opencode-message.updated') {
      const { info } = event.payload;
      const error = assistantError(info);
      if (error) {
        // The stream and the prompt's own response both report a failed message, so it is keyed by message to show once.
        upsertDisplayMessage(messages, {
          id: isRecord(info) && typeof info.id === 'string' ? `opencode-error-${info.id}` : `opencode-${event.type}-${event.timestamp}`,
          type: 'error',
          message: error,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type === 'opencode-message.part.delta') {
      const { partID, field, delta } = event.payload;
      const streamed = typeof partID === 'string' ? streamedParts.get(partID) : undefined;
      if (streamed && field === 'text' && typeof delta === 'string') {
        streamed.text += delta;
        upsertStreamedPart(streamed);
      }
      continue;
    }

    if (event.type === 'opencode-error') {
      const message = typeof event.payload.message === 'string' ? event.payload.message : 'Opencode run failed';
      messages.push({
        id: `opencode-${event.type}-${event.timestamp}`,
        type: 'error',
        message: formatInferenceError(message, {
          ...(typeof event.payload.status === 'number' ? { status: event.payload.status } : {}),
        }),
        timestamp: event.timestamp,
      });
      continue;
    }

    if (applyToolInputEvent(event, messages, 'opencode', inputState, isToolInputQuestion)) continue;

    if (event.type === 'opencode-session.next.tool.called') {
      const tool = typeof event.payload.tool === 'string' ? event.payload.tool : 'tool';
      const input = event.payload.input ?? event.payload.arguments;
      const callId = typeof event.payload.callID === 'string' ? event.payload.callID : null;
      const id = callId ? `opencode-tool-${callId}` : `opencode-${event.type}-${event.timestamp}`;
      upsertDisplayMessage(messages, createCallDisplayMessage({
        id,
        server: 'opencode',
        tool,
        inputRequest: callId ? inputState.requests.get(callId) : undefined,
        input: isRecord(input) ? input : stringifyDisplayValue(input),
        status: 'in_progress',
        timestamp: event.timestamp,
      }));
      continue;
    }

    const part = partFromEvent(event);
    if (!part) continue;

    let id = `opencode-${event.type}-${event.timestamp}`;
    if (typeof part.callID === 'string') id = `opencode-tool-${part.callID}`;
    else if (typeof part.id === 'string') id = `opencode-${part.id}`;
    const time = isRecord(part.time) ? part.time : null;
    const timestamp = timestampFromMs(time?.start, event.timestamp);

    if ((part.type === 'text' || part.type === 'reasoning') && typeof part.id === 'string') {
      const streamed: StreamedPart = {
        id,
        type: part.type,
        text: typeof part.text === 'string' ? part.text : '',
        completed: Boolean(time?.end),
        timestamp,
      };
      streamedParts.set(part.id, streamed);
      upsertStreamedPart(streamed);
      continue;
    }

    if (part.type === 'tool' && isRecord(part.state)) {
      const state = part.state;
      const status = toolStatus(state.status);
      const tool = typeof part.tool === 'string' ? part.tool : 'tool';
      const input = state.input;
      const output = state.status === 'completed'
        ? stringifyDisplayValue(state.output)
        : state.status === 'error'
          ? stringifyDisplayValue(state.error)
          : undefined;
      upsertDisplayMessage(messages, createCallDisplayMessage({
        id,
        server: 'opencode',
        tool,
        inputRequest: typeof part.callID === 'string' ? inputState.requests.get(part.callID) : undefined,
        input: isRecord(input) ? input : stringifyDisplayValue(input),
        output,
        status,
        timestamp,
      }));
      continue;
    }

    if (part.type === 'patch') {
      const files = Array.isArray(part.files) ? part.files.filter((file): file is string => typeof file === 'string') : [];
      if (files.length > 0) {
        upsertDisplayMessage(messages, {
          id,
          type: 'file_change',
          changes: files.map((path) => ({ path, kind: 'update' })),
          status: 'completed',
          timestamp,
        });
      }
    }
  }

  return messages;
}
