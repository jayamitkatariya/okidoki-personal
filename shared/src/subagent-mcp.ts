export const SUBAGENT_MCP_SERVER_NAME = 'subagents';

export const SUBAGENT_MCP_TOOLS = {
  getProviders: 'get_providers',
  spawnAgent: 'spawn_agent',
  getAgent: 'get_agent',
  waitAgent: 'wait_agent',
  messageAgent: 'message_agent',
  deleteAgent: 'delete_agent',
} as const;

export const SUBAGENT_MCP_TOOL_NAMES = Object.values(SUBAGENT_MCP_TOOLS);

export type SubagentMcpToolName = typeof SUBAGENT_MCP_TOOLS[keyof typeof SUBAGENT_MCP_TOOLS];

export function isSubagentMcpToolName(tool: string): tool is SubagentMcpToolName {
  return SUBAGENT_MCP_TOOL_NAMES.some((name) => name === tool);
}

export function isSubagentMcpServerName(server: string | undefined): boolean {
  return server === SUBAGENT_MCP_SERVER_NAME;
}
