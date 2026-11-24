import type { SDKMessage as ClaudeSDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage as CursorSDKMessage } from '@cursor/sdk';
import type { Part as OpencodePart } from '@opencode-ai/sdk/v2';
import type { AgentSessionEvent as PiEvent } from '@earendil-works/pi-coding-agent';
import type { ServerNotification, v2 } from '@okidoki/shared/codex-asp-types';
import {
  extractToolResultText,
  isRecord,
  normalizeContentBlocks,
  type LinearAgentPlanItem,
  type LinearEvent,
  type LinearResponseEvent,
  type LinearThoughtEvent,
} from '@okidoki/shared';

export function linearThoughtToResponse(thought: LinearThoughtEvent): LinearResponseEvent {
  return {
    linearSessionId: thought.linearSessionId,
    content: {
      type: 'response',
      body: thought.content.body,
    },
  };
}

function summarizeInput(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (isRecord(input)) {
    if (input.file_path) return String(input.file_path);
    if (input.command) return String(input.command);
    if (input.pattern) return `pattern: ${String(input.pattern)}`;
    if (input.query) return String(input.query);
    if (input.url) return String(input.url);
    if (typeof input.activeForm === 'string' && input.activeForm) return String(input.activeForm);
    if (typeof input.subject === 'string' && input.subject) return String(input.subject);
    for (const [key, value] of Object.entries(input)) {
      return `${key}: ${String(value)}`;
    }
  }
  return '';
}

function summarizeResult(result: unknown): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (isRecord(result)) {
    if (typeof result.message === 'string') return result.message;
    if (typeof result.error === 'string') return result.error;
    if (typeof result.stdout === 'string') return result.stdout;
    if (typeof result.stderr === 'string') return result.stderr;
    if (typeof result.path === 'string') return result.path;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function toolAction(toolName: string): string {
  switch (toolName) {
    case 'Bash':
    case 'bash':
    case 'shell':
      return 'Running command';
    case 'Edit':
    case 'edit':
      return 'Editing file';
    case 'Write':
    case 'write':
      return 'Writing file';
    case 'Read':
    case 'read':
      return 'Reading file';
    case 'Glob':
    case 'glob':
      return 'Searching files';
    case 'Grep':
    case 'grep':
    case 'semsearch':
      return 'Searching code';
    case 'WebSearch':
      return 'Web search';
    case 'WebFetch':
      return 'Fetching URL';
    case 'delete':
      return 'Deleting file';
    case 'Task':
    case 'task':
      return 'Spawning subagent';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'update_todos':
    case 'create_plan':
      return 'Updating plan';
    default:
      return toolName;
  }
}

export function convertClaudeEvent(
  event: ClaudeSDKMessage,
  linearSessionId: string
): LinearEvent | null {
  if (event.type === 'assistant') {
    const contentBlocks = normalizeContentBlocks(event.message.content);

    for (const block of contentBlocks) {
      if (block.type === 'text' && block.text) {
        return {
          linearSessionId,
          content: {
            type: 'thought',
            body: block.text,
          },
        };
      }

      if (block.type === 'thinking' && block.thinking) {
        return {
          linearSessionId,
          content: {
            type: 'thought',
            body: block.thinking,
          },
        };
      }

      if (block.type === 'tool_use' && block.name) {
        const toolName = block.name;
        const parameter = summarizeInput(block.input);

        return {
          linearSessionId,
          content: {
            type: 'action',
            action: toolAction(toolName),
            parameter,
          },
        };
      }
    }
  }

  if (event.type === 'user') {
    const contentBlocks = normalizeContentBlocks(event.message.content);

    for (const block of contentBlocks) {
      if (block.type === 'tool_result') {
        const resultText = extractToolResultText(block.content);
        const isError = block.is_error || false;
        const result = isError ? `Error: ${resultText}` : resultText || 'Done';

        return {
          linearSessionId,
          content: {
            type: 'action',
            action: 'Tool completed',
            parameter: '',
            result,
          },
        };
      }
    }
  }

  return null;
}

export function convertCursorEvent(
  event: CursorSDKMessage,
  linearSessionId: string
): LinearEvent | null {
  if (event.type === 'assistant') {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        return {
          linearSessionId,
          content: {
            type: 'thought',
            body: block.text,
          },
        };
      }

      if (block.type === 'tool_use' && block.name) {
        return {
          linearSessionId,
          content: {
            type: 'action',
            action: toolAction(block.name),
            parameter: summarizeInput(block.input),
          },
        };
      }
    }
  }

  if (event.type === 'thinking' && event.text) {
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body: event.text,
      },
    };
  }

  if (event.type === 'tool_call') {
    const result = event.status === 'running'
      ? undefined
      : event.status === 'error'
        ? `Error: ${summarizeResult(event.result) || 'Tool failed'}`
        : summarizeResult(event.result) || 'Done';

    return {
      linearSessionId,
      content: {
        type: 'action',
        action: toolAction(event.name),
        parameter: summarizeInput(event.args),
        ...(result ? { result } : {}),
      },
    };
  }

  if (event.type === 'task' && event.text) {
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body: event.text,
      },
    };
  }

  return null;
}

function isOpencodePartEnded(part: OpencodePart): boolean {
  return 'time' in part && isRecord(part.time) && 'end' in part.time && part.time.end !== undefined;
}

export function convertOpencodePart(
  part: OpencodePart,
  linearSessionId: string,
): LinearEvent | null {
  if ((part.type === 'text' || part.type === 'reasoning') && isOpencodePartEnded(part)) {
    const body = typeof part.text === 'string' ? part.text.trim() : '';
    if (!body) return null;
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body,
      },
    };
  }

  if (part.type === 'tool') {
    const state = part.state;
    const result = state.status === 'completed'
      ? summarizeResult(state.output) || 'Done'
      : state.status === 'error'
        ? `Error: ${summarizeResult(state.error) || 'Tool failed'}`
        : undefined;

    return {
      linearSessionId,
      content: {
        type: 'action',
        action: toolAction(typeof part.tool === 'string' ? part.tool : 'Tool'),
        parameter: summarizeInput(state.input),
        ...(result ? { result } : {}),
      },
    };
  }

  if (part.type === 'patch') {
    const files = 'files' in part && Array.isArray(part.files)
      ? part.files.filter((file) => typeof file === 'string')
      : [];
    if (files.length === 0) return null;
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: 'File change',
        parameter: files.join(', '),
        result: 'Done',
      },
    };
  }

  return null;
}

export function convertPiEvent(
  event: PiEvent,
  linearSessionId: string,
): LinearEvent | null {
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const { content } = event.message;
    const text = content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim();
    const body = text || content.flatMap((block) => block.type === 'thinking' ? [block.thinking] : []).join('\n').trim();
    return body ? { linearSessionId, content: { type: 'thought', body } } : null;
  }

  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    const output = event.type === 'tool_execution_end' && isRecord(event.result) ? extractToolResultText(event.result.content) : '';
    const result = event.type !== 'tool_execution_end'
      ? undefined
      : event.isError
        ? `Error: ${output || 'Tool failed'}`
        : output || 'Done';
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: toolAction(event.toolName),
        parameter: event.type === 'tool_execution_start' ? summarizeInput(event.args) : '',
        ...(result ? { result } : {}),
      },
    };
  }

  return null;
}

export function mapTodoStatus(status?: string): LinearAgentPlanItem['status'] {
  if (status === 'in_progress') {
    return 'inProgress';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'cancelled' || status === 'canceled') {
    return 'canceled';
  }
  return 'pending';
}

type CodexAspItemLifecycle = 'started' | 'completed';

function codexAspReasoningText(item: Extract<v2.ThreadItem, { type: 'reasoning' }>): string {
  return [...item.summary, ...item.content].filter(Boolean).join('\n').trim();
}

function codexAspChangePaths(item: Extract<v2.ThreadItem, { type: 'fileChange' }>): string {
  return item.changes.map((change) => change.path).filter(Boolean).join(', ');
}

function codexAspStatusResult(status: string): string {
  return status === 'completed' ? 'Done' : status || 'Done';
}

function convertCodexAspItem(
  item: v2.ThreadItem,
  lifecycle: CodexAspItemLifecycle,
  linearSessionId: string,
): LinearEvent | null {
  if (item.type === 'agentMessage') {
    if (!item.text) return null;
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body: item.text,
      },
    };
  }

  if (item.type === 'reasoning') {
    const text = codexAspReasoningText(item);
    if (!text) return null;
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body: text,
      },
    };
  }

  if (item.type === 'commandExecution') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: 'Running command',
        parameter: item.command,
        ...(lifecycle === 'completed'
          ? { result: item.exitCode !== null ? `Exit code: ${item.exitCode}` : item.aggregatedOutput || 'Done' }
          : {}),
      },
    };
  }

  if (item.type === 'fileChange') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: 'File change',
        parameter: codexAspChangePaths(item),
        ...(lifecycle === 'completed' ? { result: codexAspStatusResult(item.status) } : {}),
      },
    };
  }

  if (item.type === 'mcpToolCall') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: item.tool || 'MCP tool call',
        parameter: item.server,
        ...(lifecycle === 'completed'
          ? { result: item.error?.message ?? codexAspStatusResult(item.status) }
          : {}),
      },
    };
  }

  if (item.type === 'dynamicToolCall') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: item.tool,
        parameter: item.namespace ?? '',
        ...(lifecycle === 'completed'
          ? { result: item.success === false ? 'Failed' : codexAspStatusResult(item.status) }
          : {}),
      },
    };
  }

  if (item.type === 'webSearch') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: 'Web search',
        parameter: item.query,
        ...(lifecycle === 'completed' ? { result: 'Done' } : {}),
      },
    };
  }

  if (item.type === 'plan') {
    return {
      linearSessionId,
      content: {
        type: 'action',
        action: 'Updating plan',
        parameter: item.text,
        ...(lifecycle === 'completed' ? { result: 'Done' } : {}),
      },
    };
  }

  return null;
}

export function convertCodexAspNotification(
  notification: ServerNotification,
  linearSessionId: string,
): LinearEvent | null {
  if (notification.method === 'turn/started') {
    return {
      linearSessionId,
      content: {
        type: 'thought',
        body: 'Processing...',
      },
    };
  }

  if (notification.method === 'item/started') {
    return convertCodexAspItem(notification.params.item, 'started', linearSessionId);
  }

  if (notification.method === 'item/completed') {
    return convertCodexAspItem(notification.params.item, 'completed', linearSessionId);
  }

  return null;
}

export function extractPlanFromCodexAspNotification(
  notification: ServerNotification,
): LinearAgentPlanItem[] | null {
  if (notification.method !== 'turn/plan/updated' || notification.params.plan.length === 0) {
    return null;
  }

  return notification.params.plan
    .filter((item) => item.step.trim().length > 0)
    .map((item) => ({
      content: item.step.trim(),
      status: item.status,
    }));
}
