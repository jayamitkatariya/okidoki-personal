import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { byteSize, SYNCED_TABLES, trimSnapshot } from "./sync";
import { auth } from "./auth";

// Groups items into mutation-sized batches: at most 50 items or ~4 MB of arguments each.
function batches(items: any[]): any[][] {
  const groups: any[][] = [];
  let current: any[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = byteSize(item);
    if (current.length && (current.length >= 50 || bytes + size > 4_000_000)) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

const http = httpRouter();

// Convex Auth's sign-in endpoints (token refresh, JWKS for verifying its own tokens).
auth.addHttpRoutes(http);

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
  if (!secret) {
    console.error("OKIDOKI_SYNC_SECRET is not set; rejecting request. Run `npx convex env set OKIDOKI_SYNC_SECRET ...`.");
    return false;
  }
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
    const accountId = body.accountId;
    const state = body.state as Record<string, any>;
    const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

    await ctx.runMutation(internal.sync.pushMeta, {
      accountId,
      accounts: list(state.accounts),
      settings: state.settings ?? {},
      connectors: list(state.connectors),
    });

    let written = 0;
    let removed = 0;
    for (const table of SYNCED_TABLES) {
      // A field the Mac didn't send is left alone, so a partial payload never wipes a table.
      if (!Array.isArray(state[table])) continue;
      for (const items of batches(state[table])) {
        written += (await ctx.runMutation(internal.sync.upsertBatch, { accountId, table, items })).written;
      }
      const keep = state[table].map((item: any) => String(item.id));
      let cursor: string | null = null;
      for (;;) {
        const page: { cursor: string; isDone: boolean; removed: number } = await ctx.runMutation(internal.sync.removeMissingPage, {
          accountId,
          table,
          keep,
          cursor,
        });
        removed += page.removed;
        if (page.isDone) break;
        cursor = page.cursor;
      }
    }

    const syncedAt = await ctx.runMutation(internal.sync.writeSnapshot, {
      accountId,
      device: body.device ?? "mac",
      state: trimSnapshot(state),
    });
    return json({ ok: true, syncedAt, written, removed });
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
    const result = await ctx.runQuery(internal.dashboard.forDevice, { accountId });
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
