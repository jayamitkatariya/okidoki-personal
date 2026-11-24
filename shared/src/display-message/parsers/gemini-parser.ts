import { getUserMessage, getUserMessageId } from '../../agent-event-utils';
import type { AgentEvent } from '../../event';
import { isRecord } from '../../type-guards';
import type { DisplayMessage, Status, TodoItemStatus } from '../types';
import { applyToolInputEvent, type ToolInputEventState, createCallDisplayMessage, isToolInputQuestion, markTurnEnd, stringifyDisplayValue, upsertDisplayMessage } from './utils';

type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk';

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap((entry) => (
    isRecord(entry) && entry.type === 'content' && isRecord(entry.content) && typeof entry.content.text === 'string'
      ? [entry.content.text]
      : []
  )).join('\n');
}

function commandLine(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = [input.CommandLine, input.commandLine, input.command_line, input.command].find((value) => typeof value === 'string' && value);
  return typeof command === 'string' ? command : undefined;
}

export function parseGeminiEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const activeChunks: Partial<Record<ChunkKind, string>> = {};
  const toolUpdates = new Map<string, Record<string, unknown>>();
  const inputState: ToolInputEventState = { requests: new Map(), resolutions: new Map(), requestedAt: new Map() };
  let chunkSequence = 0;

  for (const event of events) {
    const userContent = getUserMessage(event);
    if (userContent !== null) {
      activeChunks.agent_message_chunk = undefined;
      activeChunks.agent_thought_chunk = undefined;
      if (userContent.trim()) messages.push({
        id: getUserMessageId(event) ?? `gemini-user-${event.timestamp}`,
        type: 'user',
        content: userContent,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'gemini-error') {
      messages.push({
        id: `gemini-error-${event.timestamp}`,
        type: 'error',
        message: typeof event.payload.message === 'string' ? event.payload.message : 'Gemini failed',
        timestamp: event.timestamp,
      });
      continue;
    }

    if (event.type === 'gemini-turn-complete') {
      for (const message of messages) {
        if (message.type === 'reasoning' && message.status === 'in_progress') message.status = 'completed';
      }
      markTurnEnd(messages, event.timestamp);
      activeChunks.agent_message_chunk = undefined;
      activeChunks.agent_thought_chunk = undefined;
      continue;
    }

    if (applyToolInputEvent(event, messages, 'gemini', inputState, isToolInputQuestion)) continue;

    if ((event.type !== 'gemini-session-update' && event.type !== 'gemini-chunk') || !isRecord(event.payload.update)) continue;
    const update = event.payload.update;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      if (!isRecord(update.content) || update.content.type !== 'text' || typeof update.content.text !== 'string' || !update.content.text) continue;
      const explicitId = typeof update.messageId === 'string' && update.messageId ? `gemini-${kind}-${update.messageId}` : null;
      const id = explicitId ?? activeChunks[kind] ?? `gemini-${kind}-${chunkSequence++}`;
      activeChunks[kind] = id;
      if (!explicitId) activeChunks[kind === 'agent_message_chunk' ? 'agent_thought_chunk' : 'agent_message_chunk'] = undefined;
      const existing = messages.find((message) => message.id === id);
      const content = `${existing && 'content' in existing && typeof existing.content === 'string' ? existing.content : ''}${update.content.text}`;
      upsertDisplayMessage(messages, kind === 'agent_thought_chunk'
        ? { id, type: 'reasoning', content, status: 'in_progress', timestamp: existing?.timestamp ?? event.timestamp }
        : { id, type: 'agent', content, timestamp: existing?.timestamp ?? event.timestamp });
      continue;
    }

    activeChunks.agent_message_chunk = undefined;
    activeChunks.agent_thought_chunk = undefined;

    if ((kind === 'tool_call' || kind === 'tool_call_update') && typeof update.toolCallId === 'string') {
      const call = { ...toolUpdates.get(update.toolCallId), ...update };
      toolUpdates.set(update.toolCallId, call);
      const id = `gemini-tool-${update.toolCallId}`;
      const timestamp = messages.find((message) => message.id === id)?.timestamp ?? event.timestamp;
      const status: Status = call.status === 'failed' ? 'failed' : call.status === 'completed' ? 'completed' : 'in_progress';
      const output = contentText(call.content) || stringifyDisplayValue(call.rawOutput);
      const inputRequest = inputState.requests.get(update.toolCallId);
      const diffs = Array.isArray(call.content)
        ? call.content.filter((entry): entry is Record<string, unknown> & { path: string } => isRecord(entry) && entry.type === 'diff' && typeof entry.path === 'string')
        : [];
      const command = call.kind === 'execute' ? commandLine(call.rawInput) ?? (typeof call.title === 'string' ? call.title : undefined) : undefined;

      if (!inputRequest && command) {
        upsertDisplayMessage(messages, { id, type: 'command', command, output, status, timestamp });
      } else if (!inputRequest && diffs.length > 0) {
        upsertDisplayMessage(messages, {
          id,
          type: 'file_change',
          changes: diffs.map((diff) => ({
            path: diff.path,
            kind: diff.oldText === null || diff.oldText === undefined ? 'add' : diff.newText === '' && call.kind === 'delete' ? 'delete' : 'update',
          })),
          status,
          timestamp,
        });
      } else {
        upsertDisplayMessage(messages, createCallDisplayMessage({
          id,
          server: 'gemini',
          tool: [call.title, call.name, call.kind].find((value): value is string => typeof value === 'string' && value.length > 0) ?? 'tool',
          inputRequest,
          input: call.rawInput === undefined ? undefined : isRecord(call.rawInput) ? call.rawInput : stringifyDisplayValue(call.rawInput),
          output,
          status,
          timestamp,
        }));
      }
      continue;
    }

    if (kind === 'plan' && Array.isArray(update.entries)) {
      const items = update.entries.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.content !== 'string') return [];
        const itemStatus: TodoItemStatus = entry.status === 'completed' || entry.status === 'in_progress' ? entry.status : 'pending';
        return [{ text: entry.content, completed: itemStatus === 'completed', itemStatus }];
      });
      upsertDisplayMessage(messages, {
        id: 'gemini-plan',
        type: 'todo_list',
        items,
        status: items.every((item) => item.completed) ? 'completed' : 'in_progress',
        timestamp: event.timestamp,
      });
    }
  }

  return messages;
}
