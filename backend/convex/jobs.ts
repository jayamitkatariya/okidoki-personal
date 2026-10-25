import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { skillsForWorker } from "./sharedSkills";
import { peopleIn, requireSpaceMember, spaceAccess } from "./spaces";

// Jobs for the agent in a space. The panel creates them from chat (`@okidoki …`) and answers
// approvals; a worker Mac takes them over the secret-guarded HTTP routes and reports back.
// Workers are trusted the way sync is: the Mac proves it holds the sync secret, and names the
// work account it is running as; that account must be linked to a login in the organization.

const WORKER_STALE_MS = 45_000;
/// A job whose worker hasn't been heard from this long is given up on.
const JOB_LOST_MS = 2 * 60_000;
const OUTPUT_TAIL = 8_000;
const HELD = ["accepted", "running", "waiting"];
const MENTION = /(^|[^\w@])@okidoki\b/i;

export function mentionsAgent(text: string): boolean {
  return MENTION.test(text);
}

export function stripMention(text: string): string {
  return text.replace(/(^|[^\w@])@okidoki\b[:,]?/gi, "$1").replace(/\s+/g, " ").trim();
}

export function workerOnline(worker: Pick<Doc<"workers">, "enabled" | "lastSeenAt">, now = Date.now()): boolean {
  return worker.enabled && now - worker.lastSeenAt < WORKER_STALE_MS;
}

/** off · paused · ready, from the row's state or, for older builds, its switch. */
export function workerState(worker: Pick<Doc<"workers">, "enabled" | "state">): "off" | "paused" | "ready" {
  if (!worker.enabled) return "off";
  return worker.state === "paused" ? "paused" : "ready";
}

async function workerFor(ctx: QueryCtx | MutationCtx, accountId: string | null): Promise<Doc<"workers"> | null> {
  if (!accountId) return null;
  return await ctx.db
    .query("workers")
    .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
    .first();
}

/** Whether the Mac holding this job has gone quiet for long enough that nobody should wait on it. */
export async function workerLost(ctx: QueryCtx | MutationCtx, job: Doc<"spaceRuns">, now = Date.now()): Promise<boolean> {
  if (!HELD.includes(job.status)) return false;
  const worker = await workerFor(ctx, job.workerAccountId);
  return !worker || now - worker.lastSeenAt > JOB_LOST_MS;
}

/** The work account's organization membership, through the secret-trusted account id. */
export async function linkFor(ctx: QueryCtx | MutationCtx, accountId: string): Promise<Doc<"memberships"> | null> {
  const link = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
    .first();
  return link && link.status === "active" ? link : null;
}

export async function spaceMemberOf(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">, userId: Id<"users">): Promise<Doc<"spaceMembers"> | null> {
  const rows = await ctx.db
    .query("spaceMembers")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
  return rows.find((row) => row.userId === userId) ?? null;
}

async function postAgentLine(ctx: MutationCtx, job: Doc<"spaceRuns">, text: string) {
  const now = Date.now();
  await ctx.db.insert("spaceMessages", {
    spaceId: job.spaceId,
    authorId: null,
    author: "agent",
    kind: "text",
    text,
    runId: job._id,
    fileId: null,
    createdAt: now,
  });
  await ctx.db.patch(job.spaceId, { lastMessageAt: now, lastMessage: `okidoki: ${text.slice(0, 110)}` });
}

/** The agent gets a job from a chat message. Called by chat.send when the agent is mentioned. */
export async function createJob(ctx: MutationCtx, space: Doc<"spaces">, requestedBy: Id<"users">, text: string): Promise<Id<"spaceRuns">> {
  const now = Date.now();
  const prompt = stripMention(text).slice(0, 4000);
  const jobId = await ctx.db.insert("spaceRuns", {
    spaceId: space._id,
    orgId: space.orgId,
    requestedBy,
    prompt,
    status: "queued",
    decision: "",
    workerAccountId: null,
    workerDevice: "",
    workerName: "",
    runClientId: null,
    title: prompt.slice(0, 80),
    summary: "",
    output: "",
    steps: [],
    preview: null,
    messageId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
  });
  const messageId = await ctx.db.insert("spaceMessages", {
    spaceId: space._id,
    authorId: null,
    author: "agent",
    kind: "run",
    text: "",
    runId: jobId,
    fileId: null,
    createdAt: now + 1,
  });
  await ctx.db.patch(jobId, { messageId });
  return jobId;
}

function jobView(job: Doc<"spaceRuns">, people: Map<string, { name: string }>) {
  return {
    id: job._id,
    spaceId: job.spaceId,
    requestedBy: people.get(job.requestedBy)?.name ?? "Someone",
    prompt: job.prompt,
    status: job.status,
    decision: job.decision,
    workerName: job.workerName,
    workerDevice: job.workerDevice,
    runClientId: job.runClientId,
    title: job.title,
    summary: job.summary,
    output: job.output,
    steps: job.steps,
    preview: job.preview,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

export type JobView = ReturnType<typeof jobView>;

// Jobs in a space, newest first, for the chat's run cards and the space's Runs tab.
export const forSpace = query({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member) return [];
    const people = await peopleIn(ctx, access.space.orgId);
    const rows = await ctx.db
      .query("spaceRuns")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .order("desc")
      .take(100);
    return rows.map((job) => jobView(job, people));
  },
});

// Workers online in the organization, so the space header can say whether anyone will pick a job up.
export const workersFor = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const link = await linkFor(ctx, accountId);
    if (!link || link.userId !== userId) return [];
    const people = await peopleIn(ctx, link.orgId);
    const now = Date.now();
    const rows = await ctx.db
      .query("workers")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    return rows.map((worker) => ({
      accountId: worker.accountClientId,
      userId: worker.userId,
      name: people.get(worker.userId)?.name ?? "Someone",
      device: worker.device,
      kind: worker.kind,
      online: workerOnline(worker, now),
      state: workerState(worker),
      isYou: worker.userId === userId,
      lastSeenAt: worker.lastSeenAt,
    }));
  },
});

/** Records a member's answer to a waiting run and tells the chat. The worker Mac acts on it next poll. */
export async function decideJob(ctx: MutationCtx, job: Doc<"spaceRuns">, userId: Id<"users">, decision: string) {
  if (decision !== "approve" && decision !== "decline") throw new Error("unknown decision");
  if (job.status !== "waiting") throw new Error("that run isn't waiting any more");
  const people = await peopleIn(ctx, job.orgId);
  await ctx.db.patch(job._id, { decision, updatedAt: Date.now() });
  await postAgentLine(ctx, job, decision === "approve" ? `${people.get(userId)?.name ?? "Someone"} approved it. Going ahead.` : `${people.get(userId)?.name ?? "Someone"} said not now. Stopping.`);
}

// Anyone in the space answers an approval; the worker Mac acts on it next poll.
export const decide = mutation({
  args: { jobId: v.id("spaceRuns"), decision: v.string() },
  handler: async (ctx, { jobId, decision }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return;
    const access = await requireSpaceMember(ctx, job.spaceId);
    await decideJob(ctx, job, access.userId, decision);
  },
});

export const cancel = mutation({
  args: { jobId: v.id("spaceRuns") },
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return;
    const access = await requireSpaceMember(ctx, job.spaceId);
    if (["done", "failed", "cancelled"].includes(job.status)) return;
    const now = Date.now();
    // A queued job dies here, as does one whose Mac has gone quiet; one a worker still holds is
    // told to stop through its decision and closes when the Mac confirms.
    if (job.status === "queued" || (await workerLost(ctx, job, now))) {
      await ctx.db.patch(job._id, { status: "cancelled", decision: "decline", endedAt: now, updatedAt: now });
    } else {
      await ctx.db.patch(job._id, { decision: "decline", updatedAt: now });
    }
    const people = await peopleIn(ctx, job.orgId);
    await postAgentLine(ctx, job, `${people.get(access.userId)?.name ?? "Someone"} cancelled it.`);
  },
});

// Jobs whose Mac stopped heart-beating are failed so the chat isn't left waiting. Runs from a cron.
export const reapLost = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let reaped = 0;
    for (const status of HELD) {
      const rows = await ctx.db
        .query("spaceRuns")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(100);
      for (const job of rows) {
        if (!(await workerLost(ctx, job, now))) continue;
        await ctx.db.patch(job._id, { status: "failed", endedAt: now, updatedAt: now });
        await postAgentLine(ctx, { ...job, status: "failed" }, `Lost contact with ${job.workerName || "the worker"}'s Mac. Ask again and a Mac that's online will take it.`);
        reaped += 1;
      }
    }
    return { reaped };
  },
});

// ---- Worker side (HTTP routes, secret-trusted) ----

export const heartbeat = internalMutation({
  args: { accountId: v.string(), device: v.string(), kind: v.string(), enabled: v.boolean(), state: v.optional(v.string()) },
  handler: async (ctx, { accountId, device, kind, enabled, state }) => {
    const link = await linkFor(ctx, accountId);
    if (!link) return { ok: false as const, reason: "account isn't linked to an organization" };
    const existing = await ctx.db
      .query("workers")
      .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
      .first();
    const row = {
      accountClientId: accountId,
      userId: link.userId,
      orgId: link.orgId,
      device: device.slice(0, 120),
      kind: kind === "privateMac" ? "privateMac" : "thisMac",
      enabled,
      state: !enabled ? "off" : state === "paused" ? "paused" : "ready",
      lastSeenAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("workers", row);
    return { ok: true as const };
  },
});

// Queued jobs this worker may take, plus decisions on the jobs it already holds.
export const poll = internalQuery({
  args: { accountId: v.string(), kind: v.string(), state: v.optional(v.string()) },
  handler: async (ctx, { accountId, kind, state }) => {
    const link = await linkFor(ctx, accountId);
    if (!link) return { jobs: [], held: [] };
    // A paused Mac keeps reporting what it holds but takes nothing new.
    const queued =
      state === "paused"
        ? []
        : await ctx.db
            .query("spaceRuns")
            .withIndex("by_org_status", (q) => q.eq("orgId", link.orgId).eq("status", "queued"))
            .take(20);
    const jobs = [];
    for (const job of queued) {
      const space = await ctx.db.get(job.spaceId);
      if (!space) continue;
      // Only a member of the space runs its jobs, and a private-Mac space wants a private-Mac worker.
      if (!(await spaceMemberOf(ctx, job.spaceId, link.userId))) continue;
      if (space.workerPolicy === "privateMac" && kind !== "privateMac") continue;
      if (space.workerPolicy === "hostedVM") continue;
      jobs.push({ id: job._id, spaceId: job.spaceId, spaceName: space.name, prompt: job.prompt, createdAt: job.createdAt });
    }
    const held = [];
    for (const status of ["accepted", "running", "waiting"]) {
      const rows = await ctx.db
        .query("spaceRuns")
        .withIndex("by_worker", (q) => q.eq("workerAccountId", accountId).eq("status", status))
        .take(20);
      for (const job of rows) held.push({ id: job._id, status: job.status, decision: job.decision, runClientId: job.runClientId });
    }
    return { jobs, held };
  },
});

// First worker to accept wins; a job already taken comes back as null.
export const accept = internalMutation({
  args: { accountId: v.string(), jobId: v.id("spaceRuns"), device: v.string() },
  handler: async (ctx, { accountId, jobId, device }) => {
    const link = await linkFor(ctx, accountId);
    const job = await ctx.db.get(jobId);
    if (!link || !job || job.status !== "queued" || job.orgId !== link.orgId) return null;
    if (!(await spaceMemberOf(ctx, job.spaceId, link.userId))) return null;
    const people = await peopleIn(ctx, job.orgId);
    const workerName = people.get(link.userId)?.name ?? "Someone";
    const now = Date.now();
    await ctx.db.patch(job._id, { status: "accepted", workerAccountId: accountId, workerDevice: device.slice(0, 120), workerName, startedAt: now, updatedAt: now });
    await postAgentLine(ctx, job, `On it — running on ${workerName}'s Mac${device ? ` (${device.slice(0, 40)})` : ""}.`);
    // The space's shared skills ride along, so "replay the expense report" works on a Mac that never recorded it.
    const sharedSkills = await skillsForWorker(ctx, job.orgId, job.spaceId);
    return { id: job._id, spaceId: job.spaceId, prompt: job.prompt, sharedSkills };
  },
});

export const update = internalMutation({
  args: {
    accountId: v.string(),
    jobId: v.id("spaceRuns"),
    status: v.optional(v.string()),
    runClientId: v.optional(v.string()),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    output: v.optional(v.string()),
    steps: v.optional(v.any()),
    preview: v.optional(v.any()),
    // A line for the chat, e.g. the answer or the failure. Posted once per call.
    say: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, jobId, status, runClientId, title, summary, output, steps, preview, say }) => {
    const job = await ctx.db.get(jobId);
    if (!job || job.workerAccountId !== accountId) return { ok: false as const };
    if (["done", "failed", "cancelled"].includes(job.status)) return { ok: true as const };
    const now = Date.now();
    const patch: Partial<Doc<"spaceRuns">> = { updatedAt: now };
    if (status !== undefined) {
      if (!["accepted", "running", "waiting", "done", "failed", "cancelled"].includes(status)) throw new Error("unknown status");
      patch.status = status;
      if (["done", "failed", "cancelled"].includes(status)) patch.endedAt = now;
      // A fresh wait clears the previous answer so a second approval is asked for again.
      if (status === "waiting") patch.decision = "";
    }
    if (runClientId !== undefined) patch.runClientId = runClientId;
    if (title !== undefined) patch.title = title.slice(0, 120);
    if (summary !== undefined) patch.summary = summary.slice(0, 2000);
    if (output !== undefined) patch.output = output.slice(-OUTPUT_TAIL);
    if (steps !== undefined) patch.steps = Array.isArray(steps) ? steps.slice(0, 60) : [];
    if (preview !== undefined) patch.preview = preview;
    await ctx.db.patch(job._id, patch);
    if (say) await postAgentLine(ctx, { ...job, ...patch } as Doc<"spaceRuns">, say.slice(0, 4000));
    return { ok: true as const };
  },
});
