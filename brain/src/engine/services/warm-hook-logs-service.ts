import { mkdir, readFile, writeFile, readdir, appendFile, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { buildHookOutputPreview, type WarmHookLogEntry } from '@okidoki/shared';
import { ENVIRONMENT_HOOK_LOG_FILENAME, repoHookLogFilename } from './hook-log-files';

const LOGS_DIR = join(homedir(), '.okidoki', 'warm-hook-logs');
const CURRENT_RUN_LOG = join(LOGS_DIR, 'current-run.log');

// On-disk shape: stores the full untruncated output. The list endpoint
// derives preview/totalChars from this on read.
type StoredWarmHookLog = Omit<WarmHookLogEntry, 'outputTruncated' | 'outputTotalChars'>;

function withPreview(stored: StoredWarmHookLog): WarmHookLogEntry {
  const preview = buildHookOutputPreview(stored.output);
  return { ...stored, ...preview };
}

class WarmHookLogsService {
  private async ensureDir(): Promise<void> {
    await mkdir(LOGS_DIR, { recursive: true });
  }

  async saveEnvironmentHookLog(entry: Omit<StoredWarmHookLog, 'hookType' | 'hookName'>): Promise<void> {
    await this.ensureDir();
    const log: StoredWarmHookLog = {
      hookType: 'environment',
      hookName: 'environment',
      ...entry,
    };
    await writeFile(join(LOGS_DIR, ENVIRONMENT_HOOK_LOG_FILENAME), `${JSON.stringify(log, null, 2)}\n`, 'utf-8');
  }

  async saveRepoHookLog(repoName: string, entry: Omit<StoredWarmHookLog, 'hookType' | 'hookName'>): Promise<void> {
    await this.ensureDir();
    const log: StoredWarmHookLog = {
      hookType: 'repository',
      hookName: repoName,
      ...entry,
    };
    await writeFile(join(LOGS_DIR, repoHookLogFilename(repoName)), `${JSON.stringify(log, null, 2)}\n`, 'utf-8');
  }

  async getAllLogs(): Promise<WarmHookLogEntry[]> {
    let files: string[];
    try {
      files = await readdir(LOGS_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const logs: WarmHookLogEntry[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(join(LOGS_DIR, file), 'utf-8');
        const stored = JSON.parse(raw) as StoredWarmHookLog;
        // Snapshots from older engines can still hold a global.json log.
        if (stored.hookType !== 'environment' && stored.hookType !== 'repository') continue;
        logs.push(withPreview(stored));
      } catch {
        // skip malformed files
      }
    }

    logs.sort((a, b) => {
      if (a.hookType !== b.hookType) return a.hookType === 'environment' ? -1 : 1;
      return a.hookName.localeCompare(b.hookName);
    });

    return logs;
  }

  async resetCurrentRunLog(): Promise<void> {
    await this.ensureDir();
    try {
      await unlink(CURRENT_RUN_LOG);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async appendCurrentRunLog(chunk: string): Promise<void> {
    if (!chunk) return;
    await appendFile(CURRENT_RUN_LOG, chunk, 'utf-8');
  }

  async getCurrentRunLog(): Promise<string | null> {
    try {
      return await readFile(CURRENT_RUN_LOG, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async getFullOutput(hookType: WarmHookLogEntry['hookType'], hookName: string): Promise<string | null> {
    const filename = hookType === 'environment'
      ? ENVIRONMENT_HOOK_LOG_FILENAME
      : repoHookLogFilename(hookName);
    try {
      const raw = await readFile(join(LOGS_DIR, filename), 'utf-8');
      const stored = JSON.parse(raw) as StoredWarmHookLog;
      // Defend against a stored entry whose hookName drifted from the requested
      // one (e.g. a sanitized-filename collision across different inputs).
      if (stored.hookType !== hookType || stored.hookName !== hookName) {
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

export const warmHookLogsService = new WarmHookLogsService();
