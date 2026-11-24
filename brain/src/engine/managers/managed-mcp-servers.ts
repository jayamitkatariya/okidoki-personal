import { readFile } from 'fs/promises';
import type { ServerEntry } from 'pi-mcp-adapter';
import { isRecord } from '../utils/type-guards';
import { PI_MCP_CONFIG_PATH } from './agent-auth-paths';
import { engineScriptProcess } from './subagent-mcp-config';

/** The monolith writes every agent's MCP config from one set; Pi's file holds it in the neutral `mcpServers` shape. */
export async function getManagedPiMcpServers(path = PI_MCP_CONFIG_PATH): Promise<Record<string, ServerEntry>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return {};
    return Object.fromEntries(Object.entries(parsed.mcpServers).filter(
      (entry): entry is [string, ServerEntry] => isRecord(entry[1])
        && (typeof entry[1].command === 'string' || typeof entry[1].url === 'string'),
    ));
  } catch {
    return {};
  }
}

// HTTP servers run through a stdio bridge, which finds out whether they speak streamable HTTP or legacy SSE.
export function managedMcpServerProcess(entry: ServerEntry): { command: string; args: string[]; env?: Record<string, string> } {
  if (entry.command) return { command: entry.command, args: entry.args ?? [], env: entry.env };
  return { ...engineScriptProcess('mcp-http-bridge', []), env: { OKIDOKI_MCP_URL: entry.url ?? '', OKIDOKI_MCP_HEADERS: JSON.stringify(entry.headers ?? {}) } };
}
