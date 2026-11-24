import type { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { parseProxyRouteCheck, proxyRouteCheckScript, type ProxyRouteCheck } from '@okidoki/shared';
import { execFileAsync } from '../utils/exec';

let proxyAddress: string | null = null;

const ipv4 = (address: string | undefined) => address?.replace(/^::ffff:/, '');

/** Connections arriving on eth0 come from the provider's proxy. */
export function recordProxyConnection(socket: Socket): void {
  const eth0 = networkInterfaces().eth0?.find((entry) => entry.family === 'IPv4')?.address;
  if (eth0 && ipv4(socket.localAddress) === eth0) proxyAddress = ipv4(socket.remoteAddress) ?? proxyAddress;
}

export function checkProxyRoute(): Promise<ProxyRouteCheck | undefined> {
  return execFileAsync('sh', ['-c', proxyRouteCheckScript(proxyAddress)], { timeout: 10_000 })
    .then(({ stdout }) => parseProxyRouteCheck(stdout), () => undefined);
}
