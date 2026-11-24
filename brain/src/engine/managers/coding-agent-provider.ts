import type {
  AgentEvent,
  ChatGoal,
  ChatHistoryPageParams,
  ChatHistoryResponse,
  InterruptChatResponse,
  QueuedMessageInfo,
  QueueMutationResponse,
  SendChatMessageRequest,
  SendChatMessageResponse,
  SlashCommand,
  UpdateChatGoalRequest,
} from '@okidoki/shared';
import type { MessageAcceptedHandler, QueuedMessage } from '../services/message-queue-service';

export interface ProviderForkPoint {
  sessionId: string;
  throughTurn: string;
}

export interface CodingAgentProvider {
  enqueueMessage(
    request: SendChatMessageRequest,
    onAccepted?: MessageAcceptedHandler,
  ): Promise<SendChatMessageResponse>;
  interrupt(persistRemoval: (messageIds: string[]) => Promise<void>, requestedStoppedAt?: string): Promise<InterruptChatResponse>;
  clearGoal?(model?: string): Promise<ChatGoal | null>;
  updateGoal?(request: UpdateChatGoalRequest): Promise<ChatGoal | null>;
  listSlashCommands?(): Promise<SlashCommand[]>;
  getHistory(page?: ChatHistoryPageParams): Promise<ChatHistoryResponse>;
  isProcessing(): boolean;
  hasActiveBackgroundTasks?(): boolean;
  /**
   * True when the agent is paused on an interactive tool call (e.g. a
   * question or tool approval) waiting for the user to choose an option.
   * Implies `isProcessing()` is also true.
   */
  isAwaitingInput?(): boolean;
  isAuthRetrying?(): boolean;
  mayBeReconnecting?(): boolean;
  getGoal?(): ChatGoal | null;
  getQueue(): QueuedMessageInfo[];
  queuedRequests(): Promise<QueuedMessage[]>;
  restoreQueue(messages: QueuedMessage[]): void;
  removeFromQueue(messageId: string, persistRemoval: () => Promise<void>): Promise<boolean>;
  clearQueue(persistRemoval: (messageIds: string[]) => Promise<void>): Promise<boolean>;
  updateQueuedMessage(messageId: string, message: string): boolean;
  reorderQueue(messageId: string, newPosition: number): boolean;
  /** Providers that can't steer report `success: false` so the caller keeps the message queued. */
  steerFromQueue(messageId: string): Promise<QueueMutationResponse>;
  sendNow(messageId: string): Promise<QueueMutationResponse>;
  respondToToolInput?(requestId: string, selectionId: string): Promise<boolean>;
  reportsOwnStop?(event: AgentEvent): boolean;
  forkPoint?(beforeMessageId?: string): Promise<ProviderForkPoint | null>;
  forkFrom?(point: ProviderForkPoint): Promise<void>;
  /**
   * Called when the chat is deleted or sits idle. Implement only if the provider holds process-level resources to
   * release, and leave the provider able to resume the session on its next message (a deleted chat can be restored).
   */
  dispose?(): void | Promise<void>;
}
