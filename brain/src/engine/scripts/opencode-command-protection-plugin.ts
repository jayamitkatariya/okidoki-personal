import { spawn } from 'node:child_process';

interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

interface ToolExecuteBeforeInput {
  tool: string;
  callID: string;
}

interface ToolExecuteBeforeOutput {
  args: unknown;
}

interface ToolExecuteAfterOutput {
  output: string;
  metadata: Record<string, unknown>;
}

function evaluate(tool: string, args: unknown, callId: string, cwd: string): Promise<PolicyResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PolicyResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const hookPath = process.env.OKIDOKI_COMMAND_PROTECTION_HOOK_PATH;
    const runtimePath = process.env.OKIDOKI_COMMAND_PROTECTION_RUNTIME_PATH;
    if (!hookPath || !runtimePath) {
      finish({ allowed: false, reason: 'Okidoki command protection runtime is missing.' });
      return;
    }
    const hookArgs = hookPath.endsWith('.ts') && !runtimePath.endsWith('/bun')
      ? ['--import', 'tsx', hookPath, 'opencode']
      : [hookPath, 'opencode'];
    const child = spawn(runtimePath, hookArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ allowed: false, reason: 'Command protection failed closed: hook timed out' });
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk).slice(-16_384); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-16_384); });
    child.on('error', (error) => finish({ allowed: false, reason: `Command protection failed closed: ${error.message}` }));
    child.on('exit', (code) => {
      if (code !== 0) {
        finish({ allowed: false, reason: `Command protection failed closed: ${stderr || `hook exited with code ${code}`}` });
        return;
      }
      try {
        const result: unknown = JSON.parse(stdout);
        finish(result && typeof result === 'object' && 'allowed' in result && typeof result.allowed === 'boolean'
          ? { allowed: result.allowed, ...('reason' in result && typeof result.reason === 'string' ? { reason: result.reason } : {}) }
          : { allowed: false, reason: 'Command protection failed closed: invalid hook response' });
      } catch {
        finish({ allowed: false, reason: 'Command protection failed closed: invalid hook response' });
      }
    });
    child.stdin.end(JSON.stringify({ name: tool, arguments: args, call_id: callId, cwd }));
  });
}

export const OkidokiCommandProtection = async ({ directory }: { directory: string }) => ({
  'tool.execute.before': async (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => {
    const result = await evaluate(input.tool, output.args, input.callID, directory);
    if (!result.allowed) throw new Error(result.reason ?? 'Blocked by Okidoki command protection.');
  },
  'tool.execute.after': async (input: ToolExecuteBeforeInput & { args: unknown }, output: ToolExecuteAfterOutput | undefined) => {
    if (!output) return;
    const exitCode = output.metadata?.exit ?? output.metadata?.exitCode;
    const success = input.tool === 'bash' || input.tool === 'shell'
      ? exitCode === 0
      : output.metadata?.isError !== true;
    const hookPath = process.env.OKIDOKI_POST_TOOL_PR_HOOK_PATH;
    const runtimePath = process.env.OKIDOKI_COMMAND_PROTECTION_RUNTIME_PATH;
    if (!hookPath || !runtimePath) return;
    const hookArgs = hookPath.endsWith('.ts') && !runtimePath.endsWith('/bun')
      ? ['--import', 'tsx', hookPath, 'opencode']
      : [hookPath, 'opencode'];
    await new Promise<void>((resolve) => {
      const child = spawn(runtimePath, hookArgs, { cwd: directory, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve());
      child.on('exit', () => resolve());
      child.stdin.end(JSON.stringify({ tool: input.tool, args: input.args, output: output.output, success }));
    });
  },
});
