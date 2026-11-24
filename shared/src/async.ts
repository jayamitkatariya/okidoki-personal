export const TIMEOUT = Symbol('timeout');

/** The abandoned branch's late rejection is swallowed so it can't surface as unhandled. */
export async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    promise.catch(() => {});
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const result = await raceWithTimeout(promise, ms);
  if (result === TIMEOUT) {
    throw new Error(message);
  }
  return result;
}

export function createConcurrencyLimit(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const waiting: (() => void)[] = [];
  let active = 0;
  return async (task) => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
