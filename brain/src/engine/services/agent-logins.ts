import { readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { CREDENTIAL_SCOPE, parsePosixEnv, serializePosixEnvFile, type AgentLoginWithdrawal, type AgentProvider } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';

/** Leaves the member's own login alone: only a login resolved for someone else, or for no one, is withdrawn. */
export async function withdrawAgentLogin(provider: AgentProvider, { envKeys, files }: AgentLoginWithdrawal): Promise<boolean> {
  if (ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS[provider]?.scope === CREDENTIAL_SCOPE.USER) return false;
  for (const key of envKeys) {
    Reflect.deleteProperty(ENGINE_ENV, key);
    delete process.env[key];
  }
  const { [provider]: _withdrawn, ...remaining } = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS;
  ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS = remaining;
  process.env.OKIDOKI_AGENT_CREDENTIALS = JSON.stringify(remaining);
  await Promise.all(files.map((file) => rm(file, { force: true })));
  // An engine restart or update reloads this file, which would otherwise bring the login back.
  const path = join(homedir(), '.okidoki', 'runtime-env.sh');
  const persisted = parsePosixEnv(readFileSync(path, 'utf-8'));
  for (const key of envKeys) delete persisted.values[key];
  writeFileSync(path, serializePosixEnvFile(
    { ...persisted.values, OKIDOKI_AGENT_CREDENTIALS: JSON.stringify(remaining) },
    new Set([...persisted.unsetKeys, ...envKeys]),
  ));
  // The app server keeps the env and tokens it started with.
  if (provider === 'codex') await (await import('../managers/codex-asp/asp-host')).restartCodexAspHostIfRunning();
  return true;
}
