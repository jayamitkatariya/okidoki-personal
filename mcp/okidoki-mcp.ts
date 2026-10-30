#!/usr/bin/env bun
/**
 * okidoki as an MCP server, over stdio. Lets Claude Code, Cursor or any MCP client replay your
 * recorded skills, search the vault, and hand it requests, through the okidoki app running on
 * this Mac (its control endpoint on 127.0.0.1). No dependencies.
 *
 *   claude mcp add okidoki -- bun /path/to/okidoki-personal/mcp/okidoki-mcp.ts
 *
 * Replays still wait for your okay in the notch whenever okidoki would ask anyway.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORT = process.env.OKIDOKI_SUPPORT_DIR || join(homedir(), "Library", "Application Support", "Okidoki Personal");
const VERSION = "0.1.0";

type Json = Record<string, unknown>;

function control(): { port: number; token: string } {
  try {
    const info = JSON.parse(readFileSync(join(SUPPORT, "control.json"), "utf8")) as { port?: number; token?: string };
    if (info.port && info.token) return { port: info.port, token: info.token };
  } catch {}
  throw new Error("okidoki isn't running on this Mac (no control.json). Open Okidoki Personal and try again.");
}

async function call(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
  const { port, token } = control();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(String(json.error ?? `okidoki answered HTTP ${response.status}`));
  return json;
}

export const TOOLS = [
  {
    name: "list_skills",
    description: "List the skills recorded in okidoki (\"watch me\" recordings it can replay on this Mac), with the {{parameters}} each one fills in.",
    inputSchema: { type: "object", properties: {} },
    run: () => call("GET", "/skills"),
  },
  {
    name: "replay_skill",
    description: "Replay a recorded okidoki skill on this Mac, by name or id. Fill {{parameters}} with values. okidoki may ask the user for an okay first.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The skill's name or id, from list_skills." },
        times: { type: "number", description: "How many passes (default 1)." },
        values: { type: "object", description: "Values for the skill's {{parameters}}.", additionalProperties: { type: "string" } },
      },
      required: ["skill"],
    },
    run: (args: Json) => call("POST", "/replay", { skill: args.skill, times: args.times, values: args.values }),
  },
  {
    name: "vault_search",
    description: "Find documents in the user's okidoki vault folder by name. Returns file paths on this Mac.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: (args: Json) => call("GET", `/vault/search?q=${encodeURIComponent(String(args.query ?? ""))}`),
  },
  {
    name: "ask_okidoki",
    description: "Hand okidoki a request in plain English to do on this Mac (open apps, do things on the web, drive the screen). Anything risky waits for the user's okay.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (args: Json) => call("POST", "/ask", { text: args.text }),
  },
] as const;

export async function handle(message: Json): Promise<Json | undefined> {
  const id = message.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: (message.params as Json | undefined)?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "okidoki", version: VERSION },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const params = (message.params ?? {}) as { name?: string; arguments?: Json };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `no tool ${params.name}` } };
      try {
        const result = await tool.run(params.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      // Notifications (no id) need no answer; unknown requests get "method not found".
      return id === undefined ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${String(message.method)}` } };
  }
}

if (import.meta.main) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      const response = await handle(message);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    }
  });
}
