export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: {
    backoffsMs: readonly number[];
    retryable: (error: unknown) => boolean;
    logPrefix: string;
  },
): Promise<T> {
  const attempts = options.backoffsMs.length + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !options.retryable(error)) {
        throw error;
      }
      const delayMs = options.backoffsMs[attempt - 1] ?? 5_000;
      console.warn(
        `[${options.logPrefix}] ${label}: retryable failure (attempt ${attempt}/${attempts}), retrying in ${delayMs}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
