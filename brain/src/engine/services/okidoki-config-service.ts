import { readFile, appendFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_START_HOOK_TIMEOUT_MS,
  ENVIRONMENT_HOOK_RUN_LOG_LIMIT,
  HOOK_EXEC_MAX_BUFFER_BYTES,
  OKIDOKI_CONFIG_FILENAMES,
  createErrorResult,
  createSuccessResult,
  createUuidFromHex,
  type EnvironmentHookRunStep,
  parseOkidokiConfigString,
  repositorySystemPrompts,
  type EngineRepoState,
  type Result,
  type OkidokiConfig,
  type StartHookConfig,
  type StartHookStreamEvent,
  type StartHooksReport,
} from '@okidoki/shared';
import { loadRepoState, saveRepoState } from '../utils/state';
import { gitService } from '../git/service';
import { environmentDetailsService } from './environment-details-service';
import { startHookLogsService } from './start-hook-logs-service';
import { checkProxyRoute } from './network-check';
import { ENGINE_ENV } from '../engine-env';
import { monolithService } from './monolith-service';

const START_HOOK_REPORT_ATTEMPTS = 6;
const START_HOOK_REPORT_RETRY_MS = 2_000;

const START_HOOKS_LOG = join(homedir(), '.okidoki', 'startHooks.log');

interface RepoConfigEntry {
  repoName: string;
  workingDirectory: string;
  defaultBranch: string;
  config: OkidokiConfig;
}

interface StartHookResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  steps: EnvironmentHookRunStep[];
}

interface ExecuteStartHooksParams {
  environmentStartHook?: string;
  timeoutMs?: number;
  ignorePersistedState?: boolean;
  markRepoCompleted?: boolean;
  onEvent?: (event: StartHookStreamEvent) => void;
  onStart?: () => void;
}

interface RepoConfigError {
  repoName: string;
  error: string;
}

/**
 * Find and read the first okidoki config file in a directory.
 * Checks okidoki.json first, then okidoki.yaml, then okidoki.yml.
 */
export async function readOkidokiConfigFromDir(dirPath: string): Promise<Result<{ config: OkidokiConfig; filename: string } | null>> {
  for (const filename of OKIDOKI_CONFIG_FILENAMES) {
    const configPath = join(dirPath, filename);
    if (!existsSync(configPath)) {
      continue;
    }

    const data = await readFile(configPath, 'utf-8');
    try {
      return createSuccessResult({ config: parseOkidokiConfigString(data, filename), filename });
    } catch (error) {
      return createErrorResult({ message: `Could not parse ${filename}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return createSuccessResult(null);
}

class OkidokiConfigService {
  private configs: RepoConfigEntry[] = [];
  private configErrors: RepoConfigError[] = [];
  private hooksRunning = false;
  private hooksCompleted = false;
  private hooksFailed = false;
  /** By hook owner; their background processes outlive the run, and survive a pause along with the engine. */
  private hookProcessGroups = new Map<string, number[]>();

  /**
   * Initialize by reading all okidoki config files and running start hooks.
   */
  async initialize(beforeHooks: Promise<void> = Promise.resolve()): Promise<void> {
    await this.loadConfigs();
    if (ENGINE_ENV.OKIDOKI_DISABLE_AUTO_START_HOOKS) {
      this.hooksRunning = false;
      this.hooksCompleted = false;
      this.hooksFailed = false;
      return;
    }
    // A memory snapshot clones the process's random state, so every workspace claimed from one would draw the same random id.
    const runId = createUuidFromHex(createHash('sha256').update(`${ENGINE_ENV.OKIDOKI_WORKSPACE_ID}:${Date.now()}`).digest('hex'));
    // The finished report is the only copy of the run's output, so it survives a monolith deploy or a network blip.
    const report = async (payload: Omit<StartHooksReport, 'runId'>, attempts = 1) => {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (await monolithService.sendEvent({ type: 'start_hooks', payload: { runId, ...payload } })) return;
        if (attempt < attempts) await delay(START_HOOK_REPORT_RETRY_MS * 2 ** (attempt - 1));
      }
    };
    this.hooksRunning = true;
    // Agents wait for this log's completion line, and the previous boot's stays in it until the hooks start.
    if (this.getStartHookConfig()) await writeFile(START_HOOKS_LOG, 'Start hooks are waiting to run.\n', 'utf-8').catch((error) => console.error('Failed to reset start hooks log:', error));
    void beforeHooks.then(() => this.executeStartHooks({ onStart: () => void report({ status: 'running' }) })).then(async (result) => report({
      status: result.exitCode === 0 && !result.timedOut ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.output.slice(-ENVIRONMENT_HOOK_RUN_LOG_LIMIT),
      outputChars: result.output.length,
      network: await checkProxyRoute(),
      steps: result.steps,
    }, START_HOOK_REPORT_ATTEMPTS), (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.hooksFailed = true;
      this.hooksRunning = false;
      console.error('[OkidokiConfig] Start hooks execution failed:', errorMessage);
      return report({ status: 'failed', exitCode: 1, output: errorMessage }, START_HOOK_REPORT_ATTEMPTS);
    });
  }

  /** Otherwise a rerun starts a second copy of every server the owner's previous run left running. */
  private async stopStartHookProcesses(owner: string): Promise<void> {
    const groups = this.hookProcessGroups.get(owner) ?? [];
    this.hookProcessGroups.delete(owner);
    const signal = (name: NodeJS.Signals | 0) => groups.filter((pgid) => {
      try {
        process.kill(-pgid, name);
        return true;
      } catch {
        return false;
      }
    });
    if (signal('SIGTERM').length === 0) return;
    const deadline = Date.now() + 5_000;
    while (signal(0).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    signal('SIGKILL');
  }

  /**
   * Load and parse okidoki config from each discovered repository root.
   * Checks okidoki.json first, then falls back to okidoki.yaml/okidoki.yml.
   */
  private async loadConfigs(): Promise<void> {
    const repos = await gitService.listRepositories();
    const configs: RepoConfigEntry[] = [];
    const configErrors: RepoConfigError[] = [];

    for (const repo of repos) {
      try {
        const result = await readOkidokiConfigFromDir(repo.path);
        if (!result.ok) {
          console.error(`[OkidokiConfig] ${repo.name}: ${result.error.message}`);
          configErrors.push({ repoName: repo.name, error: result.error.message });
          continue;
        }
        if (!result.data) {
          continue;
        }

        configs.push({
          repoName: repo.name,
          workingDirectory: repo.path,
          defaultBranch: repo.defaultBranch,
          config: result.data.config,
        });
      } catch (error) {
        console.error(`[OkidokiConfig] Error loading ${repo.name} config:`, error instanceof Error ? error.message : error);
      }
    }

    this.configs = configs.sort((a, b) => a.repoName.localeCompare(b.repoName));
    this.configErrors = configErrors;
  }

  /**
   * Write a message to the start hooks log file.
   */
  private async logToFile(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}\n`;
    try {
      await mkdir(join(homedir(), '.okidoki'), { recursive: true });
      await appendFile(START_HOOKS_LOG, logLine, 'utf-8');
    } catch (error) {
      console.error('Failed to write to start hooks log:', error);
    }
  }

  private async executeEnvironmentStartHook(params: {
    content: string;
    timeoutMs?: number;
    onOutputChunk?: (chunk: string) => void;
  }): Promise<{ exitCode: number; timedOut: boolean; output: string[] }> {
    await this.stopStartHookProcesses('environment');
    await this.logToFile(`[environment] --- Running env-level start hook ---`);
    const result = await this.execStartHookCommand({
      command: params.content,
      label: 'env start hook',
      repoName: 'environment',
      cwd: homedir(),
      timeout: params.timeoutMs ?? DEFAULT_START_HOOK_TIMEOUT_MS,
      onOutputChunk: params.onOutputChunk,
    });
    if (result.exitCode !== 0) {
      this.hooksFailed = true;
      await environmentDetailsService.setEnvironmentStartHook('no');
    } else {
      await environmentDetailsService.setEnvironmentStartHook('yes');
    }
    return result;
  }

  private async execStartHookCommand(params: {
    command: string;
    label: string;
    repoName: string;
    cwd: string;
    timeout: number;
    onOutputChunk?: (chunk: string) => void;
  }): Promise<{ exitCode: number; timedOut: boolean; output: string[] }> {
    const output: string[] = [];
    let outputBytes = 0;
    let bufferExceeded = false;

    const emit = (chunk: string) => {
      output.push(chunk);
      params.onOutputChunk?.(chunk);
    };

    await this.logToFile(`[${params.repoName}] --- Running: ${params.label} ---`);
    emit(`$ ${params.label}\n`);

    return new Promise((resolve) => {
      // Login shell so hooks pick up tools warm hooks wrote to ~/.bash_profile / ~/.profile (pyenv, nvm, cargo, etc.)
      const proc = spawn('bash', ['-lc', params.command], {
        cwd: params.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      if (proc.pid) this.hookProcessGroups.set(params.repoName, [...(this.hookProcessGroups.get(params.repoName) ?? []), proc.pid]);

      let timedOut = false;
      let settled = false;

      const finish = (result: { exitCode: number; timedOut: boolean; output: string[] }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, params.timeout);

      const handleData = (data: Buffer, streamName: 'stdout' | 'stderr') => {
        outputBytes += data.length;
        if (bufferExceeded) return;
        if (outputBytes > HOOK_EXEC_MAX_BUFFER_BYTES) {
          bufferExceeded = true;
          const message = `\n[output truncated — exceeded ${HOOK_EXEC_MAX_BUFFER_BYTES} bytes]\n`;
          emit(message);
          void this.logToFile(`[${params.repoName}] [ERROR] ${message.trim()}`);
          proc.kill('SIGTERM');
          return;
        }

        const text = data.toString();
        emit(text);
        void this.logToFile(`[${params.repoName}] [${streamName}] ${text}`);
      };

      proc.stdout.on('data', (data: Buffer) => handleData(data, 'stdout'));
      proc.stderr.on('data', (data: Buffer) => handleData(data, 'stderr'));

      proc.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = bufferExceeded ? 1 : (code ?? 1);
        if (exitCode !== 0) {
          const reason = timedOut ? 'timed out' : `exited with code ${exitCode}`;
          const message = `[ERROR] ${params.label} failed: ${reason}\n`;
          emit(message);
          void this.logToFile(`[${params.repoName}] ${message.trim()}`);
        } else {
          void this.logToFile(`[${params.repoName}] --- Completed: ${params.label} ---`);
        }
        finish({ exitCode, timedOut: timedOut && !bufferExceeded, output });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        const message = `[ERROR] ${params.label} failed: ${error.message}\n`;
        emit(message);
        void this.logToFile(`[${params.repoName}] ${message.trim()}`);
        finish({ exitCode: 1, timedOut: false, output });
      });

      proc.stdin.end();
    });
  }

  private async executeStartHooks(params: ExecuteStartHooksParams = {}): Promise<StartHookResult> {
    const onEvent = params.onEvent ?? (() => {});
    const envHookContent = (params.environmentStartHook ?? ENGINE_ENV.OKIDOKI_ENV_START_HOOK)?.trim() ?? '';
    const repoEntries = [
      ...this.repositoryStartHookEntries(),
      ...(ENGINE_ENV.OKIDOKI_REPOSITORY_HOOKS_DISABLED ? [] : this.configErrors),
    ].sort((a, b) => a.repoName.localeCompare(b.repoName));
    const outputBlocks: string[] = [];
    const steps: EnvironmentHookRunStep[] = [];
    let overallExitCode = 0;
    let overallTimedOut = false;

    const recordResult = (result: { exitCode: number; timedOut: boolean; output: string[] }) => {
      const output = result.output.join('');
      if (output) {
        outputBlocks.push(output);
      }
      if (result.exitCode !== 0 && overallExitCode === 0) {
        overallExitCode = result.exitCode;
      }
      if (result.timedOut) {
        overallTimedOut = true;
      }
    };

    if (!envHookContent && repoEntries.length === 0) {
      this.hooksRunning = false;
      this.hooksCompleted = true;
      this.hooksFailed = false;
      await environmentDetailsService.setEnvironmentStartHook('n/a');
      const repos = await gitService.listRepositories();
      for (const repo of repos) {
        await environmentDetailsService.setRepositoryStartHook(repo.name, 'n/a');
      }
      const result = { exitCode: 0, output: 'No start hooks configured.', timedOut: false, steps };
      onEvent({ type: 'output', data: `${result.output}\n`, label: 'start-hooks' });
      onEvent({ type: 'complete', exitCode: result.exitCode, timedOut: result.timedOut, steps });
      return result;
    }

    this.hooksRunning = true;
    this.hooksCompleted = false;
    this.hooksFailed = false;
    params.onStart?.();

    try {
      await mkdir(join(homedir(), '.okidoki'), { recursive: true });
      await writeFile(
        START_HOOKS_LOG,
        `=== Start Hooks Execution Log ===\nStarted: ${new Date().toISOString()}\nEnvironment hook: ${envHookContent ? 'yes' : 'no'}\nRepositories: ${repoEntries.length}\n\n`,
        'utf-8',
      );

      if (envHookContent) {
        const envResult = await this.executeEnvironmentStartHook({
          content: envHookContent,
          timeoutMs: params.timeoutMs,
          onOutputChunk: (chunk) => onEvent({ type: 'output', data: chunk, label: 'environment' }),
        });
        recordResult(envResult);
        steps.push({ repository: null, status: envResult.exitCode === 0 ? 'succeeded' : 'failed' });
        await startHookLogsService.saveEnvironmentLog({
          hookCommands: [envHookContent],
          output: envResult.output.join(''),
          exitCode: envResult.exitCode,
          timedOut: envResult.timedOut,
          executedAt: new Date().toISOString(),
        });
      } else {
        await environmentDetailsService.setEnvironmentStartHook('n/a');
      }

      const repos = await gitService.listRepositories();
      const reposWithHooks = new Set(repoEntries.map((entry) => entry.repoName));
      for (const repo of repos) {
        if (!reposWithHooks.has(repo.name)) {
          await environmentDetailsService.setRepositoryStartHook(repo.name, 'n/a');
        }
      }

      for (const entry of repoEntries) {
        if ('error' in entry) {
          const output = `[ERROR] ${entry.repoName}: ${entry.error}\n`;
          onEvent({ type: 'output', data: output, label: `repo:${entry.repoName}` });
          await this.logToFile(`[${entry.repoName}] ${output.trim()}`);
          recordResult({ exitCode: 1, timedOut: false, output: [output] });
          await startHookLogsService.saveRepoLog(entry.repoName, {
            hookCommands: [],
            output,
            exitCode: 1,
            timedOut: false,
            executedAt: new Date().toISOString(),
          });
          await environmentDetailsService.setRepositoryStartHook(entry.repoName, 'no');
          steps.push({ repository: entry.repoName, status: 'failed' });
          continue;
        }

        const startHookConfig = entry.config.startHook;
        if (!startHookConfig) {
          continue;
        }

        const persistedRepoState = await loadRepoState(entry.repoName);
        if (!params.ignorePersistedState && persistedRepoState?.startHooksCompleted) {
          await this.logToFile(`[${entry.repoName}] Start hooks already completed in this workspace lifecycle, skipping`);
          await environmentDetailsService.setRepositoryStartHook(entry.repoName, 'yes');
          steps.push({ repository: entry.repoName, status: 'skipped' });
          continue;
        }
        await this.stopStartHookProcesses(entry.repoName);

        const timeout = params.timeoutMs ?? startHookConfig.timeout ?? DEFAULT_START_HOOK_TIMEOUT_MS;
        let repoFailed = false;
        let lastExitCode = 0;
        let repoTimedOut = false;
        const repoOutput: string[] = [];
        const onRepoOutput = (chunk: string) => onEvent({ type: 'output', data: chunk, label: `repo:${entry.repoName}` });

        await this.logToFile(`[${entry.repoName}] Executing ${startHookConfig.commands.length} hook(s) with timeout ${timeout}ms`);

        if (startHookConfig.separate === false) {
          const combinedScript = `set -e\n${startHookConfig.commands.join('\n')}`;
          const result = await this.execStartHookCommand({
            command: combinedScript,
            label: 'combined script',
            repoName: entry.repoName,
            cwd: entry.workingDirectory,
            timeout,
            onOutputChunk: onRepoOutput,
          });
          repoOutput.push(...result.output);
          recordResult(result);
          if (result.exitCode !== 0) {
            lastExitCode = result.exitCode;
            repoTimedOut = result.timedOut;
            this.hooksFailed = true;
            repoFailed = true;
            await environmentDetailsService.setRepositoryStartHook(entry.repoName, 'no');
          }
        } else {
          for (const hook of startHookConfig.commands) {
            const result = await this.execStartHookCommand({
              command: hook,
              label: hook,
              repoName: entry.repoName,
              cwd: entry.workingDirectory,
              timeout,
              onOutputChunk: onRepoOutput,
            });
            repoOutput.push(...result.output);
            recordResult(result);
            if (result.exitCode !== 0) {
              lastExitCode = result.exitCode;
              repoTimedOut = result.timedOut;
              this.hooksFailed = true;
              repoFailed = true;
              await environmentDetailsService.setRepositoryStartHook(entry.repoName, 'no');
              break;
            }
          }
        }

        await startHookLogsService.saveRepoLog(entry.repoName, {
          hookCommands: startHookConfig.commands,
          output: repoOutput.join('\n'),
          exitCode: lastExitCode,
          timedOut: repoTimedOut,
          executedAt: new Date().toISOString(),
        });

        // Don't mark complete on failure so the hook re-runs on next workspace restart instead of being silently skipped
        if ((params.markRepoCompleted ?? true) && !repoFailed) {
          const fallbackRepoState: EngineRepoState = persistedRepoState ?? {
            name: entry.repoName,
            path: entry.workingDirectory,
            defaultBranch: entry.defaultBranch,
            currentBranch: entry.defaultBranch,
            prUrls: [],
            gitDiff: null,
            startHooksCompleted: false,
          };
          await saveRepoState(entry.repoName, { startHooksCompleted: true }, fallbackRepoState);
        }
        await environmentDetailsService.setRepositoryStartHook(entry.repoName, repoFailed ? 'no' : 'yes');
        steps.push({ repository: entry.repoName, status: repoFailed ? 'failed' : 'succeeded' });
      }

      this.hooksCompleted = true;
      this.hooksFailed = overallExitCode !== 0;
      const result = {
        exitCode: overallExitCode,
        output: outputBlocks.join('\n\n'),
        timedOut: overallTimedOut,
        steps,
      };
      onEvent({ type: 'complete', exitCode: result.exitCode, timedOut: result.timedOut, steps });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.hooksFailed = true;
      this.hooksCompleted = false;
      console.error('[OkidokiConfig] Start hooks execution failed:', errorMessage);
      await this.logToFile(`[SYSTEM] [ERROR] Start hooks execution failed: ${errorMessage}`);
      throw error;
    } finally {
      await this.logToFile(`=== All start hooks completed at ${new Date().toISOString()} ===`);
      this.hooksRunning = false;
    }
  }

  async runStartHooksStreaming(params: {
    environmentStartHook?: string;
    timeoutMs?: number;
    onEvent: (event: StartHookStreamEvent) => void;
  }): Promise<StartHookResult> {
    await this.loadConfigs();
    return this.executeStartHooks({
      environmentStartHook: params.environmentStartHook,
      timeoutMs: params.timeoutMs,
      ignorePersistedState: true,
      markRepoCompleted: false,
      onEvent: params.onEvent,
    });
  }

  /**
   * Check if start hooks are currently running.
   */
  areHooksRunning(): boolean {
    return this.hooksRunning;
  }

  areHooksCompleted(): boolean {
    return this.hooksCompleted;
  }

  didHooksFail(): boolean {
    return this.hooksFailed;
  }

  getStartHookConfig(): StartHookConfig | undefined {
    const commands: string[] = [];
    const envHookContent = ENGINE_ENV.OKIDOKI_ENV_START_HOOK?.trim();
    if (envHookContent) {
      commands.push(`[environment] ${envHookContent}`);
    }
    for (const entry of this.repositoryStartHookEntries()) {
      const repoCommands = entry.config.startHook?.commands ?? [];
      for (const command of repoCommands) {
        commands.push(`[${entry.repoName}] ${command}`);
      }
    }

    if (commands.length === 0) {
      return undefined;
    }

    return { commands };
  }

  private repositoryStartHookEntries(): RepoConfigEntry[] {
    if (ENGINE_ENV.OKIDOKI_REPOSITORY_HOOKS_DISABLED) return [];
    return this.configs.filter((entry) => entry.config.startHook && entry.config.startHook.commands.length > 0);
  }

  getSystemPrompts(): string[] {
    return repositorySystemPrompts(this.configs);
  }
}

export const okidokiConfigService = new OkidokiConfigService();
