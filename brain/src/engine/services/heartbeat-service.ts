import { AUTO_SIZE_RULES, TENSORLAKE_IMAGE_NAME, isRecord, needsMoreMemory, type EngineHeartbeatRequest, type SandboxMemorySample } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { monolithRequest } from './monolith-service';
import { resourceMonitor } from './resource-monitor';

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

class HeartbeatService {
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private bootTimeMs: number | null = null;
  private autoSize = false;
  private lastSpikeAt = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 15_000;
  private static readonly REQUEST_TIMEOUT_MS = 5_000;

  start(bootTimeMs: number): void {
    if (!ENGINE_ENV.OKIDOKI_WORKSPACE_ID || this.interval) return;
    this.bootTimeMs = bootTimeMs;
    resourceMonitor.onMemorySample = (sample) => {
      // Minute summaries can arrive after memory has already run out, so an Auto workspace reports a spike as soon as it's sampled.
      if (!this.autoSize || this.inFlight || Date.now() - this.lastSpikeAt < AUTO_SIZE_RULES.SPIKE_INTERVAL_MS) return;
      if (!needsMoreMemory(sample.memoryUsedMb, sample.memoryTotalMb, sample.memoryPressureSome)) return;
      this.lastSpikeAt = Date.now();
      void this.ping(sample);
    };
    resourceMonitor.start();
    void this.ping();
    this.interval = setInterval(() => {
      void this.ping();
    }, HeartbeatService.HEARTBEAT_INTERVAL_MS);
    unrefTimer(this.interval);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    resourceMonitor.stop();
  }

  private async ping(memorySpike?: SandboxMemorySample): Promise<void> {
    if (this.inFlight || !this.bootTimeMs) return;
    this.inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HeartbeatService.REQUEST_TIMEOUT_MS);
    unrefTimer(timeout);

    const resources = resourceMonitor.pendingMinutes();
    try {
      const body: EngineHeartbeatRequest = {
        bootTimeMs: this.bootTimeMs,
        uptimeSeconds: Math.floor((Date.now() - this.bootTimeMs) / 1000),
        status: 'active',
        engineImage: TENSORLAKE_IMAGE_NAME,
        ...(resources.length ? { resources } : {}),
        ...(memorySpike ? { memorySpike } : {}),
      };
      const response = await monolithRequest('/v1/engine/heartbeat', {
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        const reply: unknown = await response.json().catch(() => null);
        if (isRecord(reply) && reply.resourcesRecorded === true) resourceMonitor.acknowledge(resources);
        if (isRecord(reply)) this.autoSize = reply.autoSize === true;
      } else {
        console.warn(`[EngineHeartbeat] Ping returned ${response.status}`);
      }
    } catch (error) {
      console.warn('[EngineHeartbeat] Ping failed:', error);
    } finally {
      clearTimeout(timeout);
      this.inFlight = false;
    }
  }
}

export const heartbeatService = new HeartbeatService();
