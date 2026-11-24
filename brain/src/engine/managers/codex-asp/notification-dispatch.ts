import type {
  ServerNotification,
  v2,
} from '@okidoki/shared/codex-asp-types';
import type { AspNotification } from './asp-client';

type TurnStartedNotification = Extract<ServerNotification, { method: 'turn/started' }>;
type TurnCompletedNotification = Extract<ServerNotification, { method: 'turn/completed' }>;
type TurnPlanUpdatedNotification = Extract<ServerNotification, { method: 'turn/plan/updated' }>;
type ThreadGoalUpdatedNotification = Extract<ServerNotification, { method: 'thread/goal/updated' }>;
type ThreadGoalClearedNotification = Extract<ServerNotification, { method: 'thread/goal/cleared' }>;
type ItemStartedNotification = Extract<ServerNotification, { method: 'item/started' }>;
type ItemCompletedNotification = Extract<ServerNotification, { method: 'item/completed' }>;
type AgentMessageDeltaNotification = Extract<ServerNotification, { method: 'item/agentMessage/delta' }>;
type ReasoningSummaryTextDeltaNotification = Extract<ServerNotification, { method: 'item/reasoning/summaryTextDelta' }>;
type ReasoningTextDeltaNotification = Extract<ServerNotification, { method: 'item/reasoning/textDelta' }>;
type ReasoningSummaryPartAddedNotification = Extract<ServerNotification, { method: 'item/reasoning/summaryPartAdded' }>;
type CommandExecutionOutputDeltaNotification = Extract<ServerNotification, { method: 'item/commandExecution/outputDelta' }>;
type FileChangeOutputDeltaNotification = Extract<ServerNotification, { method: 'item/fileChange/outputDelta' }>;
type AccountRateLimitsUpdatedNotification = Extract<ServerNotification, { method: 'account/rateLimits/updated' }>;
type ThreadTokenUsageUpdatedNotification = Extract<ServerNotification, { method: 'thread/tokenUsage/updated' }>;
type ContextCompactedNotification = Extract<ServerNotification, { method: 'thread/compacted' }>;
type ModelReroutedNotification = Extract<ServerNotification, { method: 'model/rerouted' }>;
type ThreadStatusChangedNotification = Extract<ServerNotification, { method: 'thread/status/changed' }>;

export const TURN_STARTED_METHOD: TurnStartedNotification['method'] = 'turn/started';
export const TURN_COMPLETED_METHOD: TurnCompletedNotification['method'] = 'turn/completed';
export const TURN_PLAN_UPDATED_METHOD: TurnPlanUpdatedNotification['method'] = 'turn/plan/updated';
export const THREAD_GOAL_UPDATED_METHOD: ThreadGoalUpdatedNotification['method'] = 'thread/goal/updated';
export const THREAD_GOAL_CLEARED_METHOD: ThreadGoalClearedNotification['method'] = 'thread/goal/cleared';
export const ITEM_STARTED_METHOD: ItemStartedNotification['method'] = 'item/started';
export const ITEM_COMPLETED_METHOD: ItemCompletedNotification['method'] = 'item/completed';
export const AGENT_MESSAGE_DELTA_METHOD: AgentMessageDeltaNotification['method'] = 'item/agentMessage/delta';
export const REASONING_SUMMARY_TEXT_DELTA_METHOD: ReasoningSummaryTextDeltaNotification['method'] = 'item/reasoning/summaryTextDelta';
export const REASONING_TEXT_DELTA_METHOD: ReasoningTextDeltaNotification['method'] = 'item/reasoning/textDelta';
export const REASONING_SUMMARY_PART_ADDED_METHOD: ReasoningSummaryPartAddedNotification['method'] = 'item/reasoning/summaryPartAdded';
export const COMMAND_EXECUTION_OUTPUT_DELTA_METHOD: CommandExecutionOutputDeltaNotification['method'] = 'item/commandExecution/outputDelta';
export const FILE_CHANGE_OUTPUT_DELTA_METHOD: FileChangeOutputDeltaNotification['method'] = 'item/fileChange/outputDelta';
export const ACCOUNT_RATE_LIMITS_UPDATED_METHOD: AccountRateLimitsUpdatedNotification['method'] = 'account/rateLimits/updated';
export const THREAD_TOKEN_USAGE_UPDATED_METHOD: ThreadTokenUsageUpdatedNotification['method'] = 'thread/tokenUsage/updated';
export const THREAD_COMPACTED_METHOD: ContextCompactedNotification['method'] = 'thread/compacted';
export const MODEL_REROUTED_METHOD: ModelReroutedNotification['method'] = 'model/rerouted';
export const THREAD_STATUS_CHANGED_METHOD: ThreadStatusChangedNotification['method'] = 'thread/status/changed';

export type AspNotificationHandlers = Partial<{
  [M in AspNotification['method']]: (notification: Extract<AspNotification, { method: M }>) => void;
}>;

export function dispatchAspNotification(
  notification: AspNotification,
  handlers: AspNotificationHandlers,
): void {
  const handler = handlers[notification.method];
  if (!handler) return;
  // Each entry's narrow input type matches its key, so the runtime method
  // lookup picks the right signature — widen once here so the call site stays
  // a single declarative table.
  (handler as (n: AspNotification) => void)(notification);
}

export function recoverCompletedTurn(
  turn: v2.Turn,
  completedItems: v2.ThreadItem[],
  agentMessageDeltas: ReadonlyMap<string, string>,
): v2.Turn {
  const items = turn.items.length > 0 ? [...turn.items] : [];
  const itemIds = new Set(items.map((item) => item.id));

  for (const item of completedItems) {
    if (itemIds.has(item.id)) continue;
    items.push(item);
    itemIds.add(item.id);
  }

  for (const [itemId, text] of agentMessageDeltas) {
    if (itemIds.has(itemId)) continue;
    items.push({ type: 'agentMessage', id: itemId, text, phase: null, memoryCitation: null, delivery: null, questions: null });
  }

  return items.length > 0 ? { ...turn, items, itemsView: 'full' } : turn;
}
