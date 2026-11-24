import { readFile } from 'node:fs/promises';
import { InFlightMap, MAX_PENDING_RESOURCE_MINUTES, withTimeout, type SandboxMemorySample, type SandboxResourceMinute } from '@okidoki/shared';

const SAMPLE_INTERVAL_MS = 5_000;

interface Sample {
  cpuCount: number;
  memoryTotalMb: number;
  busyCpus: number;
  stealCpus: number;
  usedMb: number;
  cacheMb: number;
  availableMb: number;
  pressure: Pressure;
}

interface Pressure {
  cpuSome: number | null;
  cpuFull: number | null;
  memorySome: number | null;
  memoryFull: number | null;
  ioSome: number | null;
  ioFull: number | null;
}

interface OomCounters {
  vmstat: number | null;
  cgroup: number | null;
}

const READ_TIMEOUT_MS = 2_000;

const pendingReads = new InFlightMap<string, string>();
const boundedReads = new WeakMap<Promise<string>, Promise<string>>();

// A stuck read holds a libuv thread, so it is shared until it settles (retries would drain the pool) and so is its timeout, so samples don't pile listeners onto it.
function readWithin(path: string): Promise<string> {
  const read = pendingReads.run(path, () => readFile(path, 'utf8'));
  const bounded = boundedReads.get(read) ?? withTimeout(read, READ_TIMEOUT_MS, `Timed out reading ${path}`);
  boundedReads.set(read, bounded);
  return bounded;
}
const readOptional = (path: string) => readWithin(path).catch(() => null);

function parseCounters(text: string | null): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const line of text?.split('\n') ?? []) {
    const [key, value] = line.split(/:?\s+/);
    if (key && value) counters[key] = Number(value);
  }
  return counters;
}

function parsePressure(text: string | null, kind: 'some' | 'full'): number | null {
  const match = text?.match(new RegExp(`^${kind} avg10=([\\d.]+)`, 'm'));
  return match ? Number(match[1]) : null;
}

// Hosts of the same size can run work up to 2x slower without it showing as steal, so a fixed piece of work is timed instead.
let probeState = 1;
function cpuProbeMs(): number {
  const start = performance.now();
  for (let i = 0; i < 1_000_000; i++) probeState = (Math.imul(probeState, 1_103_515_245) + 12_345) >>> 0;
  return performance.now() - start;
}

const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function maxPressure(samples: Sample[], key: keyof Pressure): number | null {
  const values = samples.map((sample) => sample.pressure[key]).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private previousCpu: { busy: number; steal: number; total: number } | null = null;
  private oomBaseline: Promise<OomCounters> | null = null;
  private minute: { start: number; samples: Sample[]; probeMs: number } | null = null;
  private pending: SandboxResourceMinute[] = [];
  onMemorySample: ((sample: SandboxMemorySample) => void) | null = null;
  private readonly cgroupEventsPath = readOptional('/proc/self/cgroup')
    .then((text) => text?.match(/^0::(.*)$/m)?.[1])
    .then((path) => (path ? `/sys/fs/cgroup${path.replace(/\/$/, '')}/memory.events` : null));

  start(): void {
    if (this.timer) return;
    this.oomBaseline = this.readOomCounters();
    void this.sample();
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.previousCpu = null;
    if (this.minute) void this.finishMinute(this.minute);
    this.minute = null;
  }

  pendingMinutes(): SandboxResourceMinute[] {
    return [...this.pending];
  }

  acknowledge(sent: SandboxResourceMinute[]): void {
    const last = sent.at(-1)?.minute;
    if (last) this.pending = this.pending.filter((minute) => minute.minute > last);
  }

  private async readOomCounters(): Promise<OomCounters> {
    const eventsPath = await this.cgroupEventsPath;
    const [vmstat, events] = await Promise.all([readOptional('/proc/vmstat'), eventsPath ? readOptional(eventsPath) : null]);
    return {
      vmstat: vmstat === null ? null : parseCounters(vmstat).oom_kill ?? 0,
      cgroup: eventsPath && events === null ? null : parseCounters(events).oom_kill ?? 0,
    };
  }

  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [stat, meminfo, cpuPressure, memoryPressure, ioPressure] = await Promise.all([
        readWithin('/proc/stat'),
        readWithin('/proc/meminfo'),
        readOptional('/proc/pressure/cpu'),
        readOptional('/proc/pressure/memory'),
        readOptional('/proc/pressure/io'),
      ]);
      if (!this.timer) return;

      const lines = stat.split('\n');
      const jiffies = lines[0].trim().split(/\s+/).slice(1, 9).map(Number);
      const total = jiffies.reduce((sum, value) => sum + value, 0);
      const cpu = { busy: total - jiffies[3] - jiffies[4], steal: jiffies[7], total };
      const previous = this.previousCpu;
      this.previousCpu = cpu;
      if (!previous || cpu.total <= previous.total) return;

      const cpuCount = lines.filter((line) => /^cpu\d/.test(line)).length;
      const memory = parseCounters(meminfo);
      const cacheKb = memory.Buffers + memory.Cached + (memory.SReclaimable ?? 0);
      const sample: Sample = {
        cpuCount,
        memoryTotalMb: memory.MemTotal / 1024,
        busyCpus: ((cpu.busy - previous.busy) / (cpu.total - previous.total)) * cpuCount,
        stealCpus: ((cpu.steal - previous.steal) / (cpu.total - previous.total)) * cpuCount,
        usedMb: (memory.MemTotal - memory.MemFree - cacheKb) / 1024,
        cacheMb: cacheKb / 1024,
        availableMb: memory.MemAvailable / 1024,
        pressure: {
          cpuSome: parsePressure(cpuPressure, 'some'),
          cpuFull: parsePressure(cpuPressure, 'full'),
          memorySome: parsePressure(memoryPressure, 'some'),
          memoryFull: parsePressure(memoryPressure, 'full'),
          ioSome: parsePressure(ioPressure, 'some'),
          ioFull: parsePressure(ioPressure, 'full'),
        },
      };

      const start = Math.floor(Date.now() / 60_000) * 60_000;
      if (this.minute && this.minute.start !== start) {
        const finished = this.minute;
        this.minute = null;
        await this.finishMinute(finished);
      }
      this.minute ??= { start, samples: [], probeMs: cpuProbeMs() };
      this.minute.samples.push(sample);
      this.onMemorySample?.({
        at: new Date().toISOString(),
        memoryTotalMb: round(sample.memoryTotalMb),
        memoryUsedMb: round(sample.usedMb),
        memoryPressureSome: sample.pressure.memorySome,
      });
    } catch (error) {
      console.warn('[ResourceMonitor] Sample failed:', error);
    } finally {
      this.sampling = false;
    }
  }

  private async finishMinute({ start, samples, probeMs }: { start: number; samples: Sample[]; probeMs: number }): Promise<void> {
    const previous = this.oomBaseline;
    const counters = this.readOomCounters();
    // A failed read keeps the last good count, so the next good read doesn't count earlier kills again.
    this.oomBaseline = Promise.all([previous, counters]).then(([before, now]) => ({
      vmstat: now.vmstat ?? before?.vmstat ?? null,
      cgroup: now.cgroup ?? before?.cgroup ?? null,
    }));
    const [baseline, current] = await Promise.all([previous, counters]);
    const killed = (key: keyof OomCounters) => {
      const before = baseline?.[key];
      const now = current[key];
      return before === null || before === undefined || now === null ? 0 : now - before;
    };
    const latest = samples[samples.length - 1];
    this.pending.push({
      minute: new Date(start).toISOString(),
      samples: samples.length,
      cpuCount: latest.cpuCount,
      memoryTotalMb: round(latest.memoryTotalMb),
      cpuBusyAvg: round(average(samples.map((sample) => sample.busyCpus)), 2),
      cpuBusyMax: round(Math.max(...samples.map((sample) => sample.busyCpus)), 2),
      memoryUsedAvgMb: round(average(samples.map((sample) => sample.usedMb))),
      memoryUsedMaxMb: round(Math.max(...samples.map((sample) => sample.usedMb))),
      memoryCacheAvgMb: round(average(samples.map((sample) => sample.cacheMb))),
      memoryAvailableMinMb: round(Math.min(...samples.map((sample) => sample.availableMb))),
      cpuPressureSomeMax: maxPressure(samples, 'cpuSome'),
      cpuPressureFullMax: maxPressure(samples, 'cpuFull'),
      memoryPressureSomeMax: maxPressure(samples, 'memorySome'),
      memoryPressureFullMax: maxPressure(samples, 'memoryFull'),
      ioPressureSomeMax: maxPressure(samples, 'ioSome'),
      ioPressureFullMax: maxPressure(samples, 'ioFull'),
      // /proc/vmstat counts every kill in a VM; the cgroup counter covers sandboxes where /proc shows the host.
      oomKills: Math.max(killed('vmstat'), killed('cgroup'), 0),
      cpuStealAvg: round(average(samples.map((sample) => sample.stealCpus)), 2),
      cpuProbeMs: round(probeMs, 2),
    });
    if (this.pending.length > MAX_PENDING_RESOURCE_MINUTES) this.pending.splice(0, this.pending.length - MAX_PENDING_RESOURCE_MINUTES);
  }
}

export const resourceMonitor = new ResourceMonitor();
