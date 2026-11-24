import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_ENV } from '../engine-env';

export async function installWorkspaceSdk(): Promise<void> {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../workspace-sdk');
  const targets = [
    resolve(ENGINE_ENV.HOME_DIR, 'node_modules/@okidoki/sdk'),
    '/tmp/node_modules/@okidoki/sdk',
  ];
  await Promise.all(targets.map(async (target) => {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }));
}
