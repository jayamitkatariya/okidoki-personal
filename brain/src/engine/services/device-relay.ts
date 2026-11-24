import { createServer, type Server, type Socket } from 'net';
import { writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import WebSocket, { createWebSocketStream } from 'ws';

const DEVICE_WAIT_MS = 20_000;

interface Relay {
  server: Server;
  knownHostsPath: string;
  knownHosts?: string;
  waiting: WebSocket[];
  pending: Array<(device: WebSocket) => void>;
}

const relays = new Map<string, Relay>();

function pipe(local: Socket, device: WebSocket): void {
  device.send('open');
  const stream = createWebSocketStream(device);
  const close = () => {
    local.destroy();
    stream.destroy();
  };
  local.on('error', close).on('close', close);
  stream.on('error', close).on('close', close);
  local.pipe(stream).pipe(local);
}

function remove<T>(list: T[], item: T): void {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
}

function attach(relay: Relay, local: Socket): void {
  const device = relay.waiting.pop();
  if (device) return pipe(local, device);
  const timer = setTimeout(() => local.destroy(), DEVICE_WAIT_MS);
  const take = (next: WebSocket) => {
    clearTimeout(timer);
    pipe(local, next);
  };
  relay.pending.push(take);
  local.once('close', () => {
    clearTimeout(timer);
    remove(relay.pending, take);
  });
}

// Each connection carries the identity the device pinned, which may postdate this workspace's start.
export function acceptDeviceConnection(name: string, device: WebSocket, hostKeys: string[]): void {
  const relay = relays.get(name);
  if (!relay) return device.close(4404, 'This workspace has no such device connecting from itself');
  const knownHosts = hostKeys.map((key) => `${name} ${key}\n`).join('');
  if (knownHosts !== relay.knownHosts) {
    writeFileSync(relay.knownHostsPath, knownHosts, { mode: 0o600 });
    relay.knownHosts = knownHosts;
  }
  const take = relay.pending.shift();
  if (take) return take(device);
  relay.waiting.push(device);
  device.once('close', () => remove(relay.waiting, device));
}

function stopDeviceRelays(): void {
  for (const relay of relays.values()) {
    relay.server.close();
    relay.waiting.forEach((device) => device.terminate());
  }
  relays.clear();
}

export async function startDeviceRelays(names: string[], paths: { socket: (name: string) => string; knownHosts: (name: string) => string }, signal: AbortSignal): Promise<void> {
  stopDeviceRelays();
  signal.addEventListener('abort', stopDeviceRelays, { once: true });
  await Promise.all(names.map(async (name) => {
    await rm(paths.socket(name), { force: true });
    const relay: Relay = { server: createServer((local) => attach(relay, local)), knownHostsPath: paths.knownHosts(name), waiting: [], pending: [] };
    relays.set(name, relay);
    await new Promise<void>((resolve, reject) => relay.server.once('error', reject).listen(paths.socket(name), resolve));
  }));
}
