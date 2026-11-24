/**
 * Message Queue Service
 *
 * Provides a queue mechanism for agent messages. When an agent is busy processing,
 * new messages are queued instead of being rejected. After processing completes,
 * the next message in the queue is automatically processed.
 */

import type { SendChatMessageRequest, SendChatMessageResponse } from '@okidoki/shared';
import { MERGED_MESSAGE_SEPARATOR } from '@okidoki/shared';

export interface QueuedMessage extends SendChatMessageRequest {
  id: string;
  queuedAt: string;
  engineTurn?: boolean;
}

export type MessageAcceptedHandler = (
  response: SendChatMessageResponse,
  acceptedMessage: SendChatMessageRequest,
) => Promise<void>;
export type MessageStartedHandler = (message: QueuedMessage) => Promise<void>;

interface ActiveTurn {
  message: QueuedMessage;
  controller: AbortController;
  /** Set once the agent has the message; a Stop before that withdraws the message instead of ending a turn. */
  delivered: boolean;
  requeueAfter?: string;
}

export class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private messageIdCounter = 0;
  private processMessage: (request: QueuedMessage, signal: AbortSignal) => Promise<void>;
  private onProcessingChanged: (processing: boolean) => void;
  private onMessageStarted: MessageStartedHandler;
  private onQueueChanged: () => void;
  private acceptanceByMessage = new WeakMap<QueuedMessage, Promise<void>>();
  // A withdrawal mark implies the entry was present when its acceptance
  // rejected; intentional removals (remove, clear, drain, steer) can never
  // coincide with it, so recovery only needs this mark plus the cancellation
  // version below.
  private acceptanceWithdrawals = new WeakSet<QueuedMessage>();
  private queueCancellationVersion = 0;
  private activeTurn: ActiveTurn | null = null;
  private readonly stoppedTurns = new WeakSet<AbortSignal>();
  // Held while an idle-path acceptance persists, so nothing else can start a turn before it.
  private starting = false;

  constructor(
    processMessage: (request: QueuedMessage, signal: AbortSignal) => Promise<void>,
    onProcessingChanged: (processing: boolean) => void = () => {},
    onMessageStarted: MessageStartedHandler = async () => {},
    onQueueChanged: () => void = () => {},
  ) {
    this.processMessage = processMessage;
    this.onProcessingChanged = onProcessingChanged;
    this.onMessageStarted = onMessageStarted;
    this.onQueueChanged = onQueueChanged;
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${++this.messageIdCounter}`;
  }

  /**
   * Add a message to the queue or start processing immediately if not busy
   * @returns Object indicating whether the message was queued or started processing
   */
  async enqueue(
    request: Omit<QueuedMessage, 'id' | 'queuedAt'>,
    onAccepted: MessageAcceptedHandler = async () => {},
  ): Promise<SendChatMessageResponse> {
    if (this.processing && this.canMergeIntoTail(request)) {
      const tail = this.queue[this.queue.length - 1];
      const response = {
        queued: true,
        messageId: tail.id,
        position: this.queue.length,
      };
      const cancellationVersion = this.queueCancellationVersion;
      // The tail is mutated only after acceptance persists durably: a failed
      // acceptance must leave it untouched, or an idempotent retry would
      // append the same fragment twice. Prior failures are swallowed so the
      // retry's own acceptance still runs against the unchanged tail.
      const prior = this.acceptanceByMessage.get(tail) ?? Promise.resolve();
      const acceptance = prior.catch(() => {}).then(async () => {
        let acceptedMessage: QueuedMessage;
        while (true) {
          const baseMessage = tail.message;
          acceptedMessage = {
            ...tail,
            message: `${baseMessage}${MERGED_MESSAGE_SEPARATOR}${request.message}`,
            ...(tail.images || request.images?.length
              ? { images: [...(tail.images ?? []), ...(request.images ?? [])] }
              : {}),
          };
          await onAccepted(response, acceptedMessage);
          if (tail.message === baseMessage) break;
        }
        tail.message = acceptedMessage.message;
        if (acceptedMessage.images) tail.images = [...acceptedMessage.images];
        if (
          !this.queue.includes(tail)
          && this.queueCancellationVersion === cancellationVersion
          && this.acceptanceWithdrawals.delete(tail)
        ) {
          this.queue.push(tail);
        }
        this.onQueueChanged();
      });
      this.acceptanceByMessage.set(tail, acceptance);
      await acceptance;
      return response;
    }

    const messageId = request.messageId ?? this.generateMessageId();
    const queuedMessage: QueuedMessage = {
      ...request,
      id: messageId,
      // Providers stamp this id onto the transcript user event so history
      // rendering can pair it with the accepted snapshot by identity.
      messageId,
      queuedAt: request.submittedAt ?? new Date().toISOString(),
    };

    // An engine turn only resumes an idle chat: any turn already running or starting takes over.
    if (queuedMessage.engineTurn && (this.processing || this.starting)) {
      return { queued: false, messageId, position: 0 };
    }

    if (this.processing || this.starting) {
      this.queue.push(queuedMessage);
      this.onQueueChanged();
      const response = {
        queued: true,
        messageId,
        position: this.queue.length,
      };
      // A rejected acceptance must take the entry back out, or an idempotent
      // retry would queue the same message twice.
      const acceptance = onAccepted(response, queuedMessage).catch((error) => {
        const index = this.queue.indexOf(queuedMessage);
        if (index !== -1) {
          this.queue.splice(index, 1);
          this.acceptanceWithdrawals.add(queuedMessage);
          this.onQueueChanged();
        }
        throw error;
      });
      this.acceptanceByMessage.set(queuedMessage, acceptance);
      await acceptance;
      return response;
    }

    const response = {
      queued: false,
      messageId,
      position: 0,
    };
    // The turn exists before its acceptance persists, so a Stop that arrives meanwhile has something to withdraw.
    const turn: ActiveTurn = { message: queuedMessage, controller: new AbortController(), delivered: false };
    this.activeTurn = turn;
    this.starting = true;
    try {
      await onAccepted(response, queuedMessage);
    } catch (error) {
      this.activeTurn = null;
      this.starting = false;
      this.resumeIfIdle();
      throw error;
    }
    this.starting = false;
    if (turn.controller.signal.aborted) {
      this.activeTurn = null;
      this.resumeIfIdle();
      return response;
    }
    this.startProcessing(queuedMessage, turn).catch((error) => {
      console.error('[MessageQueue] Unhandled error in startProcessing:', error);
    });
    return response;
  }

  private canMergeIntoTail(request: SendChatMessageRequest): boolean {
    if (!request.merge || !request.type) return false;
    const tail = this.queue[this.queue.length - 1];
    if (!tail) return false;
    return tail.merge === true && tail.type === request.type;
  }

  private async startProcessing(
    queuedMessage: QueuedMessage,
    turn: ActiveTurn = { message: queuedMessage, controller: new AbortController(), delivered: false },
  ): Promise<void> {
    const { signal } = turn.controller;
    this.activeTurn = turn;
    this.processing = true;
    this.onProcessingChanged(true);
    this.onQueueChanged();

    try {
      while (true) {
        const acceptance = this.acceptanceByMessage.get(queuedMessage);
        if (!acceptance) break;
        await acceptance;
        if (this.acceptanceByMessage.get(queuedMessage) !== acceptance) continue;
        this.acceptanceByMessage.delete(queuedMessage);
        break;
      }
      if (!signal.aborted) {
        if (!queuedMessage.engineTurn) await this.onMessageStarted(queuedMessage);
        await this.processMessage(queuedMessage, signal);
      }
    } catch (error) {
      console.error('[MessageQueue] Error processing message:', error);
    } finally {
      this.activeTurn = null;
      this.processing = false;
      if (turn.requeueAfter && !this.stoppedTurns.has(signal)) {
        this.queue.splice(this.queue.findIndex(({ id }) => id === turn.requeueAfter) + 1, 0, queuedMessage);
      }
      if (this.queue.length === 0) {
        this.onProcessingChanged(false);
        this.onQueueChanged();
      }

      // Process next message in queue
      await this.processNextInQueue();
    }
  }

  private async processNextInQueue(): Promise<void> {
    const nextMessage = this.queue.shift();
    if (nextMessage) {
      await this.startProcessing(nextMessage);
    }
  }

  /**
   * Check if currently processing a message
   */
  isProcessing(): boolean {
    return this.processing;
  }

  drainQueue(): QueuedMessage[] {
    const drained = this.queue;
    this.queueCancellationVersion++;
    this.queue = [];
    this.onQueueChanged();
    return drained;
  }

  /** A turn a Stop has taken stays the active one while it unwinds, so it is not withdrawn or requeued a second time. */
  stoppedTurn(): ActiveTurn | null {
    return this.activeTurn && this.stoppedTurns.has(this.activeTurn.controller.signal) ? this.activeTurn : null;
  }

  cancelActiveTurn(stop = false): ActiveTurn | null {
    const turn = this.activeTurn;
    if (!turn) return null;
    const taken = this.stoppedTurn();
    if (stop) this.stoppedTurns.add(turn.controller.signal);
    turn.controller.abort();
    return taken ? null : turn;
  }

  requeueActiveTurnAfter(messageId: string): { message: QueuedMessage; afterId: string } | null {
    const turn = this.activeTurn;
    if (!turn || turn.delivered || turn.message.engineTurn || this.stoppedTurn()) return null;
    turn.requeueAfter ??= messageId;
    return { message: turn.message, afterId: turn.requeueAfter };
  }

  isStopped(signal: AbortSignal): boolean {
    return this.stoppedTurns.has(signal);
  }

  isRequeued(signal: AbortSignal): boolean {
    return this.activeTurn?.controller.signal === signal && this.activeTurn.requeueAfter !== undefined;
  }

  markDelivered(): void {
    if (this.activeTurn) this.activeTurn.delivered = true;
  }

  /**
   * Get all queued messages (does not include the currently processing message)
   */
  getQueue(): QueuedMessage[] {
    return [...this.queue];
  }

  updateQueuedMessage(messageId: string, message: string): boolean {
    const queuedMessage = this.queue.find((item) => item.id === messageId);
    if (!queuedMessage) return false;
    queuedMessage.message = message;
    this.onQueueChanged();
    return true;
  }

  takeFromQueue(messageId: string): { message: QueuedMessage; index: number } | null {
    const index = this.queue.findIndex((m) => m.id === messageId);
    if (index === -1) return null;
    const [message] = this.queue.splice(index, 1);
    this.onQueueChanged();
    return { message, index };
  }

  restoreToQueue(message: QueuedMessage, index: number): void {
    const clamped = Math.max(0, Math.min(index, this.queue.length));
    this.queue.splice(clamped, 0, message);
    this.onQueueChanged();
  }

  restore(messages: QueuedMessage[]): void {
    this.queue.unshift(...messages);
    this.onQueueChanged();
  }

  resumeIfIdle(): void {
    if (this.processing || this.starting || this.queue.length === 0) return;
    void this.processNextInQueue().catch((error) => {
      console.error('[MessageQueue] Error resuming idle queue:', error);
    });
  }

  /**
   * Move a message to a new position in the queue
   * @returns true if the message was found and moved
   */
  reorderQueue(messageId: string, newPosition: number): boolean {
    const index = this.queue.findIndex((m) => m.id === messageId);
    if (index === -1) return false;

    const clamped = Math.max(0, Math.min(newPosition, this.queue.length - 1));
    if (index === clamped) return true;

    const [item] = this.queue.splice(index, 1);
    this.queue.splice(clamped, 0, item);
    this.onQueueChanged();
    return true;
  }

  /**
   * Reset everything including clearing processing state
   */
  reset(): void {
    this.queueCancellationVersion++;
    this.queue = [];
    this.processing = false;
    this.onQueueChanged();
  }
}
