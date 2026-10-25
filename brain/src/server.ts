import { groundTeach, think } from "./llm";
import { execute, pause, resume, stop, stopAll, validateExecution } from "./executor";
import { tools, findTools } from "./catalog";
import { computerAct } from "./computer";
import { driveStep } from "./computer2";
import type { DriveRequest } from "./types";
import { refineTeach, teachStep } from "./teach";
import { conceptFollowUp, conceptLesson } from "./concept";
import { checkToken } from "./apify";
import { closeAll, forget, reconcile, validateMcpServer } from "./mcp";
import { mcpCatalog, runConnector, stopConnector, stopAllConnectors, validateConnectorRun } from "./connectors";
import { closeMemory, memoryStatus, syncMemory, warmMemory } from "./memory";
import { anthropicKey, apifyToken, mossCredentials } from "./keys";
import { portalRoute } from "./portal";
import { findDocument } from "./finder";
import { CODING_AGENTS, type ComputerRequest, type ConceptFollowRequest, type ConceptRequest, type ConnectorRunRequest, type ExecuteRequest, type McpServerConfig, type MemorySyncRequest, type TeachRefineRequest, type TeachStepRequest, type ThinkRequest } from "./types";

const port = Number(process.env.OKIDOKI_BRAIN_PORT ?? 4319);

const token = process.env.OKIDOKI_BRAIN_TOKEN || crypto.randomUUID();
const corsHeaders: Record<string, string> = {};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

async function body<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function installedTools(): string[] {
  return tools.filter((tool) => Bun.which(tool.command) !== null).map((tool) => tool.id);
}

export async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The entry workbench is a page for this Mac's browser, so it can't carry the sidecar token.
    const portal = await portalRoute(request, url);
    if (portal) return portal;
    if (request.headers.has("origin") || request.headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        version: "0.9.1",
        runtime: `bun ${Bun.version}`,
        agents: CODING_AGENTS.filter((agent) => Bun.which(agent === "cursor" ? "cursor-agent" : agent) !== null),
        tools: installedTools(),
        port,
      });
    }

    if (url.pathname === "/tools" && request.method === "GET") {
      return json({
        tools: tools.map((tool) => ({
          ...tool,
          installed: Bun.which(tool.command) !== null,
        })),
      });
    }

    if (url.pathname === "/tools/find" && request.method === "GET") {
      return json({ tools: findTools(url.searchParams.get("q") ?? "") });
    }

    if (url.pathname === "/think" && request.method === "POST") {
      try {
        const payload = await body<ThinkRequest>(request);
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await think(payload, key);
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

    if (url.pathname === "/teach/ground" && request.method === "POST") {
      try {
        const payload = await body<{
          screenshotBase64?: string;
          appName?: string;
          topic?: string;
          say?: string;
          stepIndex?: number;
          stepCount?: number;
          space?: "window" | "screen";
          model?: string;
        }>(request);
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await groundTeach(
          {
            screenshotBase64: payload.screenshotBase64,
            appName: payload.appName,
            topic: payload.topic || "",
            say: payload.say || "",
            stepIndex: payload.stepIndex ?? 0,
            stepCount: payload.stepCount ?? 1,
            space: payload.space === "window" ? "window" : "screen",
          },
          key,
          payload.model || "claude-haiku-5-5",
        );
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/teach/step" && request.method === "POST") {
      try {
        const payload = await body<Partial<TeachStepRequest>>(request);
        if (!payload.topic) {
          return json({ error: "topic required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await teachStep(
          {
            topic: payload.topic,
            app: payload.app,
            outline: Array.isArray(payload.outline) ? payload.outline.filter((s) => typeof s === "string").slice(0, 12) : [],
            log: Array.isArray(payload.log) ? payload.log.slice(-14) : [],
            stepNumber: payload.stepNumber ?? 1,
            imageWidth: payload.imageWidth ?? 0,
            imageHeight: payload.imageHeight ?? 0,
            screenshotBase64: payload.screenshotBase64,
            controls: Array.isArray(payload.controls) ? payload.controls.slice(0, 120) : [],
            mode: payload.mode === "practice" ? "practice" : "guide",
            known: Array.isArray(payload.known) ? payload.known.filter((k) => typeof k === "string").slice(0, 20) : [],
            milestones: Array.isArray(payload.milestones) ? payload.milestones.filter((m) => typeof m === "string").slice(0, 6) : [],
            language: payload.language,
            model: payload.model,
            pageTitle: typeof payload.pageTitle === "string" ? payload.pageTitle.slice(0, 200) : undefined,
            pageURL: typeof payload.pageURL === "string" ? payload.pageURL.slice(0, 300) : undefined,
          },
          key,
        );
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // Newline-delimited JSON: an "intro" line as soon as the title and first sentence exist, then
    // the full "lesson" (or an "error"). Lets the app start talking while the model is still drawing.
    if (url.pathname === "/teach/concept/stream" && request.method === "POST") {
      let payload: Partial<ConceptRequest>;
      try {
        payload = await body<Partial<ConceptRequest>>(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
      if (!payload.topic) return json({ error: "topic required" }, 400);
      const key = anthropicKey(request.headers.get("x-anthropic-key"));
      const topic = payload.topic;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (line: unknown) => {
            try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); } catch { /* client went away */ }
          };
          conceptLesson(
            {
              topic,
              context: payload.context,
              pageTitle: payload.pageTitle,
              pageURL: payload.pageURL,
              screenshotBase64: payload.screenshotBase64,
              imageWidth: payload.imageWidth,
              imageHeight: payload.imageHeight,
              language: payload.language,
              model: payload.model,
            },
            key,
            fetch,
            { intro: (title, intro) => send({ type: "intro", title, intro }) },
          ).then((result) => {
            if (result.lesson) send({ type: "lesson", lesson: result.lesson, warnings: result.warnings ?? [] });
            else send({ type: "error", error: result.error ?? "couldn't build the lesson" });
          }).catch((error) => {
            send({ type: "error", error: error instanceof Error ? error.message : "couldn't build the lesson" });
          }).finally(() => {
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache", ...corsHeaders } });
    }

    if (url.pathname === "/teach/concept/follow" && request.method === "POST") {
      try {
        const payload = await body<Partial<ConceptFollowRequest>>(request);
        if (!payload.topic || !payload.question) {
          return json({ error: "topic and question required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await conceptFollowUp(
          {
            topic: payload.topic,
            question: payload.question,
            partId: payload.partId,
            partName: payload.partName,
            sceneSummary: payload.sceneSummary ?? "",
            language: payload.language,
            model: payload.model,
          },
          key,
        );
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/teach/refine" && request.method === "POST") {
      try {
        const payload = await body<Partial<TeachRefineRequest>>(request);
        if (!payload.cropBase64 || !payload.describe) {
          return json({ error: "crop and describe required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await refineTeach(
          {
            cropBase64: payload.cropBase64,
            cropWidth: payload.cropWidth ?? 0,
            cropHeight: payload.cropHeight ?? 0,
            describe: payload.describe,
            model: payload.model,
          },
          key,
        );
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/computer" && request.method === "POST") {
      try {
        const payload = await body<ComputerRequest>(request);
        if (!payload.goal) {
          return json({ error: "goal required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        const result = await computerAct(payload, key);
        return json({ action: result.action, usedModel: result.usedModel, error: result.error, meta: result.meta });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    // Driving protocol v2: the computer use toolset, batches, one conversation per run.
    if (url.pathname === "/computer/v2" && request.method === "POST") {
      try {
        const payload = await body<DriveRequest>(request);
        if (!payload.goal || !payload.runID || !payload.observation) {
          return json({ error: "goal, runID and observation required" }, 400);
        }
        const key = anthropicKey(request.headers.get("x-anthropic-key"));
        return json(await driveStep(payload, key));
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
      const stream = new ReadableStream({
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
            const out = await driveStep(payload, key, fetch, 55_000, (action) => {
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

    if (url.pathname === "/execute" && request.method === "POST") {
      let payload: ExecuteRequest;
      try {
        payload = await body<ExecuteRequest>(request);
      } catch {
        return json({ error: "bad request" }, 400);
      }
      const invalid = validateExecution(payload);
      if (invalid) return json({ error: invalid }, 400);

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const emit = (event: string, data: Record<string, unknown>) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              closed = true;
            }
          };
          const finish = () => {
            if (closed) return;
            closed = true;
            try { controller.close(); } catch {}
          };
          execute(payload, emit).finally(finish);
          request.signal.addEventListener("abort", () => {
            // Browser/native disconnected. Let background work continue; just stop writing.
            closed = true;
          });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...corsHeaders,
        },
      });
    }

    // Connects to each MCP server and lists its tools. The Mac calls this when servers change, to show
    // status in the Toolbox and to warm the cache so /think doesn't wait on a cold start.
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
      const { id } = await body<{ id: string }>(request);
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
      const { token } = await body<{ token?: string }>(request);
      const resolved = apifyToken(token);
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
      const { runId } = await body<{ runId: string }>(request);
      const shellStopped = stop(runId);
      return json({ stopped: stopConnector(runId) || shellStopped });
    }
    if (url.pathname === "/pause" && request.method === "POST") {
      const { runId } = await body<{ runId: string }>(request);
      return json({ paused: pause(runId) });
    }
    if (url.pathname === "/resume" && request.method === "POST") {
      const { runId } = await body<{ runId: string }>(request);
      return json({ resumed: resume(runId) });
    }

    return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  // idleTimeout defaults to 10 s and would close a slow model call or a job that's quiet for a while.
  const server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024, fetch: handleRequest });


let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAll();
  stopAllConnectors();
  closeAll(); // don't leave MCP server processes behind
  void closeMemory();
  server.stop(true);
  setTimeout(() => process.exit(0), 850);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`okidoki brain listening on http://127.0.0.1:${server.port}`);
console.log(`bun ${Bun.version} · ${tools.length} tools in the catalog`);

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
