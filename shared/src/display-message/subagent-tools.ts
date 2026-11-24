import { isSubagentMcpServerName, isSubagentMcpToolName, SUBAGENT_MCP_TOOLS } from '../subagent-mcp';
import { parseMcpToolName } from './parsers/mcp';
import { parseToolCallInput } from './tool-call';
import type { ToolCallMessage } from './types';

function chatIdFrom(input: ToolCallMessage['input']): string | null {
  const value = parseToolCallInput(input).inputObject;
  if (!value) return null;
  if ('chatId' in value && typeof value.chatId === 'string') return value.chatId;
  return 'chat_id' in value && typeof value.chat_id === 'string' ? value.chat_id : null;
}

export function subagentToolName(message: ToolCallMessage): string | null {
  const mcp = parseMcpToolName(message.tool);
  const server = mcp?.server ?? message.server;
  const tool = mcp?.tool ?? message.tool;
  return isSubagentMcpServerName(server) ? tool : null;
}

export function subagentChatId(message: ToolCallMessage): string | null {
  const tool = subagentToolName(message);
  if (!tool || tool === SUBAGENT_MCP_TOOLS.getProviders || !isSubagentMcpToolName(tool)) return null;

  const inputId = chatIdFrom(message.input);
  if (inputId) return inputId;
  if (tool !== SUBAGENT_MCP_TOOLS.spawnAgent || !message.output) return null;

  return chatIdFrom(message.output);
}

// Claude Code frames a Task result for its model; people only need the report, and a background agent's report lives in its own transcript.
export function subagentReport(output: string): string {
  if (output.startsWith('Async agent launched successfully.')) return '';
  const trailer = output.lastIndexOf('\nagentId: ');
  const lines = (trailer === -1 ? output : output.slice(0, trailer)).replace(/<usage>[\s\S]*?<\/usage>/g, '').split('\n');
  const header = lines.findIndex((line) => line.startsWith('[Subagent hand-back] '));
  if (header === -1) return lines.join('\n').trim();
  const dedent = (part: string[]) => part.map((line) => line.replace(/^ {2}/, '')).join('\n').trim();
  return [dedent(lines.slice(0, header)), dedent(lines.slice(header + 1))].filter(Boolean).join('\n\n');
}
