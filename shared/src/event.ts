import { isAgentFallbackReason, type AgentFallbackReason } from './agent-quota';
import { isValidAgentProvider, type AgentProvider } from './agent';
import { credentialAccountSchema, isAuthMethod, isCredentialScope, type CredentialAccount } from './analytics/types';
import type { AuthMethod, CredentialScope } from './credentials';
import { isRecord } from './type-guards';

export interface AgentEvent {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export const CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE = 'claude-partial-message';

export interface ClaudePartialMessagePayload {
  streamId: string;
  parent_tool_use_id: string | null;
  text?: string;
  thinking?: string;
  /** `command` is only Bash's first line. */
  tool?: { id: string; name: string } & ({ filePath: string } | { command: string });
  status: 'in_progress' | 'completed';
}

export function coerceClaudePartialMessagePayload(payload: Record<string, unknown>): ClaudePartialMessagePayload | null {
  const streamId = payload.streamId;
  if (typeof streamId !== 'string' || !streamId) return null;

  const parentToolUseId = payload.parent_tool_use_id;
  const text = typeof payload.text === 'string' && payload.text ? payload.text : undefined;
  const thinking = typeof payload.thinking === 'string' && payload.thinking ? payload.thinking : undefined;
  const tool = isRecord(payload.tool) && typeof payload.tool.id === 'string' && typeof payload.tool.name === 'string'
    ? typeof payload.tool.filePath === 'string'
      ? { id: payload.tool.id, name: payload.tool.name, filePath: payload.tool.filePath }
      : typeof payload.tool.command === 'string' ? { id: payload.tool.id, name: payload.tool.name, command: payload.tool.command } : undefined
    : undefined;
  if (!text && !thinking && !tool) return null;

  return {
    streamId,
    parent_tool_use_id: typeof parentToolUseId === 'string' ? parentToolUseId : null,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    ...(tool ? { tool } : {}),
    status: payload.status === 'completed' ? 'completed' : 'in_progress',
  };
}

export const ACCEPTED_USER_MESSAGE_SOURCE = 'okidoki-chat-turn-accepted';
export const QUEUED_MESSAGE_REMOVED_EVENT_TYPE = 'okidoki-queued-message-removed';
export const REMOVED_MESSAGE_IDS_PAYLOAD_KEY = 'removedMessageIds';
export const USER_MESSAGE_ID_PAYLOAD_KEY = 'okidokiMessageId';
/** On every record of a message that edits an earlier one: the edited message, which it replaces along with everything after it. */
export const REPLACED_MESSAGE_ID_PAYLOAD_KEY = 'okidokiReplacedMessageId';
export const RESENT_MESSAGE_ID_PAYLOAD_KEY = 'okidokiResentMessageId';
export const DELIVERY_RETRYING_PAYLOAD_KEY = 'okidokiDeliveryRetrying';
export const CODEX_ASP_ITEM_ID_PAYLOAD_KEY = 'codexAspItemId';
/** Legacy Codex history record: a mutable transcript snapshot or delta. Converted to item events on read. */
export const CODEX_ASP_TRANSCRIPT_UPDATED_EVENT_TYPE = 'codex-asp-transcript-updated';
/** One completed Codex item, immutable once written. */
export const CODEX_ITEM_EVENT_TYPE = 'codex-item';
/** The current state of an in-progress Codex item. Streamed, never persisted; replaced by the completed item. */
export const CODEX_ITEM_PARTIAL_EVENT_TYPE = 'codex-item-partial';
/** Emitted only once a turn is terminal; in-progress turns produce no event. */
export const CODEX_TURN_EVENT_TYPE = 'codex-turn';
/** The turn named by `codexAspItemId` failed because the model was at capacity, and the engine is continuing it after a backoff. */
export const CODEX_TURN_RETRY_EVENT_TYPE = 'codex-turn-retry';
/** First record of a Codex history file written in the item-event format. */
export const CODEX_HISTORY_FORMAT_EVENT_TYPE = 'codex-history-format';

/**
 * Successive flushes of one streamed message share a stream id, so a later
 * flush (or the completed record) replaces the earlier one in place.
 */
export function getEventStreamId(event: AgentEvent): string | null {
  if (event.type === CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE) {
    return typeof event.payload.streamId === 'string' && event.payload.streamId
      ? event.payload.streamId
      : null;
  }
  if (event.type === CODEX_ITEM_EVENT_TYPE || event.type === CODEX_ITEM_PARTIAL_EVENT_TYPE) {
    const item = event.payload.item;
    return isRecord(item) && typeof item.id === 'string' ? item.id : null;
  }
  return null;
}

/**
 * Synthetic AgentEvent type emitted by the engine when the Codex backing
 * account changes credit/rate-limit state. Surfaced to the UI as a banner
 * so users see why Codex stopped responding instead of an opaque error.
 */
export const CODEX_QUOTA_STATUS_EVENT_TYPE = 'codex-quota-status';

export const CHAT_INTERRUPTED_EVENT_TYPE = 'okidoki-interrupted';

export interface ChatInterruptedPayload {
  steered?: true;
}

/**
 * Synthetic AgentEvent for a message that was refused or taken back, right after that message's refused copy: an accepted user message with the same text.
 * A copy written for a taken-back message has an id of its own, and the history that carries it lists the message's id in `removedMessageIds`,
 * so a client that still holds the message as sent or queued drops that row and shows the copy alone.
 */
export const CHAT_MESSAGE_REJECTED_EVENT_TYPE = 'okidoki-message-rejected';
/** On that event: the id the refused message was sent under. Not `USER_MESSAGE_ID_PAYLOAD_KEY`: clients merge events that share that id into one. */
export const REJECTED_MESSAGE_ID_PAYLOAD_KEY = 'rejectedMessageId';
/** On that event: the row's `ChatMessageRefusedRowCode`. Absent for a message the engine refused or was never shown, and from servers that wrote none. */
export const REJECTED_CODE_PAYLOAD_KEY = 'rejectedCode';
/** What a taken-back message's refused copy has as its id, in front of the message's own. No client makes such an id. */
export const REFUSED_COPY_MESSAGE_ID_PREFIX = 'refused-copy-';

export const CHAT_TURN_LOST_EVENT_TYPE = 'okidoki-turn-lost';
export const CHAT_TURN_LOST_MESSAGE = "The workspace restarted and cut this turn off. It wasn't retried.";

export const CHAT_GOAL_EVENT_TYPE = 'chat-goal';

/** A message another chat sent this one with Claude Code's SendMessage, which the SDK doesn't stream. */
export const CLAUDE_PEER_MESSAGE_EVENT_TYPE = 'claude-peer-message';

export interface ClaudePeerMessagePayload {
  name?: string;
  /** The sender's address, which a reply may use instead of its name. */
  from?: string;
  body: string;
}

export const AUTH_RETRY_STATUS_EVENT_TYPE = 'auth-retry-status';

export const CURSOR_CONNECTION_STATUS_EVENT_TYPE = 'cursor-connection-status';

/**
 * Synthetic AgentEvent emitted when an agent's credential runs out of quota and
 * the workspace moves itself onto the next credential. Purely a notification:
 * the switch has already happened by the time this is emitted.
 */
export const AUTH_FALLBACK_EVENT_TYPE = 'auth-fallback';

export type AuthFallbackStatus = 'switched' | 'failed';

export interface AuthFallbackPayload {
  provider: AgentProvider;
  reason: AgentFallbackReason;
  exhaustedMethod: AuthMethod;
  exhaustedScope?: CredentialScope;
  exhaustedAccount?: CredentialAccount;
  candidateMethod: AuthMethod;
  candidateScope: CredentialScope;
  candidateAccount?: CredentialAccount;
  status: AuthFallbackStatus;
  detail?: string;
  /** Set when the turn moved to an older model on the same credential, which could not serve `fromModel`. */
  fromModel?: string;
  toModel?: string;
}

export function coerceAuthFallbackPayload(
  payload: Record<string, unknown>,
): AuthFallbackPayload | null {
  const { provider, reason, exhaustedMethod, exhaustedScope, candidateMethod, candidateScope, status, detail, fromModel, toModel } = payload;
  const exhaustedAccount = credentialAccountSchema.safeParse(payload.exhaustedAccount).data;
  const candidateAccount = credentialAccountSchema.safeParse(payload.candidateAccount).data;
  if (
    typeof provider !== 'string' || !isValidAgentProvider(provider)
    || !isAgentFallbackReason(reason)
    || !isAuthMethod(exhaustedMethod)
    || !isAuthMethod(candidateMethod)
    || !isCredentialScope(candidateScope)
    || (status !== 'switched' && status !== 'failed')
  ) {
    return null;
  }

  return {
    provider,
    reason,
    exhaustedMethod,
    ...(isCredentialScope(exhaustedScope) ? { exhaustedScope } : {}),
    ...(exhaustedAccount ? { exhaustedAccount } : {}),
    candidateMethod,
    candidateScope,
    ...(candidateAccount ? { candidateAccount } : {}),
    status,
    ...(typeof detail === 'string' && detail ? { detail } : {}),
    ...(typeof fromModel === 'string' && typeof toModel === 'string' ? { fromModel, toModel } : {}),
  };
}

export interface ModelRefusalFallback {
  fromModel: string;
  toModel: string;
  /** False when only a subagent or side question was retried, so the chat stays on `fromModel`. */
  sessionSwitched: boolean;
}

/** Claude Code retries a reply its safeguards stopped on an older model and keeps the session there. */
export function coerceModelRefusalFallback({ type, payload }: Pick<AgentEvent, 'type' | 'payload'>): ModelRefusalFallback | null {
  const { original_model: fromModel, fallback_model: toModel } = payload;
  if (type !== 'claude-system' || payload.subtype !== 'model_refusal_fallback' || typeof fromModel !== 'string' || typeof toModel !== 'string') return null;
  return { fromModel, toModel, sessionSwitched: payload.scope !== 'local' };
}

export interface CredentialFallbackNotice extends AuthFallbackPayload {
  at: string;
}

export type CodexQuotaState = 'ok' | 'out_of_credits' | 'rate_limited';

export type ChatGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export const CHAT_GOAL_STATUS_LABELS: Record<ChatGoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  usageLimited: 'Usage limited',
  budgetLimited: 'Budget limited',
  complete: 'Complete',
};

export interface ChatGoal {
  threadId: string;
  objective: string;
  status: ChatGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatGoalEventPayload {
  goal: ChatGoal | null;
}

const CHAT_GOAL_STATUSES: readonly ChatGoalStatus[] = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
];

function isChatGoalStatus(value: unknown): value is ChatGoalStatus {
  return typeof value === 'string' && CHAT_GOAL_STATUSES.some((status) => status === value);
}

export function coerceChatGoalPayload(payload: Record<string, unknown>): ChatGoal | null {
  const goal = payload.goal;
  if (goal === null || goal === undefined) return null;
  if (typeof goal !== 'object') return null;
  const candidate = goal as Record<string, unknown>;
  const threadId = candidate.threadId;
  const objective = candidate.objective;
  const status = candidate.status;
  const tokensUsed = candidate.tokensUsed;
  const timeUsedSeconds = candidate.timeUsedSeconds;
  const createdAt = candidate.createdAt;
  const updatedAt = candidate.updatedAt;
  const tokenBudget = candidate.tokenBudget ?? null;
  if (
    typeof threadId !== 'string' ||
    typeof objective !== 'string' ||
    !isChatGoalStatus(status) ||
    typeof tokensUsed !== 'number' ||
    typeof timeUsedSeconds !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    (tokenBudget !== null && typeof tokenBudget !== 'number')
  ) {
    return null;
  }
  return {
    threadId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

export interface CodexTurnRetryPayload {
  attempt: number;
  maxAttempts: number;
  [CODEX_ASP_ITEM_ID_PAYLOAD_KEY]: string;
}

export function parseCodexTurnRetryPayload(payload: Record<string, unknown>): CodexTurnRetryPayload | undefined {
  const { attempt, maxAttempts, [CODEX_ASP_ITEM_ID_PAYLOAD_KEY]: turnId } = payload;
  return typeof attempt === 'number' && typeof maxAttempts === 'number' && typeof turnId === 'string'
    ? { attempt, maxAttempts, [CODEX_ASP_ITEM_ID_PAYLOAD_KEY]: turnId }
    : undefined;
}

export interface CodexQuotaStatusPayload {
  state: CodexQuotaState;
  /** Last reported credit balance (string from the rollout payload). */
  balance?: string | null;
  /** When `state === 'rate_limited'`, the SDK's reset bucket id (e.g. "premium"). */
  rateLimitResetType?: string | null;
  /** Codex `plan_type` field from rollout `rate_limits`. */
  planType?: string | null;
}

/**
 * Synthetic AgentEvent emitted when an agent reports current context-window
 * usage. This is intentionally not a display message; the chat UI renders the
 * latest value as a compact hoverable status pill near the composer controls.
 */
export const CONTEXT_USAGE_EVENT_TYPE = 'context-usage';

export interface ContextUsageCategory {
  name: string;
  tokens: number;
  percentage: number;
}

export interface ContextUsagePayload {
  provider: AgentProvider;
  source: 'claude_context' | 'codex_token_count' | 'claude_usage' | 'provider_usage';
  model?: string | null;
  totalTokens: number;
  maxTokens: number | null;
  rawMaxTokens?: number | null;
  percentage: number;
  /**
   * Whether the provider performs automatic context compaction. When true,
   * the UI can communicate to the user that hitting the limit triggers a
   * summarization step rather than a hard error.
   */
  compactsAutomatically?: boolean;
  /**
   * Percentage of `maxTokens` at which the provider triggers auto-compaction.
   * Surfaced from the Claude Agent SDK's `autoCompactThreshold` so the UI
   * can render an "approaching compaction" warning.
   */
  autoCompactThreshold?: number;
  categories: ContextUsageCategory[];
  updatedAt: string;
}
