import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

function options() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function authorized(request: Request): boolean {
  const secret = process.env.OKIDOKI_SYNC_SECRET;
  if (!secret) return true; // local development default; set the env var for real use
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

http.route({
  path: "/api/sync",
  method: "OPTIONS",
  handler: httpAction(async () => options()),
});

http.route({
  path: "/api/sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    let body: { accountId?: string; device?: string; state?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400);
    }
    if (!body.accountId || !body.state) return json({ error: "accountId and state required" }, 400);
    const result = await ctx.runMutation(internal.sync.pushSnapshot, {
      accountId: body.accountId,
      device: body.device ?? "mac",
      state: body.state,
    });
    return json(result);
  }),
});

http.route({
  path: "/api/bootstrap",
  method: "OPTIONS",
  handler: httpAction(async () => options()),
});

http.route({
  path: "/api/bootstrap",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const accountId = new URL(request.url).searchParams.get("accountId");
    if (!accountId) return json({ error: "accountId required" }, 400);
    const result = await ctx.runQuery(api.dashboard.bootstrap, { accountId });
    return json({ state: result?.state ?? null, updatedAt: result?.updatedAt ?? 0 });
  }),
});

http.route({
  path: "/api/share",
  method: "OPTIONS",
  handler: httpAction(async () => options()),
});

http.route({
  path: "/api/share",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    let body: { accountId?: string; accountName?: string; run?: any; runId?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad json" }, 400);
    }
    if (!body.accountId || !body.run || !body.runId) return json({ error: "accountId, runId and run required" }, 400);
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    await ctx.runMutation(internal.sync.createShare, {
      token,
      accountId: body.accountId,
      accountName: body.accountName ?? "someone",
      runId: body.runId,
      run: body.run,
    });
    const base = process.env.OKIDOKI_SHARE_BASE_URL ?? "https://okidoki.app";
    return json({ token, url: `${base.replace(/\/$/, "")}/#/share/${token}` });
  }),
});

http.route({
  path: "/api/share",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (!token) return json({ error: "token required" }, 400);
    const result = await ctx.runQuery(api.share.get, { token });
    return json(result);
  }),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true, service: "okidoki-convex" })),
});

export default http;
