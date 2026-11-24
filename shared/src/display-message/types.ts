import type { ChatHistoryOmittedBody, CodexAspTranscriptPatchOperation, CodexAspTranscriptStatus, UserMessageImage } from '../engine/v1';
import type { AgentEvent, AuthFallbackPayload, ChatInterruptedPayload, CodexQuotaState, ModelRefusalFallback } from '../event';
import type { AgentProvider, ThinkingLevel } from '../agent';
import type { AgentFallbackReason } from '../agent-quota';
import type { ManagerEvent } from '../manager-events';
import type { MessageOrigin } from '../message-origin';
import { isRecord } from '../type-guards';
import type { ChatMessageRefusedRowCode } from '../types';
import type { AppshotAttachment, MessageAnnotation, parseVideoSizes, WalkthroughAttachment } from '../user-message-attachments';

export type Status = CodexAspTranscriptStatus;
export type { UserMessageImage } from '../engine/v1';

// Discriminated union for different message types
export type DisplayMessage =
  | UserMessage
  | AgentMessage
  | ReasoningMessage
  | CommandMessage
  | FileChangeMessage
  | PatchMessage
  | ToolCallMessage
  | WebSearchMessage
  | TodoListMessage
  | SkillMessage
  | SubagentMessage
  | BackgroundTaskMessage
  | PeerMessage
  | ErrorMessage
  | InterruptionMessage
  | QuotaStatusMessage
  | AuthFallbackMessage
  | ModelFallbackMessage
  | HarnessSwitchMessage
  | ManagerEventNoticeMessage
  | CapacityRetryMessage;

export type MessageType = DisplayMessage['type'];

export const RUN_STEP_TYPES = ['agent', 'reasoning', 'command', 'file_change', 'patch', 'tool_call', 'web_search', 'todo_list', 'skill', 'subagent'] as const satisfies readonly MessageType[];

export type RunStep = Extract<DisplayMessage, { type: (typeof RUN_STEP_TYPES)[number] }>;

export interface UserMessage {
  id: string;
  type: 'user';
  content: string;
  images?: UserMessageImage[];
  files?: string[];
  videoSizes?: ReturnType<typeof parseVideoSizes>;
  walkthroughs?: WalkthroughAttachment[];
  annotations?: MessageAnnotation[];
  appshots?: AppshotAttachment[];
  timestamp: string;
  senderUserId?: string;
  senderEmail?: string;
  senderDisplayName?: string;
  senderAvatarUrl?: string;
  origin?: MessageOrigin;
  cancelled?: boolean;
}

interface RunEnd {
  // The agent's run ended on this message, so any later work without a user message is a run of its own.
  endsTurn?: boolean;
}

export interface AgentMessage extends RunEnd {
  id: string;
  type: 'agent';
  content: string;
  timestamp: string;
  isPlan?: boolean;
  // Codex stamps an answer when it starts streaming, so the turn's end comes from when the run finished.
  completedAt?: string;
}

export interface ReasoningMessage extends RunEnd {
  id: string;
  type: 'reasoning';
  content: string;
  status?: Status;
  timestamp: string;
  sourceTimestamp?: string;
  completedAt?: string;
}

export interface CommandMessage extends RunEnd {
  id: string;
  type: 'command';
  command: string;
  description?: string;
  skillNames?: string[];
  output?: string;
  outputOmitted?: ChatHistoryOmittedBody;
  exitCode?: number;
  status?: Status;
  timestamp: string;
}

export interface FileChangeMessage extends RunEnd {
  id: string;
  type: 'file_change';
  changes: Array<{
    path: string;
    kind: 'add' | 'delete' | 'update';
  }>;
  status?: Status;
  timestamp: string;
}

export interface PatchMessage extends RunEnd {
  id: string;
  type: 'patch';
  operations: CodexAspTranscriptPatchOperation[];
  output?: string;
  exitCode?: number;
  status?: Status;
  timestamp: string;
}

export type ToolInputRequestStatus = 'pending' | 'resolved' | 'aborted';

export interface ToolInputOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
  variant?: 'primary' | 'secondary';
}

export interface ToolInputQuestion {
  id: string;
  prompt: string;
  multiSelect: boolean;
  allowCustom?: boolean;
  options: ToolInputOption[];
}

export type ToolInputAnswers = Record<string, { options: string[] } | { custom: string }>;

export interface ToolInputRequest {
  requestId: string;
  status: ToolInputRequestStatus;
  options?: ToolInputOption[];
  questions?: ToolInputQuestion[];
  selectionId?: string;
  selectionSummary?: string;
  resolvedAt?: string;
  waitedMs?: number;
}

export interface ToolCallMessage extends RunEnd {
  id: string;
  type: 'tool_call';
  server: string;
  tool: string;
  input?: Record<string, unknown> | string;
  output?: string;
  outputOmitted?: ChatHistoryOmittedBody;
  images?: UserMessageImage[];
  status?: Status;
  timestamp: string;
  inputRequest?: ToolInputRequest;
}

export interface WebSearchMessage extends RunEnd {
  id: string;
  type: 'web_search';
  query: string;
  status?: Status;
  timestamp: string;
}

export type TodoItemStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoListMessage extends RunEnd {
  id: string;
  type: 'todo_list';
  items: Array<{
    text: string;
    completed: boolean;
    itemStatus?: TodoItemStatus;
  }>;
  status?: Status;
  timestamp: string;
}

export interface SkillMessage extends RunEnd {
  id: string;
  type: 'skill';
  skillName: string;
  path?: string;
  args?: string;
  status?: Status;
  timestamp: string;
}

export interface SubagentMessage extends RunEnd {
  id: string;
  type: 'subagent';
  toolUseId: string;
  description: string;
  prompt: string;
  subagentType: string;
  receiverThreadIds?: string[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  status?: Status;
  output?: string;
  outputOmitted?: ChatHistoryOmittedBody;
  nestedEvents: AgentEvent[];
  timestamp: string;
}

export type BackgroundTaskStatus = 'in_progress' | 'completed' | 'failed' | 'stopped';
export type BackgroundTaskSubtype = 'task_started' | 'task_progress' | 'task_updated' | 'task_notification';

export interface BackgroundTaskUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface WorkflowAgentProgress {
  agentId: string;
  label: string;
  model?: string;
  state?: string;
  promptPreview?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

export interface BackgroundTaskPayload {
  subtype: BackgroundTaskSubtype;
  taskId: string;
  toolUseId?: string;
  subagentType?: string;
  isBackgrounded?: boolean;
  description?: string;
  summary?: string;
  outputFile?: string;
  status?: string;
  taskType?: string;
  workflowName?: string;
  prompt?: string;
  lastToolName?: string;
  usage?: BackgroundTaskUsage;
  /** CLI housekeeping (skip_transcript tasks, auto-started watchers); not user work. */
  ambient?: boolean;
  workflowAgents?: WorkflowAgentProgress[];
  patch?: {
    status?: string;
    description?: string;
    error?: string;
    isBackgrounded?: boolean;
  };
}

const BACKGROUND_TASK_SUBTYPES: ReadonlySet<string> = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

function isBackgroundTaskSubtype(subtype: unknown): subtype is BackgroundTaskSubtype {
  return typeof subtype === 'string' && BACKGROUND_TASK_SUBTYPES.has(subtype);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function coerceBackgroundTaskPayload(payload: unknown): BackgroundTaskPayload | null {
  if (!isRecord(payload)) return null;

  const subtype = payload.subtype;
  if (!isBackgroundTaskSubtype(subtype)) return null;

  const taskId = payload.task_id;
  if (typeof taskId !== 'string' || !taskId) return null;

  const patch = isRecord(payload.patch)
    ? {
        status: optionalString(payload.patch.status),
        description: optionalString(payload.patch.description),
        error: optionalString(payload.patch.error),
        isBackgrounded: optionalBoolean(payload.patch.is_backgrounded),
      }
    : undefined;

  const usage = isRecord(payload.usage)
    ? {
        totalTokens: optionalNumber(payload.usage.total_tokens),
        toolUses: optionalNumber(payload.usage.tool_uses),
        durationMs: optionalNumber(payload.usage.duration_ms),
      }
    : undefined;

  const workflowAgents = Array.isArray(payload.workflow_progress)
    ? payload.workflow_progress.flatMap((entry): WorkflowAgentProgress[] => {
        if (!isRecord(entry) || entry.type !== 'workflow_agent') return [];
        const agentId = optionalString(entry.agentId);
        const label = optionalString(entry.label);
        if (!agentId || !label) return [];
        return [{
          agentId,
          label,
          model: optionalString(entry.model),
          state: optionalString(entry.state),
          promptPreview: optionalString(entry.promptPreview),
          lastToolSummary: optionalString(entry.lastToolSummary),
          resultPreview: optionalString(entry.resultPreview),
        }];
      })
    : undefined;

  return {
    subtype,
    taskId,
    toolUseId: optionalString(payload.tool_use_id),
    subagentType: optionalString(payload.subagent_type),
    isBackgrounded: optionalBoolean(payload.is_backgrounded),
    description: optionalString(payload.description),
    summary: optionalString(payload.summary),
    outputFile: optionalString(payload.output_file),
    status: optionalString(payload.status),
    taskType: optionalString(payload.task_type),
    workflowName: optionalString(payload.workflow_name),
    prompt: optionalString(payload.prompt),
    lastToolName: optionalString(payload.last_tool_name),
    usage,
    ambient: optionalBoolean(payload.ambient),
    workflowAgents,
    patch,
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function normalizeBackgroundTaskStatus(status: unknown): BackgroundTaskStatus {
  if (status === 'completed' || status === 'failed' || status === 'stopped') {
    return status;
  }
  if (status === 'killed') {
    return 'stopped';
  }
  return 'in_progress';
}

export interface BackgroundTaskMessage {
  id: string;
  type: 'background_task';
  taskId: string;
  toolUseId?: string;
  subagentType?: string;
  command?: string;
  status: BackgroundTaskStatus;
  description?: string;
  summary?: string;
  outputFile?: string;
  taskType?: string;
  workflowName?: string;
  prompt?: string;
  lastToolName?: string;
  usage?: BackgroundTaskUsage;
  error?: string;
  isBackgrounded?: boolean;
  notifiedAt?: string;
  timestamp: string;
}

export interface PeerMessage {
  id: string;
  type: 'peer_message';
  direction: 'received' | 'sent';
  chat?: string;
  content: string;
  status?: Status;
  timestamp: string;
}

export interface ErrorMessage {
  id: string;
  type: 'error';
  message: string;
  /** Of the notice under a refused copy: the id its message was sent under, which is not the copy's own when the message was taken back. */
  rejectedMessageId?: string;
  /** Of the notice under a refused row, when the server that wrote it gave its code: a taken-back message's, or, for a row that keeps its message's id, may-have-run or the code of a message the server gave up on. */
  rejectedCode?: ChatMessageRefusedRowCode;
  timestamp: string;
}

export interface CapacityRetryMessage {
  id: string;
  type: 'capacity_retry';
  attempt: number;
  maxAttempts: number;
  reason?: string;
  status: Status;
  timestamp: string;
}

export interface InterruptionMessage extends ChatInterruptedPayload {
  id: string;
  type: 'interruption';
  durationMs?: number;
  timestamp: string;
}

export interface AuthFallbackMessage extends AuthFallbackPayload {
  id: string;
  type: 'auth_fallback';
  timestamp: string;
}

interface ModelFallbackMessage extends ModelRefusalFallback {
  id: string;
  type: 'model_fallback';
  timestamp: string;
}

export interface HarnessSwitchMessage {
  id: string;
  type: 'harness_switch';
  trigger: 'auto' | 'switch';
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  fromModel?: string;
  toModel?: string;
  reason?: AgentFallbackReason;
  timestamp: string;
}

export type SwitchNoticeMessage = HarnessSwitchMessage | AuthFallbackMessage | ModelFallbackMessage;

export interface ManagerEventNoticeMessage {
  id: string;
  type: 'multitask_event';
  events: ManagerEvent[];
  timestamp: string;
}

export interface QuotaStatusMessage {
  id: string;
  type: 'quota_status';
  provider: 'codex';
  state: CodexQuotaState;
  balance?: string | null;
  rateLimitResetType?: string | null;
  planType?: string | null;
  timestamp: string;
}
