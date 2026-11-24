import { buildGitCredentialHelperScript, GIT_CREDENTIAL_HELPER_FILENAME } from '@okidoki/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { AsyncLock } from './async-lock';
import { execFileAsync } from './exec';
import { rememberCredentials } from './transcript-secrets';

export async function atomicWriteFile(
  path: string,
  data: string,
  options?: { mode?: number; flush?: boolean },
): Promise<void> {
  const tmpFile = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpFile, data, { encoding: 'utf-8', mode: options?.mode, flush: options?.flush });
    await rename(tmpFile, path);
  } catch (error) {
    await unlink(tmpFile).catch(() => undefined);
    throw error;
  }
}

export async function writeSecureCredentialFile(
  filePath: string,
  content: string,
  options?: { ensureParentDir?: boolean }
): Promise<void> {
  if (options?.ensureParentDir) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  }
  rememberCredentials(filePath, content);
  // Tmp-file + rename so a concurrent `gh` read can't see a half-written file.
  await atomicWriteFile(filePath, content, { mode: 0o600 });
}

export async function configureManagedGitCredentialHelper(homeDir: string): Promise<void> {
  const credentialsPath = join(homeDir, '.git-credentials');
  const helperPath = join(homeDir, GIT_CREDENTIAL_HELPER_FILENAME);
  await atomicWriteFile(helperPath, buildGitCredentialHelperScript(credentialsPath), { mode: 0o700 });
  await execFileAsync('git', ['config', '--global', '--replace-all', 'credential.helper', helperPath], {
    env: { ...process.env, HOME: homeDir },
  });
  await execFileAsync('git', ['config', '--global', 'credential.https://github.com.useHttpPath', 'true'], {
    env: { ...process.env, HOME: homeDir },
  });
}

// Serialize read-modify-write cycles so concurrent refresh managers can't drop
// each other's lines.
const credentialFileLock = new AsyncLock();

export function upsertCredentialFileLines(
  filePath: string,
  hosts: string[],
  lines: string[],
): Promise<void> {
  return credentialFileLock.run(async () => {
    let existing: string[] = [];
    try {
      existing = (await readFile(filePath, 'utf-8')).split('\n').filter(Boolean);
    } catch {
      existing = [];
    }
    const kept = existing.filter((line) => !hosts.some((host) => line.endsWith(`@${host}`) || line.includes(`@${host}/`)));
    await writeSecureCredentialFile(filePath, [...lines, ...kept, ''].join('\n'));
  });
}

export function removeCredentialFileLines(
  filePath: string,
  shouldRemove: (line: string) => boolean,
): Promise<void> {
  return credentialFileLock.run(async () => {
    let existing: string[] = [];
    try {
      existing = (await readFile(filePath, 'utf-8')).split('\n').filter(Boolean);
    } catch {
      return;
    }
    const kept = existing.filter((line) => !shouldRemove(line));
    await writeSecureCredentialFile(filePath, [...kept, ''].join('\n'));
  });
}
