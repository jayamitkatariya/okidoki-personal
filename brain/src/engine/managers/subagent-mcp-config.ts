import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SUBAGENT_MCP_TOOL_NAMES } from '@okidoki/shared';

export const SUBAGENT_MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000 + 60_000;

export function engineScriptProcess(script: string, args: string[]) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const builtEntry = join(directory, `${script}.js`);
  const sourceEntry = join(directory, '..', `${script}.ts`);
  const entry = existsSync(builtEntry) ? builtEntry : sourceEntry;
  return {
    command: process.execPath,
    args: [
      ...(entry.endsWith('.ts') ? ['--import', createRequire(import.meta.url).resolve('tsx/esm')] : []),
      entry,
      ...args,
    ],
  };
}

export function subagentMcpProcessConfig(parentChatId: string) {
  return engineScriptProcess('subagent-mcp', ['--parent', parentChatId]);
}

export function subagentCodexMcpConfig(parentChatId: string) {
  return {
    ...subagentMcpProcessConfig(parentChatId),
    env_vars: ['OKIDOKI_ENGINE_PORT', 'OKIDOKI_ENGINE_SECRET'],
    enabled_tools: [...SUBAGENT_MCP_TOOL_NAMES],
    required: true,
    default_tools_approval_mode: 'approve',
    startup_timeout_sec: 10,
    tool_timeout_sec: Math.ceil(SUBAGENT_MCP_TOOL_TIMEOUT_MS / 1000),
  };
}
