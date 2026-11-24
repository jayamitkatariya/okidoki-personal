import { isRecord, parseMcpToolName, skillNamesFromCommand, type DisplayMessage, type SkillUseKind } from '@okidoki/shared';

export interface SkillCall {
  kind: 'skill';
  id: string;
  skillName: string;
  useKind: SkillUseKind;
  occurredAt: string;
}

export interface McpCall {
  kind: 'mcp';
  id: string;
  mcpName: string;
  occurredAt: string;
}

export type SkillMcpCall = SkillCall | McpCall;

const NON_MCP_SERVERS = new Set(['claude', 'cursor', 'gemini', 'muse', 'opencode', 'pi', 'custom', 'dynamic']);

function mcpNameFromToolCall(message: Extract<DisplayMessage, { type: 'tool_call' }>): string | null {
  const parsedName = parseMcpToolName(message.tool);
  if (parsedName) return parsedName.server;

  if (message.tool.startsWith('mcp.')) {
    const [server, ...toolParts] = message.tool.slice('mcp.'.length).split('.');
    if (server && toolParts.length > 0) return server;
  }

  return NON_MCP_SERVERS.has(message.server) ? null : message.server;
}

const SHELL_TOOL_NAMES = /^(bash|shell|run_shell_command)$/i;

function skillCallsFromCommand(id: string, skillNames: readonly string[], occurredAt: string): SkillCall[] {
  return skillNames.map((skillName, index) => ({
    kind: 'skill',
    id: skillNames.length === 1 ? id : `${id}-${index}`,
    skillName,
    useKind: 'shell',
    occurredAt,
  }));
}

export function extractSkillMcpCalls(messages: readonly DisplayMessage[]): SkillMcpCall[] {
  return messages.flatMap((message): SkillMcpCall[] => {
    if (message.type === 'skill') {
      return [{ kind: 'skill', id: message.id, skillName: message.skillName, useKind: message.path ? 'read' : 'invoke', occurredAt: message.timestamp }];
    }

    if (message.type === 'command') {
      return skillCallsFromCommand(message.id, message.skillNames ?? [], message.timestamp);
    }

    if (message.type !== 'tool_call') return [];

    const command = SHELL_TOOL_NAMES.test(message.tool) && isRecord(message.input) ? message.input.command ?? message.input.cmd : undefined;
    if (typeof command === 'string') return skillCallsFromCommand(message.id, skillNamesFromCommand(command), message.timestamp);

    const mcpName = mcpNameFromToolCall(message);
    return mcpName ? [{ kind: 'mcp', id: message.id, mcpName, occurredAt: message.timestamp }] : [];
  });
}
