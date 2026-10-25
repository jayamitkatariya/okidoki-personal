import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { byteSize, SYNCED_TABLES, trimSnapshot } from "./sync";
import { auth } from "./auth";
import type { Id } from "./_generated/dataModel";

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
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders },
  });
}

function options() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// Same length and content, compared without short-circuiting on the first differing byte.
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request): boolean {
  const secret = process.env.OKIDOKI_SYNC_SECRET?.trim();
  if (!secret) {
    console.error("OKIDOKI_SYNC_SECRET is not set; rejecting request. Run `npx convex env set OKIDOKI_SYNC_SECRET ...`.");
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? sameSecret(match[1].trim(), secret) : false;
}

// Convex caps HTTP action bodies at 20 MiB; refuse early with a clear message instead of a platform error.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

async function readJson<T>(request: Request): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return { ok: false, response: json({ error: "payload too large" }, 413) };
  try {
    const body = (await request.json()) as T;
    if (!body || typeof body !== "object") return { ok: false, response: json({ error: "bad json" }, 400) };
    return { ok: true, body };
  } catch {
    return { ok: false, response: json({ error: "bad json" }, 400) };
  }
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

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
    const parsed = await readJson<{ accountId?: unknown; device?: unknown; state?: unknown; sentAt?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId) || !body.state || typeof body.state !== "object") {
      return json({ error: "accountId and state required" }, 400);
    }
    const accountId = body.accountId;
    const device = typeof body.device === "string" && body.device.trim() ? body.device.trim().slice(0, 120) : "mac";
    const sentAt = typeof body.sentAt === "number" && Number.isFinite(body.sentAt) ? body.sentAt : Date.now();
    const state = body.state as Record<string, any>;
    const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);

    const claim = await ctx.runMutation(internal.sync.begin, { accountId, sentAt, device });
    if (!claim.ok) return json({ error: "stale", detail: "a newer sync for this account already landed", latest: claim.latest }, 409);

    await ctx.runMutation(internal.sync.pushMeta, {
      accountId,
      accounts: list(state.accounts),
      settings: state.settings && typeof state.settings === "object" ? state.settings : {},
      connectors: list(state.connectors),
    });

    let written = 0;
    let removed = 0;
    for (const table of SYNCED_TABLES) {
      // A field the Mac didn't send is left alone, so a partial payload never wipes a table.
      if (!Array.isArray(state[table])) continue;
      const items = state[table].filter((item: any) => item && typeof item === "object" && isId(item.id));
      for (const batch of batches(items)) {
        written += (await ctx.runMutation(internal.sync.upsertBatch, { accountId, table, items: batch })).written;
      }
      // Deleting is the one step that can't be undone by the next sync, so make sure we're still the newest one.
      if (!(await ctx.runMutation(internal.sync.stillCurrent, { accountId, sentAt }))) {
        return json({ error: "stale", detail: "superseded by a newer sync", written, removed }, 409);
      }
      // One string, not an array: Convex caps array arguments at 8,192 elements.
      const keep = items.map((item: any) => String(item.id)).join("\n");
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
      device,
      state: trimSnapshot(state),
      sentAt,
    });
    await ctx.runMutation(internal.sync.finish, { accountId, sentAt });
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
    if (!isId(accountId)) return json({ error: "accountId required" }, 400);
    const result = await ctx.runQuery(internal.dashboard.forDevice, { accountId });
    return json({ state: result?.state ?? null, updatedAt: result?.updatedAt ?? 0 });
  }),
});

http.route({
  path: "/api/purge",
  method: "OPTIONS",
  handler: httpAction(async () => options()),
});

// The Mac deleted an account: drop everything synced for it. Guarded by the same secret as sync.
http.route({
  path: "/api/purge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<{ accountId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    if (!isId(parsed.body.accountId)) return json({ error: "accountId required" }, 400);
    let removed = 0;
    for (let i = 0; i < 500; i++) {
      const page = await ctx.runMutation(internal.sync.purgeAccountPage, { accountId: parsed.body.accountId });
      removed += page.removed;
      if (page.done) return json({ ok: true, removed });
    }
    return json({ error: "purge incomplete; run again", removed }, 500);
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
    const parsed = await readJson<{ accountId?: unknown; accountName?: unknown; run?: unknown; runId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId) || !isId(body.runId) || !body.run || typeof body.run !== "object") {
      return json({ error: "accountId, runId and run required" }, 400);
    }
    if (byteSize(body.run) > 800_000) return json({ error: "run too large to share; trim its output" }, 413);
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const result = await ctx.runMutation(internal.sync.createShare, {
      token,
      accountId: body.accountId,
      accountName: typeof body.accountName === "string" && body.accountName.trim() ? body.accountName.trim().slice(0, 80) : "someone",
      runId: body.runId,
      run: body.run,
    });
    // No hosted share page yet: without OKIDOKI_SHARE_BASE_URL there is no link to hand out,
    // and the Mac falls back to copying the run itself.
    const base = (process.env.OKIDOKI_SHARE_BASE_URL ?? "").replace(/\/$/, "");
    return json({ token: result.token, url: base ? `${base}/#/share/${result.token}` : null });
  }),
});

http.route({
  path: "/api/share",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (!isId(token)) return json({ error: "token required" }, 400);
    const result = await ctx.runQuery(api.share.get, { token });
    if (!result) return json({ error: "not found" }, 404);
    await ctx.runMutation(api.share.viewed, { token });
    return json(result);
  }),
});

// ---- Worker: a Mac work account that runs the agent's jobs for its spaces. Same secret as sync. ----

for (const path of ["/api/worker/poll", "/api/worker/accept", "/api/worker/update"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => options()) });
}

// Heartbeat plus the queue: jobs this worker may take, and decisions on the ones it holds.
http.route({
  path: "/api/worker/poll",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<{ accountId?: unknown; device?: unknown; kind?: unknown; enabled?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId)) return json({ error: "accountId required" }, 400);
    const device = typeof body.device === "string" ? body.device : "mac";
    const kind = body.kind === "privateMac" ? "privateMac" : "thisMac";
    const enabled = body.enabled !== false;
    const beat = await ctx.runMutation(internal.jobs.heartbeat, { accountId: body.accountId, device, kind, enabled });
    if (!beat.ok) return json({ ok: false, reason: beat.reason, jobs: [], held: [] });
    if (!enabled) return json({ ok: true, jobs: [], held: [] });
    const queue = await ctx.runQuery(internal.jobs.poll, { accountId: body.accountId, kind });
    return json({ ok: true, ...queue });
  }),
});

http.route({
  path: "/api/worker/accept",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<{ accountId?: unknown; jobId?: unknown; device?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId) || !isId(body.jobId)) return json({ error: "accountId and jobId required" }, 400);
    const job = await ctx.runMutation(internal.jobs.accept, { accountId: body.accountId, jobId: body.jobId as any, device: typeof body.device === "string" ? body.device : "mac" });
    return json({ job });
  }),
});

http.route({
  path: "/api/worker/update",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId) || !isId(body.jobId)) return json({ error: "accountId and jobId required" }, 400);
    const str = (value: unknown) => (typeof value === "string" ? value : undefined);
    const result = await ctx.runMutation(internal.jobs.update, {
      accountId: body.accountId,
      jobId: body.jobId as any,
      status: str(body.status),
      runClientId: str(body.runClientId),
      title: str(body.title),
      summary: str(body.summary),
      output: str(body.output),
      steps: Array.isArray(body.steps) ? body.steps : undefined,
      preview: body.preview !== undefined ? body.preview : undefined,
      say: str(body.say),
    });
    return json(result);
  }),
});

http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => json({ ok: true, service: "okidoki-convex", syncConfigured: Boolean(process.env.OKIDOKI_SYNC_SECRET) })),
});

// ---- The Mac adding a document to the vault (a form it found on the web). Same secret as sync. ----

for (const path of ["/api/vault/upload-url", "/api/vault/save"]) {
  http.route({ path, method: "OPTIONS", handler: httpAction(async () => options()) });
}

http.route({
  path: "/api/vault/upload-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<{ accountId?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    if (!isId(parsed.body.accountId)) return json({ error: "accountId required" }, 400);
    return json(await ctx.runMutation(internal.vault.uploadUrlForAccount, { accountId: parsed.body.accountId }));
  }),
});

http.route({
  path: "/api/vault/save",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJson<{ accountId?: unknown; storageId?: unknown; name?: unknown; mime?: unknown; space?: unknown }>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isId(body.accountId)) return json({ error: "accountId required" }, 400);
    if (!isId(body.storageId)) return json({ error: "storageId required" }, 400);
    if (typeof body.name !== "string" || !body.name.trim()) return json({ error: "name required" }, 400);
    return json(await ctx.runMutation(internal.vault.saveFileForAccount, {
      accountId: body.accountId,
      storageId: body.storageId as Id<"_storage">,
      name: body.name,
      mime: typeof body.mime === "string" ? body.mime : "application/pdf",
      space: typeof body.space === "string" ? body.space.slice(0, 80) : "",
    }));
  }),
});

export default http;
