import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { postMessage } from "./chat";
import { decideJob, linkFor, workerOnline } from "./jobs";
import { activeMembership } from "./orgs";
import { requiredApps } from "./sharedSkills";
import { addMember, peopleIn, spaceMemberOf } from "./spaces";

// The Mac's view of its organization, served over the secret-guarded worker routes. The notch
// and the cursor card read it, so approvals, unread chats and shared skills reach people without
// the control panel open — and act on it the same way. The Mac is trusted the way the worker is:
// it holds the sync secret and names the work account it runs as.

const APPROVAL_LIMIT = 20;
const SKILL_LIMIT = 60;
const DEFAULT_SPACE = "general";

async function spacesFor(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return ctx.db
    .query("spaces")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
}

async function unreadIn(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">, since: number): Promise<number> {
  const rows = await ctx.db
    .query("spaceMessages")
    .withIndex("by_space_time", (q) => q.eq("spaceId", spaceId).gt("createdAt", since))
    .take(100);
  return rows.length;
}

function previewOf(job: Doc<"spaceRuns">) {
  const preview = job.preview && typeof job.preview === "object" ? (job.preview as Record<string, unknown>) : null;
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 12) : []);
  return {
    summary: typeof preview?.summary === "string" ? preview.summary : job.summary,
    risk: preview?.risk === "high" || preview?.risk === "medium" ? preview.risk : "low",
    steps: list(preview?.steps),
    commands: list(preview?.commands),
    apps: list(preview?.apps),
  };
}

/** Everything the Mac shows outside the panel, for one work account. Null when it isn't linked. */
export async function summaryFor(ctx: QueryCtx | MutationCtx, accountId: string) {
  const link = await linkFor(ctx, accountId);
  if (!link) return null;
  const org = await ctx.db.get(link.orgId);
  if (!org) return null;
  const admin = link.role === "owner" || link.role === "admin";
  const people = await peopleIn(ctx, link.orgId);
  const allSpaces = await spacesFor(ctx, link.orgId);
  const spaceNames = new Map(allSpaces.map((space) => [space._id as string, space.name]));

  const spaces = [];
  const mine = new Set<string>();
  for (const space of allSpaces) {
    const member = await spaceMemberOf(ctx, space._id, link.userId);
    if (member) mine.add(space._id);
    spaces.push({
      id: space._id,
      name: space.name,
      colorHex: space.colorHex,
      workerPolicy: space.workerPolicy,
      joined: Boolean(member),
      unread: member ? await unreadIn(ctx, space._id, member.lastReadAt) : 0,
      lastMessage: space.lastMessage,
      lastMessageAt: space.lastMessageAt,
    });
  }
  spaces.sort((a, b) => Number(b.joined) - Number(a.joined) || b.lastMessageAt - a.lastMessageAt);

  const waiting = await ctx.db
    .query("spaceRuns")
    .withIndex("by_org_status", (q) => q.eq("orgId", link.orgId).eq("status", "waiting"))
    .take(APPROVAL_LIMIT * 2);
  const approvals = waiting
    .filter((job) => job.decision === "" && mine.has(job.spaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, APPROVAL_LIMIT)
    .map((job) => ({
      id: job._id,
      spaceId: job.spaceId,
      spaceName: spaceNames.get(job.spaceId) ?? "a space",
      prompt: job.prompt,
      title: job.title,
      requestedBy: people.get(job.requestedBy)?.name ?? "Someone",
      workerName: job.workerName,
      workerIsYou: job.workerAccountId === accountId,
      preview: previewOf(job),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

  const skillRows = await ctx.db
    .query("spaceSkills")
    .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
    .collect();
  // Steps stay behind: the Mac pulls a skill when it's about to replay it.
  const sharedSkills = skillRows
    .filter((row) => row.spaceId === null || mine.has(row.spaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SKILL_LIMIT)
    .map((row) => ({
      id: row._id,
      spaceId: row.spaceId,
      spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? "a space") : "",
      sourceSkillId: row.sourceSkillId,
      name: row.name,
      summary: row.summary,
      publishedBy: people.get(row.publishedBy)?.name ?? "Someone",
      isMine: row.publishedBy === link.userId,
      version: row.version,
      stepCount: Array.isArray(row.steps) ? row.steps.length : 0,
      requires: row.requires,
      runCount: row.runCount,
      updatedAt: row.updatedAt,
    }));

  let pendingJoins = 0;
  if (admin) {
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    pendingJoins = rows.filter((row) => row.status === "pending").length;
  }

  return {
    org: { id: org._id, name: org.name, role: link.role, welcome: org.welcome ?? "", pendingJoins, memberCount: people.size },
    me: { userId: link.userId, name: people.get(link.userId)?.name ?? "" },
    spaces,
    approvals,
    sharedSkills,
  };
}

export type EnterpriseSummary = NonNullable<Awaited<ReturnType<typeof summaryFor>>>;

export const summary = internalQuery({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => summaryFor(ctx, accountId),
});

// ---- Acting from the Mac (secret-trusted, keyed by the work account) ----

async function requireLink(ctx: QueryCtx | MutationCtx, accountId: string): Promise<Doc<"memberships">> {
  const link = await linkFor(ctx, accountId);
  if (!link) throw new Error("account isn't linked to an organization");
  return link;
}

async function requireMember(ctx: QueryCtx | MutationCtx, link: Doc<"memberships">, spaceId: Id<"spaces">) {
  const space = await ctx.db.get(spaceId);
  if (!space || space.orgId !== link.orgId) throw new Error("no such space");
  const member = await spaceMemberOf(ctx, spaceId, link.userId);
  if (!member) throw new Error("join the space first");
  return { space, member };
}

export const decideForAccount = internalMutation({
  args: { accountId: v.string(), jobId: v.id("spaceRuns"), decision: v.string() },
  handler: async (ctx, { accountId, jobId, decision }) => {
    const link = await requireLink(ctx, accountId);
    const job = await ctx.db.get(jobId);
    if (!job || job.orgId !== link.orgId) throw new Error("no such run");
    await requireMember(ctx, link, job.spaceId);
    await decideJob(ctx, job, link.userId, decision);
    return { ok: true as const };
  },
});

export const sendForAccount = internalMutation({
  args: { accountId: v.string(), spaceId: v.id("spaces"), text: v.string() },
  handler: async (ctx, { accountId, spaceId, text }) => {
    const link = await requireLink(ctx, accountId);
    const { space, member } = await requireMember(ctx, link, spaceId);
    return postMessage(ctx, space, member, text);
  },
});

export const markReadForAccount = internalMutation({
  args: { accountId: v.string(), spaceId: v.id("spaces") },
  handler: async (ctx, { accountId, spaceId }) => {
    const link = await requireLink(ctx, accountId);
    const { member } = await requireMember(ctx, link, spaceId);
    await ctx.db.patch(member._id, { lastReadAt: Date.now() });
    return { ok: true as const };
  },
});

export const joinSpaceForAccount = internalMutation({
  args: { accountId: v.string(), spaceId: v.id("spaces") },
  handler: async (ctx, { accountId, spaceId }) => {
    const link = await requireLink(ctx, accountId);
    const space = await ctx.db.get(spaceId);
    if (!space || space.orgId !== link.orgId) throw new Error("no such space");
    await addMember(ctx, space, link.userId);
    return { ok: true as const };
  },
});

// A shared skill's steps, when the Mac is about to replay it.
export const pullSkill = internalQuery({
  args: { accountId: v.string(), sharedId: v.id("spaceSkills") },
  handler: async (ctx, { accountId, sharedId }) => {
    const link = await requireLink(ctx, accountId);
    const row = await ctx.db.get(sharedId);
    if (!row || row.orgId !== link.orgId) return null;
    if (row.spaceId && !(await spaceMemberOf(ctx, row.spaceId, link.userId))) return null;
    return { id: row._id, name: row.name, summary: row.summary, steps: row.steps, version: row.version };
  },
});

export const recordSkillRunForAccount = internalMutation({
  args: { accountId: v.string(), sharedId: v.id("spaceSkills") },
  handler: async (ctx, { accountId, sharedId }) => {
    const link = await requireLink(ctx, accountId);
    const row = await ctx.db.get(sharedId);
    if (!row || row.orgId !== link.orgId) return { ok: false as const };
    if (row.spaceId && !(await spaceMemberOf(ctx, row.spaceId, link.userId))) return { ok: false as const };
    await ctx.db.patch(row._id, { runCount: row.runCount + 1 });
    return { ok: true as const };
  },
});

// "share <skill> with my team" from the cursor card. Same rules as the panel's publish.
export const publishForAccount = internalMutation({
  args: {
    accountId: v.string(),
    spaceId: v.union(v.id("spaces"), v.null()),
    skill: v.object({ id: v.string(), name: v.string(), summary: v.string(), steps: v.array(v.any()) }),
  },
  handler: async (ctx, { accountId, spaceId, skill }) => {
    const link = await requireLink(ctx, accountId);
    if (spaceId) await requireMember(ctx, link, spaceId);
    const name = skill.name.trim().slice(0, 120);
    if (!name) throw new Error("the skill needs a name");
    if (!skill.steps.length) throw new Error("the skill has no steps");
    const steps = skill.steps.slice(0, 400);
    const now = Date.now();
    const existing = (
      await ctx.db
        .query("spaceSkills")
        .withIndex("by_source", (q) => q.eq("sourceSkillId", skill.id))
        .collect()
    ).find((row) => row.orgId === link.orgId && row.spaceId === spaceId);
    if (existing) {
      if (existing.publishedBy !== link.userId && !(link.role === "owner" || link.role === "admin")) throw new Error("someone else published that one");
      const history = Array.isArray(existing.history) ? existing.history : [];
      await ctx.db.patch(existing._id, {
        name,
        summary: skill.summary.slice(0, 500),
        steps,
        requires: requiredApps(steps),
        version: existing.version + 1,
        history: [{ version: existing.version, steps: existing.steps, at: existing.updatedAt }, ...history].slice(0, 5),
        updatedAt: now,
      });
      return { id: existing._id, version: existing.version + 1 };
    }
    const id = await ctx.db.insert("spaceSkills", {
      orgId: link.orgId,
      spaceId,
      sourceSkillId: skill.id,
      name,
      summary: skill.summary.slice(0, 500),
      steps,
      requires: requiredApps(steps),
      publishedBy: link.userId,
      version: 1,
      runCount: 0,
      history: [],
      createdAt: now,
      updatedAt: now,
    });
    return { id, version: 1 };
  },
});

// ---- The starter pack: a general space everyone lands in, and a welcome note ----

/** The organization's general space, made on first use. Every active member is in it. */
export async function generalSpace(ctx: MutationCtx, orgId: Id<"organizations">, createdBy: Id<"users">): Promise<Doc<"spaces">> {
  const spaces = await spacesFor(ctx, orgId);
  const existing = spaces.find((space) => space.name.toLowerCase() === DEFAULT_SPACE);
  if (existing) return existing;
  const now = Date.now();
  const spaceId = await ctx.db.insert("spaces", {
    orgId,
    name: DEFAULT_SPACE,
    colorHex: "44E45E",
    workerPolicy: "thisMac",
    createdBy,
    createdAt: now,
    lastMessageAt: now,
    lastMessage: "",
  });
  await ctx.db.insert("spaceMessages", {
    spaceId,
    authorId: null,
    author: "system",
    kind: "system",
    text: "Everyone in the organization is here. Hand okidoki a job with @okidoki — or just type while it's only you.",
    runId: null,
    fileId: null,
    createdAt: now,
  });
  return (await ctx.db.get(spaceId))!;
}

/** A member just became active: put them in the general space so day one has somewhere to start. */
export async function welcomeMember(ctx: MutationCtx, orgId: Id<"organizations">, userId: Id<"users">) {
  const space = await generalSpace(ctx, orgId, userId);
  await addMember(ctx, space, userId, "member", 0);
}

export const setWelcome = mutation({
  args: { orgId: v.id("organizations"), welcome: v.string() },
  handler: async (ctx, { orgId, welcome }) => {
    const me = await activeMembership(ctx, orgId);
    if (!me || !(me.role === "owner" || me.role === "admin")) throw new Error("only an owner or admin can do that");
    await ctx.db.patch(orgId, { welcome: welcome.trim().slice(0, 600) });
  },
});

// ---- Rollout: how far the organization has got, for admins on the Team page ----

export const rollout = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const link = await linkFor(ctx, accountId);
    if (!link || link.userId !== userId) return null;
    const admin = link.role === "owner" || link.role === "admin";
    if (!admin) return null;
    const people = await peopleIn(ctx, link.orgId);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const workers = await ctx.db
      .query("workers")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const workerByUser = new Map(workers.map((worker) => [worker.userId as string, worker]));
    const skills = await ctx.db
      .query("spaceSkills")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const publishedBy = new Map<string, number>();
    for (const skill of skills) publishedBy.set(skill.publishedBy, (publishedBy.get(skill.publishedBy) ?? 0) + 1);
    const now = Date.now();
    const members = memberships
      .filter((row) => row.status === "active")
      .map((row) => {
        const worker = workerByUser.get(row.userId);
        return {
          id: row._id,
          userId: row.userId,
          name: people.get(row.userId)?.name ?? "Someone",
          email: people.get(row.userId)?.email ?? "",
          role: row.role,
          // A linked work account means okidoki is installed and signed in on their Mac.
          installed: Boolean(row.accountClientId),
          // The heartbeat goes out whenever the Mac is on with a work account, worker on or off.
          lastSeenAt: worker?.lastSeenAt ?? null,
          online: worker ? now - worker.lastSeenAt < 45_000 : false,
          workerOn: worker ? workerOnline(worker, now) : false,
          device: worker?.device ?? "",
          skillsPublished: publishedBy.get(row.userId) ?? 0,
          joinedAt: row.joinedAt,
        };
      })
      .sort((a, b) => Number(b.installed) - Number(a.installed) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    const totalReplays = skills.reduce((sum, skill) => sum + skill.runCount, 0);
    return {
      members,
      installed: members.filter((member) => member.installed).length,
      activeToday: members.filter((member) => member.lastSeenAt && now - member.lastSeenAt < 24 * 60 * 60_000).length,
      workersOn: members.filter((member) => member.workerOn).length,
      skillsShared: skills.length,
      totalReplays,
      topSkills: [...skills]
        .sort((a, b) => b.runCount - a.runCount)
        .slice(0, 5)
        .map((skill) => ({ id: skill._id, name: skill.name, runCount: skill.runCount, publishedBy: people.get(skill.publishedBy)?.name ?? "Someone" })),
    };
  },
});
