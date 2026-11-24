import type { CapacityRetryMessage, DisplayMessage, CommandMessage, UserMessage } from '../types';
import type { AgentEvent, CodexQuotaState } from '../../event';
import {
  CHAT_INTERRUPTED_EVENT_TYPE,
  CODEX_ASP_ITEM_ID_PAYLOAD_KEY,
  CODEX_QUOTA_STATUS_EVENT_TYPE,
  CODEX_TURN_RETRY_EVENT_TYPE,
  USER_MESSAGE_ID_PAYLOAD_KEY,
  parseCodexTurnRetryPayload,
} from '../../event';
import { codexItemFromEvent, codexTurnFromEvent } from '../../engine/v1';
import { safeJsonParse } from '../../json';
import { areUserMessagesWithinMatchWindow, parseTimestampMs } from '../../user-message-matching';
import { stripOkidokiInstructionBlock } from '../../prompts';
import { userMessageImageHash } from '../../user-message-images';
import { createCallDisplayMessage, userMessageImages } from './utils';
import { skillNamesFromCommand } from '../format';
import { collectCodexTurns, messagesForCodexTurn } from './codex-asp-parser';

// Helper to determine status from exit code
function getStatusFromExitCode(exitCode: number | undefined): 'completed' | 'failed' {
  return exitCode === 0 ? 'completed' : 'failed';
}

function getPayloadString(event: AgentEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === 'string' ? value : null;
}

function displayId(event: AgentEvent, eventIndex: number, prefix: string): string {
  const stableId = getPayloadString(event, USER_MESSAGE_ID_PAYLOAD_KEY)
    ?? getPayloadString(event, CODEX_ASP_ITEM_ID_PAYLOAD_KEY);
  return stableId ? `${prefix}-${stableId}` : `${prefix}-${event.timestamp}-${eventIndex}`;
}

// Parse plain-text shell output from Codex
// Handles both formats:
//   "Exit code: N\n..." (shell/shell_command)
//   "Chunk ID: ...\nWall time: ...\nProcess exited with code N\n...\nOutput:\n..." (exec_command)
function parseShellOutput(raw: string): { exitCode: number; output: string } {
  const exitCodeMatch = raw.match(/^Exit code: (\d+)/m) || raw.match(/Process exited with code (\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;
  const outputIndex = raw.indexOf('Output:\n');
  const output = outputIndex >= 0 ? raw.slice(outputIndex + 'Output:\n'.length) : raw;
  return { exitCode, output };
}

// Parse apply_patch tool input into structured operations
function parsePatch(input: string): Array<{ action: 'add' | 'update' | 'delete'; path: string; moveTo?: string; diff?: string }> {
  const operations: Array<{ action: 'add' | 'update' | 'delete'; path: string; moveTo?: string; diff?: string }> = [];

  // Split by file operation markers
  const lines = input.split('\n');
  let currentOp: { action: 'add' | 'update' | 'delete'; path: string; moveTo?: string; diff?: string } | null = null;
  let diffLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('*** Add File:')) {
      if (currentOp) {
        if (diffLines.length > 0) currentOp.diff = diffLines.join('\n');
        operations.push(currentOp);
        diffLines = [];
      }
      currentOp = {
        action: 'add',
        path: line.replace('*** Add File:', '').trim(),
      };
    } else if (line.startsWith('*** Update File:')) {
      if (currentOp) {
        if (diffLines.length > 0) currentOp.diff = diffLines.join('\n');
        operations.push(currentOp);
        diffLines = [];
      }
      currentOp = {
        action: 'update',
        path: line.replace('*** Update File:', '').trim(),
      };
    } else if (line.startsWith('*** Delete File:')) {
      if (currentOp) {
        if (diffLines.length > 0) currentOp.diff = diffLines.join('\n');
        operations.push(currentOp);
        diffLines = [];
      }
      currentOp = {
        action: 'delete',
        path: line.replace('*** Delete File:', '').trim(),
      };
    } else if (line.startsWith('*** Move to:')) {
      if (currentOp) {
        currentOp.moveTo = line.replace('*** Move to:', '').trim();
      }
    } else if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      // Skip envelope markers
      continue;
    } else if (currentOp && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('@@') || line.trim() === '')) {
      // Collect diff lines
      diffLines.push(line);
    }
  }

  // Push last operation
  if (currentOp) {
    if (diffLines.length > 0) currentOp.diff = diffLines.join('\n');
    operations.push(currentOp);
  }

  return operations;
}

interface RecordedPrompt {
  message: UserMessage;
  index: number;
  timestampMs: number;
}

function takeRecordedPrompt(prompts: RecordedPrompt[], echo: UserMessage, turnIndex: number): UserMessage | undefined {
  const timestampMs = parseTimestampMs(echo.timestamp);
  let closestIndex = -1;
  let closestDistance = Infinity;
  // Recent prompts usually match; equal distances still prefer the earliest record.
  for (let i = prompts.length - 1; i >= 0; i--) {
    const candidate = prompts[i];
    const distance = Math.abs(candidate.timestampMs - timestampMs);
    if (distance > closestDistance) continue;
    if (candidate.index >= turnIndex && !areUserMessagesWithinMatchWindow(
      { content: stripOkidokiInstructionBlock(candidate.message.content), timestamp: candidate.timestampMs },
      { content: stripOkidokiInstructionBlock(echo.content), timestamp: timestampMs },
    )) continue;
    const images = candidate.message.images;
    if (images && echo.images && (
      images.length !== echo.images.length
      || images.some((image, index) => {
        const other = echo.images?.[index];
        if (!other || image.mediaType !== other.mediaType) return true;
        if (image.data && other.data) return image.data !== other.data;
        const hash = userMessageImageHash(image);
        return hash === undefined || hash !== userMessageImageHash(other);
      })
    )) continue;
    closestIndex = i;
    closestDistance = distance;
  }
  return closestIndex === -1 ? undefined : prompts.splice(closestIndex, 1)[0].message;
}

const promptTurnIds = new WeakMap<DisplayMessage, string>();

export function codexPromptTurnId(message: DisplayMessage): string | undefined {
  return promptTurnIds.get(message);
}

export function parseCodexEvents(events: AgentEvent[]): DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const turns = collectCodexTurns(events);
  const turnInsertions = new Map<string, number>();
  const pendingCommands = new Map<string, CommandMessage>();
  const pendingToolCalls = new Map<string, Extract<DisplayMessage, { type: 'tool_call' }>>();
  const pendingPatches = new Map<string, {
    input: string;
    status: 'in_progress' | 'completed' | 'failed';
    timestamp: string;
    operations: Array<{ action: 'add' | 'update' | 'delete'; path: string; moveTo?: string; diff?: string }>;
  }>();

  const retriedTurnIds = new Set<string>();
  let pendingRetry: CapacityRetryMessage | null = null;

  events.forEach((event, eventIndex) => {
    const turnId = codexItemFromEvent(event)?.turnId ?? codexTurnFromEvent(event)?.turnId;
    if (turnId !== undefined) {
      if (!turnInsertions.has(turnId)) turnInsertions.set(turnId, messages.length);
      if (pendingRetry && !retriedTurnIds.has(turnId)) {
        pendingRetry.status = 'completed';
        pendingRetry = null;
      }
      return;
    }

    // Left in progress, so the stopped turn shows the retry as stopped.
    if (event.type === CHAT_INTERRUPTED_EVENT_TYPE) {
      pendingRetry = null;
      return;
    }

    if (event.type === CODEX_TURN_RETRY_EVENT_TYPE) {
      const retry = parseCodexTurnRetryPayload(event.payload);
      if (!retry) return;
      retriedTurnIds.add(retry[CODEX_ASP_ITEM_ID_PAYLOAD_KEY]);
      pendingRetry = {
        id: displayId(event, eventIndex, 'capacity-retry'),
        type: 'capacity_retry',
        attempt: retry.attempt,
        maxAttempts: retry.maxAttempts,
        status: 'in_progress',
        timestamp: event.timestamp,
      };
      messages.push(pendingRetry);
      return;
    }

    if (event.type === 'codex-asp-error') {
      if (pendingRetry) {
        pendingRetry.status = 'completed';
        pendingRetry = null;
      }
      // The failed turn on this page already renders the same failure; only surface the
      // engine-level error when that turn is not here.
      const failedTurnId = getPayloadString(event, CODEX_ASP_ITEM_ID_PAYLOAD_KEY);
      if (!(failedTurnId && turns.has(failedTurnId))) {
        messages.push({
          id: displayId(event, eventIndex, 'error'),
          type: 'error',
          message: getPayloadString(event, 'message') ?? 'Codex run failed',
          timestamp: event.timestamp,
        });
      }
      return;
    }

    // Synthetic quota-status events emitted by the engine when the Codex
    // backing account hits a credit/rate-limit transition.
    if (event.type === CODEX_QUOTA_STATUS_EVENT_TYPE) {
      const state = event.payload?.state as CodexQuotaState | undefined;
      if (state) {
        messages.push({
          id: `codex-quota-${event.timestamp}-${eventIndex}`,
          type: 'quota_status',
          provider: 'codex',
          state,
          balance: (event.payload?.balance as string | null | undefined) ?? null,
          rateLimitResetType: (event.payload?.rateLimitResetType as string | null | undefined) ?? null,
          planType: (event.payload?.planType as string | null | undefined) ?? null,
          timestamp: event.timestamp,
        });
      }
      return;
    }

    // Handle user messages from event_msg
    if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
      const message = getPayloadString(event, 'message');
      messages.push({
        id: displayId(event, eventIndex, 'user'),
        type: 'user',
        content: message ?? '',
        images: userMessageImages(event.payload.images),
        timestamp: event.timestamp,
      });
    }

    // Handle agent reasoning from event_msg
    if (event.type === 'event_msg' && event.payload?.type === 'agent_reasoning') {
      messages.push({
        id: displayId(event, eventIndex, 'reasoning'),
        type: 'reasoning',
        content: (event.payload.text as string) || '',
        status: 'completed',
        timestamp: event.timestamp,
      });
    }

    // Process response_item events (canonical format)
    if (event.type === 'response_item') {
      const payloadType = event.payload?.type as string;

      // Agent messages
      if (payloadType === 'message' && event.payload?.role === 'assistant') {
        const content = (event.payload.content as Array<{ type: string; text?: string }>) || [];
        const textContent = content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text || '')
          .join('\n');

        if (textContent) {
          messages.push({
            id: displayId(event, eventIndex, 'agent'),
            type: 'agent',
            content: textContent,
            timestamp: event.timestamp,
          });
        }
      }

      // Shell/Bash commands (function_call with name="shell", "shell_command", or "exec_command")
      if (payloadType === 'function_call' && (event.payload?.name === 'shell' || event.payload?.name === 'shell_command' || event.payload?.name === 'exec_command')) {
        const callId = event.payload.call_id as string;
        const args = safeJsonParse<{ command?: string | string[]; cmd?: string }>((event.payload.arguments as string) || '{}', {});
        const command = args.cmd || (Array.isArray(args.command) ? args.command.join(' ') : args.command) || '';
        const skillNames = skillNamesFromCommand(command);

        const msg: CommandMessage = {
          id: `command-${callId || 'no-call-id'}-${eventIndex}`,
          type: 'command',
          command,
          ...(skillNames.length > 0 ? { skillNames } : {}),
          output: '',
          status: 'in_progress',
          timestamp: event.timestamp,
        };
        messages.push(msg);
        if (callId) {
          pendingCommands.set(callId, msg);
        }
      }

      // Command output (function_call_output)
      if (payloadType === 'function_call_output') {
        const callId = event.payload.call_id as string;
        const rawOutput = (event.payload.output as string) || '';

        const commandMsg = callId ? pendingCommands.get(callId) : undefined;
        if (commandMsg) {
          const { exitCode, output } = parseShellOutput(rawOutput);
          commandMsg.output = output;
          commandMsg.exitCode = exitCode;
          commandMsg.status = getStatusFromExitCode(exitCode);
          pendingCommands.delete(callId);
        }
      }

      // Custom tool calls
      if (payloadType === 'custom_tool_call') {
        const callId = event.payload.call_id as string;
        const name = event.payload.name as string;
        const input = (event.payload.input as string) || '';
        const server = typeof event.payload.server === 'string' ? event.payload.server : 'custom';
        const status = (event.payload.status as 'in_progress' | 'completed' | 'failed') || 'in_progress';

        if (name === 'apply_patch') {
          const operations = parsePatch(input);
          pendingPatches.set(callId, { input, status, timestamp: event.timestamp, operations });
        } else {
          const id = `toolcall-${callId || getPayloadString(event, CODEX_ASP_ITEM_ID_PAYLOAD_KEY) || `${event.timestamp}-${eventIndex}`}`;
          const msg = createCallDisplayMessage({
            id,
            server,
            tool: name,
            input,
            status,
            timestamp: event.timestamp,
          });
          messages.push(msg);
          if (callId && msg.type === 'tool_call') {
            pendingToolCalls.set(callId, msg);
          }
        }
      }

      // Custom tool call output
      if (payloadType === 'custom_tool_call_output') {
        const callId = event.payload.call_id as string;
        const output = safeJsonParse<{ output?: string; metadata?: { exit_code?: number } }>(
          (event.payload.output as string) || '{}',
          {}
        );

        const pendingPatch = pendingPatches.get(callId);
        if (pendingPatch) {
          messages.push({
            id: `patch-${pendingPatch.timestamp}-${eventIndex}`,
            type: 'patch',
            operations: pendingPatch.operations,
            output: output.output || '',
            exitCode: output.metadata?.exit_code,
            status: getStatusFromExitCode(output.metadata?.exit_code),
            timestamp: pendingPatch.timestamp,
          });
          pendingPatches.delete(callId);
        } else {
          const fallbackToolCallMsg = messages.findLast((m): m is Extract<DisplayMessage, { type: 'tool_call' }> => m.type === 'tool_call');
          const toolCallMsg = pendingToolCalls.get(callId) ?? fallbackToolCallMsg;
          if (toolCallMsg) {
            toolCallMsg.status = getStatusFromExitCode(output.metadata?.exit_code);
            toolCallMsg.output = output.output ?? (typeof event.payload.output === 'string' ? event.payload.output : '');
            if (callId) {
              pendingToolCalls.delete(callId);
            }
          }
        }
      }

      // Plan updates (function_call with name="update_plan")
      if (payloadType === 'function_call' && event.payload?.name === 'update_plan') {
        const args = safeJsonParse<{ plan?: Array<{ status: string; step: string }> }>(
          (event.payload.arguments as string) || '{}',
          {}
        );

        if (args.plan && Array.isArray(args.plan)) {
          const todoItems = args.plan.map(item => ({
            text: item.step,
            completed: item.status === 'completed'
          }));

          messages.push({
            id: `todo-${event.timestamp}-${eventIndex}`,
            type: 'todo_list',
            items: todoItems,
            status: 'completed',
            timestamp: event.timestamp,
          });
        }
      }
    }
  });

  const recordedPrompts = new Map<string, RecordedPrompt[]>();
  messages.forEach((message, index) => {
    if (message.type !== 'user') return;
    const content = stripOkidokiInstructionBlock(message.content);
    const prompts = recordedPrompts.get(content) ?? [];
    prompts.push({ message, index, timestampMs: parseTimestampMs(message.timestamp) });
    recordedPrompts.set(content, prompts);
  });
  const claimedPrompts = new Set<DisplayMessage>();
  for (const [turnId, index] of [...turnInsertions].reverse()) {
    const turn = turns.get(turnId);
    if (!turn) continue;
    const kept: DisplayMessage[] = [];
    let opened = false;
    for (const message of messagesForCodexTurn(turn)) {
      if (retriedTurnIds.has(turnId)) {
        if (message.type === 'error') continue;
        if (message.type === 'reasoning' && message.status === 'in_progress') {
          kept.push({ ...message, status: 'failed' });
          continue;
        }
      }
      if (message.type !== 'user') {
        kept.push(message);
        continue;
      }
      const prompts = recordedPrompts.get(stripOkidokiInstructionBlock(message.content));
      const recorded = prompts && takeRecordedPrompt(prompts, message, index);
      if (recorded) claimedPrompts.add(recorded);
      const prompt = recorded ? {
        ...recorded,
        images: recorded.images?.map((image, index) => image.data ? image : message.images?.[index]?.data ? message.images[index] : image) ?? message.images,
      } : message;
      if (!opened) promptTurnIds.set(prompt, turnId);
      opened = true;
      kept.push(prompt);
    }
    messages.splice(index, 0, ...kept);
  }

  return messages.filter((message) => !claimedPrompts.has(message));
}
