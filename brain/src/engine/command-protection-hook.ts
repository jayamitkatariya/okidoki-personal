import type { CommandProtectionEvaluateRequest } from '@okidoki/shared';
import { evaluateCommandProtection } from './services/command-protection-service';
import { isRecord } from './utils/type-guards';

const provider = process.argv[2];

function writeResult(allowed: boolean, reason?: string): void {
  if (provider === 'cursor') {
    process.stdout.write(JSON.stringify(allowed
      ? { permission: 'allow' }
      : { permission: 'deny', user_message: reason, agent_message: reason }));
    return;
  }
  if (provider === 'opencode') {
    process.stdout.write(JSON.stringify({ allowed, reason }));
    return;
  }
  if (provider === 'gemini') {
    process.stdout.write(JSON.stringify(allowed ? { decision: 'allow' } : { decision: 'deny', reason }));
    return;
  }
  if (!allowed) {
    process.stderr.write(reason ?? 'Blocked by Okidoki command protection.');
    process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  if (provider !== 'cursor' && provider !== 'opencode' && provider !== 'gemini') {
    throw new Error('Unknown command protection hook provider.');
  }
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  const input: unknown = JSON.parse(body);
  if (!isRecord(input)) throw new Error('Invalid command protection hook input.');
  // Antigravity sends `{ toolCall: { name, args } }`, and its run_command names the command `CommandLine`.
  const geminiCall = isRecord(input.toolCall) ? input.toolCall : null;
  const payload: Record<string, unknown> = geminiCall
    ? {
      name: geminiCall.name,
      // The shell parser reads `command`, so run_command's `CommandLine` must reach it under that name.
      arguments: isRecord(geminiCall.args) && typeof geminiCall.args.CommandLine === 'string' ? { ...geminiCall.args, command: geminiCall.args.CommandLine } : geminiCall.args,
      cwd: isRecord(geminiCall.args) && geminiCall.args.Cwd ? geminiCall.args.Cwd : input.cwd,
      call_id: geminiCall.id,
    }
    : input;
  const toolName = typeof payload.tool_name === 'string'
    ? payload.tool_name
    : typeof payload.name === 'string'
      ? payload.name
      : 'tool';
  const toolInput = payload.tool_input ?? payload.arguments ?? payload;
  const request: CommandProtectionEvaluateRequest = {
    provider,
    source: `${provider}_pre_tool_use`,
    toolName,
    toolInput,
    cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd(),
    toolUseId: typeof payload.tool_use_id === 'string'
      ? payload.tool_use_id
      : typeof payload.call_id === 'string'
        ? payload.call_id
        : null,
  };
  const result = await evaluateCommandProtection(request);
  writeResult(result.allowed, result.reason);
}

main().catch((error) => {
  writeResult(false, `Command protection failed closed: ${error instanceof Error ? error.message : String(error)}`);
});
