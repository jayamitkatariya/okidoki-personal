import { coerceBackgroundTaskPayload, normalizeBackgroundTaskStatus, type BackgroundTaskMessage, type CommandMessage, type DisplayMessage, type PatchMessage, type ReasoningMessage, type SubagentMessage, type ToolInputOption, type TodoListMessage, type ToolInputQuestion, type UserMessageImage } from '../types';
import { CHAT_INTERRUPTED_EVENT_TYPE, CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE, CLAUDE_PEER_MESSAGE_EVENT_TYPE, USER_MESSAGE_ID_PAYLOAD_KEY, coerceClaudePartialMessagePayload, coerceModelRefusalFallback, type AgentEvent, type ClaudePartialMessagePayload } from '../../event';
import { TaskAccumulator, extractToolResultText, normalizeContentBlocks, type MessageContentBlock, type AccumulatedTask } from '../task-accumulator';
import { safeJsonParse } from '../../json';
import { areUserMessagesWithinMatchWindow } from '../../user-message-matching';
import { createCallDisplayMessage, markTurnEnd, userMessageImages } from './utils';
import { fileContentDiff, skillNamesFromCommand } from '../format';
import { CLAUDE_STOPPED_TOOL_RESULT, CLAUDE_SUBAGENT_TOOL_NAMES, COMPACTION_CONTENT, GOAL_TOOL_NAME } from '../constants';
import { isRecord } from '../../type-guards';
import { subagentReport } from '../subagent-tools';

export type ClaudeResultPayload = {
  is_error?: boolean;
  subtype?: string;
  errors?: string[];
  result?: string;
  terminal_reason?: string;
};

const ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools']);

const COMMAND_TOOL_NAMES = new Set(['Bash', 'bash', 'shell']);
const FILE_TOOL_NAMES = new Set(['Write', 'Edit']);

// Events and their content blocks keep their identity across the re-parse every history change triggers, so work
// that scales with a tool's input or output runs once per event. Keys are whole blocks and events: structural
// sharing can hand one input object to two different tool calls.
const toolMessageTemplates = new WeakMap<MessageContentBlock, Omit<CommandMessage, 'timestamp'> | Omit<PatchMessage, 'timestamp'>>();
const toolResults = new WeakMap<ClaudeBackendEvent, ReturnType<typeof extractToolResult>>();

function fileOrCommandMessage(block: MessageContentBlock, timestamp: string): CommandMessage | PatchMessage {
  let template = toolMessageTemplates.get(block);
  if (!template) {
    const input = typeof block.input === 'string' ? safeJsonParse<Record<string, unknown>>(block.input, {}) : block.input ?? {};
    template = toolMessageTemplate(block.name ?? '', block.id ?? '', input);
    toolMessageTemplates.set(block, template);
  }
  return { ...template, timestamp };
}

function toolMessageTemplate(toolName: string, toolUseId: string, input: Record<string, unknown>): Omit<CommandMessage, 'timestamp'> | Omit<PatchMessage, 'timestamp'> {
  if (COMMAND_TOOL_NAMES.has(toolName)) {
    const command = typeof input.command === 'string' ? input.command : '';
    const skillNames = skillNamesFromCommand(command);
    return {
      id: `command-${toolUseId}`,
      type: 'command',
      command,
      ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim() } : {}),
      ...(skillNames.length > 0 ? { skillNames } : {}),
      output: '',
      status: 'in_progress',
    };
  }

  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  let diff: string | undefined;
  if (toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const oldLines = input.old_string.replace(/\n$/, '').split('\n');
    const newLines = input.new_string.replace(/\n$/, '').split('\n');
    let head = 0;
    while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
    let tail = 0;
    while (tail < oldLines.length - head && tail < newLines.length - head
      && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
    diff = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.slice(0, head).map(l => ` ${l}`),
      ...oldLines.slice(head, oldLines.length - tail).map(l => `-${l}`),
      ...newLines.slice(head, newLines.length - tail).map(l => `+${l}`),
      ...oldLines.slice(oldLines.length - tail).map(l => ` ${l}`),
    ].join('\n');
  } else if (toolName === 'Write' && typeof input.content === 'string') {
    diff = fileContentDiff(filePath, input.content, 'add');
  }

  return {
    id: `patch-${toolUseId}`,
    type: 'patch',
    operations: [{ action: toolName === 'Write' ? 'add' : 'update', path: filePath, diff }],
    status: 'in_progress',
  };
}

function createSubagentMessage(timestamp: string, fields: Omit<SubagentMessage, 'id' | 'type' | 'timestamp'>): SubagentMessage {
  return { id: `subagent-${fields.toolUseId}`, type: 'subagent', ...fields, timestamp };
}

function groupNestedEvents(events: ClaudeBackendEvent[]): Map<string, AgentEvent[]> {
  const nested = new Map<string, AgentEvent[]>();
  for (const { timestamp, type, payload } of events) {
    const parent = payload.parent_tool_use_id;
    if (typeof parent !== 'string') continue;
    const siblings = nested.get(parent);
    if (siblings) siblings.push({ timestamp, type, payload });
    else nested.set(parent, [{ timestamp, type, payload }]);
  }
  return nested;
}

function extractToolResult(event: ClaudeBackendEvent) {
  const toolResult = normalizeContentBlocks(event.payload.message?.content).find(c => c.type === 'tool_result');
  if (!toolResult?.tool_use_id) return undefined;
  const output = extractToolResultText(toolResult.content);
  // Claude Code answers a call cut off by Stop or Send now with this refusal, so the call stays unfinished and settles as stopped.
  if (toolResult.is_error && (output.startsWith(CLAUDE_STOPPED_TOOL_RESULT) || output.startsWith("The user doesn't want to take this action right now"))) return undefined;
  const exitCode = output.match(/exit code:?\s*(\d+)/i)?.[1];
  return {
    toolResult,
    toolUseId: toolResult.tool_use_id,
    output,
    outputOmitted: toolResult.okidokiOmitted,
    images: contentImages(normalizeContentBlocks(toolResult.content)),
    exitCode: exitCode === undefined ? undefined : parseInt(exitCode, 10),
    status: toolResult.is_error ? 'failed' as const : 'completed' as const,
  };
}

function readToolResult(event: ClaudeBackendEvent) {
  if (event.type !== 'claude-user') return undefined;
  if (!toolResults.has(event)) toolResults.set(event, extractToolResult(event));
  return toolResults.get(event);
}

/** Tool results in a history page whose tool_use is on an older page, which parseClaudeEvents drops. */
export function parseClaudeOrphanToolResults(events: ClaudeBackendEvent[]) {
  const mainEvents = events.filter(e => (e.payload.parent_tool_use_id ?? null) === null);
  const toolUseIds = new Set(mainEvents.flatMap(e => e.type === 'claude-assistant'
    ? normalizeContentBlocks(e.payload.message?.content).map(block => block.id)
    : []));
  return mainEvents.flatMap((event) => {
    const result = readToolResult(event);
    if (!result || toolUseIds.has(result.toolUseId)) return [];
    return [{ type: 'tool_result' as const, tool_use_id: result.toolUseId, status: result.status, output: result.output, timestamp: event.timestamp }];
  });
}

export function coerceClaudeResultPayload(payload: Record<string, unknown>): ClaudeResultPayload {
  return {
    is_error: typeof payload.is_error === 'boolean' ? payload.is_error : undefined,
    subtype: typeof payload.subtype === 'string' ? payload.subtype : undefined,
    errors: Array.isArray(payload.errors)
      ? payload.errors.filter((e): e is string => typeof e === 'string')
      : undefined,
    result: typeof payload.result === 'string' ? payload.result : undefined,
    terminal_reason: typeof payload.terminal_reason === 'string' ? payload.terminal_reason : undefined,
  };
}

// Claude Code opens every error_during_execution result with an
// `[ede_diagnostic] ...` line and appends genuine failures after it, so a
// result carrying nothing else describes a stopped turn, not a failure.
export function stripAgentDiagnosticErrors(errors: string[]): string[] {
  return errors.filter((error) => !error.startsWith('[ede_diagnostic]'));
}

// Shared so the engine and display parser agree on what counts as a failed turn.
export function isClaudeResultError(payload: ClaudeResultPayload): boolean {
  if (payload.terminal_reason && ABORTED_TERMINAL_REASONS.has(payload.terminal_reason)) return false;
  if (payload.errors?.length && stripAgentDiagnosticErrors(payload.errors).length === 0) return false;
  return Boolean(payload.is_error) || payload.subtype !== 'success';
}

interface ClaudeBackendEvent {
  timestamp: string;
  type: string;  // "claude-user", "claude-assistant", "claude-result", "claude-system"
  payload: {
    parent_tool_use_id?: string | null;
    message?: {
      id?: string;
      // String form is used for slash-command echoes (e.g. the `/model` switch).
      content?: string | MessageContentBlock[];
    };
    [key: string]: unknown;
  };
}

// Slash-command echoes Claude Code records as user messages — session-internal
// artifacts the user never typed, so they're dropped from the transcript.
const LOCAL_COMMAND_ECHO_REGEX = /^<(?:command-name|command-message|local-command-stdout|local-command-stderr)>/;

// Tool results, synthetic injections (e.g. skill prompts) and local command echoes are `claude-user` records too.
export function readClaudeUserPrompt(
  payload: Record<string, unknown>,
  content: MessageContentBlock[],
): { text: string; images: UserMessageImage[] } | undefined {
  if (payload.isSynthetic || content.some((c) => c.type === 'tool_result' && c.tool_use_id)) return undefined;
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');
  if (LOCAL_COMMAND_ECHO_REGEX.test(text.trim())) return undefined;
  const images = contentImages(content);
  return text || images.length > 0 ? { text, images } : undefined;
}

function contentImages(content: MessageContentBlock[]): UserMessageImage[] {
  return content.flatMap((c) => {
    if (c.type !== 'image' || !c.source || (!c.source.data && !c.okidokiOmitted)) return [];
    return [{
      type: 'image' as const,
      mediaType: c.source.media_type || 'image/png',
      data: c.source.data || '',
      ...(c.okidokiOmitted ? { okidokiOmitted: c.okidokiOmitted } : {}),
    }];
  });
}

/**
 * Parse Claude backend events into frontend DisplayMessage format
 * Handles SDKMessage types from Claude SDK
 *
 * @param events - Array of Claude backend events to parse
 * @param parentToolUseId - Optional parent tool use ID to filter for.
 *                          If undefined, filters for main conversation (null).
 *                          If string, filters for that specific subagent.
 */
export function parseClaudeEvents(
  events: ClaudeBackendEvent[],
  parentToolUseId?: string | null
): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  // Appends are indexed on the next lookup; replacements go through replaceMessage, since they can change an id.
  const indexesById = new Map<string, number[]>();
  let indexedCount = 0;
  const indexesOf = (id: string) => {
    for (; indexedCount < messages.length; indexedCount++) {
      const indexes = indexesById.get(messages[indexedCount].id);
      if (indexes) indexes.push(indexedCount);
      else indexesById.set(messages[indexedCount].id, [indexedCount]);
    }
    return indexesById.get(id) ?? [];
  };
  const replaceMessage = (index: number, message: DisplayMessage) => {
    const previousId = messages[index].id;
    messages[index] = message;
    if (index >= indexedCount || previousId === message.id) return;
    const previous = indexesById.get(previousId);
    if (!previous) throw new Error(`Chat message ${previousId} is missing from the id index`);
    previous.splice(previous.indexOf(index), 1);
    const next = indexesById.get(message.id);
    if (!next) indexesById.set(message.id, [index]);
    else next.splice(next.filter((other) => other < index).length, 0, index);
  };
  const upsertMessage = <T extends DisplayMessage>(message: T): T => {
    const [index] = indexesOf(message.id);
    if (index === undefined) messages.push(message);
    else replaceMessage(index, message);
    return message;
  };

  // Filter events based on parent_tool_use_id
  // If parentToolUseId is explicitly passed, use that (even if it's null)
  // If not passed (undefined), default to filtering for main conversation (null)
  const filterValue = parentToolUseId !== undefined ? parentToolUseId : null;

  const filteredEvents = events.filter(e => {
    const eventParentToolUseId = e.payload.parent_tool_use_id ?? null;
    return eventParentToolUseId === filterValue;
  });

  // Track tool calls by their ID for correlation with results
  const toolCallMap = new Map<string, {
    messageIndex: number;
    toolName: string;
    input: Record<string, unknown> | string;
  }>();
  const taskMessageMap = new Map<string, BackgroundTaskMessage>();
  const peerNames = new Map<string, string>();
  const peerTimestamps = new Map<string, number>();
  const workflowAgentMessageMap = new Map<string, SubagentMessage>();
  const ambientTaskIds = new Set<string>();
  const partialIndexes = new Map<string, { reasoning?: number; agent?: number }>();
  const streamingTools = new Map<string, { tool: NonNullable<ClaudePartialMessagePayload['tool']>; timestamp: string }>();
  const completedStreamIds = new Set<string>();
  const supersededStreamIds = new Set<string>();
  let liveStreamId: string | null = null;
  const endStreamingTools = (exceptStreamId?: string) => {
    for (const streamId of streamingTools.keys()) {
      if (streamId !== exceptStreamId) streamingTools.delete(streamId);
    }
  };
  let compaction: ReasoningMessage | undefined;
  const assistantThinking = new Map<string, string[]>();
  const assistantTextCounts = new Map<string, number>();
  const acceptedUserMessageIndexes = new Set<number>();
  const canonicalUserMessageIndexes = new Set<number>();
  // Accepted placeholders are persisted when a prompt is submitted, which for
  // a prompt queued behind a running turn is mid-turn; the transcript copy is
  // recorded where the turn actually starts, so it takes over the position and
  // the placeholder is dropped at the end.
  const supersededUserMessageIndexes = new Set<number>();
  const stampedUserMessages = new Set<DisplayMessage>();
  const findMatchingUserMessageIndex = (
    indexes: Set<number>,
    content: string,
    timestamp: string,
    messageId?: unknown,
  ) => {
    // Identity beats heuristics: content/timestamp matching fails when a
    // queued message was edited or waited past the match grace period. The id
    // scan covers all user messages, not just the unconsumed index set, so a
    // re-recorded event (e.g. a steer retried after a failure) replaces the
    // first occurrence instead of rendering a duplicate bubble.
    if (typeof messageId === 'string') {
      const byId = indexesOf(messageId).find((index) =>
        messages[index].type === 'user' && !supersededUserMessageIndexes.has(index));
      if (byId !== undefined) return byId;
    }
    for (const index of indexes) {
      const message = messages[index];
      if (message?.type === 'user'
        && !(typeof messageId === 'string' && stampedUserMessages.has(message))
        && areUserMessagesWithinMatchWindow(message, { content, timestamp })) return index;
    }
    return undefined;
  };

  const taskAccumulator = new TaskAccumulator();
  let nestedEventsByParent: Map<string, AgentEvent[]> | undefined;
  const collectNestedEvents = (toolUseId: string) => (nestedEventsByParent ??= groupNestedEvents(events)).get(toolUseId) ?? [];

  const todoItems = new WeakMap<AccumulatedTask, TodoListMessage['items'][number]>();
  const taskSnapshot = () =>
    taskAccumulator.getTasks().map((task) => {
      const item = todoItems.get(task) ?? { text: task.subject, completed: task.status === 'completed', itemStatus: task.status };
      todoItems.set(task, item);
      return item;
    });

  // First pass: Process all events and build the message list
  filteredEvents.forEach((event) => {
    if (event.type === 'event_msg' && event.payload.type === 'user_message') {
      const content = typeof event.payload.message === 'string' ? event.payload.message : '';
      const images = userMessageImages(event.payload.images);
      if (content || images) {
        const messageId = event.payload[USER_MESSAGE_ID_PAYLOAD_KEY];
        const canonicalIndex = findMatchingUserMessageIndex(canonicalUserMessageIndexes, content, event.timestamp, messageId);
        const canonical = canonicalIndex === undefined ? undefined : messages[canonicalIndex];
        const message: DisplayMessage = {
          id: typeof messageId === 'string' ? messageId : `user-${event.timestamp}`,
          type: 'user',
          content,
          images: images?.length ? images : canonical?.type === 'user' ? canonical.images : undefined,
          timestamp: event.timestamp,
        };
        if (canonicalIndex === undefined) {
          acceptedUserMessageIndexes.add(messages.push(message) - 1);
        } else {
          replaceMessage(canonicalIndex, message);
          canonicalUserMessageIndexes.delete(canonicalIndex);
        }
        if (typeof messageId === 'string' || (canonical && stampedUserMessages.has(canonical))) stampedUserMessages.add(message);
      }
      return;
    }

    if (event.type === CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE) {
      const payload = coerceClaudePartialMessagePayload(event.payload);
      if (!payload) return;

      // Only one stream is live per lane, so a new id means the previous was abandoned.
      if (liveStreamId !== null && liveStreamId !== payload.streamId) {
        supersededStreamIds.add(liveStreamId);
      }
      liveStreamId = payload.streamId;
      endStreamingTools(payload.streamId);

      const existing = partialIndexes.get(payload.streamId) ?? {};
      // Snapshots keep carrying thinking after its canonical block has arrived.
      if (payload.thinking && !assistantThinking.has(payload.streamId)) {
        const reasoningMessage = {
          id: `reasoning-${payload.streamId}-thinking`,
          type: 'reasoning' as const,
          content: payload.thinking,
          status: payload.status,
          timestamp: event.timestamp,
        };
        if (existing.reasoning !== undefined) replaceMessage(existing.reasoning, reasoningMessage);
        else existing.reasoning = messages.push(reasoningMessage) - 1;
      }
      if (payload.text && !completedStreamIds.has(payload.streamId)) {
        const agentMessage = {
          id: `agent-${payload.streamId}-0`,
          type: 'agent' as const,
          content: payload.text,
          timestamp: event.timestamp,
        };
        if (existing.agent !== undefined) replaceMessage(existing.agent, agentMessage);
        else existing.agent = messages.push(agentMessage) - 1;
      }
      if (payload.tool) streamingTools.set(payload.streamId, { tool: payload.tool, timestamp: event.timestamp });
      partialIndexes.set(payload.streamId, existing);
      return;
    }

    if (event.type === CLAUDE_PEER_MESSAGE_EVENT_TYPE) {
      const { name, from, body } = event.payload;
      if (typeof body !== 'string') return;
      if (typeof name === 'string' && typeof from === 'string') peerNames.set(from, name);
      const sameTime = peerTimestamps.get(event.timestamp) ?? 0;
      peerTimestamps.set(event.timestamp, sameTime + 1);
      messages.push({
        id: `peer-${event.timestamp}-${sameTime}`,
        type: 'peer_message',
        direction: 'received',
        ...(typeof name === 'string' ? { chat: name } : {}),
        content: body,
        timestamp: event.timestamp,
      });
      return;
    }

    // Handle user messages (claude-user)
    if (event.type === 'claude-user') {
      const content = normalizeContentBlocks(event.payload.message?.content);

      // Check if this is a tool_result
      const toolResult = content.find(c => c.type === 'tool_result');
      if (toolResult && toolResult.tool_use_id) {
        if (!toolResult.is_error) {
          taskAccumulator.processContentBlock(toolResult);
        }
        // This is a tool result - we'll handle it in the second pass
        return;
      }

      const prompt = readClaudeUserPrompt(event.payload, content);
      if (prompt) {
        const { text: textContent, images } = prompt;
        const stampedId = event.payload[USER_MESSAGE_ID_PAYLOAD_KEY];
        const acceptedIndex = findMatchingUserMessageIndex(
          acceptedUserMessageIndexes,
          textContent,
          event.timestamp,
          stampedId,
        );
        const accepted = acceptedIndex === undefined ? undefined : messages[acceptedIndex];
        const message: DisplayMessage = {
          id: accepted?.id ?? (typeof stampedId === 'string' ? stampedId : `user-${event.timestamp}`),
          type: 'user',
          content: textContent || (images.length > 0 ? `[${images.length} image${images.length > 1 ? 's' : ''} attached]` : ''),
          images: images.length > 0 ? images : accepted?.type === 'user' ? accepted.images : undefined,
          timestamp: event.timestamp,
        };
        if (acceptedIndex === undefined) {
          canonicalUserMessageIndexes.add(messages.push(message) - 1);
        } else if (acceptedUserMessageIndexes.has(acceptedIndex)) {
          supersededUserMessageIndexes.add(acceptedIndex);
          acceptedUserMessageIndexes.delete(acceptedIndex);
          canonicalUserMessageIndexes.add(messages.push(message) - 1);
        } else {
          replaceMessage(acceptedIndex, message);
        }
        if (typeof stampedId === 'string' || (accepted && stampedUserMessages.has(accepted))) stampedUserMessages.add(message);
      }
    }

    // Handle assistant messages (claude-assistant)
    if (event.type === 'claude-assistant') {
      const messageId = event.payload.message?.id;
      const contentBlocks = normalizeContentBlocks(event.payload.message?.content);
      const messageKey = messageId || event.timestamp;
      // Claude Code echoes `/goal` as synthetic assistant text ("Goal set: …"), which would otherwise render as an answer.
      const localCommand = event.payload.local_command_run;
      const goalArgs = isRecord(localCommand) && localCommand.command === GOAL_TOOL_NAME && typeof localCommand.args === 'string'
        ? localCommand.args.trim()
        : '';
      if (goalArgs) {
        upsertMessage({
          id: `goal-${messageKey}`,
          type: 'tool_call',
          server: 'claude',
          tool: GOAL_TOOL_NAME,
          input: goalArgs === 'clear' ? undefined : { objective: goalArgs },
          status: 'completed',
          timestamp: event.timestamp,
        });
        return;
      }
      // A partial stream's id is its API message id, so a message reuses them.
      const streamRefs = messageId ? partialIndexes.get(messageId) : undefined;
      if (messageId) {
        endStreamingTools(messageId);
        if (liveStreamId !== null && liveStreamId !== messageId) {
          supersededStreamIds.add(liveStreamId);
        }
        // The SDK emits one assistant event per finished content block, and a
        // client cache keeps a stream's partial in the slot of its first flush,
        // so a thinking-only event can precede text that is still streaming.
        // Only a text block ends the stream; until then its partial text stays.
        if (contentBlocks.some((block) => block.type === 'text' && block.text)) {
          completedStreamIds.add(messageId);
          liveStreamId = null;
        }
      }

      // Thinking blocks for one message can span several events, so accumulate.
      const thinkingBlocks = contentBlocks.flatMap((block) =>
        block.type === 'thinking' && typeof block.thinking === 'string' ? [block.thinking] : [],
      );
      if (thinkingBlocks.length > 0) {
        const allThinking = [...(assistantThinking.get(messageKey) ?? []), ...thinkingBlocks];
        assistantThinking.set(messageKey, allThinking);
        const reasoningMessage: DisplayMessage = {
          id: `reasoning-${messageKey}-thinking`,
          type: 'reasoning',
          content: allThinking.join('\n\n'),
          status: 'completed',
          timestamp: event.timestamp,
        };
        if (streamRefs?.reasoning !== undefined) {
          replaceMessage(streamRefs.reasoning, reasoningMessage);
          streamRefs.reasoning = undefined;
        } else {
          upsertMessage(reasoningMessage);
        }
      }

      contentBlocks.forEach((block) => {
        // A message's text blocks arrive one per event, so the block index can't disambiguate them.
        if (block.type === 'text' && block.text) {
          const textIndex = assistantTextCounts.get(messageKey) ?? 0;
          assistantTextCounts.set(messageKey, textIndex + 1);
          const agentMessage: DisplayMessage = {
            id: `agent-${messageKey}-${textIndex}`,
            type: 'agent',
            content: block.text,
            timestamp: event.timestamp,
          };
          if (streamRefs?.agent !== undefined) {
            replaceMessage(streamRefs.agent, agentMessage);
            streamRefs.agent = undefined;
          } else {
            upsertMessage(agentMessage);
          }
        }

        // Handle tool_use blocks (function calls)
        if (block.type === 'tool_use' && block.id) {
          const toolName = block.name || 'unknown';
          const toolInput = block.input || {};
          const toolUseId = block.id;

          // Store tool call info for later correlation
          toolCallMap.set(toolUseId, {
            messageIndex: messages.length,
            toolName,
            input: toolInput,
          });

          if (CLAUDE_SUBAGENT_TOOL_NAMES.has(toolName)) {
            const inputObj = typeof toolInput === 'string'
              ? safeJsonParse<{ description?: string; prompt?: string; subagent_type?: string; model?: string }>(toolInput, {})
              : toolInput as { description?: string; prompt?: string; subagent_type?: string; model?: string };

            // Collect all nested events for this subagent
            const nestedEvents = collectNestedEvents(toolUseId);

            messages.push(createSubagentMessage(event.timestamp, {
              toolUseId,
              description: inputObj.description || 'Subagent Task',
              prompt: inputObj.prompt || '',
              subagentType: inputObj.subagent_type || 'general',
              model: inputObj.model,
              status: 'in_progress',
              nestedEvents,
            }));
          }
          else if (COMMAND_TOOL_NAMES.has(toolName) || FILE_TOOL_NAMES.has(toolName)) {
            messages.push(fileOrCommandMessage(block, event.timestamp));
          }
          else if (toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskList') {
            taskAccumulator.processContentBlock(block);
            const snapshot = taskSnapshot();
            if (snapshot.length > 0) {
              messages.push({
                id: `todo-${toolUseId}`,
                type: 'todo_list',
                items: snapshot,
                status: 'completed',
                timestamp: event.timestamp,
              });
            }
          }
          else if (toolName === 'SendMessage') {
            const parsed: unknown = typeof toolInput === 'string' ? safeJsonParse<unknown>(toolInput, {}) : toolInput;
            const input = isRecord(parsed) ? parsed : {};
            const to = typeof input.to === 'string' ? input.to.replace(/\s+\[[0-9a-f]+\]$/, '') : '';
            const chat = peerNames.get(to) ?? (to.startsWith('uds:') ? undefined : to || undefined);
            messages.push({
              id: `peer-${toolUseId}`,
              type: 'peer_message',
              direction: 'sent',
              ...(chat ? { chat } : {}),
              content: typeof input.message === 'string' ? input.message : '',
              status: 'in_progress',
              timestamp: event.timestamp,
            });
          }
          // Check if this is a WebSearch tool
          else if (toolName === 'WebSearch') {
            const inputObj = typeof toolInput === 'string'
              ? safeJsonParse<{ query?: string }>(toolInput, {})
              : toolInput as { query?: string };

            const query = inputObj.query || '';

            messages.push({
              id: `search-${toolUseId}`,
              type: 'web_search',
              query,
              status: 'in_progress',
              timestamp: event.timestamp,
            });
          }
          // Check if this is a Skill tool
          else if (toolName === 'Skill') {
            const inputObj = typeof toolInput === 'string'
              ? safeJsonParse<{ skill?: string; args?: string }>(toolInput, {})
              : toolInput as { skill?: string; args?: string };

            messages.push({
              id: `skill-${toolUseId}`,
              type: 'skill',
              skillName: inputObj.skill || 'unknown',
              args: inputObj.args,
              status: 'in_progress',
              timestamp: event.timestamp,
            });
          }
          // Generic tool calls (MCP tools, etc.)
          else {
            messages.push(createCallDisplayMessage({
              id: `toolcall-${toolUseId}`,
              server: 'claude',
              tool: toolName,
              input: toolInput,
              status: 'in_progress',
              timestamp: event.timestamp,
            }));
          }
        }
      });
    }

    if (event.type === 'claude-result' || event.type === CHAT_INTERRUPTED_EVENT_TYPE) endStreamingTools();
    if (compaction && (event.type === 'claude-result' || event.type === CHAT_INTERRUPTED_EVENT_TYPE)) {
      compaction.status = 'failed';
      compaction.completedAt = event.timestamp;
      compaction = undefined;
    }

    // Handle result messages (claude-result)
    if (event.type === 'claude-result') {
      const payload = coerceClaudeResultPayload(event.payload);
      markTurnEnd(messages);

      if (isClaudeResultError(payload)) {
        const genuineErrors = stripAgentDiagnosticErrors(payload.errors ?? []);
        messages.push({
          id: `error-${event.timestamp}`,
          type: 'error',
          message: genuineErrors.length > 0
            ? genuineErrors.join('\n')
            : payload.result || 'Claude session encountered an unexpected error.',
          timestamp: event.timestamp,
        });
      }
    }

    if (event.type === 'claude-system') {
      const { subtype, status, compact_result: compactResult } = event.payload;
      const compactionEnded = subtype === 'compact_boundary' || compactResult === 'failed';
      if (compactionEnded || (subtype === 'status' && status === 'compacting')) {
        if (!compaction) {
          compaction = { id: `compaction-${event.timestamp}`, type: 'reasoning', content: COMPACTION_CONTENT, timestamp: event.timestamp };
          messages.push(compaction);
        }
        compaction.status = !compactionEnded ? 'in_progress' : compactResult === 'failed' ? 'failed' : 'completed';
        if (compactionEnded) {
          compaction.completedAt = event.timestamp;
          compaction = undefined;
        }
      }

      const refusalFallback = coerceModelRefusalFallback(event);
      if (refusalFallback) messages.push({ id: `model-fallback-${event.timestamp}`, type: 'model_fallback', ...refusalFallback, timestamp: event.timestamp });

      const payload = coerceBackgroundTaskPayload(event.payload);
      // Only the start and notification bookends carry the ambient flag, so
      // remember it for the progress and patch events in between.
      if (payload?.ambient) ambientTaskIds.add(payload.taskId);
      if (payload && !ambientTaskIds.has(payload.taskId)) {
        // Ultracode workflow children are spawned by the Workflow runner, not by
        // Agent tool calls, so progress snapshots are the only place they surface.
        for (const workflowAgent of payload.workflowAgents ?? []) {
          const existingWorkflowAgent = workflowAgentMessageMap.get(workflowAgent.agentId);
          const nextWorkflowAgent = createSubagentMessage(
            existingWorkflowAgent?.timestamp ?? event.timestamp,
            {
              toolUseId: workflowAgent.agentId,
              description: workflowAgent.label,
              prompt: workflowAgent.promptPreview ?? existingWorkflowAgent?.prompt ?? '',
              subagentType: 'general',
              model: workflowAgent.model ?? existingWorkflowAgent?.model,
              status: workflowAgent.state === 'done' ? 'completed' : workflowAgent.state === 'error' ? 'failed' : 'in_progress',
              output: workflowAgent.resultPreview ?? workflowAgent.lastToolSummary ?? existingWorkflowAgent?.output,
              nestedEvents: existingWorkflowAgent?.nestedEvents ?? collectNestedEvents(workflowAgent.agentId),
            },
          );
          workflowAgentMessageMap.set(workflowAgent.agentId, upsertMessage(nextWorkflowAgent));
        }

        const existing = taskMessageMap.get(payload.taskId);
        const nextStatus = payload.subtype === 'task_notification'
          ? normalizeBackgroundTaskStatus(payload.status)
          : payload.subtype === 'task_updated' && payload.patch?.status !== undefined
            ? normalizeBackgroundTaskStatus(payload.patch?.status)
            : existing?.status ?? 'in_progress';

        const nextMessage: BackgroundTaskMessage = {
          id: `task-${payload.taskId}`,
          type: 'background_task',
          taskId: payload.taskId,
          toolUseId: payload.toolUseId ?? existing?.toolUseId,
          subagentType: payload.subagentType ?? existing?.subagentType,
          status: nextStatus,
          description: payload.description ?? payload.patch?.description ?? existing?.description,
          summary: payload.summary ?? existing?.summary,
          outputFile: payload.outputFile ?? existing?.outputFile,
          taskType: payload.taskType ?? existing?.taskType,
          workflowName: payload.workflowName ?? existing?.workflowName,
          prompt: payload.prompt ?? existing?.prompt,
          lastToolName: payload.lastToolName ?? existing?.lastToolName,
          usage: payload.usage ?? existing?.usage,
          error: payload.patch?.error ?? existing?.error,
          isBackgrounded: payload.isBackgrounded ?? payload.patch?.isBackgrounded ?? existing?.isBackgrounded,
          notifiedAt: payload.subtype === 'task_notification' ? event.timestamp : existing?.notifiedAt,
          timestamp: existing?.timestamp ?? event.timestamp,
        };

        taskMessageMap.set(payload.taskId, upsertMessage(nextMessage));
      }
    }
  });

  filteredEvents.forEach((event) => {
    if (event.type === 'okidoki-tool-input-request') {
      const payload = event.payload as {
        toolUseId?: string;
        requestId?: string;
        options?: ToolInputOption[];
        questions?: ToolInputQuestion[];
      };
      if (!payload.toolUseId || !payload.requestId) return;
      if (!Array.isArray(payload.options) && !Array.isArray(payload.questions)) return;
      const toolInfo = toolCallMap.get(payload.toolUseId);
      if (!toolInfo) return;
      const message = messages[toolInfo.messageIndex];
      if (!message || message.type !== 'tool_call') return;
      message.inputRequest = {
        requestId: payload.requestId,
        status: 'pending',
        options: payload.options,
        questions: payload.questions,
      };
    }
    if (event.type === 'okidoki-tool-input-resolved') {
      const payload = event.payload as {
        toolUseId?: string;
        selectionId?: string;
        selectionSummary?: string;
      };
      if (!payload.toolUseId || !payload.selectionId) return;
      const toolInfo = toolCallMap.get(payload.toolUseId);
      if (!toolInfo) return;
      const message = messages[toolInfo.messageIndex];
      if (!message || message.type !== 'tool_call' || !message.inputRequest) return;
      message.inputRequest = {
        ...message.inputRequest,
        status: payload.selectionId === 'aborted' ? 'aborted' : 'resolved',
        selectionId: payload.selectionId,
        selectionSummary: payload.selectionSummary,
        resolvedAt: event.timestamp,
      };
    }
  });

  // Appended last, not at the stream's partial: that index is where the message began, before tools that already ran.
  for (const [streamId, { tool, timestamp }] of streamingTools) {
    if (toolCallMap.has(tool.id) || supersededStreamIds.has(streamId)) continue;
    if (!COMMAND_TOOL_NAMES.has(tool.name) && !FILE_TOOL_NAMES.has(tool.name)) continue;
    messages.push(fileOrCommandMessage({ type: 'tool_use', id: tool.id, name: tool.name, input: 'filePath' in tool ? { file_path: tool.filePath } : { command: tool.command } }, timestamp));
  }

  // Second pass: Process tool results and update corresponding messages
  filteredEvents.forEach((event) => {
    const result = readToolResult(event);
    if (!result) return;
    const { toolResult, output: resultContent, outputOmitted, status } = result;
    const toolInfo = toolCallMap.get(result.toolUseId);
    if (!toolInfo) return;

    const isError = status === 'failed';

    if (toolInfo.toolName === 'TaskCreate' && !isError) {
      taskAccumulator.processContentBlock(toolResult);
    }

    // Find and update the corresponding message
    const message = messages[toolInfo.messageIndex];
    if (!message) return;

    // Update based on message type
    if (message.type === 'command') {
      message.output = resultContent;
      message.outputOmitted = outputOmitted;
      message.status = status;
      message.exitCode = result.exitCode ?? (isError ? 1 : 0);
    } else if (message.type === 'patch') {
      message.status = status;
    } else if (message.type === 'web_search') {
      message.status = status;
    } else if (message.type === 'peer_message') {
      const result: unknown = safeJsonParse<unknown>(resultContent, {});
      message.status = isError || (isRecord(result) && result.success === false) ? 'failed' : 'completed';
    } else if (message.type === 'tool_call') {
      message.output = resultContent;
      message.outputOmitted = outputOmitted;
      if (result.images.length > 0) message.images = result.images;
      message.status = status;
    } else if (message.type === 'skill' && isError && message.path) {
      replaceMessage(toolInfo.messageIndex, { id: message.id, type: 'tool_call', server: 'claude', tool: toolInfo.toolName, input: toolInfo.input, output: resultContent, outputOmitted, status, timestamp: message.timestamp });
    } else if (message.type === 'skill') {
      message.status = status;
    } else if (message.type === 'subagent') {
      message.output = subagentReport(resultContent);
      message.outputOmitted = outputOmitted;
      message.status = status;
    }
  });

  for (const message of messages) {
    if (message.type === 'background_task' && message.toolUseId) {
      const toolInfo = toolCallMap.get(message.toolUseId);
      const toolMessage = toolInfo ? messages[toolInfo.messageIndex] : undefined;
      if (toolMessage?.type === 'command') message.command = toolMessage.command;
      if (toolMessage?.type === 'subagent') {
        message.prompt ??= toolMessage.prompt;
        message.subagentType ??= toolMessage.subagentType;
        // A background agent's tool result only says it launched; its task says when it finished.
        toolMessage.status = message.status === 'stopped' ? 'failed' : message.status;
      }
    }
  }

  // Final position-dependent step: removals reindex messages, invalidating every stored position (toolCallMap, partialIndexes).
  const staleIndexes = new Set<number>(supersededUserMessageIndexes);
  for (const streamId of [...completedStreamIds, ...supersededStreamIds]) {
    const refs = partialIndexes.get(streamId);
    if (refs?.reasoning !== undefined) staleIndexes.add(refs.reasoning);
    if (refs?.agent !== undefined) staleIndexes.add(refs.agent);
  }
  if (staleIndexes.size === 0) return messages;
  return messages.filter((_, index) => !staleIndexes.has(index));
}
