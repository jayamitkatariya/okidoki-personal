import { createErrorResult, createSuccessResult, type Result } from '@okidoki/shared';
import { monolithRequest } from './services/monolith-service';

export class TokenCache<T, K> {
  private readonly cache = new Map<string, { token: T; refreshAt: number }>();
  private readonly inflight = new Map<string, Promise<Result<T, K>>>();

  constructor(private readonly maxEntries = Infinity) {}

  get(key: string, load: () => Promise<Result<{ token: T; refreshAt: number }, K>>, force = false): Promise<Result<T, K>> {
    const cached = this.cache.get(key);
    if (!force && cached && cached.refreshAt > Date.now()) return Promise.resolve(createSuccessResult(cached.token));
    const inflightKey = force ? `${key}\0force` : key;
    let pending = this.inflight.get(inflightKey);
    if (!pending) {
      pending = load().then((result): Result<T, K> => {
        this.cache.delete(key);
        if (!result.ok) return result;
        const oldest = this.cache.keys().next();
        if (this.cache.size >= this.maxEntries && !oldest.done) this.cache.delete(oldest.value);
        this.cache.set(key, result.data);
        return createSuccessResult(result.data.token);
      }).finally(() => this.inflight.delete(inflightKey));
      this.inflight.set(inflightKey, pending);
    }
    return pending;
  }
}

export async function requestToken(
  request: typeof monolithRequest,
  path: string,
  body: Record<string, unknown>,
  failureMessage: string,
): Promise<Result<Response, 503>> {
  try {
    return createSuccessResult(await request(path, { body }));
  } catch (error) {
    return createErrorResult({ message: error instanceof Error ? error.message : failureMessage, code: 503 });
  }
}
