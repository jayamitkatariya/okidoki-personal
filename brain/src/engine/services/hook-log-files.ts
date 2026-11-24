import { createHash } from 'crypto';

export const ENVIRONMENT_HOOK_LOG_FILENAME = 'environment.json';

export function repoHookLogFilename(repoName: string): string {
  const safe = repoName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = createHash('sha256').update(repoName).digest('hex').slice(0, 8);
  return `repo-${safe}-${hash}.json`;
}
