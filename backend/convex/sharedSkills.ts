import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { activeMembership } from "./orgs";
import { orgForAccount, peopleIn, spaceAccess } from "./spaces";

// Skills shared inside an organization. A member publishes one of their recorded skills to a
// space or to everyone; colleagues pull it onto their own Macs and replay it there.

const HISTORY = 5;
const MAX_STEPS = 400;

const stepValidator = v.any();

export function requiredApps(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const apps = new Set<string>();
  for (const step of steps) {
    const app = step && typeof step === "object" ? (step as { app?: unknown }).app : null;
    if (typeof app === "string" && app.trim() && app.trim().toLowerCase() !== "mac") apps.add(app.trim());
  }
  return [...apps].sort((a, b) => a.localeCompare(b));
}

/** Typed values a recording carries become blanks a colleague fills in. Secrets never get this far. */
export function parameterNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];
  for (const step of steps) {
    const input = step && typeof step === "object" ? (step as { action?: unknown; input?: unknown }) : null;
    if (input?.action === "type" && typeof input.input === "string") {
      const match = input.input.match(/\{\{\s*([^}]+?)\s*\}\}/g);
      for (const token of match ?? []) {
        const name = token.replace(/[{}]/g, "").trim();
        if (name && !names.includes(name)) names.push(name);
      }
    }
  }
  return names;
}

async function view(ctx: QueryCtx | MutationCtx, row: Doc<"spaceSkills">, people: Map<string, { name: string }>, me: Id<"users">, admin: boolean, spaceNames: Map<string, string>) {
  return {
    id: row._id,
    spaceId: row.spaceId,
    spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? "a space") : "",
    sourceSkillId: row.sourceSkillId,
    name: row.name,
    summary: row.summary,
    steps: row.steps,
    stepCount: Array.isArray(row.steps) ? row.steps.length : 0,
    requires: row.requires,
    params: parameterNames(row.steps),
    publishedBy: people.get(row.publishedBy)?.name ?? "Someone",
    isMine: row.publishedBy === me,
    canUnpublish: row.publishedBy === me || admin,
    version: row.version,
    versions: Array.isArray(row.history) ? row.history.length + 1 : 1,
    runCount: row.runCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Everything shared in the organization this work account links to: org-wide first, then by space.
export const list = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const link = await orgForAccount(ctx, accountId);
    if (!link) return [];
    const people = await peopleIn(ctx, link.orgId);
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const spaceNames = new Map(spaces.map((space) => [space._id as string, space.name]));
    const admin = link.role === "owner" || link.role === "admin";
    const rows = await ctx.db
      .query("spaceSkills")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const out = [];
    for (const row of rows) out.push(await view(ctx, row, people, link.userId, admin, spaceNames));
    out.sort((a, b) => Number(Boolean(a.spaceId)) - Number(Boolean(b.spaceId)) || b.updatedAt - a.updatedAt);
    return out;
  },
});

export const publish = mutation({
  args: {
    accountId: v.string(),
    spaceId: v.union(v.id("spaces"), v.null()),
    skill: v.object({ id: v.string(), name: v.string(), summary: v.string(), steps: v.array(stepValidator) }),
  },
  handler: async (ctx, { accountId, spaceId, skill }) => {
    const link = await orgForAccount(ctx, accountId);
    if (!link) throw new Error("link this account to an organization first");
    if (spaceId) {
      const access = await spaceAccess(ctx, spaceId);
      if (!access?.member || access.space.orgId !== link.orgId) throw new Error("join the space first");
    }
    const name = skill.name.trim().slice(0, 120);
    if (!name) throw new Error("the skill needs a name");
    if (!skill.steps.length) throw new Error("the skill has no steps");
    const steps = skill.steps.slice(0, MAX_STEPS);
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
        history: [{ version: existing.version, steps: existing.steps, at: existing.updatedAt }, ...history].slice(0, HISTORY),
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

// Puts the previous version back on top. The current one is kept in the history.
export const rollback = mutation({
  args: { sharedId: v.id("spaceSkills") },
  handler: async (ctx, { sharedId }) => {
    const row = await ctx.db.get(sharedId);
    if (!row) return;
    const me = await activeMembership(ctx, row.orgId);
    if (!me) throw new Error("you're not in that organization");
    if (row.publishedBy !== me.userId && !(me.role === "owner" || me.role === "admin")) throw new Error("only the publisher or an admin can do that");
    const history = Array.isArray(row.history) ? row.history : [];
    const previous = history[0];
    if (!previous) throw new Error("there's no earlier version");
    await ctx.db.patch(row._id, {
      steps: previous.steps,
      requires: requiredApps(previous.steps),
      version: row.version + 1,
      history: [{ version: row.version, steps: row.steps, at: row.updatedAt }, ...history.slice(1)].slice(0, HISTORY),
      updatedAt: Date.now(),
    });
  },
});

export const unpublish = mutation({
  args: { sharedId: v.id("spaceSkills") },
  handler: async (ctx, { sharedId }) => {
    const row = await ctx.db.get(sharedId);
    if (!row) return;
    const me = await activeMembership(ctx, row.orgId);
    if (!me) throw new Error("you're not in that organization");
    if (row.publishedBy !== me.userId && !(me.role === "owner" || me.role === "admin")) throw new Error("only the publisher or an admin can do that");
    await ctx.db.delete(row._id);
  },
});

export const recordRun = mutation({
  args: { sharedId: v.id("spaceSkills") },
  handler: async (ctx, { sharedId }) => {
    const row = await ctx.db.get(sharedId);
    if (!row) return;
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await activeMembership(ctx, row.orgId))) return;
    await ctx.db.patch(row._id, { runCount: row.runCount + 1 });
  },
});

/** Shared skills a worker Mac should have on hand for a space: the space's own and the organization's. */
export async function skillsForWorker(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, spaceId: Id<"spaces">) {
  const rows = await ctx.db
    .query("spaceSkills")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return rows
    .filter((row) => row.spaceId === null || row.spaceId === spaceId)
    .slice(0, 50)
    .map((row) => ({ id: row._id, name: row.name, summary: row.summary, steps: row.steps, version: row.version }));
}
