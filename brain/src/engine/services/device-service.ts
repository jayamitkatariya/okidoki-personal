import { readdirSync } from 'fs';
import { mkdir, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { DEVICE_SCREEN_FILE_SUFFIX, DEVICES_DIR as DEVICES_HOME_DIR, LOCAL_CONTROL_FILE_PREFIX, type DeviceScreenCredentials, type ProvisionedDevice } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { execFileAsync } from '../utils/exec';
import { startDeviceRelays } from './device-relay';

// Included by /etc/ssh/ssh_config.d/okidoki-devices.conf in the sandbox image.
const DEVICES_DIR = join(ENGINE_ENV.HOME_DIR, DEVICES_HOME_DIR);
const TAILSCALED_UNIT = 'okidoki-tailscaled';

const relayPaths = {
  socket: (name: string) => join(DEVICES_DIR, `${name}.sock`),
  knownHosts: (name: string) => join(DEVICES_DIR, `${name}.known_hosts`),
};

function sshConfig(devices: ProvisionedDevice[], tailnet: boolean): string {
  return devices.map((device) => [
    `Host ${device.name}`,
    `  User ${device.username}`,
    `  IdentityFile ${join(DEVICES_DIR, device.name)}`,
    '  IdentitiesOnly yes',
    '  ServerAliveInterval 30',
    ...(device.host === null
      ? [
        `  ProxyCommand websocat -b - unix:${relayPaths.socket(device.name)}`,
        // Anyone holding the device's token could answer through the relay, so only the identity the device pinned is trusted.
        `  UserKnownHostsFile ${relayPaths.knownHosts(device.name)}`,
        '  StrictHostKeyChecking yes',
      ]
      : [
        `  HostName ${device.host}`,
        `  Port ${device.port}`,
        '  StrictHostKeyChecking accept-new',
        // Userspace networking leaves the sandbox's routes and DNS alone, so tailnet names resolve through tailscaled.
        ...(tailnet ? ['  ProxyCommand tailscale nc %h %p'] : []),
      ]),
  ].join('\n')).join('\n\n') + '\n';
}

async function joinTailnet(authKey: string, workspaceId: string, signal: AbortSignal): Promise<void> {
  const running = await execFileAsync('systemctl', ['is-active', '--quiet', TAILSCALED_UNIT]).then(() => true, () => false);
  if (!running) {
    // A transient unit outlives engine restarts and needs no unit file in the image.
    await execFileAsync('sudo', ['systemd-run', `--unit=${TAILSCALED_UNIT}`, '--collect', '--property=Restart=on-failure',
      '/usr/local/bin/tailscaled', '--tun=userspace-networking', '--state=mem:', '--statedir=/run/tailscale'], { signal });
  }
  // Idempotent: a node that is still signed in keeps its identity, one removed while the workspace slept signs in again.
  await execFileAsync('sudo', ['tailscale', 'up', `--auth-key=${authKey}`, `--hostname=okidoki-${workspaceId.slice(0, 8)}`,
    '--operator=user', '--accept-dns=false', '--timeout=60s'], { signal });
}

export async function connectDevices(signal: AbortSignal): Promise<void> {
  const { OKIDOKI_ENV_DEVICES: devices, TS_AUTHKEY: authKey, OKIDOKI_WORKSPACE_ID: workspaceId } = ENGINE_ENV;
  // The desktop app's local control files are its own, written over its SSH link at any time.
  const stale = (await readdir(DEVICES_DIR).catch(() => [])).filter((entry) => !entry.startsWith(LOCAL_CONTROL_FILE_PREFIX));
  await Promise.all(stale.map((entry) => rm(join(DEVICES_DIR, entry), { recursive: true, force: true })));
  const tailnetKey = devices.some((device) => device.host !== null) ? authKey : undefined;
  // A sandbox resumed from a pause still runs the tailscaled it had when it had devices.
  if (!tailnetKey) await execFileAsync('sudo', ['systemctl', 'stop', TAILSCALED_UNIT], { signal }).catch(() => undefined);
  if (devices.length === 0) return;
  await mkdir(DEVICES_DIR, { recursive: true, mode: 0o700 });
  await Promise.all(devices.flatMap((device) => [
    writeFile(join(DEVICES_DIR, device.name), device.private_key, { mode: 0o600 }),
    ...(device.screen_password === undefined ? [] : [writeFile(
      join(DEVICES_DIR, `${device.name}${DEVICE_SCREEN_FILE_SUFFIX}`),
      JSON.stringify({ username: device.username, password: device.screen_password } satisfies DeviceScreenCredentials),
      { mode: 0o600 },
    )]),
  ]));
  await writeFile(join(DEVICES_DIR, 'devices.conf'), sshConfig(devices, tailnetKey !== undefined), { mode: 0o600 });
  await startDeviceRelays(devices.flatMap((device) => device.host === null ? [device.name] : []), relayPaths, signal);
  if (tailnetKey && workspaceId) await joinTailnet(tailnetKey, workspaceId, signal);
}

export function localControlComputers(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(DEVICES_DIR);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => entry.startsWith(LOCAL_CONTROL_FILE_PREFIX) && entry.endsWith('.conf') ? [entry.slice(LOCAL_CONTROL_FILE_PREFIX.length, -'.conf'.length)] : []);
}
