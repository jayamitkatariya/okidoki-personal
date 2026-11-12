import { think } from "./llm";
import { computerAct } from "./computer";
import { driveStep } from "./computer2";
import type { DriveRequest } from "./types";
import { checkToken } from "./apify";
import { closeAll, forget, reconcile, validateMcpServer } from "./mcp";
import { mcpCatalog, runConnector, stopConnector, stopAllConnectors, validateConnectorRun } from "./connectors";
import { closeMemory, memoryStatus, syncMemory, warmMemory } from "./memory";
import { anthropicKey, apifyToken, mossCredentials } from "./keys";
import { findDocument } from "./finder";
import type { ComputerRequest, ConnectorRunRequest, McpServerConfig, MemorySyncRequest, ThinkRequest } from "./types";
import { browserStep, type BrowserRequest } from "./browser";
import { compileSkill, resolveValues, routeRequest, type CompileRequest, type ResolveRequest, type RouteRequest } from "./skillcompile";
import { macStep, type MacStepRequest } from "./macstep";

const port = Number(process.env.OKIDOKI_BRAIN_PORT ?? 4329);

const token = process.env.OKIDOKI_BRAIN_TOKEN || crypto.randomUUID();
const corsHeaders: Record<string, string> = {};

/** A fetch whose calls stop when `signal` fires: the Mac dropped the request, or pressed Esc. */
function fetchUntil(signal: AbortSignal): typeof fetch {
  return ((input, init) => fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
  })) as typeof fetch;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

/** The JSON body as an object. Anything else (no body, not JSON, a bare value) is a 400, never a crash. */
class BadRequest extends Error {}
async function body<T>(request: Request): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BadRequest("the request body isn't JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new BadRequest("the request body must be a JSON object");
  return parsed as T;
}

export async function handleRequest(request: Request): Promise<Response> {
  try {
    return await route(request);
  } catch (error) {
    if (error instanceof BadRequest) return json({ error: error.message }, 400);
    // A route that threw must still answer with JSON the Mac can read, never Bun's HTML error page.
    const message = error instanceof Error ? error.message : "request failed";
    console.error(`brain: ${new URL(request.url).pathname} failed: ${message}`);
    return json({ error: message }, 500);
  }
}

async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.has("origin") || request.headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        version: "0.9.1",
        runtime: `bun ${Bun.version}`,
        port,
      });
    }

    if (url.pathname === "/think" && request.method === "POST") {
      try {
        const payload = await body<ThinkRequest>(request);
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        // The Mac drops the connection when the user backs out of the question; the model call
        // stops with it instead of finishing an answer nobody will see.
        const result = await think(payload, key, fetchUntil(request.signal));
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/find/document" && request.method === "POST") {
      try {
        const payload = await body<{ query?: unknown; model?: unknown }>(request);
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        return json(await findDocument(typeof payload.query === "string" ? payload.query : "", key));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // Smart replay: generalize a run into a skill, fill one item's values from its documents, or pick
    // the skill an everyday request means. Each is one model call, made up front, never per step.
    if (url.pathname === "/skill/compile" && request.method === "POST") {
      const payload = await body<CompileRequest>(request);
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      return json(await compileSkill(payload, key, fetchUntil(request.signal)));
    }
    if (url.pathname === "/skill/resolve" && request.method === "POST") {
      const payload = await body<ResolveRequest>(request);
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      return json(await resolveValues(payload, key, fetchUntil(request.signal)));
    }
    if (url.pathname === "/skill/route" && request.method === "POST") {
      const payload = await body<RouteRequest>(request);
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      return json(await routeRequest(payload, key, fetchUntil(request.signal)));
    }

    // Smart Mac replay's help on evidence: one turn through the app's accessibility controls.
    if (url.pathname === "/mac/step" && request.method === "POST") {
      const payload = await body<MacStepRequest>(request);
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      return json(await macStep(payload, key, fetchUntil(request.signal)));
    }

    if (url.pathname === "/computer" && request.method === "POST") {
      try {
        const payload = await body<ComputerRequest>(request);
        if (!payload.goal) {
          return json({ error: "goal required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await computerAct(payload, key, fetchUntil(request.signal));
        return json({ action: result.action, usedModel: result.usedModel, error: result.error, meta: result.meta });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // The browser agent: one turn of a web task in okidoki's own browser.
    if (url.pathname === "/browser/step" && request.method === "POST") {
      try {
        const payload = await body<BrowserRequest>(request);
        if (!payload.goal || !payload.runID || !payload.observation) {
          return json({ error: "goal, runID and observation required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        return json(await browserStep(payload, key, fetchUntil(request.signal)));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // The same browser turn, streamed as newline-delimited JSON: one {type:"action"} line the moment each
    // action is written, so the Mac starts on the first while the model writes the rest, then {type:"end"}
    // with anything not yet sent.
    if (url.pathname === "/browser/step/stream" && request.method === "POST") {
      let payload: BrowserRequest;
      try {
        payload = await body<BrowserRequest>(request);
      } catch {
        return json({ error: "bad request" }, 400);
      }
      if (!payload.goal || !payload.runID || !payload.observation) {
        return json({ error: "goal, runID and observation required" }, 400);
      }
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      const gone = new AbortController();
      const stopModel = fetchUntil(AbortSignal.any([request.signal, gone.signal]));
      const stream = new ReadableStream({
        cancel() {
          gone.abort();
        },
        async start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const send = (line: Record<string, unknown>) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            } catch {
              closed = true;
            }
          };
          let sent = 0;
          try {
            const out = await browserStep(payload, key, stopModel, 55_000, (action) => {
              sent += 1;
              send({ type: "action", action });
            });
            // Streamed actions come out in the same order as the reply's, so the rest is what's left.
            send({ type: "end", actions: out.actions.slice(sent), meta: out.meta, error: out.error });
          } catch (error) {
            send({ type: "end", actions: [], error: error instanceof Error ? error.message : "model unavailable" });
          } finally {
            closed = true;
            try { controller.close(); } catch {}
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache", ...corsHeaders } });
    }

    // Driving protocol v2: the computer use toolset, batches, one conversation per run.
    if (url.pathname === "/computer/v2" && request.method === "POST") {
      try {
        const payload = await body<DriveRequest>(request);
        if (!payload.goal || !payload.runID || !payload.observation) {
          return json({ error: "goal, runID and observation required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        return json(await driveStep(payload, key, fetchUntil(request.signal)));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // The same turn, streamed as newline-delimited JSON: one {type:"action"} line per action the moment
    // the model finishes writing it, then {type:"end"} with the timings and anything not yet sent.
    if (url.pathname === "/computer/v2/stream" && request.method === "POST") {
      let payload: DriveRequest;
      try {
        payload = await body<DriveRequest>(request);
      } catch {
        return json({ error: "bad request" }, 400);
      }
      if (!payload.goal || !payload.runID || !payload.observation) {
        return json({ error: "goal, runID and observation required" }, 400);
      }
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      // Esc on the Mac cancels the stream: stop the model call too, instead of paying for a turn
      // nobody will run and committing it into the session.
      const gone = new AbortController();
      const stopModel = fetchUntil(AbortSignal.any([request.signal, gone.signal]));
      const stream = new ReadableStream({
        cancel() {
          gone.abort();
        },
        async start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const send = (line: Record<string, unknown>) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            } catch {
              closed = true;
            }
          };
          const sent = new Set<string>();
          try {
            const out = await driveStep(payload, key, stopModel, 55_000, (action) => {
              if (action.id) sent.add(action.id);
              send({ type: "action", action });
            });
            const rest = out.actions.filter((action) => !action.id || !sent.has(action.id));
            send({ type: "end", actions: rest, meta: out.meta, error: out.error, fallback: out.fallback });
          } catch (error) {
            send({ type: "end", actions: [], error: error instanceof Error ? error.message : "model unavailable" });
          } finally {
            closed = true;
            try { controller.close(); } catch {}
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache", ...corsHeaders } });
    }

    // Connects to each MCP server and lists its tools. The Mac calls this when servers change, to show
    // status in the dashboard and to warm the cache so /think doesn't wait on a cold start.
    if (url.pathname === "/mcp/tools" && request.method === "POST") {
      try {
        const { servers, reconnect } = await body<{ servers: McpServerConfig[]; reconnect?: boolean }>(request);
        if (!Array.isArray(servers)) return json({ error: "servers must be an array" }, 400);
        const invalid = servers.map(validateMcpServer).find(Boolean);
        if (invalid) return json({ error: invalid }, 400);
        if (new Set(servers.map(server => server.id)).size !== servers.length) return json({ error: "MCP server ids must be unique" }, 400);
        reconcile(servers, reconnect === true);
        const catalog = await mcpCatalog(servers ?? [], 30_000);
        return json({
          servers: catalog.map((entry) => ({
            id: entry.server.id,
            ok: !entry.error,
            error: entry.error,
            tools: entry.tools.map((tool) => ({ name: tool.name, description: tool.description })),
          })),
        });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/mcp/forget" && request.method === "POST") {
      const { id } = await body<{ id?: unknown }>(request);
      if (typeof id !== "string" || !id) return json({ error: "id required" }, 400);
      forget(id);
      return json({ ok: true });
    }

    // The Mac sends recent turns and right-now notes. Moss embeds only what changed.
    if (url.pathname === "/memory/sync" && request.method === "POST") {
      try {
        const payload = await body<MemorySyncRequest>(request);
        const moss = mossCredentials(payload.projectId, payload.projectKey);
        if (!moss) return json({ error: "Moss project id and key required" }, 400);
        return json(await syncMemory({ ...payload, ...moss }));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/memory/status" && request.method === "GET") {
      return json(memoryStatus());
    }

    if (url.pathname === "/apify/check" && request.method === "POST") {
      const { token } = await body<{ token?: unknown }>(request);
      const resolved = apifyToken(typeof token === "string" ? token : undefined);
      if (!resolved) return json({ ok: false, error: "No Apify key configured" });
      return json(await checkToken(resolved));
    }

    if (url.pathname === "/connector/run" && request.method === "POST") {
      try {
        const payload = await body<ConnectorRunRequest>(request);
        const invalid = validateConnectorRun(payload);
        if (invalid) return json({ error: invalid }, 400);
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        return json(await runConnector(payload, key));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      const { runId } = await body<{ runId?: unknown }>(request);
      if (typeof runId !== "string" || !runId) return json({ error: "runId required" }, 400);
      return json({ stopped: stopConnector(runId) });
    }

    return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  // idleTimeout defaults to 10 s and would close a slow model call or a stream that's quiet for a while.
  const server = Bun.serve({
    port, hostname: "127.0.0.1", idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024, fetch: handleRequest,
    error(error) { return json({ error: error.message }, 500); },
  });


let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAllConnectors();
  closeAll(); // don't leave MCP server processes behind
  void closeMemory();
  server.stop(true);
  setTimeout(() => process.exit(0), 850);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`okidoki brain listening on http://127.0.0.1:${server.port}`);
console.log(`bun ${Bun.version}`);

const moss = mossCredentials();
if (moss) {
  warmMemory(moss.projectId, moss.projectKey).then(
    () => console.log("moss short-term memory ready"),
    (error) => console.log(`moss short-term memory unavailable: ${error instanceof Error ? error.message : "failed"}`),
  );
}

// Watchdog: if the parent app dies (force-quit, SIGKILL), the sidecar exits on its own
// instead of lingering on the port and shadowing the next launch.
setInterval(() => {
  const ppid = process.ppid;
  if (!ppid || ppid === 1) {
    console.log(`parent gone (ppid=${ppid}) — exiting`);
    shutdown();
  }
}, 3000);

}
