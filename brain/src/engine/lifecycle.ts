import { readFileSync, rmSync, writeFileSync } from 'fs';
import type { EngineLifecycleState } from '@okidoki/shared';

// Outlives the engine process and its watchdog: a restart mid-life (crash, OOM, or a
// systemd restart of the whole unit) boots with the park flag the boot unit always passes,
// and this file is what tells it the workspace is still live. Sleep clears it, and /tmp
// means a sandbox created from a pool snapshot starts without one.
const CLAIM_FILE = '/tmp/okidoki-engine.claim';

class EngineLifecycle {
  state: EngineLifecycleState = 'parked';
  workspaceId: string | null = null;
  private activeWaiters: Array<() => void> = [];
  private transitions: Promise<unknown> = Promise.resolve();

  get active(): boolean {
    return this.state === 'active';
  }

  /** The workspace an earlier run of this engine activated for and never slept. */
  get claimedWorkspaceId(): string | null {
    try {
      return readFileSync(CLAIM_FILE, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  claim(workspaceId: string): void {
    this.workspaceId = workspaceId;
    writeFileSync(CLAIM_FILE, workspaceId);
  }

  releaseClaim(): void {
    rmSync(CLAIM_FILE, { force: true });
  }

  set(state: EngineLifecycleState): void {
    this.state = state;
    if (state === 'active') {
      for (const wake of this.activeWaiters.splice(0)) wake();
    }
  }

  waitForActive(timeoutMs: number): Promise<void> {
    if (this.active) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.activeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Overlapping activate/sleep requests apply one after another instead of interleaving. */
  transition<T>(run: () => Promise<T>): Promise<T> {
    const next = this.transitions.then(run, run);
    this.transitions = next.catch(() => undefined);
    return next;
  }
}

export const lifecycle = new EngineLifecycle();
