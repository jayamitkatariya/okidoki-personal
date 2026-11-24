import { spawn } from 'child_process';
import {
  HOOK_EXEC_MAX_BUFFER_BYTES,
  clampWarmHookTimeoutMs,
  resolveWarmHookConfig,
  type EnvironmentHookRunStep,
  type WarmHookStreamEvent,
} from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';
import { gitService } from '../git/service';
import { environmentDetailsService } from './environment-details-service';
import { readOkidokiConfigFromDir } from './okidoki-config-service';
import { warmHookLogsService } from './warm-hook-logs-service';

interface WarmHookResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

type RepoWarmHook = { repoName: string; repoPath: string } & (
  | { commands: string[]; timeoutMs?: number; separate?: boolean }
  | { configError: string }
);

async function collectRepoWarmHooks(): Promise<RepoWarmHook[]> {
  const repos = await gitService.listRepositories();
  const collected: RepoWarmHook[] = [];

  for (const repo of repos) {
    const result = await readOkidokiConfigFromDir(repo.path);
    if (!result.ok) {
      collected.push({ repoName: repo.name, repoPath: repo.path, configError: result.error.message });
      continue;
    }
    const warmHook = result.data?.config.warmHook ? resolveWarmHookConfig(result.data.config.warmHook) : null;
    if (!warmHook) {
      continue;
    }

    collected.push({
      repoName: repo.name,
      repoPath: repo.path,
      commands: warmHook.commands,
      timeoutMs: warmHook.timeoutMs,
      separate: warmHook.separate,
    });
  }

  collected.sort((a, b) => a.repoName.localeCompare(b.repoName));
  return collected;
}

export async function runWarmHooks(params: {
  environmentWarmHook?: string;
  timeoutMs?: number;
}): Promise<WarmHookResult> {
  return runWarmHooksStreaming({ ...params, onEvent: () => {} });
}

export type { WarmHookStreamEvent };

async function executeHookScriptStreaming(params: {
  label: string;
  cwd: string;
  content: string;
  timeoutMs?: number;
  onChunk: (chunk: string) => void;
}): Promise<WarmHookResult> {
  const timeout = clampWarmHookTimeoutMs(params.timeoutMs);
  const outputParts: string[] = [];
  let outputBytes = 0;
  let bufferExceeded = false;

  params.onChunk(`$ ${params.label}\n`);

  return new Promise<WarmHookResult>((resolve) => {
    const proc = spawn('bash', ['-lc', params.content], {
      cwd: params.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    const handleData = (data: Buffer) => {
      outputBytes += data.length;
      if (bufferExceeded) return;
      if (outputBytes > HOOK_EXEC_MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        const msg = `\n[output truncated — exceeded ${HOOK_EXEC_MAX_BUFFER_BYTES} bytes]\n`;
        outputParts.push(msg);
        params.onChunk(msg);
        proc.kill('SIGTERM');
        return;
      }
      const text = data.toString();
      outputParts.push(text);
      params.onChunk(text);
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const output = [`$ ${params.label}`, ...outputParts].join('');
      resolve({
        exitCode: bufferExceeded ? 1 : (code ?? 1),
        output,
        timedOut: killed && !bufferExceeded,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      const output = [`$ ${params.label}\n`, ...outputParts, err.message].join('');
      resolve({
        exitCode: 1,
        output,
        timedOut: false,
      });
    });

    proc.stdin.end();
  });
}

export async function runWarmHooksStreaming(params: {
  environmentWarmHook?: string;
  timeoutMs?: number;
  onEvent: (event: WarmHookStreamEvent) => void;
}): Promise<WarmHookResult> {
  await warmHookLogsService.resetCurrentRunLog();
  const originalOnEvent = params.onEvent;
  const steps: EnvironmentHookRunStep[] = [];
  const onEvent: typeof originalOnEvent = (event) => {
    if (event.type === 'output' && event.data) {
      // Fire-and-forget; the SSE stream is authoritative for in-process callers
      // and this file is just a tail-able mirror for other monolith instances.
      void warmHookLogsService.appendCurrentRunLog(event.data).catch(() => {});
    }
    originalOnEvent(event.type === 'complete' ? { ...event, steps } : event);
  };
  params = { ...params, onEvent };
  const outputBlocks: string[] = [];
  const environmentHook = params.environmentWarmHook?.trim();

  if (environmentHook) {
    const envResult = await executeHookScriptStreaming({
      label: 'environment-warm-hook',
      cwd: gitService.getWorkspaceRoot(),
      content: environmentHook,
      timeoutMs: params.timeoutMs,
      onChunk: (chunk) => params.onEvent({ type: 'output', data: chunk, label: 'environment-warm-hook' }),
    });
    outputBlocks.push(envResult.output);
    steps.push({ repository: null, status: envResult.exitCode === 0 ? 'succeeded' : 'failed' });
    await environmentDetailsService.setEnvironmentWarmHook(envResult.exitCode === 0 ? 'yes' : 'no', envResult.output);
    await warmHookLogsService.saveEnvironmentHookLog({
      hookScript: environmentHook,
      output: envResult.output,
      exitCode: envResult.exitCode,
      timedOut: envResult.timedOut,
      executedAt: new Date().toISOString(),
    });

    if (envResult.exitCode !== 0) {
      const result: WarmHookResult = {
        exitCode: envResult.exitCode,
        output: outputBlocks.join('\n\n'),
        timedOut: envResult.timedOut,
      };
      params.onEvent({ type: 'complete', exitCode: result.exitCode, timedOut: result.timedOut });
      return result;
    }
  } else {
    await environmentDetailsService.setEnvironmentWarmHook('n/a');
  }

  const repoHooks = ENGINE_ENV.OKIDOKI_REPOSITORY_HOOKS_DISABLED ? [] : await collectRepoWarmHooks();
  const repoHookNames = new Set(repoHooks.map((repoHook) => repoHook.repoName));
  const discoveredRepos = await gitService.listRepositories();

  for (const repo of discoveredRepos) {
    if (!repoHookNames.has(repo.name)) {
      await environmentDetailsService.setRepositoryWarmHook(repo.name, 'n/a');
    }
  }

  for (const repoHook of repoHooks) {
    if ('configError' in repoHook) {
      const output = `$ repo-warm-hook:${repoHook.repoName}\n[ERROR] ${repoHook.configError}\n`;
      params.onEvent({ type: 'output', data: output, label: `repo:${repoHook.repoName}` });
      outputBlocks.push(output);
      steps.push({ repository: repoHook.repoName, status: 'failed' });
      await environmentDetailsService.setRepositoryWarmHook(repoHook.repoName, 'no');
      await warmHookLogsService.saveRepoHookLog(repoHook.repoName, {
        hookScript: '',
        output,
        exitCode: 1,
        timedOut: false,
        executedAt: new Date().toISOString(),
      });
      const result: WarmHookResult = { exitCode: 1, output: outputBlocks.join('\n\n'), timedOut: false };
      params.onEvent({ type: 'complete', exitCode: result.exitCode, timedOut: result.timedOut });
      return result;
    }

    const combinedScript = repoHook.commands.join('\n');
    const repoOutputBlocks: string[] = [];
    let repoFailed = false;
    let repoTimedOut = false;
    let repoExitCode = 0;

    if (repoHook.separate === false) {
      const scriptWithErrExit = `set -e\n${combinedScript}`;
      const repoResult = await executeHookScriptStreaming({
        label: `repo-warm-hook:${repoHook.repoName}`,
        cwd: repoHook.repoPath,
        content: scriptWithErrExit,
        timeoutMs: repoHook.timeoutMs,
        onChunk: (chunk) => params.onEvent({ type: 'output', data: chunk, label: `repo:${repoHook.repoName}` }),
      });

      outputBlocks.push(repoResult.output);
      repoOutputBlocks.push(repoResult.output);

      if (repoResult.exitCode !== 0) {
        repoFailed = true;
        repoTimedOut = repoResult.timedOut;
        repoExitCode = repoResult.exitCode;
      }
    } else {
      for (const command of repoHook.commands) {
        const repoResult = await executeHookScriptStreaming({
          label: `repo-warm-hook:${repoHook.repoName}`,
          cwd: repoHook.repoPath,
          content: command,
          timeoutMs: repoHook.timeoutMs,
          onChunk: (chunk) => params.onEvent({ type: 'output', data: chunk, label: `repo:${repoHook.repoName}` }),
        });

        outputBlocks.push(repoResult.output);
        repoOutputBlocks.push(repoResult.output);

        if (repoResult.exitCode !== 0) {
          repoFailed = true;
          repoTimedOut = repoResult.timedOut;
          repoExitCode = repoResult.exitCode;
          break;
        }
      }
    }

    steps.push({ repository: repoHook.repoName, status: repoFailed ? 'failed' : 'succeeded' });
    await environmentDetailsService.setRepositoryWarmHook(
      repoHook.repoName,
      repoFailed ? 'no' : 'yes',
    );

    const loggedScript = repoHook.separate === false ? `set -e\n${combinedScript}` : combinedScript;
    await warmHookLogsService.saveRepoHookLog(repoHook.repoName, {
      hookScript: loggedScript,
      output: repoOutputBlocks.join('\n\n'),
      exitCode: repoFailed ? repoExitCode : 0,
      timedOut: repoTimedOut,
      executedAt: new Date().toISOString(),
    });

    if (repoFailed) {
      const result: WarmHookResult = {
        exitCode: repoExitCode,
        output: outputBlocks.join('\n\n'),
        timedOut: repoTimedOut,
      };
      params.onEvent({ type: 'complete', exitCode: result.exitCode, timedOut: result.timedOut });
      return result;
    }
  }

  if (outputBlocks.length === 0) {
    const result: WarmHookResult = { exitCode: 0, output: 'No warm hooks configured.', timedOut: false };
    params.onEvent({ type: 'complete', exitCode: 0, timedOut: false });
    return result;
  }

  const result: WarmHookResult = { exitCode: 0, output: outputBlocks.join('\n\n'), timedOut: false };
  params.onEvent({ type: 'complete', exitCode: 0, timedOut: false });
  return result;
}
