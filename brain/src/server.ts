import { think } from "./llm";
import { execute, pause, resume, stop, isBlocked } from "./executor";
import { tools, findTools } from "./catalog";
import { computerAct } from "./computer";
import type { ComputerRequest, ExecuteRequest, ThinkRequest } from "./types";

const port = Number(process.env.OKIDOKI_BRAIN_PORT ?? 4319);

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-anthropic-key, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  maxRequestBodySize: 64 * 1024 * 1024,

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (url.pathname === "/health") {
      return json({
        ok: true,
        version: "0.9.1",
        runtime: `bun ${Bun.version}`,
        agents: ["claude", "opencode", "omp", "hermes"].filter((agent) => Bun.which(agent) !== null),
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
        const key = request.headers.get("x-anthropic-key") ?? undefined;
        const result = await think(payload, key);
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/computer" && request.method === "POST") {
      try {
        const payload = await body<ComputerRequest>(request);
        if (!payload.goal || !payload.screenshotBase64) {
          return json({ error: "goal and screenshot required" }, 400);
        }
        const key = request.headers.get("x-anthropic-key") ?? undefined;
        const result = await computerAct(payload, key);
        return json({ action: result.action, usedModel: result.usedModel, error: result.error });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "bad request" }, 400);
      }
    }

    if (url.pathname === "/execute" && request.method === "POST") {
      let payload: ExecuteRequest;
      try {
        payload = await body<ExecuteRequest>(request);
      } catch {
        return json({ error: "bad request" }, 400);
      }
      const commands = payload.commands ?? [];
      const bad = commands.find((command) => isBlocked(command));
      if (bad) return json({ error: "blocked command" }, 403);

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

    if (url.pathname === "/stop" && request.method === "POST") {
      const { runId } = await body<{ runId: string }>(request);
      return json({ stopped: stop(runId) });
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
  },
});

console.log(`okidoki brain listening on http://127.0.0.1:${server.port}`);
console.log(`bun ${Bun.version} · ${tools.length} tools in the catalog`);

// Watchdog: if the parent app dies (force-quit, SIGKILL), the sidecar exits on its own
// instead of lingering on the port and shadowing the next launch.
setInterval(() => {
  const ppid = process.ppid;
  if (!ppid || ppid === 1) {
    console.log(`parent gone (ppid=${ppid}) — exiting`);
    process.exit(0);
  }
}, 3000);
