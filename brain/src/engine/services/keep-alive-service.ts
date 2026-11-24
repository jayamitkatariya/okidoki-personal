import type { EngineKeepAliveRequest } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from './monolith-service';

/**
 * Keep-alive pings are driven by agent events (noteActivity) plus an injected
 * check for in-flight work, rather than the foreground turn lifecycle: work
 * that outlives its originating turn — spawned agents, background Bash, wake-up
 * turns — would otherwise stop pinging and get idle-suspended mid-run.
 */
class KeepAliveService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs = 0;
  private activityCheck: (() => boolean) | null = null;
  private static readonly PING_INTERVAL_MS = 5 * 60 * 1000;

  setActivityCheck(check: () => boolean): void {
    this.activityCheck = check;
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  noteActivity(): void {
    this.lastActivityMs = Date.now();
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.tick().catch((error) => {
        console.error('[KeepAlive] Ping failed:', error);
      });
    }, KeepAliveService.PING_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const busy = this.activityCheck?.() ?? false;
    if (!busy && Date.now() - this.lastActivityMs >= KeepAliveService.PING_INTERVAL_MS) {
      if (this.interval) clearInterval(this.interval);
      this.interval = null;
      return;
    }
    await this.ping(busy ? {} : { idleMs: Date.now() - this.lastActivityMs });
  }

  private async ping(body: EngineKeepAliveRequest): Promise<void> {
    if (
      !ENGINE_ENV.OKIDOKI_MONOLITH_URL
      || !ENGINE_ENV.OKIDOKI_ENGINE_SECRET
      || !ENGINE_ENV.OKIDOKI_WORKSPACE_ID
    ) {
      return;
    }

    try {
      const response = await monolithRequest('/v1/engine/keep-alive', { body });
      if (!response.ok) {
        console.warn(`[KeepAlive] Ping returned ${response.status}`);
      }
    } catch (error) {
      console.error('[KeepAlive] Failed to reach monolith:', error);
    }
  }
}

export const keepAliveService = new KeepAliveService();
