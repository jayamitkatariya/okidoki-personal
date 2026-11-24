const ITEM_UPDATE_COALESCE_MS = 250;

export class ItemUpdateCoalescer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastFlushAt = new Map<string, number>();

  constructor(
    private readonly flush: (key: string) => void,
    private readonly intervalMs = ITEM_UPDATE_COALESCE_MS,
  ) {}

  schedule(key: string, options: { immediate?: boolean } = {}): void {
    if (this.timers.has(key)) return;
    const elapsed = Date.now() - (this.lastFlushAt.get(key) ?? 0);
    if (options.immediate || elapsed >= this.intervalMs) {
      this.flushNow(key);
      return;
    }
    this.timers.set(key, setTimeout(() => this.flushNow(key), this.intervalMs - elapsed));
  }

  /** Drops a pending flush but keeps when the key last flushed, so the next schedule still waits out the interval. */
  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  flushPending(): void {
    for (const key of [...this.timers.keys()]) this.flushNow(key);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private flushNow(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.lastFlushAt.set(key, Date.now());
    this.flush(key);
  }
}
