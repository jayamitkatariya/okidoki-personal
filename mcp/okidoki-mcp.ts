#!/usr/bin/env bun
/**
 * okidoki as an MCP server, over stdio. Lets Claude Code, Cursor, Codex or any MCP client hand okidoki
 * browser tasks, Mac (computer use) tasks and skill replays, wait for the result, steer the run (pause,
 * take back, stop, answer its question), drive tabs of their own in okidoki's browser, and read the
 * person's memory and vault — through the okidoki app running on this Mac. No dependencies.
 *
 *   claude mcp add okidoki -- okidoki mcp
 *   claude mcp add okidoki -- bun /path/to/okidoki-personal/mcp/okidoki-mcp.ts
 *
 * Anything risky still waits for the person's okay in the notch, and captchas are theirs to pass.
 */
import { api, call, type Json } from "./client";

const VERSION = "0.2.0";

type Tool = { name: string; description: string; inputSchema: Json; run: (args: Json) => Promise<Json | { image: string }> };

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export const TOOLS: Tool[] = [
  {
    name: "okidoki_do",
    description:
      "Hand okidoki a task in plain English and (by default) wait for the result. mode: auto (okidoki picks; a saved skill replays if one fits), " +
      "browser (its own browser, with the person's logins), computer (drives this Mac's apps), chat (answer only). " +
      "Returns the run: status, result, and `needs` when it's waiting on the person (an okay, a captcha, a question). " +
      "Pass `thread` from a previous result to continue that conversation.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task, as you'd say it to a person." },
        mode: { type: "string", enum: ["auto", "browser", "computer", "chat"] },
        wait: { type: "number", description: "Seconds to wait for it to finish (default 180; 0 returns at once)." },
        thread: { type: "string", description: "Continue this conversation (from an earlier result)." },
      },
      required: ["text"],
    },
    run: (a) => api.task(String(a.text ?? ""), String(a.mode ?? "auto"), num(a.wait, 180), a.thread as string | undefined),
  },
  {
    name: "okidoki_run",
    description: "A run's status and result. log: true adds its step log.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, log: { type: "boolean" } }, required: ["id"] },
    run: (a) => api.run(String(a.id), Boolean(a.log)),
  },
  {
    name: "okidoki_wait",
    description: "Waits until a run is done or needs the person, up to `timeout` seconds (default 300).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, timeout: { type: "number" } }, required: ["id"] },
    run: (a) => api.wait(String(a.id), num(a.timeout, 300)),
  },
  {
    name: "okidoki_steer",
    description:
      "Steer a run: stop it, pause it (the page or Mac becomes the person's), or resume/takeback (okidoki carries on from wherever things are now).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, action: { type: "string", enum: ["stop", "pause", "resume", "takeback"] } },
      required: ["id", "action"],
    },
    run: (a) => api.control(String(a.id), a.action as "stop" | "pause" | "resume" | "takeback"),
  },
  {
    name: "okidoki_reply",
    description: "Answer the question a run asked (status `asked`); okidoki carries on with it.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
    run: (a) => api.reply(String(a.id), String(a.text ?? "")),
  },
  {
    name: "okidoki_save_skill",
    description:
      "Keep a finished web run as a skill: next time (for any new data) okidoki replays it in seconds instead of working it out. " +
      "Do this after a task the person will repeat.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] },
    run: (a) => api.save(String(a.id), a.name as string | undefined),
  },
  {
    name: "okidoki_runs",
    description: "Recent okidoki runs, newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    run: (a) => api.runs(num(a.limit, 10)),
  },
  {
    name: "list_skills",
    description:
      "The person's saved okidoki skills (recorded or learned workflows that replay in seconds, adapting to new data), with the inputs each needs.",
    inputSchema: { type: "object", properties: {} },
    run: () => api.skills(),
  },
  {
    name: "list_library",
    description: "Ready-made templates okidoki can learn from: the first run is done by the agent, then it replays.",
    inputSchema: { type: "object", properties: {} },
    run: () => api.library(),
  },
  {
    name: "replay_skill",
    description:
      "Replay a saved skill by name or id. `items`: one object of input values per pass (e.g. one per person or invoice); or `values` " +
      "with `times`. Missing values are found in the person's vault documents when the skill can. Waits `wait` seconds (default 300).",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        values: { type: "object" },
        times: { type: "number" },
        wait: { type: "number" },
      },
      required: ["skill"],
    },
    run: (a) =>
      api.replay(String(a.skill ?? ""), {
        items: a.items as Json[] | undefined,
        values: a.values as Json | undefined,
        times: a.times as number | undefined,
        wait: num(a.wait, 300),
      }),
  },
  {
    name: "browser_open",
    description: "Open a tab of your own in okidoki's browser (it has the person's logins). Returns its tab number.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: (a) => api.open(String(a.url ?? "")),
  },
  {
    name: "browser_page",
    description: "A tab's URL, text and numbered elements (use the numbers as `ref` in browser_act). Defaults to your latest tab.",
    inputSchema: { type: "object", properties: { tab: { type: "number" } } },
    run: (a) => api.page(a.tab as number | undefined),
  },
  {
    name: "browser_act",
    description:
      "Act in a tab you opened: action click|type|select|press|scroll|hover|navigate|back, on `ref` (from browser_page) or a CSS `selector`. " +
      "type takes `text` (and `submit: true` to press Enter), select takes `value`, press takes `key`, scroll takes `direction`, navigate takes `url`.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "number" },
        action: { type: "string" },
        ref: { type: "number" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
        value: { type: "string" },
        key: { type: "string" },
        direction: { type: "string" },
        url: { type: "string" },
      },
      required: ["action"],
    },
    run: (a) => api.act(a),
  },
  {
    name: "browser_screenshot",
    description: "A screenshot of a tab you can read (yours, or one a run you started is working in).",
    inputSchema: { type: "object", properties: { tab: { type: "number" } } },
    run: async (a) => {
      const shot = await api.screenshot(a.tab as number | undefined);
      return { image: String(shot.png ?? "") };
    },
  },
  {
    name: "browser_tabs",
    description: "okidoki's browser tabs: which are yours, which you can read.",
    inputSchema: { type: "object", properties: {} },
    run: () => api.tabs(),
  },
  {
    name: "browser_close",
    description: "Close a tab you opened.",
    inputSchema: { type: "object", properties: { tab: { type: "number" } }, required: ["tab"] },
    run: (a) => api.close(Number(a.tab)),
  },
  {
    name: "memory",
    description: "What okidoki remembers about the person (preferences, facts, what's going on right now).",
    inputSchema: { type: "object", properties: {} },
    run: () => api.memory(),
  },
  {
    name: "remember",
    description: "Tell okidoki a lasting fact about the person, so its tasks and replays use it.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (a) => api.remember(String(a.text ?? "")),
  },
  {
    name: "vault_search",
    description: "Find documents in the person's okidoki vault folder by name. Returns file paths on this Mac.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    run: (a) => api.vault(String(a.query ?? "")),
  },
  {
    name: "ask_okidoki",
    description: "Fire and forget: hand okidoki a request and return at once (okidoki_do waits for the result).",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    run: (a) => call("POST", "/ask", { text: a.text }),
  },
];

export async function handle(message: Json): Promise<Json | undefined> {
  const id = message.id;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: (message.params as Json | undefined)?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "okidoki", version: VERSION },
        instructions:
          "okidoki does things on this Mac for the person: web tasks in its own browser (with their logins), Mac app tasks, and saved skills " +
          "that replay in seconds. Prefer okidoki_do with a plain-English task; check list_skills for a skill that already does it. When a run " +
          "`needs` the person (an okay, a captcha), tell them and okidoki_wait; never try to get past a captcha yourself.",
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
        if ("image" in result && typeof result.image === "string") {
          return reply({ content: [{ type: "image", data: result.image, mimeType: "image/png" }] });
        }
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

export function serve() {
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
      // Calls run side by side: a long okidoki_do mustn't hold up a ping or a status check.
      void handle(message).then((response) => {
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      });
    }
  });
}

if (import.meta.main) serve();
