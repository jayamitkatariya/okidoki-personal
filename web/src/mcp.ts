export { joinCommand, splitCommand } from "../../shared/commandLine";
import type { McpServer } from "./types";

type ServerSnippet = { name?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string> };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringMap = (value: unknown): value is Record<string, string> => object(value) && Object.values(value).every(item => typeof item === "string");

// Accept the bare server or the mcpServers wrapper used in server READMEs.
export function parseServerJSON(text: string): ServerSnippet | null {
  try {
    let value: unknown = JSON.parse(text);
    if (!object(value)) return null;
    if (value.mcpServers !== undefined) value = value.mcpServers;
    if (!object(value)) return null;
    let name: string | undefined;
    if (!value.command && !value.url) {
      const first = Object.entries(value)[0];
      if (!first) return null;
      [name, value] = first;
    }
    if (!object(value) || !(typeof value.command === "string" && value.command.trim() || typeof value.url === "string" && value.url.trim())) return null;
    if (value.command !== undefined && typeof value.command !== "string" || value.url !== undefined && typeof value.url !== "string") return null;
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(item => typeof item === "string"))) return null;
    if (value.env !== undefined && !stringMap(value.env) || value.headers !== undefined && !stringMap(value.headers)) return null;
    return { name, command: value.command as string | undefined, url: value.url as string | undefined,
      args: value.args as string[] | undefined, env: value.env as Record<string, string> | undefined, headers: value.headers as Record<string, string> | undefined };
  } catch { return null; }
}

/** The servers in a Claude Desktop, Claude Code or Cursor config: `{"mcpServers": {name: {command, args, env} | {url, headers}}}`. */
export function serversFromConfig(text: string): { server: McpServer; secrets: { env: Record<string, string>; headers: Record<string, string> } }[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const table = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, Record<string, unknown>>;
  return Object.entries(table)
    .filter(([, value]) => value && typeof value === "object" && (typeof value.command === "string" || typeof value.url === "string"))
    .map(([name, value]) => {
      const http = typeof value.url === "string";
      const strings = (raw: unknown) => Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      return {
        server: {
          id: `mcp-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          name,
          transport: http ? "http" : "stdio",
          command: http ? "" : String(value.command),
          args: http ? [] : ((value.args as unknown[]) ?? []).map(String),
          url: http ? String(value.url) : "",
          enabled: true,
        } as McpServer,
        secrets: { env: strings(value.env), headers: strings(value.headers) },
      };
    });
}
