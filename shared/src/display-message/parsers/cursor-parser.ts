import type { AgentEvent } from '../../event';
import { getUserMessageId } from '../../agent-event-utils';
import { isRecord } from '../../type-guards';
import type { DisplayMessage, Status } from '../types';
import { createCallDisplayMessage, markTurnEnd, stringifyDisplayValue } from './utils';

function getTextContent(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function cursorStatusToDisplayStatus(status: unknown): Status {
  return status === 'completed' || status === 'FINISHED'
    ? 'completed'
    : status === 'error' || status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED'
      ? 'failed'
      : 'in_progress';
}

function cursorRunId(event: AgentEvent): string {
  const runId = event.payload.run_id;
  return typeof runId === 'string' ? runId : 'unknown-run';
}

function getCursorAssistantText(event: AgentEvent): string {
  const message = isRecord(event.payload.message) ? event.payload.message : null;
  return getTextContent(message?.content);
}

function getCursorThinkingText(event: AgentEvent): string {
  const text = event.payload.text;
  if (typeof text === 'string') return text;
  const message = isRecord(event.payload.message) ? event.payload.message : null;
  return typeof message?.text === 'string' ? message.text : '';
}

function isTerminalStatus(status: unknown): boolean {
  return status === 'FINISHED' || status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED';
}

function finalizeOpenCalls(messages: DisplayMessage[], callIndexes: Map<string, number>, status: Status) {
  for (const index of callIndexes.values()) {
    const message = messages[index];
    if ((message?.type === 'tool_call' || message?.type === 'skill') && message.status === 'in_progress') {
      messages[index] = {
        ...message,
        status,
      };
    }
  }
}

export function parseCursorEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const callIndexes = new Map<string, number>();
  const runAssistantSegments = new Map<string, number>();
  const runThinkingSegments = new Map<string, number>();
  let activeAssistant: { runId: string; index: number } | null = null;
  let activeThinking: { runId: string; index: number } | null = null;

  const finalizeActiveThinking = (status: Status) => {
    if (!activeThinking) return;
    const message = messages[activeThinking.index];
    if (message?.type === 'reasoning') {
      messages[activeThinking.index] = {
        ...message,
        status,
      };
    }
  };

  for (const event of events) {
    if (event.type === 'event_msg' && event.payload.type === 'user_message') {
      activeAssistant = null;
      activeThinking = null;
      const message = event.payload.message;
      if (typeof message === 'string' && message.trim()) {
        messages.push({
          id: getUserMessageId(event) ?? `cursor-user-${event.timestamp}-${messages.length}`,
          type: 'user',
          content: message,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type === 'cursor-assistant') {
      const text = getCursorAssistantText(event);
      if (text) {
        const runId = cursorRunId(event);
        if (!activeAssistant || activeAssistant.runId !== runId) {
          const segment: number = runAssistantSegments.get(runId) ?? 0;
          runAssistantSegments.set(runId, segment + 1);
          activeAssistant = {
            runId,
            index: messages.push({
              id: `cursor-agent-${runId}-${segment}`,
              type: 'agent',
              content: '',
              timestamp: event.timestamp,
            }) - 1,
          };
        }
        const message = messages[activeAssistant.index];
        if (message?.type === 'agent') {
          messages[activeAssistant.index] = {
            ...message,
            content: `${message.content}${text}`,
          };
        }
      }
      continue;
    }

    if (event.type === 'cursor-thinking') {
      const text = getCursorThinkingText(event);
      if (text.trim()) {
        const runId = cursorRunId(event);
        if (!activeThinking || activeThinking.runId !== runId) {
          const segment: number = runThinkingSegments.get(runId) ?? 0;
          runThinkingSegments.set(runId, segment + 1);
          activeThinking = {
            runId,
            index: messages.push({
              id: `cursor-reasoning-${runId}-${segment}`,
              type: 'reasoning',
              content: '',
              status: 'in_progress',
              timestamp: event.timestamp,
            }) - 1,
          };
        }
        const message = messages[activeThinking.index];
        if (message?.type === 'reasoning') {
          messages[activeThinking.index] = {
            ...message,
            content: `${message.content}${text}`,
            status: 'in_progress',
          };
        }
      }
      continue;
    }

    if (event.type === 'cursor-tool_call') {
      activeAssistant = null;
      const callId = typeof event.payload.call_id === 'string'
        ? event.payload.call_id
        : `cursor-tool-${event.timestamp}-${messages.length}`;
      const tool = typeof event.payload.name === 'string' ? event.payload.name : 'tool';
      const status = cursorStatusToDisplayStatus(event.payload.status);
      const input = isRecord(event.payload.args)
        ? event.payload.args
        : typeof event.payload.args === 'string'
          ? event.payload.args
          : undefined;
      const existing = callIndexes.get(callId);
      const next = createCallDisplayMessage({
        id: callId,
        server: 'cursor',
        tool,
        ...(input !== undefined ? { input } : {}),
        output: stringifyDisplayValue(event.payload.result),
        status,
        timestamp: event.timestamp,
      });
      if (existing === undefined) {
        callIndexes.set(callId, messages.push(next) - 1);
      } else {
        messages[existing] = next;
      }
      continue;
    }

    if (event.type === 'cursor-task') {
      activeAssistant = null;
      const text = event.payload.text;
      if (typeof text === 'string' && text.trim()) {
        messages.push({
          id: `cursor-task-${event.timestamp}-${messages.length}`,
          type: 'agent',
          content: text,
          timestamp: event.timestamp,
        });
      }
      continue;
    }

    if (event.type === 'cursor-status') {
      const status = event.payload.status;
      if (isTerminalStatus(status)) {
        const displayStatus = cursorStatusToDisplayStatus(status);
        finalizeActiveThinking(displayStatus);
        finalizeOpenCalls(messages, callIndexes, displayStatus);
        markTurnEnd(messages);
        activeThinking = null;
        activeAssistant = null;
      }
      continue;
    }

    if (event.type === 'cursor-error') {
      finalizeActiveThinking('failed');
      finalizeOpenCalls(messages, callIndexes, 'failed');
      activeAssistant = null;
      activeThinking = null;
      const message = typeof event.payload.message === 'string' ? event.payload.message : 'Cursor run failed';
      messages.push({
        id: `cursor-error-${event.timestamp}-${messages.length}`,
        type: 'error',
        message,
        timestamp: event.timestamp,
      });
    }
  }

  return messages;
}
