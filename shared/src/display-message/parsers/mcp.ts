/**
 * MCP tool names follow the convention `mcp__{server}__{tool}` — split into
 * the server and tool parts when the pattern matches, otherwise return null.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const prefix = 'mcp__';
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}
