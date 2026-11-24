import { mkdir, readFile, writeFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { buildHookOutputPreview, type StartHookLogEntry } from '@okidoki/shared';
import { ENVIRONMENT_HOOK_LOG_FILENAME, repoHookLogFilename } from './hook-log-files';

const LOGS_DIR = join(homedir(), '.okidoki', 'start-hook-logs');

type StoredStartHookLog = Omit<StartHookLogEntry, 'outputTruncated' | 'outputTotalChars'>;

function withPreview(stored: StoredStartHookLog): StartHookLogEntry {
  const preview = buildHookOutputPreview(stored.output);
  return { ...stored, ...preview };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeStored(raw: unknown): StoredStartHookLog | null {
  if (!isObject(raw)) return null;
  if (typeof raw.output !== 'string' || typeof raw.exitCode !== 'number') return null;

  const hookType: StartHookLogEntry['hookType'] = raw.hookType === 'environment' ? 'environment' : 'repository';
  const repoNameField = optionalString(raw.repoName);
  const hookName = optionalString(raw.hookName) ?? repoNameField ?? '';
  const repoName = repoNameField ?? hookName;
  const hookCommands = Array.isArray(raw.hookCommands)
    ? raw.hookCommands.filter((c): c is string => typeof c === 'string')
    : [];
  return {
    hookType,
    hookName,
    repoName,
    hookCommands,
    output: raw.output,
    exitCode: raw.exitCode,
    timedOut: typeof raw.timedOut === 'boolean' ? raw.timedOut : false,
    executedAt: optionalString(raw.executedAt) ?? '',
  };
}

class StartHookLogsService {
  private async ensureDir(): Promise<void> {
    await mkdir(LOGS_DIR, { recursive: true });
  }

  private async saveLog(
    hookType: StartHookLogEntry['hookType'],
    hookName: string,
    entry: Omit<StoredStartHookLog, 'hookType' | 'hookName' | 'repoName'>,
  ): Promise<void> {
    await this.ensureDir();
    const log: StoredStartHookLog = { hookType, hookName, repoName: hookName, ...entry };
    const filename = hookType === 'environment' ? ENVIRONMENT_HOOK_LOG_FILENAME : repoHookLogFilename(hookName);
    await writeFile(join(LOGS_DIR, filename), `${JSON.stringify(log, null, 2)}\n`, 'utf-8');
  }

  async saveEnvironmentLog(entry: Omit<StoredStartHookLog, 'hookType' | 'hookName' | 'repoName'>): Promise<void> {
    await this.saveLog('environment', 'environment', entry);
  }

  async saveRepoLog(repoName: string, entry: Omit<StoredStartHookLog, 'hookType' | 'hookName' | 'repoName'>): Promise<void> {
    await this.saveLog('repository', repoName, entry);
  }

  async getAllLogs(): Promise<StartHookLogEntry[]> {
    let files: string[];
    try {
      files = await readdir(LOGS_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const logs: StartHookLogEntry[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(join(LOGS_DIR, file), 'utf-8');
        const stored = normalizeStored(JSON.parse(raw));
        if (stored) {
          logs.push(withPreview(stored));
        }
      } catch {
        // skip malformed files
      }
    }

    logs.sort((a, b) => {
      if (a.hookType !== b.hookType) {
        return a.hookType === 'environment' ? -1 : 1;
      }
      return a.hookName.localeCompare(b.hookName);
    });

    return logs;
  }

  async getFullOutput(hookType: StartHookLogEntry['hookType'], hookName: string): Promise<string | null> {
    const filename = hookType === 'environment' ? ENVIRONMENT_HOOK_LOG_FILENAME : repoHookLogFilename(hookName);
    try {
      const raw = await readFile(join(LOGS_DIR, filename), 'utf-8');
      const stored = normalizeStored(JSON.parse(raw));
      if (!stored || stored.hookType !== hookType || stored.hookName !== hookName) {
        return null;
      }
      return stored.output;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }
}

export const startHookLogsService = new StartHookLogsService();
