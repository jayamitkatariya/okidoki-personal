import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parsePosixEnv } from '@okidoki/shared';

export type RuntimeEnvFile = ReturnType<typeof parsePosixEnv>;

let loadedKeys: string[] = [];

export function readRuntimeEnvFile(): RuntimeEnvFile | null {
  try {
    const stateDir = process.env.OKIDOKI_ENGINE_STATE_DIR ?? join(homedir(), '.okidoki');
    return parsePosixEnv(readFileSync(join(stateDir, 'runtime-env.sh'), 'utf-8'));
  } catch {
    return null;
  }
}

export function loadRuntimeEnvFile(file = readRuntimeEnvFile()): void {
  if (!file) return;
  // An engine kept alive through sleep still holds values set at runtime, like a credential fallback's; only the unset lines revoke those.
  for (const key of [...loadedKeys, ...file.unsetKeys]) {
    if (!(key in file.values)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(file.values)) {
    process.env[key] = value;
  }
  loadedKeys = Object.keys(file.values);
}
