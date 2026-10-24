import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { activeMembership } from "./orgs";

// Spaces: groups inside an organization. Anyone in the organization can see and join a space;
// its chat, files and jobs answer only members of the space.

const SPACE_COLORS = ["44E45E", "1FB57A", "3DDC97", "0B8A5E", "B8F26B", "8FB7FF", "F2B84B", "E97A6B", "C79BFF"];
const WORKER_POLICIES = ["thisMac", "privateMac", "hostedVM"];

/** The organization this work account is linked to, through the signed-in login. */
export async function orgForAccount(ctx: QueryCtx | MutationCtx, accountId: string): Promise<Doc<"memberships"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const link = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
    .first();
  return link && link.userId === userId && link.status === "active" ? link : null;
}

export interface SpaceAccess {
  space: Doc<"spaces">;
  userId: Id<"users">;
  /** The caller's row in the space, or null when they're in the organization but not the space. */
  member: Doc<"spaceMembers"> | null;
}

/** What the signed-in user may do with a space: null when they're not in its organization. */
export async function spaceAccess(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">): Promise<SpaceAccess | null> {
  const space = await ctx.db.get(spaceId);
  if (!space) return null;
  const membership = await activeMembership(ctx, space.orgId);
  if (!membership) return null;
  const rows = await ctx.db
    .query("spaceMembers")
    .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
    .collect();
  return { space, userId: membership.userId, member: rows.find((row) => row.userId === membership.userId) ?? null };
}

export async function requireSpaceMember(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">): Promise<SpaceAccess & { member: Doc<"spaceMembers"> }> {
  const access = await spaceAccess(ctx, spaceId);
  if (!access?.member) throw new Error("join the space first");
  return access as SpaceAccess & { member: Doc<"spaceMembers"> };
}

/** Display names for everyone in an organization, keyed by user id. */
export async function peopleIn(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const people = new Map<string, { name: string; email: string; colorHex: string }>();
  for (const row of rows) {
    if (row.status !== "active") continue;
    const user = await ctx.db.get(row.userId);
    const account = row.accountClientId
      ? await ctx.db
          .query("accounts")
          .withIndex("by_client", (q) => q.eq("clientId", row.accountClientId!))
          .first()
      : null;
    const email = user?.email ?? "";
    people.set(row.userId, {
      name: account?.name || user?.name || email.split("@")[0] || "Someone",
      email,
      colorHex: account?.colorHex ?? "",
    });
  }
  return people;
}

async function unreadIn(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">, since: number): Promise<number> {
  const rows = await ctx.db
    .query("spaceMessages")
    .withIndex("by_space_time", (q) => q.eq("spaceId", spaceId).gt("createdAt", since))
    .take(100);
  return rows.length;
}

// Every space in the organization this work account links to, with the caller's standing in each.
export const list = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const link = await orgForAccount(ctx, accountId);
    if (!link) return [];
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const people = await peopleIn(ctx, link.orgId);
    const out = [];
    for (const space of spaces) {
      const members = await ctx.db
        .query("spaceMembers")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .collect();
      const mine = members.find((row) => row.userId === link.userId) ?? null;
      out.push({
        id: space._id,
        name: space.name,
        colorHex: space.colorHex,
        workerPolicy: space.workerPolicy,
        createdAt: space.createdAt,
        lastMessageAt: space.lastMessageAt,
        lastMessage: space.lastMessage,
        joined: Boolean(mine),
        role: mine?.role ?? "",
        unread: mine ? await unreadIn(ctx, space._id, mine.lastReadAt) : 0,
        members: members.map((row) => {
          const person = people.get(row.userId);
          return { userId: row.userId, role: row.role, name: person?.name ?? "Someone", email: person?.email ?? "", colorHex: person?.colorHex ?? "", isYou: row.userId === link.userId };
        }),
      });
    }
    out.sort((a, b) => Number(b.joined) - Number(a.joined) || b.lastMessageAt - a.lastMessageAt);
    return out;
  },
});

export const create = mutation({
  args: { accountId: v.string(), name: v.string() },
  handler: async (ctx, { accountId, name }) => {
    const link = await orgForAccount(ctx, accountId);
    if (!link) throw new Error("link this account to an organization first");
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) throw new Error("give the space a name");
    const existing = await ctx.db
      .query("spaces")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const now = Date.now();
    const spaceId = await ctx.db.insert("spaces", {
      orgId: link.orgId,
      name: cleanName,
      colorHex: SPACE_COLORS[existing.length % SPACE_COLORS.length],
      workerPolicy: "thisMac",
      createdBy: link.userId,
      createdAt: now,
      lastMessageAt: now,
      lastMessage: "",
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId: link.userId, role: "owner", lastReadAt: now, joinedAt: now });
    const people = await peopleIn(ctx, link.orgId);
    await ctx.db.insert("spaceMessages", {
      spaceId,
      authorId: null,
      author: "system",
      kind: "system",
      text: `${people.get(link.userId)?.name ?? "Someone"} created the space`,
      runId: null,
      fileId: null,
      createdAt: now,
    });
    return { spaceId };
  },
});

export const join = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access) throw new Error("you're not in that organization");
    if (access.member) return;
    const now = Date.now();
    await ctx.db.insert("spaceMembers", { spaceId, userId: access.userId, role: "member", lastReadAt: now, joinedAt: now });
    const people = await peopleIn(ctx, access.space.orgId);
    await ctx.db.insert("spaceMessages", {
      spaceId,
      authorId: null,
      author: "system",
      kind: "system",
      text: `${people.get(access.userId)?.name ?? "Someone"} joined`,
      runId: null,
      fileId: null,
      createdAt: now,
    });
  },
});

export const leave = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member) return;
    await ctx.db.delete(access.member._id);
    const people = await peopleIn(ctx, access.space.orgId);
    await ctx.db.insert("spaceMessages", {
      spaceId,
      authorId: null,
      author: "system",
      kind: "system",
      text: `${people.get(access.userId)?.name ?? "Someone"} left`,
      runId: null,
      fileId: null,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: { spaceId: v.id("spaces"), name: v.optional(v.string()), workerPolicy: v.optional(v.string()), colorHex: v.optional(v.string()) },
  handler: async (ctx, { spaceId, name, workerPolicy, colorHex }) => {
    const access = await requireSpaceMember(ctx, spaceId);
    const patch: Partial<Doc<"spaces">> = {};
    if (name !== undefined) {
      const cleanName = name.trim().slice(0, 80);
      if (!cleanName) throw new Error("give the space a name");
      patch.name = cleanName;
    }
    if (workerPolicy !== undefined) {
      if (!WORKER_POLICIES.includes(workerPolicy)) throw new Error("unknown worker");
      patch.workerPolicy = workerPolicy;
    }
    if (colorHex !== undefined && /^[0-9A-Fa-f]{6}$/.test(colorHex)) patch.colorHex = colorHex.toUpperCase();
    if (Object.keys(patch).length) await ctx.db.patch(access.space._id, patch);
  },
});

export const remove = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access) throw new Error("you're not in that organization");
    const orgRole = await activeMembership(ctx, access.space.orgId);
    const mayDelete = access.member?.role === "owner" || orgRole?.role === "owner" || orgRole?.role === "admin";
    if (!mayDelete) throw new Error("only the space's owner or an organization admin can delete it");
    const members = await ctx.db
      .query("spaceMembers")
      .withIndex("by_space", (q) => q.eq("spaceId", spaceId))
      .collect();
    for (const row of members) await ctx.db.delete(row._id);
    // Messages go in batches; a long chat is deleted across a few calls from the panel.
    const messages = await ctx.db
      .query("spaceMessages")
      .withIndex("by_space_time", (q) => q.eq("spaceId", spaceId))
      .take(500);
    for (const row of messages) await ctx.db.delete(row._id);
    if (messages.length < 500) await ctx.db.delete(spaceId);
    return { done: messages.length < 500 };
  },
});

export const markRead = mutation({
  args: { spaceId: v.id("spaces") },
  handler: async (ctx, { spaceId }) => {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member) return;
    await ctx.db.patch(access.member._id, { lastReadAt: Date.now() });
  },
});
