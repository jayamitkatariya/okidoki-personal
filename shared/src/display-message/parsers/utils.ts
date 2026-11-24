import type { AgentEvent } from '../../event';
import { RUN_STEP_TYPES, type DisplayMessage, type RunStep, type SkillMessage, type ToolCallMessage, type ToolInputQuestion, type ToolInputRequest, type UserMessageImage } from '../types';
import { parseTimestampMs } from '../../agent-event-utils';
import { safeJsonParse } from '../../json';
import { isRecord } from '../../type-guards';

export const INTERRUPTED_MESSAGE_REGEX = /^\[Request interrupted by user.*\]$/;

export function userMessageImages(value: unknown): UserMessageImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.filter((item): item is UserMessageImage => (
    isRecord(item)
    && item.type === 'image'
    && typeof item.mediaType === 'string'
    && typeof item.data === 'string'
  ));
  return images.length > 0 ? images : undefined;
}

export function stringifyDisplayValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const runStepTypes: ReadonlySet<DisplayMessage['type']> = new Set(RUN_STEP_TYPES);

// A run can finish on a step with no reply after it, and the mark still says nothing more of that run is coming.
export function markTurnEnd(messages: DisplayMessage[], completedAt?: string): void {
  const last = messages.at(-1);
  if (last && isRunStep(last)) messages[messages.length - 1] = { ...last, endsTurn: true, ...(last.type === 'agent' && completedAt ? { completedAt } : {}) };
}

const isRunStep = (message: DisplayMessage): message is RunStep => runStepTypes.has(message.type);

export function upsertDisplayMessage<T extends DisplayMessage>(messages: DisplayMessage[], message: T): T {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;
  return message;
}

export interface ToolInputEventState {
  requests: Map<string, ToolInputRequest>;
  resolutions: Map<string, { requestId?: string; selectionId: string; selectionSummary?: string; resolvedAt: string }>;
  requestedAt: Map<string, string>;
}

export function isToolInputQuestion(value: unknown): value is ToolInputQuestion {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.prompt === 'string'
    && typeof value.multiSelect === 'boolean'
    && Array.isArray(value.options)
    && value.options.every((option) => isRecord(option)
      && typeof option.id === 'string'
      && typeof option.label === 'string');
}

export function applyToolInputEvent(
  event: AgentEvent,
  messages: DisplayMessage[],
  provider: string,
  state: ToolInputEventState,
  questionFilter?: (value: unknown) => value is ToolInputQuestion,
): boolean {
  if (event.type === 'okidoki-tool-input-request'
    && typeof event.payload.toolUseId === 'string'
    && typeof event.payload.requestId === 'string'
    && (Array.isArray(event.payload.options) || Array.isArray(event.payload.questions))) {
    const previous = state.resolutions.get(event.payload.toolUseId);
    const resolved = previous && (!previous.requestId || previous.requestId === event.payload.requestId) ? previous : undefined;
    // A tool can ask again in stages, so its earlier answered waits carry into the new request. An update to the same request keeps its wait.
    const earlier = state.requests.get(event.payload.toolUseId);
    const same = earlier?.requestId === event.payload.requestId;
    if (!same) state.requestedAt.set(event.payload.toolUseId, event.timestamp);
    const requestedAt = state.requestedAt.get(event.payload.toolUseId) ?? event.timestamp;
    const answeredNow = resolved && (!same || earlier?.status === 'pending');
    const inputRequest: ToolInputRequest = {
      requestId: event.payload.requestId,
      status: resolved?.selectionId === 'aborted' || resolved?.selectionId === 'declined'
        ? 'aborted'
        : resolved ? 'resolved' : 'pending',
      ...(Array.isArray(event.payload.options) ? { options: event.payload.options } : {}),
      ...(Array.isArray(event.payload.questions)
        ? { questions: questionFilter ? event.payload.questions.filter(questionFilter) : event.payload.questions }
        : {}),
      ...(resolved ? { selectionId: resolved.selectionId } : {}),
      ...(resolved?.selectionSummary ? { selectionSummary: resolved.selectionSummary } : {}),
      ...(resolved ? { resolvedAt: resolved.resolvedAt } : {}),
      waitedMs: (earlier?.waitedMs ?? 0) + (answeredNow ? Math.max(0, parseTimestampMs(resolved.resolvedAt) - parseTimestampMs(requestedAt)) : 0),
    };
    state.requests.set(event.payload.toolUseId, inputRequest);
    const message = messages.find((candidate): candidate is Extract<DisplayMessage, { type: 'tool_call' }> => (
      candidate.type === 'tool_call' && candidate.id === `${provider}-tool-${event.payload.toolUseId}`
    ));
    if (message) message.inputRequest = inputRequest;
    return true;
  }

  if (event.type === 'okidoki-tool-input-resolved'
    && typeof event.payload.toolUseId === 'string'
    && typeof event.payload.selectionId === 'string') {
    const resolved = {
      ...(typeof event.payload.requestId === 'string' ? { requestId: event.payload.requestId } : {}),
      selectionId: event.payload.selectionId,
      ...(typeof event.payload.selectionSummary === 'string' ? { selectionSummary: event.payload.selectionSummary } : {}),
      resolvedAt: event.timestamp,
    };
    state.resolutions.set(event.payload.toolUseId, resolved);
    const inputRequest = state.requests.get(event.payload.toolUseId);
    if (inputRequest && (!resolved.requestId || resolved.requestId === inputRequest.requestId)) {
      inputRequest.status = resolved.selectionId === 'aborted' || resolved.selectionId === 'declined' ? 'aborted' : 'resolved';
      inputRequest.selectionId = resolved.selectionId;
      if (resolved.selectionSummary) inputRequest.selectionSummary = resolved.selectionSummary;
      inputRequest.resolvedAt = resolved.resolvedAt;
      const requestedAt = state.requestedAt.get(event.payload.toolUseId);
      if (requestedAt) inputRequest.waitedMs = (inputRequest.waitedMs ?? 0) + Math.max(0, parseTimestampMs(resolved.resolvedAt) - parseTimestampMs(requestedAt));
    }
    return true;
  }

  return false;
}

function parseSkillName(tool: unknown, input: unknown): string | null {
  if (typeof tool !== 'string') return null;

  const normalizedTool = tool.toLowerCase();
  if (normalizedTool.startsWith('skill.')) return tool.slice('skill.'.length) || null;
  if (normalizedTool !== 'skill') return null;

  const parsedInput = typeof input === 'string' ? safeJsonParse<unknown>(input, null) : input;
  if (!isRecord(parsedInput)) return null;

  const skillName = parsedInput.skill ?? parsedInput.name;
  return typeof skillName === 'string' && skillName ? skillName : null;
}

export function skillNameFromFilePath(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 1].toLowerCase() !== 'skill.md') return null;
  const skillName = parts[parts.length - 2];
  return /[*?[\]{}…$]/.test(skillName) || ['skills', '.system'].includes(skillName.toLowerCase()) ? null : skillName;
}

const READ_TOOL_NAMES = new Set(['read', 'read_file', 'readfile', 'view']);

function skillFilePath(tool: string, input: unknown): string | null {
  if (!READ_TOOL_NAMES.has(tool.toLowerCase())) return null;
  const parsedInput = typeof input === 'string' ? safeJsonParse<unknown>(input, null) : input;
  if (!isRecord(parsedInput)) return null;
  const path = [parsedInput.path, parsedInput.filePath, parsedInput.file_path]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  return path && skillNameFromFilePath(path) ? path : null;
}

export function createCallDisplayMessage(
  message: Omit<ToolCallMessage, 'type'>,
): SkillMessage | ToolCallMessage {
  if (message.inputRequest) return { ...message, type: 'tool_call' };
  const path = skillFilePath(message.tool, message.input);
  const skillName = message.server.toLowerCase() === 'skills'
    ? message.tool
    : path ? skillNameFromFilePath(path) : parseSkillName(message.tool, message.input);
  if (skillName === null) return { ...message, type: 'tool_call' };
  return {
    id: message.id,
    type: 'skill',
    skillName,
    ...(path ? { path } : {}),
    status: message.status,
    timestamp: message.timestamp,
  };
}
export function insertDisplayMessageByTimestamp(
  messages: DisplayMessage[],
  message: DisplayMessage,
): void {
  const messageMs = parseTimestampMs(message.timestamp);
  let index = messages.length;
  while (index > 0 && parseTimestampMs(messages[index - 1].timestamp) > messageMs) index--;
  messages.splice(index, 0, message);
}
