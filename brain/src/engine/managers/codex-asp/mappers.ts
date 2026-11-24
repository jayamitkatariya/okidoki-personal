import type {
  ChatGoal,
  CodexAspTranscript,
  CodexAspTranscriptItem,
  CodexAspTranscriptPatchOperation,
  CodexAspTranscriptStatus,
  SendChatMessageRequest,
  UserMessageImage,
} from '@okidoki/shared';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_CODEX_MODEL,
  fileContentDiff,
  buildOutputPreview,
  DEFAULT_HOOK_OUTPUT_PREVIEW_CHARS,
  codexReasoningEffortForThinkingLevel,
  detectAgentQuotaLimit,
  normalizeCodexAspTranscriptStatus,
} from '@okidoki/shared';
import type {
  ClientRequest,
  ReasoningEffort,
  v2,
} from '@okidoki/shared/codex-asp-types';
import { getAgentAdditionalDirectories } from '../../utils/agent-additional-directories';
import { inferMediaType, normalizeImages, removeTempImageFiles, saveNormalizedImagesToTempFiles } from '../../utils/image-utils';
import { ENGINE_ENV } from '../../engine-env';
import {
  type CodexRateLimitsSnapshot,
  buildCodexRateLimitsSnapshot,
} from '../../utils/codex-quota';
import { isRecord } from '../../utils/type-guards';
import { MANAGER_INSTRUCTIONS_TAG, SUBAGENT_MCP_SERVER_NAME, splitManagerInstructions } from '@okidoki/shared';
import { subagentCodexMcpConfig } from '../subagent-mcp-config';

const localImageCache = new Map<string, UserMessageImage>();
export const DEFAULT_MODEL = DEFAULT_CODEX_MODEL;
export const THREAD_START_METHOD: Extract<ClientRequest, { method: 'thread/start' }>['method'] = 'thread/start';
export const THREAD_RESUME_METHOD: Extract<ClientRequest, { method: 'thread/resume' }>['method'] = 'thread/resume';
export const THREAD_READ_METHOD: Extract<ClientRequest, { method: 'thread/read' }>['method'] = 'thread/read';
export const THREAD_FORK_METHOD: Extract<ClientRequest, { method: 'thread/fork' }>['method'] = 'thread/fork';
export const THREAD_GOAL_SET_METHOD: Extract<ClientRequest, { method: 'thread/goal/set' }>['method'] = 'thread/goal/set';
export const THREAD_GOAL_GET_METHOD: Extract<ClientRequest, { method: 'thread/goal/get' }>['method'] = 'thread/goal/get';
export const THREAD_GOAL_CLEAR_METHOD: Extract<ClientRequest, { method: 'thread/goal/clear' }>['method'] = 'thread/goal/clear';
export const THREAD_COMPACT_START_METHOD: Extract<ClientRequest, { method: 'thread/compact/start' }>['method'] = 'thread/compact/start';
export const THREAD_INJECT_ITEMS_METHOD: Extract<ClientRequest, { method: 'thread/inject_items' }>['method'] = 'thread/inject_items';
export const THREAD_SETTINGS_UPDATE_METHOD: Extract<ClientRequest, { method: 'thread/settings/update' }>['method'] = 'thread/settings/update';
export const THREAD_BACKGROUND_TERMINALS_CLEAN_METHOD: Extract<ClientRequest, { method: 'thread/backgroundTerminals/clean' }>['method'] = 'thread/backgroundTerminals/clean';
export const TURN_START_METHOD: Extract<ClientRequest, { method: 'turn/start' }>['method'] = 'turn/start';
export const TURN_INTERRUPT_METHOD: Extract<ClientRequest, { method: 'turn/interrupt' }>['method'] = 'turn/interrupt';
export const TURN_STEER_METHOD: Extract<ClientRequest, { method: 'turn/steer' }>['method'] = 'turn/steer';
export const ACCOUNT_RATE_LIMITS_READ_METHOD: Extract<ClientRequest, { method: 'account/rateLimits/read' }>['method'] = 'account/rateLimits/read';
export const MODEL_LIST_METHOD: Extract<ClientRequest, { method: 'model/list' }>['method'] = 'model/list';
export const COLLABORATION_MODE_LIST_METHOD: Extract<ClientRequest, { method: 'collaborationMode/list' }>['method'] = 'collaborationMode/list';
export const SKILLS_LIST_METHOD: Extract<ClientRequest, { method: 'skills/list' }>['method'] = 'skills/list';
export const MAX_CODEX_ASP_TRANSCRIPT_OUTPUT_CHARS = DEFAULT_HOOK_OUTPUT_PREVIEW_CHARS;

export function getReconciledActiveTurnId(error: unknown, expectedTurnId: string): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/expected active turn id ([0-9a-f-]{36}) but found ([0-9a-f-]{36})/i);
  return match?.[1]?.toLowerCase() === expectedTurnId.toLowerCase() ? match[2] ?? null : null;
}

function codexApprovalPolicyOverrides(): Partial<Pick<v2.ThreadStartParams, 'approvalPolicy' | 'approvalsReviewer'>> {
  return {
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
  };
}

export interface TurnInputBuildResult {
  input: v2.UserInput[];
  tempImagePaths: string[];
}

export function toReasoningEffort(
  thinkingLevel: SendChatMessageRequest['thinkingLevel'],
): ReasoningEffort | undefined {
  return codexReasoningEffortForThinkingLevel(thinkingLevel);
}

export function extractRateLimitsSnapshot(
  rateLimits: v2.RateLimitSnapshot,
): CodexRateLimitsSnapshot | null {
  const credits = rateLimits.credits;
  return buildCodexRateLimitsSnapshot({
    authMethod: ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD ?? 'none',
    unlimited: credits?.unlimited ?? null,
    balance: credits?.balance ?? null,
    rateLimitResetType: rateLimits.rateLimitReachedType || null,
    planType: rateLimits.planType,
  });
}

export function timestampFromSeconds(value: number | null): string {
  return new Date((value ?? Date.now() / 1000) * 1000).toISOString();
}

export function timestampFromMilliseconds(value: number | null | undefined): string {
  return new Date(value ?? Date.now()).toISOString();
}

function stringifyToolOutput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return truncateCodexAspTranscriptOutput(value);

  if (typeof value === 'object' && 'content' in value && Array.isArray(value.content)) {
    const text = value.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return truncateCodexAspTranscriptOutput(text);
  }

  try {
    return truncateCodexAspTranscriptOutput(JSON.stringify(value));
  } catch {
    return truncateCodexAspTranscriptOutput(String(value));
  }
}

function stringifyCollabAgentStates(states: Extract<v2.ThreadItem, { type: 'collabAgentToolCall' }>['agentsStates']): string | undefined {
  const entries = Object.entries(states)
    .map(([threadId, state]) => {
      const message = state?.message?.trim();
      return `${threadId}: ${state?.status ?? 'unknown'}${message ? ` - ${message}` : ''}`;
    });
  return entries.length > 0 ? truncateCodexAspTranscriptOutput(entries.join('\n')) : undefined;
}

function codexSubagentTranscriptItem({
  id,
  description,
  prompt,
  receiverThreadIds,
  model,
  output,
  timestamp,
  status,
}: {
  id: string;
  description: string;
  prompt: string;
  receiverThreadIds: string[];
  model?: string;
  output?: string;
  timestamp: string;
  status: CodexAspTranscriptStatus;
}): Extract<CodexAspTranscriptItem, { type: 'subagent' }> {
  return {
    type: 'subagent',
    id,
    description,
    prompt,
    subagentType: 'codex',
    receiverThreadIds,
    ...(model ? { model } : {}),
    ...(output ? { output } : {}),
    timestamp,
    status,
  };
}

export function truncateCodexAspTranscriptOutput(
  output: string,
  maxChars = MAX_CODEX_ASP_TRANSCRIPT_OUTPUT_CHARS,
): string {
  return buildOutputPreview(output, {
    maxChars,
    truncateFrom: 'tail',
    marker: '\n[output truncated: showing tail of output]\n',
  }).output;
}

export function appendCodexAspTranscriptOutput(
  current: string | undefined,
  delta: string,
  maxChars = MAX_CODEX_ASP_TRANSCRIPT_OUTPUT_CHARS,
): string {
  return truncateCodexAspTranscriptOutput(`${current ?? ''}${delta}`, maxChars);
}

function transcriptPatchOperation(
  change: Extract<v2.ThreadItem, { type: 'fileChange' }>['changes'][number],
): CodexAspTranscriptPatchOperation {
  const action = change.kind.type;
  const diff = change.diff.trim().length === 0 ? undefined : action === 'update' ? change.diff : fileContentDiff(change.path, change.diff, action);
  return {
    action,
    path: change.path,
    ...(change.kind.type === 'update' && change.kind.move_path ? { moveTo: change.kind.move_path } : {}),
    ...(diff ? { diff } : {}),
  };
}

function transcriptItemsForTurn(turn: v2.Turn): v2.ThreadItem[] {
  const userItems = turn.items.filter((item) => item.type === 'userMessage');
  const otherItems = turn.items.filter((item) => item.type !== 'userMessage');
  return [...userItems, ...otherItems];
}

function userImageForLocalPath(path: string): UserMessageImage | null {
  const cached = localImageCache.get(path);
  if (cached) return cached;
  if (!existsSync(path)) return null;

  const image: UserMessageImage = {
    type: 'image',
    mediaType: inferMediaType(path),
    data: readFileSync(path).toString('base64'),
  };

  if (image.data.length > 0) localImageCache.set(path, image);
  return image;
}

function userImagesForInput(input: v2.UserInput[]): UserMessageImage[] | undefined {
  const images = input
    .filter((item): item is Extract<v2.UserInput, { type: 'localImage' }> => item.type === 'localImage')
    .map((item) => userImageForLocalPath(item.path))
    .filter((image): image is UserMessageImage => image !== null && image.data.length > 0);

  return images.length > 0 ? images : undefined;
}

export function itemToTranscriptItem(
  item: v2.ThreadItem,
  timestamp: string,
  status: CodexAspTranscriptStatus,
): CodexAspTranscriptItem | null {
  if (item.type === 'userMessage') {
    const content = item.content
      .filter((input): input is Extract<v2.UserInput, { type: 'text' }> => input.type === 'text')
      .map((input) => input.text)
      .join('\n');
    const skillNames = item.content
      .filter((input): input is Extract<v2.UserInput, { type: 'skill' }> => input.type === 'skill')
      .map((input) => input.name)
      .filter((name) => name.trim().length > 0);
    return {
      type: 'userMessage',
      id: item.id,
      content,
      ...(skillNames.length > 0 ? { skillNames } : {}),
      images: userImagesForInput(item.content),
      timestamp,
    };
  }

  if (item.type === 'agentMessage') {
    return {
      type: 'agentMessage',
      id: item.id,
      text: item.text,
      phase: item.phase as 'commentary' | 'final_answer' | null,
      timestamp,
    };
  }

  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      id: item.id,
      text: [...item.summary, ...item.content].filter(Boolean).join('\n').trim(),
      timestamp,
      status,
    };
  }

  if (item.type === 'commandExecution') {
    const exitCode = item.exitCode ?? null;
    return {
      type: 'commandExecution',
      id: item.id,
      command: item.command,
      ...(item.aggregatedOutput ? { output: truncateCodexAspTranscriptOutput(item.aggregatedOutput) } : {}),
      exitCode,
      timestamp,
      status: normalizeCodexAspTranscriptStatus(item.status, typeof exitCode === 'number' && exitCode !== 0),
    };
  }

  if (item.type === 'fileChange') {
    return {
      type: 'fileChange',
      id: item.id,
      operations: item.changes.map(transcriptPatchOperation),
      output: item.status,
      exitCode: item.status === 'completed' ? 0 : 1,
      timestamp,
      status: normalizeCodexAspTranscriptStatus(item.status),
    };
  }

  if (item.type === 'mcpToolCall') {
    return {
      type: 'toolCall',
      id: item.id,
      server: item.server,
      tool: item.tool,
      input: item.arguments,
      output: item.error?.message
        ? truncateCodexAspTranscriptOutput(item.error.message)
        : stringifyToolOutput(item.result),
      timestamp,
      status: normalizeCodexAspTranscriptStatus(item.status, item.status === 'failed'),
    };
  }

  if (item.type === 'dynamicToolCall') {
    if (item.namespace === 'collab' && item.tool === 'wait') {
      return null;
    }

    return {
      type: 'toolCall',
      id: item.id,
      server: item.namespace ?? 'dynamic',
      tool: item.tool,
      input: item.arguments,
      output: stringifyToolOutput(item.contentItems),
      timestamp,
      status: normalizeCodexAspTranscriptStatus(item.status, item.success === false),
    };
  }

  if (item.type === 'collabAgentToolCall') {
    if (item.tool === 'spawnAgent' && item.receiverThreadIds.length > 0) {
      return codexSubagentTranscriptItem({
        id: item.id,
        description: item.receiverThreadIds.length === 1 ? 'Codex subagent' : `Codex subagents (${item.receiverThreadIds.length})`,
        prompt: item.prompt ?? '',
        receiverThreadIds: item.receiverThreadIds,
        model: item.model ?? undefined,
        output: stringifyCollabAgentStates(item.agentsStates),
        timestamp,
        status: normalizeCodexAspTranscriptStatus(item.status, item.status === 'failed'),
      });
    }

    if (item.tool === 'wait') {
      return null;
    }

    return {
      type: 'toolCall',
      id: item.id,
      server: 'collab',
      tool: item.tool,
      input: item.prompt ?? undefined,
      output: stringifyToolOutput(item.agentsStates),
      timestamp,
      status: normalizeCodexAspTranscriptStatus(item.status, item.status === 'failed'),
    };
  }

  if (item.type === 'subAgentActivity' && item.kind === 'started') {
    return codexSubagentTranscriptItem({
      id: item.id,
      description: item.agentPath,
      prompt: '',
      receiverThreadIds: [item.agentThreadId],
      timestamp,
      status,
    });
  }

  if (item.type === 'webSearch') {
    return {
      type: 'webSearch',
      id: item.id,
      query: item.query,
      timestamp,
      status,
    };
  }

  if (item.type === 'plan') {
    return {
      type: 'plan',
      id: item.id,
      text: item.text,
      timestamp,
      status,
    };
  }

  if (item.type === 'contextCompaction') {
    return {
      type: 'contextCompaction',
      id: item.id,
      timestamp,
      status,
    };
  }

  if (item.type === 'imageView' || item.type === 'imageGeneration' || item.type === 'hookPrompt') {
    return null;
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return {
      type: 'reasoning',
      id: item.id,
      text: item.review,
      timestamp,
      status,
    };
  }

  return null;
}

export function aspGoalToChatGoal(goal: v2.ThreadGoal): ChatGoal {
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: timestampFromSeconds(goal.createdAt),
    updatedAt: timestampFromSeconds(goal.updatedAt),
  };
}

export function isQuotaTurnFailure(turn: v2.Turn): boolean {
  const info = turn.error?.codexErrorInfo;
  if (!info) return false;
  if (info === 'usageLimitExceeded') return true;
  if (typeof info === 'object') {
    return Object.values(info).some((detail) => isRecord(detail) && detail.httpStatusCode === 429);
  }
  return false;
}

export function isQuotaErrorMessage(error: unknown): boolean {
  return error instanceof Error && detectAgentQuotaLimit(error.message) !== null;
}

export function formatTurnFailure(turn: v2.Turn): string {
  const turnError = turn.error;
  if (!turnError) {
    return 'Codex ASP turn failed without error details';
  }
  const parts = [`Codex ASP turn failed: ${turnError.message}`];
  if (turnError.codexErrorInfo !== null) {
    parts.push(`codexErrorInfo=${JSON.stringify(turnError.codexErrorInfo)}`);
  }
  if (turnError.additionalDetails) {
    parts.push(`details=${turnError.additionalDetails}`);
  }
  return parts.join(' ');
}

export function threadToAspTranscript(thread: v2.Thread): CodexAspTranscript {
  return turnsToAspTranscript(thread.id, timestampFromSeconds(thread.updatedAt), thread.turns);
}

export function turnsToAspTranscript(
  threadId: string,
  updatedAt: string,
  sourceTurns: v2.Turn[],
): CodexAspTranscript {
  const turns = sourceTurns
    .map((turn, index) => ({ turn, index }))
    .sort((a, b) => (
      (a.turn.startedAt ?? a.turn.completedAt ?? Number.MAX_SAFE_INTEGER)
      - (b.turn.startedAt ?? b.turn.completedAt ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index
    ))
    .map(({ turn }) => {
      const startedAt = timestampFromSeconds(turn.startedAt);
      const completedAt = turn.completedAt === null ? null : timestampFromSeconds(turn.completedAt);
      const itemTimestamp = completedAt ?? startedAt;
      const status = normalizeCodexAspTranscriptStatus(turn.status);
      const items: CodexAspTranscriptItem[] = [];
      for (const item of transcriptItemsForTurn(turn)) {
        const transcriptItem = itemToTranscriptItem(item, item.type === 'userMessage' ? startedAt : itemTimestamp, status);
        if (transcriptItem) {
          items.push(transcriptItem);
        }
      }

      if (turn.error) {
        items.push({
          type: 'error',
          id: `${turn.id}-error`,
          message: formatTurnFailure(turn),
          timestamp: itemTimestamp,
        });
      }

      return {
        id: turn.id,
        status: turn.status,
        startedAt,
        completedAt,
        items,
      };
    });

  return { threadId, updatedAt, turns };
}

export async function buildThreadStartParams(
  workingDirectory: string,
  request: SendChatMessageRequest,
  developerInstructions: string | undefined,
  serviceTier?: string | null,
  subagentMcpParentChatId?: string,
  autoCompactTokens: number | null = null,
  originChatId?: string,
  disableNativeSubagents = false,
): Promise<v2.ThreadStartParams> {
  const additionalDirectories = await getAgentAdditionalDirectories();
  return {
    model: request.model ?? DEFAULT_MODEL,
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    cwd: workingDirectory,
    runtimeWorkspaceRoots: additionalDirectories,
    sandbox: 'danger-full-access',
    ...codexApprovalPolicyOverrides(),
    developerInstructions: developerInstructions ?? null,
    config: {
      web_search: ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD === 'ollama' ? 'disabled' : 'live',
      model_reasoning_summary: 'auto',
      ...(autoCompactTokens ? { model_auto_compact_token_limit: autoCompactTokens } : {}),
      ...(originChatId ? { 'shell_environment_policy.set.OKIDOKI_CHAT_ID': originChatId } : {}),
      ...(disableNativeSubagents || subagentMcpParentChatId ? {
        // Codex gates its native collaboration tools on `agents.enabled`; `features.multi_agent` is now a no-op.
        'agents.enabled': false,
      } : {}),
      ...(subagentMcpParentChatId ? {
        [`mcp_servers.${SUBAGENT_MCP_SERVER_NAME}`]: subagentCodexMcpConfig(subagentMcpParentChatId),
      } : {}),
    },
    experimentalRawEvents: false,
  };
}

export async function buildThreadResumeParams(
  workingDirectory: string,
  threadId: string,
  request: SendChatMessageRequest,
  developerInstructions: string | undefined,
  serviceTier?: string | null,
  subagentMcpParentChatId?: string,
  autoCompactTokens: number | null = null,
  originChatId?: string,
  disableNativeSubagents = false,
): Promise<v2.ThreadResumeParams> {
  const additionalDirectories = await getAgentAdditionalDirectories();
  return {
    threadId,
    model: request.model ?? DEFAULT_MODEL,
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    cwd: workingDirectory,
    runtimeWorkspaceRoots: additionalDirectories,
    sandbox: 'danger-full-access',
    ...codexApprovalPolicyOverrides(),
    developerInstructions: developerInstructions ?? null,
    config: {
      web_search: ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD === 'ollama' ? 'disabled' : 'live',
      model_reasoning_summary: 'auto',
      ...(autoCompactTokens ? { model_auto_compact_token_limit: autoCompactTokens } : {}),
      ...(originChatId ? { 'shell_environment_policy.set.OKIDOKI_CHAT_ID': originChatId } : {}),
      ...(disableNativeSubagents || subagentMcpParentChatId ? {
        // Codex gates its native collaboration tools on `agents.enabled`; `features.multi_agent` is now a no-op.
        'agents.enabled': false,
      } : {}),
      ...(subagentMcpParentChatId ? {
        [`mcp_servers.${SUBAGENT_MCP_SERVER_NAME}`]: subagentCodexMcpConfig(subagentMcpParentChatId),
      } : {}),
    },
    excludeTurns: false,
  };
}

export async function buildTurnInput(
  request: SendChatMessageRequest,
): Promise<TurnInputBuildResult> {
  const input: v2.UserInput[] = [{
    type: 'text',
    text: request.message,
    text_elements: [],
  }];

  if (!request.images || request.images.length === 0) {
    return { input, tempImagePaths: [] };
  }

  const normalizedImages = await normalizeImages(request.images);
  const tempImagePaths = await saveNormalizedImagesToTempFiles(normalizedImages);
  input.push(...tempImagePaths.flatMap((path, index): v2.UserInput[] => {
    const label = normalizedImages[index].label;
    return [...(label ? [{ type: 'text' as const, text: label, text_elements: [] }] : []), { type: 'localImage', path }];
  }));
  return { input, tempImagePaths };
}

export async function buildTurnStartParams(
  threadId: string,
  request: SendChatMessageRequest,
  serviceTier: string | null | undefined,
  unreadRequests: SendChatMessageRequest[],
): Promise<{ params: v2.TurnStartParams; tempImagePaths: string[] }> {
  const effort = toReasoningEffort(request.thinkingLevel);
  const model = request.model ?? DEFAULT_MODEL;
  const built: TurnInputBuildResult[] = [];
  try {
    for (const turn of [...unreadRequests, request]) built.push(await buildTurnInput(turn));
  } catch (error) {
    await removeTempImageFiles(built.flatMap((turn) => turn.tempImagePaths));
    throw error;
  }
  const input = built.flatMap((turn) => turn.input);
  const tempImagePaths = built.flatMap((turn) => turn.tempImagePaths);
  const { managerInstructions } = splitManagerInstructions(request.customInstructions);
  return {
    params: {
      threadId,
      input,
      ...(managerInstructions
        ? { additionalContext: { [MANAGER_INSTRUCTIONS_TAG]: { kind: 'application', value: managerInstructions } } }
        : {}),
      model,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...codexApprovalPolicyOverrides(),
      ...(effort ? { effort } : {}),
      collaborationMode: {
        mode: 'default',
        settings: {
          model,
          reasoning_effort: effort ?? null,
          developer_instructions: null,
        },
      },
    },
    tempImagePaths,
  };
}
