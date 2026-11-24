/** Serializes async operations onto one chain; a failing operation is isolated to its caller and never breaks the chain for later ones. */
export class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.chain;
  }
}
