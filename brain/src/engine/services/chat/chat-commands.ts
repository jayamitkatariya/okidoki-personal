import { mkdir, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import {
  integrationErrorNotificationTargetSchema,
  isRecord,
  sendChatMessageRequestSchema,
  sendChatMessageResponseSchema,
  type IntegrationErrorNotificationTarget,
  type SendChatMessageResponse,
} from '@okidoki/shared';
import type { QueuedMessage } from '../message-queue-service';
import { atomicWriteFile } from '../../utils/file';
import { ENGINE_DIR } from './history-paths';

// Its own folder, so nothing that uploads history or log files ever picks a saved request up.
const CHAT_COMMANDS_DIR = join(ENGINE_DIR, 'chat-commands');
// The monolith retries a send for 7 days, and a retry must get the answer the first call got.
const ACCEPTED_RETENTION_MS = 8 * 24 * 60 * 60_000;
const MAX_REMOVED_MESSAGE_IDS = 6000;

interface ChatCommandState {
  queue: QueuedMessage[];
  /** No id when an older engine started the turn. */
  running?: { id?: string; errorNotificationTargets: IntegrationErrorNotificationTarget[] };
  /** The turn a restart cut off, kept until the monolith has been sent it and the next turn has been told of it: a second restart must not forget either. */
  lost?: { errorNotificationTargets: IntegrationErrorNotificationTarget[]; reported?: true; told?: true };
  accepted: Map<string, SendChatMessageResponse & { at: string }>;
  removed: string[];
  /** Removed ids whose history record may not be written yet. */
  removing: string[];
  /** The history's size on disk when `queue` and `removing` were last both empty: the records they imply were written after it, so a restart looks for them from here instead of reading the whole history. */
  checkFrom?: number;
}

const queuedMessageSchema = sendChatMessageRequestSchema.extend({ id: z.string(), queuedAt: z.string() });

const chatCommandStateSchema: z.ZodType<ChatCommandState> = z.object({
  queue: z.array(queuedMessageSchema),
  running: z.object({
    id: z.string().optional(),
    errorNotificationTargets: z.array(integrationErrorNotificationTargetSchema),
  }).optional(),
  lost: z.object({
    errorNotificationTargets: z.array(integrationErrorNotificationTargetSchema),
    reported: z.literal(true).optional(),
    told: z.literal(true).optional(),
  }).optional(),
  accepted: z.record(z.string(), sendChatMessageResponseSchema.extend({ at: z.string() })).transform((accepted) => new Map(Object.entries(accepted))),
  removed: z.array(z.string()),
  removing: z.array(z.string()),
  checkFrom: z.number().optional(),
});

export class ChatCommands {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly chatId: string,
    readonly state: ChatCommandState = { queue: [], accepted: new Map(), removed: [], removing: [] },
  ) {}

  static async load(chatId: string): Promise<ChatCommands | null> {
    const content = await readFile(join(CHAT_COMMANDS_DIR, `${chatId}.json`), 'utf-8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (content === null) return null;
    try {
      const saved: unknown = JSON.parse(content);
      // One entry this engine cannot read (an older engine after a rollback) is dropped alone; the rest of the queue still runs.
      if (isRecord(saved) && Array.isArray(saved.queue)) {
        saved.queue = saved.queue.filter((entry) => {
          const { success, error } = queuedMessageSchema.safeParse(entry);
          if (!success) console.error('[ChatCommands] Dropped an unreadable queued message:', { chatId, error });
          return success;
        });
      }
      return new ChatCommands(chatId, chatCommandStateSchema.parse(saved));
    } catch (error) {
      console.error('[ChatCommands] Unreadable command file, starting empty:', { chatId, error });
      return new ChatCommands(chatId);
    }
  }

  save(): Promise<void> {
    const cutoff = new Date(Date.now() - ACCEPTED_RETENTION_MS).toISOString();
    for (const [key, { at }] of this.state.accepted) {
      if (at < cutoff) this.state.accepted.delete(key);
    }
    this.state.removed.splice(0, this.state.removed.length - MAX_REMOVED_MESSAGE_IDS);
    const data = JSON.stringify({ ...this.state, accepted: Object.fromEntries(this.state.accepted) });
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(CHAT_COMMANDS_DIR, { recursive: true, mode: 0o700 });
      // Flushed: a sandbox paused without its memory keeps only what reached the disk, and this is the only copy of a queued request.
      await atomicWriteFile(join(CHAT_COMMANDS_DIR, `${this.chatId}.json`), data, { mode: 0o600, flush: true });
    });
    return this.writing;
  }

  remove(): Promise<void> {
    this.writing = this.writing.catch(() => {}).then(() => rm(join(CHAT_COMMANDS_DIR, `${this.chatId}.json`), { force: true }));
    return this.writing;
  }
}
