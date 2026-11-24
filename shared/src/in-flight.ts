// Concurrent callers for the same key share one in-flight promise; the entry
// clears once it settles so subsequent calls start fresh.
export class InFlightMap<K, V> {
  private readonly pending = new Map<K, Promise<V>>();

  run(key: K, producer: () => Promise<V>): Promise<V> {
    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = (async () => producer())().finally(() => {
      if (this.pending.get(key) === promise) {
        this.pending.delete(key);
      }
    });
    this.pending.set(key, promise);
    return promise;
  }

  get(key: K): Promise<V> | undefined {
    return this.pending.get(key);
  }
}
