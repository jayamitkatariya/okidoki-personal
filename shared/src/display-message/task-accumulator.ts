import { safeJsonParse } from '../json';
import type { ChatHistoryOmittedBody } from '../engine/v1';
import { isRecord } from '../type-guards';
import type { TodoItemStatus } from './types';

export type TaskStatus = TodoItemStatus;

export interface AccumulatedTask {
  subject: string;
  status: TaskStatus;
}

function mapTaskStatus(status: unknown): TaskStatus {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
}

function toAccumulatorInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(input) ? input : {};
}

export function extractToolResultText(content: unknown, separator: string = '\n'): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  return texts.join(separator);
}

export interface MessageContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown> | string;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text: string }>;
  is_error?: boolean;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
  okidokiOmitted?: ChatHistoryOmittedBody;
}

export function normalizeContentBlocks(
  content: unknown,
): MessageContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return Array.isArray(content)
    ? content.filter((block): block is MessageContentBlock => isRecord(block) && typeof block.type === 'string')
    : [];
}

function parseStringField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseCreateResultTaskId(resultText: string): string | null {
  const parsed = resultText.trimStart().startsWith('{') ? safeJsonParse<unknown>(resultText, null) : null;
  if (isRecord(parsed) && isRecord(parsed.task)) {
    return parseStringField(parsed.task.id);
  }

  return resultText.match(/\bTask\s+#?([A-Za-z0-9_-]+)\s+created\b/i)?.[1] ?? null;
}

export class TaskAccumulator {
  private readonly tasksByTaskId = new Map<string, AccumulatedTask>();
  private readonly tasksByCreateToolUseId = new Map<string, AccumulatedTask>();
  private readonly orderedKeys: string[] = [];

  private processToolUse(toolName: string, toolUseId: string, input: Record<string, unknown>): boolean {
    if (toolName === 'TaskCreate') {
      const subject = parseStringField(input.subject);
      if (!subject) return false;
      this.tasksByCreateToolUseId.set(toolUseId, { subject, status: 'pending' });
      this.orderedKeys.push(toolUseId);
      return true;
    }

    if (toolName === 'TaskUpdate') {
      const taskId = parseStringField(input.taskId);
      if (!taskId) return false;
      if (input.status === 'deleted') {
        if (!this.tasksByTaskId.delete(taskId)) return false;
        const idx = this.orderedKeys.indexOf(taskId);
        if (idx !== -1) this.orderedKeys.splice(idx, 1);
        return true;
      }
      const existing = this.tasksByTaskId.get(taskId);
      const subject = parseStringField(input.subject) ?? existing?.subject;
      if (!subject) return false;
      const status = input.status !== undefined
        ? mapTaskStatus(input.status)
        : existing?.status ?? 'pending';
      this.tasksByTaskId.set(taskId, { subject, status });
      if (!existing) this.orderedKeys.push(taskId);
      return true;
    }

    if (toolName === 'TaskList') {
      if (!Array.isArray(input.tasks)) return false;
      let changed = false;
      for (const raw of input.tasks) {
        if (!isRecord(raw)) continue;
        const id = parseStringField(raw.id);
        const subject = parseStringField(raw.subject);
        if (!id || !subject) continue;
        const existing = this.tasksByTaskId.get(id);
        const next: AccumulatedTask = { subject, status: mapTaskStatus(raw.status) };
        if (existing && existing.subject === next.subject && existing.status === next.status) continue;
        this.tasksByTaskId.set(id, next);
        if (!existing) this.orderedKeys.push(id);
        changed = true;
      }
      return changed;
    }

    return false;
  }

  private processCreateResult(toolUseId: string, content: unknown): boolean {
    const pending = this.tasksByCreateToolUseId.get(toolUseId);
    if (!pending) return false;
    const taskId = parseCreateResultTaskId(extractToolResultText(content, ''));
    if (!taskId) return false;
    this.tasksByTaskId.set(taskId, pending);
    this.tasksByCreateToolUseId.delete(toolUseId);
    const idx = this.orderedKeys.indexOf(toolUseId);
    if (idx !== -1) this.orderedKeys.splice(idx, 1, taskId);
    return true;
  }

  getTasks(): AccumulatedTask[] {
    const out: AccumulatedTask[] = [];
    for (const key of this.orderedKeys) {
      const task = this.tasksByTaskId.get(key) ?? this.tasksByCreateToolUseId.get(key);
      if (task && task.subject) out.push(task);
    }
    return out;
  }

  processContentBlock(block: unknown): boolean {
    if (!isRecord(block)) return false;
    if (block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
      return this.processToolUse(block.name, block.id, toAccumulatorInput(block.input));
    }
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return this.processCreateResult(block.tool_use_id, block.content);
    }
    return false;
  }
}
