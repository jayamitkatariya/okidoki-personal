import { isRecord } from './utils/type-guards';
import { notifyPostToolUse } from './services/post-tool-pr-notifier';

async function main(): Promise<void> {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  try {
    const input: unknown = JSON.parse(stdin);
    const raw: Record<string, unknown> = isRecord(input) ? input : {};
    // Antigravity sends `{ toolCall: { name, args } }`, and its run_command names the command `CommandLine`.
    const record: Record<string, unknown> = isRecord(raw.toolCall)
      ? { name: raw.toolCall.name, args: isRecord(raw.toolCall.args) && typeof raw.toolCall.args.CommandLine === 'string' ? { command: raw.toolCall.args.CommandLine } : raw.toolCall.args }
      : raw;
    const toolName = [record.tool_name, record.tool, record.name].find((value): value is string => typeof value === 'string') ?? '';
    const toolInput = record.tool_input ?? record.arguments ?? record.args ?? ('command' in record ? { command: record.command } : record);
    await notifyPostToolUse(toolName, toolInput, process.argv[2] === 'opencode'
      ? { output: record.output, success: record.success === true }
      : undefined);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write('{}\n');
}

main();
