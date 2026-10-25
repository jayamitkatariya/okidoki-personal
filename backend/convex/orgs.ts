import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedAccount } from "./accounts";
import { welcomeMember } from "./enterprise";

// Organizations and memberships for the enterprise side. A login can belong to several
// organizations; each of its Mac work accounts links to at most one of them. Everything an
// organization holds (spaces, files, credentials…) answers only its active members.

export type Role = "owner" | "admin" | "member" | "agent";
const ROLES: Role[] = ["owner", "admin", "member", "agent"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DAY = 24 * 60 * 60_000;

function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}

function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "").slice(0, 120);
}

function domainOf(email: string | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  return at < 0 ? "" : email!.slice(at + 1).toLowerCase();
}

function randomCode(): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("sign in first");
  return userId;
}

/** The signed-in user's active membership in an organization, or null. */
export async function activeMembership(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<Doc<"memberships"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  return rows.find((row) => row.orgId === orgId && row.status === "active") ?? null;
}

async function requireAdmin(ctx: MutationCtx, orgId: Id<"organizations">): Promise<Doc<"memberships">> {
  const membership = await activeMembership(ctx, orgId);
  if (!membership || !isAdmin(membership.role)) throw new Error("only an owner or admin can do that");
  return membership;
}

async function summary(ctx: QueryCtx | MutationCtx, org: Doc<"organizations">, role: string) {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", org._id))
    .collect();
  return {
    id: org._id,
    name: org.name,
    domain: org.domain,
    plan: org.plan,
    createdAt: org.createdAt,
    role,
    memberCount: members.filter((row) => row.status === "active").length,
    welcome: org.welcome ?? "",
  };
}

async function memberView(ctx: QueryCtx | MutationCtx, row: Doc<"memberships">, me: Id<"users">) {
  const user = await ctx.db.get(row.userId);
  const account = row.accountClientId
    ? await ctx.db
        .query("accounts")
        .withIndex("by_client", (q) => q.eq("clientId", row.accountClientId!))
        .first()
    : null;
  const email = user?.email ?? "";
  return {
    id: row._id,
    userId: row.userId,
    name: account?.name || user?.name || email.split("@")[0] || "Someone",
    email,
    role: row.role,
    status: row.status,
    accountName: account?.name ?? "",
    colorHex: account?.colorHex ?? "",
    joinedAt: row.joinedAt,
    isYou: row.userId === me,
  };
}

// The organization this work account is linked to, with what the caller may see of it.
export const forAccount = query({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const link = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
      .first();
    if (!link || link.userId !== userId || link.status !== "active") return null;
    const org = await ctx.db.get(link.orgId);
    if (!org) return null;
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const admin = isAdmin(link.role);
    const members = [];
    const pending = [];
    for (const row of rows) {
      const view = await memberView(ctx, row, userId);
      if (row.status === "active") members.push(view);
      else if (admin) pending.push(view);
    }
    members.sort((a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || a.joinedAt - b.joinedAt);
    const now = Date.now();
    const codes = admin
      ? (
          await ctx.db
            .query("joinCodes")
            .withIndex("by_org", (q) => q.eq("orgId", org._id))
            .collect()
        )
          .filter((code) => !code.revoked && code.expiresAt > now && code.uses < code.maxUses)
          .map((code) => ({ id: code._id, code: code.code, expiresAt: code.expiresAt, uses: code.uses, maxUses: code.maxUses, createdAt: code.createdAt }))
      : [];
    return { org: await summary(ctx, org, link.role), role: link.role, members, pending, codes };
  },
});

// Every organization this login belongs to, so another work account can link to one of them.
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const out = [];
    for (const row of rows) {
      const org = await ctx.db.get(row.orgId);
      if (!org) continue;
      out.push({ ...(await summary(ctx, org, row.role)), status: row.status, linkedAccountId: row.accountClientId });
    }
    return out;
  },
});

// An organization that takes join requests from this login's email domain, if there is one.
export const byMyDomain = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    const domain = domainOf(user?.email);
    if (!domain) return null;
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
    return org ? await summary(ctx, org, "") : null;
  },
});

export const create = mutation({
  args: { name: v.string(), domain: v.string(), accountId: v.string() },
  handler: async (ctx, { name, domain, accountId }) => {
    const userId = await requireUser(ctx);
    if (!(await ownedAccount(ctx, accountId))) throw new Error("that account isn't linked to this login");
    const cleanName = name.trim().slice(0, 120);
    if (!cleanName) throw new Error("give the organization a name");
    const cleanedDomain = cleanDomain(domain);
    if (cleanedDomain) {
      const existing = await ctx.db
        .query("organizations")
        .withIndex("by_domain", (q) => q.eq("domain", cleanedDomain))
        .first();
      if (existing) throw new Error(`${cleanedDomain} already belongs to ${existing.name}`);
    }
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", { name: cleanName, domain: cleanedDomain, plan: "team", createdBy: userId, createdAt: now });
    await unlinkAccount(ctx, accountId);
    await ctx.db.insert("memberships", { orgId, userId, role: "owner", status: "active", accountClientId: accountId, joinedAt: now });
    await welcomeMember(ctx, orgId, userId);
    return { orgId };
  },
});

export const rename = mutation({
  args: { orgId: v.id("organizations"), name: v.string(), domain: v.string() },
  handler: async (ctx, { orgId, name, domain }) => {
    await requireAdmin(ctx, orgId);
    const cleanName = name.trim().slice(0, 120);
    if (!cleanName) throw new Error("give the organization a name");
    const cleanedDomain = cleanDomain(domain);
    if (cleanedDomain) {
      const existing = await ctx.db
        .query("organizations")
        .withIndex("by_domain", (q) => q.eq("domain", cleanedDomain))
        .first();
      if (existing && existing._id !== orgId) throw new Error(`${cleanedDomain} already belongs to ${existing.name}`);
    }
    await ctx.db.patch(orgId, { name: cleanName, domain: cleanedDomain });
  },
});

// A membership links to one work account; linking a new one releases the old one.
async function unlinkAccount(ctx: MutationCtx, accountId: string) {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
    .collect();
  for (const row of rows) await ctx.db.patch(row._id, { accountClientId: null });
}

export const link = mutation({
  args: { orgId: v.id("organizations"), accountId: v.string() },
  handler: async (ctx, { orgId, accountId }) => {
    if (!(await ownedAccount(ctx, accountId))) throw new Error("that account isn't linked to this login");
    const membership = await activeMembership(ctx, orgId);
    if (!membership) throw new Error("you're not a member of that organization");
    await unlinkAccount(ctx, accountId);
    await ctx.db.patch(membership._id, { accountClientId: accountId });
  },
});

export const unlink = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
      .collect();
    for (const row of rows) if (row.userId === userId) await ctx.db.patch(row._id, { accountClientId: null });
  },
});

export const join = mutation({
  args: { code: v.string(), accountId: v.string() },
  handler: async (ctx, { code, accountId }) => {
    const userId = await requireUser(ctx);
    if (!(await ownedAccount(ctx, accountId))) throw new Error("that account isn't linked to this login");
    const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const row = await ctx.db
      .query("joinCodes")
      .withIndex("by_code", (q) => q.eq("code", cleaned))
      .first();
    if (!row || row.revoked || row.expiresAt < Date.now() || row.uses >= row.maxUses) throw new Error("that code isn't valid any more");
    const org = await ctx.db.get(row.orgId);
    if (!org) throw new Error("that organization is gone");
    await unlinkAccount(ctx, accountId);
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const mine = existing.find((item) => item.orgId === org._id);
    if (mine) {
      await ctx.db.patch(mine._id, { status: "active", accountClientId: accountId });
    } else {
      await ctx.db.insert("memberships", { orgId: org._id, userId, role: "member", status: "active", accountClientId: accountId, joinedAt: Date.now() });
    }
    await ctx.db.patch(row._id, { uses: row.uses + 1 });
    await welcomeMember(ctx, org._id, userId);
    return { orgId: org._id, name: org.name };
  },
});

// Ask to join the organization that owns this login's email domain. An admin approves it.
export const requestByDomain = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const userId = await requireUser(ctx);
    if (!(await ownedAccount(ctx, accountId))) throw new Error("that account isn't linked to this login");
    const user = await ctx.db.get(userId);
    const domain = domainOf(user?.email);
    const org = domain
      ? await ctx.db
          .query("organizations")
          .withIndex("by_domain", (q) => q.eq("domain", domain))
          .first()
      : null;
    if (!org) throw new Error("no organization takes requests from that email domain");
    const existing = (
      await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    ).find((item) => item.orgId === org._id);
    if (existing) {
      if (existing.status === "active") {
        await unlinkAccount(ctx, accountId);
        await ctx.db.patch(existing._id, { accountClientId: accountId });
        return { status: "active", name: org.name };
      }
      await unlinkAccount(ctx, accountId);
      await ctx.db.patch(existing._id, { accountClientId: accountId });
      return { status: "pending", name: org.name };
    }
    await unlinkAccount(ctx, accountId);
    await ctx.db.insert("memberships", { orgId: org._id, userId, role: "member", status: "pending", accountClientId: accountId, joinedAt: Date.now() });
    return { status: "pending", name: org.name };
  },
});

export const approve = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, { membershipId }) => {
    const row = await ctx.db.get(membershipId);
    if (!row) return;
    await requireAdmin(ctx, row.orgId);
    await ctx.db.patch(row._id, { status: "active", joinedAt: Date.now() });
    await welcomeMember(ctx, row.orgId, row.userId);
  },
});

export const decline = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, { membershipId }) => {
    const row = await ctx.db.get(membershipId);
    if (!row || row.status !== "pending") return;
    await requireAdmin(ctx, row.orgId);
    await ctx.db.delete(row._id);
  },
});

export const setRole = mutation({
  args: { membershipId: v.id("memberships"), role: v.string() },
  handler: async (ctx, { membershipId, role }) => {
    if (!isRole(role)) throw new Error("unknown role");
    const row = await ctx.db.get(membershipId);
    if (!row) return;
    const me = await requireAdmin(ctx, row.orgId);
    if (row.role === "owner" && me.role !== "owner") throw new Error("only an owner can change an owner");
    if (role === "owner" && me.role !== "owner") throw new Error("only an owner can make another owner");
    if (row.role === "owner" && role !== "owner" && (await ownerCount(ctx, row.orgId)) <= 1) throw new Error("an organization needs at least one owner");
    await ctx.db.patch(row._id, { role });
  },
});

async function ownerCount(ctx: MutationCtx, orgId: Id<"organizations">): Promise<number> {
  const rows = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return rows.filter((row) => row.status === "active" && row.role === "owner").length;
}

export const remove = mutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, { membershipId }) => {
    const row = await ctx.db.get(membershipId);
    if (!row) return;
    const me = await requireAdmin(ctx, row.orgId);
    if (row.userId === me.userId) throw new Error("leave the organization instead");
    if (row.role === "owner" && me.role !== "owner") throw new Error("only an owner can remove an owner");
    await ctx.db.delete(row._id);
  },
});

export const leave = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const membership = await activeMembership(ctx, orgId);
    if (!membership) return;
    if (membership.role === "owner" && (await ownerCount(ctx, orgId)) <= 1) throw new Error("make someone else an owner first");
    await ctx.db.delete(membership._id);
  },
});

export const createCode = mutation({
  args: { orgId: v.id("organizations"), days: v.number(), maxUses: v.number() },
  handler: async (ctx, { orgId, days, maxUses }) => {
    const me = await requireAdmin(ctx, orgId);
    let code = randomCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await ctx.db
        .query("joinCodes")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (!clash) break;
      code = randomCode();
    }
    const now = Date.now();
    await ctx.db.insert("joinCodes", {
      code,
      orgId,
      spaceId: null,
      createdBy: me.userId,
      createdAt: now,
      expiresAt: now + Math.max(1, Math.min(90, Math.round(days))) * DAY,
      uses: 0,
      maxUses: Math.max(1, Math.min(500, Math.round(maxUses))),
      revoked: false,
    });
    return { code };
  },
});

export const revokeCode = mutation({
  args: { codeId: v.id("joinCodes") },
  handler: async (ctx, { codeId }) => {
    const row = await ctx.db.get(codeId);
    if (!row) return;
    await requireAdmin(ctx, row.orgId);
    await ctx.db.patch(row._id, { revoked: true });
  },
});
