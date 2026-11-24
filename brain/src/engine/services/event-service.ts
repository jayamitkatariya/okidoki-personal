import { mkdir } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE,
  CODEX_ITEM_PARTIAL_EVENT_TYPE,
  getEventStreamId,
  type EngineEvent,
} from '@okidoki/shared';
import { StreamWriter } from '../utils/stream-writer';
import { ENGINE_DIR } from './chat/history-paths';

const EVENTS_FILE = join(ENGINE_DIR, 'events.jsonl');
const MAX_REPLAY_EVENTS = 2_000;
const MAX_REPLAY_CHARS = 4 * 1024 * 1024;

type Subscriber = (frame: string) => void;

interface ReplayFrame {
  seq: number;
  frame: string;
  partialKey: string | null;
}

function partialKey(event: EngineEvent): string | null {
  if (event.type !== 'chat.turn.delta') return null;
  const { type } = event.payload.event;
  if (type !== CLAUDE_PARTIAL_MESSAGE_EVENT_TYPE && type !== CODEX_ITEM_PARTIAL_EVENT_TYPE) return null;
  const streamId = getEventStreamId(event.payload.event);
  return streamId ? `${event.payload.chatId}:${type}:${streamId}` : null;
}

export class EventService {
  private subscribers = new Set<Subscriber>();
  private writer = new StreamWriter();
  private readonly epoch = randomUUID();
  private seq = 0;
  private replay: ReplayFrame[] = [];
  private replayChars = 0;
  // Newest seq dropped for space: a client that last saw an older seq cannot resume.
  private replayFloor = 0;
  private latestPartials = new Map<string, ReplayFrame>();

  async initialize(): Promise<void> {
    await mkdir(ENGINE_DIR, { recursive: true });
    this.writer.open(EVENTS_FILE);
  }

  subscribe(subscriber: Subscriber, lastEventId?: string): () => void {
    const separator = lastEventId?.lastIndexOf(':') ?? -1;
    const after = lastEventId ? Number(lastEventId.slice(separator + 1)) : Number.NaN;
    const resumed = separator > 0
      && lastEventId?.slice(0, separator) === this.epoch
      && Number.isSafeInteger(after)
      && after >= this.replayFloor
      && after <= this.seq;
    const opened: EngineEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: 'engine.stream.opened',
      payload: { epoch: this.epoch, seq: this.seq, resumed },
    };
    subscriber(`id: ${this.epoch}:${resumed ? after : this.seq}\nevent: ${opened.type}\ndata: ${JSON.stringify(opened)}\n\n`);
    if (resumed) {
      for (const entry of this.replay) {
        if (entry.seq > after) subscriber(entry.frame);
      }
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  async publish(event: EngineEvent): Promise<void> {
    const seq = ++this.seq;
    const data = JSON.stringify({ ...event, seq });
    this.writer.write(data + '\n');
    const entry: ReplayFrame = { seq, frame: `id: ${this.epoch}:${seq}\nevent: ${event.type}\ndata: ${data}\n\n`, partialKey: partialKey(event) };
    this.remember(entry);

    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry.frame);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  // A newer partial carries the whole message so far, so only the latest one per message is replayed.
  private remember(entry: ReplayFrame): void {
    if (entry.partialKey) {
      const superseded = this.latestPartials.get(entry.partialKey);
      if (superseded) {
        const index = this.replay.indexOf(superseded);
        if (index !== -1) {
          this.replay.splice(index, 1);
          this.replayChars -= superseded.frame.length;
        }
      }
      this.latestPartials.set(entry.partialKey, entry);
    }
    this.replay.push(entry);
    this.replayChars += entry.frame.length;
    while (this.replay.length > MAX_REPLAY_EVENTS || (this.replayChars > MAX_REPLAY_CHARS && this.replay.length > 1)) {
      const evicted = this.replay.shift();
      if (!evicted) break;
      this.replayChars -= evicted.frame.length;
      this.replayFloor = evicted.seq;
      if (evicted.partialKey && this.latestPartials.get(evicted.partialKey) === evicted) this.latestPartials.delete(evicted.partialKey);
    }
  }
}

export const eventService = new EventService();
