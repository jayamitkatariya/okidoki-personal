import { KNOWN_ACTORS, runActor } from "./apify";
import { apifyToken } from "./keys";
import { callTool, listTools } from "./mcp";
import type { ConnectorCall, ConnectorRunRequest, ConnectorRunResult, ConnectorsContext, Decision, McpServerConfig, McpToolInfo } from "./types";

export interface McpCatalogEntry {
  server: McpServerConfig;
  tools: McpToolInfo[];
  error?: string;
}

// Lists every server's tools in parallel. A slow or broken server is reported, never fatal.
export async function mcpCatalog(servers: McpServerConfig[], timeoutMs: number): Promise<McpCatalogEntry[]> {
  return Promise.all(
    servers.map(async (server) => {
      try {
        return { server, tools: await listTools(server, timeoutMs) };
      } catch (error) {
        return { server, tools: [], error: error instanceof Error ? error.message : "unavailable" };
      }
    }),
  );
}

// Compact argument hint for the prompt: names, types and which are required. Full schemas would flood it.
function argsHint(schema: unknown): string {
  const object = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const props = object?.properties ?? {};
  const required = new Set(object?.required ?? []);
  const parts = Object.entries(props)
    .slice(0, 12)
    .map(([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${prop?.type ?? "any"}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

export function connectorPrompt(context: ConnectorsContext | undefined, catalog: McpCatalogEntry[]): string {
  const lines: string[] = [];
  if (context?.apify) {
    lines.push(
      `Apify is connected. For live web data — search results, a site's contents, LinkedIn, social posts, prices, listings, reviews — use kind=connector with connector_call {connector: "apify", actor, input}. It costs Apify credits, so the preview must say so (name the actor and its rough cost) and set risk=medium. Known actors:`,
      ...KNOWN_ACTORS.map((actor) => `· ${actor.id} — ${actor.use}. cost: ${actor.cost}. input: ${actor.input}`),
      `Pick the most specific actor for the ask (LinkedIn jobs → linkedin-job-search, not google-search-scraper). Use the input shape shown; don't invent fields. Keep inputs small (10-20 results) unless they asked for more.`,
    );
  }
  const usable = catalog.filter((entry) => entry.tools.length);
  if (usable.length) {
    lines.push(`MCP servers are connected. To use one of these tools, use kind=connector with connector_call {connector: "mcp", server: <server id>, tool, arguments}:`);
    for (const entry of usable) {
      lines.push(`${entry.server.name} (server id: ${entry.server.id})`);
      for (const tool of entry.tools.slice(0, 40)) {
        const about = tool.description.replace(/\s+/g, " ").slice(0, 160);
        lines.push(`· ${tool.name} ${argsHint(tool.inputSchema)}${about ? ` — ${about}` : ""}`);
      }
    }
    lines.push(`Tools that read are risk=low; tools that send, post, buy, delete or change things are risk=high and the preview says exactly what changes.`);
  }
  return lines.join("\n");
}

// Turns a connector decision the Mac can't act on (connector off, unknown server or tool) into a plain answer,
// and stamps the opaque JSON copy the Mac hands back when it runs.
export function checkConnectorDecision(decision: Decision, context: ConnectorsContext | undefined, catalog: McpCatalogEntry[]): Decision {
  if (decision.kind !== "connector") return decision;
  const call = decision.connectorCall as ConnectorCall | undefined;
  const refuse = (why: string): Decision => ({ ...decision, kind: "answer", answer: `${decision.answer ? `${decision.answer}\n\n` : ""}${why}`, connectorCall: undefined, connectorCallJSON: undefined });
  if (!call) return refuse("i meant to use a connector here, but didn't say which one.");
  if (call.connector === "apify") {
    if (!context?.apify) return refuse("that needs Apify. turn it on in connectors once a key is configured.");
    if (!call.actor) return refuse("i didn't pick an Apify actor for that.");
    call.input = isObject(call.input) ? call.input : {};
  } else if (call.connector === "mcp") {
    const entry = catalog.find((item) => item.server.id === call.server);
    if (!entry) return refuse(`there's no MCP server called ${call.server} connected.`);
    if (!entry.tools.some((tool) => tool.name === call.tool)) return refuse(`${entry.server.name} has no tool called ${call.tool}.`);
    call.arguments = isObject(call.arguments) ? call.arguments : {};
  } else {
    return refuse("i don't know that connector.");
  }
  return { ...decision, connectorCall: call, connectorCallJSON: JSON.stringify(call) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runConnector(request: ConnectorRunRequest, apiKey: string | undefined): Promise<ConnectorRunResult> {
  const invalid = validateConnectorRun(request);
  const failure = (error: string): ConnectorRunResult => ({ ok: false, answer: error, summary: error, output: "", error });
  if (invalid) return failure(invalid);
  if (active.has(request.runId)) return failure("this connector job is already running");
  const controller = new AbortController();
  active.set(request.runId, controller);
  try {
    return await executeConnector(request, apiKey, controller.signal);
  } finally {
    active.delete(request.runId);
  }
}

const active = new Map<string, AbortController>();

export function stopConnector(runId: string): boolean {
  const controller = active.get(runId);
  if (!controller) return false;
  controller.abort(new Error("stopped by you"));
  return true;
}

export function stopAllConnectors(): void {
  for (const id of active.keys()) stopConnector(id);
}

export function validateConnectorRun(value: unknown): string | undefined {
  if (!isObject(value) || typeof value.runId !== "string" || !/^[\w-]{1,128}$/.test(value.runId)) return "valid runId required";
  const call = value.call;
  if (!isObject(call) || !["mcp", "apify"].includes(call.connector as string)) return "valid connector call required";
  if (call.connector === "apify" && (typeof call.actor !== "string" || !call.actor.trim())) return "actor required";
  if (call.connector === "mcp" && (typeof call.server !== "string" || !call.server || typeof call.tool !== "string" || !call.tool)) return "server and tool required";
  if (call.input !== undefined && !isObject(call.input) || call.arguments !== undefined && !isObject(call.arguments)) return "connector arguments must be an object";
}

async function executeConnector(request: ConnectorRunRequest, apiKey: string | undefined, signal: AbortSignal): Promise<ConnectorRunResult> {
  const call = request.call;
  let data: string;
  let count: number | null = null;
  let source: string;
  try {
    if (call.connector === "apify") {
      const token = apifyToken(request.apifyToken);
      if (!token) throw new Error("No Apify key in this build.");
      source = call.actor;
      const run = await runActor(token, call.actor, call.input ?? {}, { maxChargeUsd: request.spendingLimit, signal });
      count = run.items.length;
      data = JSON.stringify(run.items, null, 2);
    } else {
      const server = (request.mcpServers ?? []).find((item) => item.id === call.server);
      if (!server) throw new Error(`The MCP server ${call.server} isn't connected any more.`);
      source = `${server.name} · ${call.tool}`;
      const result = await callTool(server, call.tool, call.arguments ?? {}, 120_000, signal);
      if (result.isError) throw new Error(result.text.slice(0, 300) || `${call.tool} failed`);
      data = result.text;
    }
  } catch (error) {
    const message = signal.aborted ? "stopped by you" : error instanceof Error ? error.message : "the connector failed";
    return { ok: false, answer: message, summary: message, output: "", error: message };
  }
  const output = data.length > 40_000 ? `${data.slice(0, 40_000)}\n…(truncated)` : data;
  const summary = count === null ? `${source} answered` : `${count} result${count === 1 ? "" : "s"} from ${source}`;
  if (count === 0) return { ok: true, answer: `nothing came back from ${source}. try different words or a wider search.`, summary, output };
  const answer = (await writeUp(request, output, source, apiKey, signal)) ?? fallbackAnswer(summary, output);
  if (signal.aborted) return { ok: false, answer: "stopped by you", summary: "stopped by you", output, error: "stopped by you" };
  return { ok: true, answer, summary, output };
}

// One plain model call that reads the raw results and answers the original request.
async function writeUp(request: ConnectorRunRequest, data: string, source: string, apiKey: string | undefined, signal: AbortSignal): Promise<string | null> {
  if (!apiKey) return null;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: request.settings?.claudeModel || "claude-haiku-5-5",
        max_tokens: 900,
        system:
          "You are Okidoki. You just ran a tool for the person. Answer their request from the results only: short, warm, concrete, markdown allowed, under 150 words unless they asked for a list. Link sources when the results have URLs. If the results don't answer it, say so plainly. Never invent data.",
        messages: [{ role: "user", content: `Request: ${request.prompt}\n\nResults from ${source}:\n${data.slice(0, 30_000)}` }],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.find((block) => block.type === "text")?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

function fallbackAnswer(summary: string, output: string): string {
  return `${summary}. the full results are in the run's output.\n\n\`\`\`\n${output.slice(0, 600)}\n\`\`\``;
}
