import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { activeMembership } from "./orgs";
import { orgForAccount, peopleIn, spaceAccess, spaceMemberOf } from "./spaces";

// The vault: an organization's documents and logins. Everything answers only active members;
// a file or login scoped to a space answers only that space's members. Passwords arrive and
// leave as ciphertext — the browser holds the vault passphrase, this deployment never does.

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** May the caller see things scoped to this space? Org-wide things need only org membership. */
async function mayRead(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces"> | null, userId: Id<"users">): Promise<boolean> {
  if (!spaceId) return true;
  return Boolean(await spaceMemberOf(ctx, spaceId, userId));
}

async function requireScope(ctx: MutationCtx, accountId: string, spaceId: Id<"spaces"> | null) {
  const link = await orgForAccount(ctx, accountId);
  if (!link) throw new Error("link this account to an organization first");
  if (spaceId) {
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member || access.space.orgId !== link.orgId) throw new Error("join the space first");
  }
  return link;
}

function isAdmin(role: string) {
  return role === "owner" || role === "admin";
}

// ---- Documents ----

export const files = query({
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
    const rows = await ctx.db
      .query("spaceFiles")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const out = [];
    for (const row of rows) {
      if (!(await mayRead(ctx, row.spaceId, link.userId))) continue;
      out.push({
        id: row._id,
        spaceId: row.spaceId,
        spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? "a space") : "",
        name: row.name,
        size: row.size,
        mime: row.mime,
        url: await ctx.storage.getUrl(row.storageId),
        uploadedBy: people.get(row.uploadedBy)?.name ?? "Someone",
        canDelete: row.uploadedBy === link.userId || isAdmin(link.role),
        createdAt: row.createdAt,
        order: row._creationTime,
      });
    }
    // Newest first. Two files saved in the same millisecond keep the order they were saved in.
    out.sort((a, b) => b.createdAt - a.createdAt || b.order - a.order);
    return out.map(({ order: _order, ...file }) => file);
  },
});

export const uploadUrl = mutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    await requireScope(ctx, accountId, null);
    return await ctx.storage.generateUploadUrl();
  },
});

export const saveFile = mutation({
  args: { accountId: v.string(), spaceId: v.union(v.id("spaces"), v.null()), storageId: v.id("_storage"), name: v.string(), size: v.number(), mime: v.string() },
  handler: async (ctx, { accountId, spaceId, storageId, name, size, mime }) => {
    const link = await requireScope(ctx, accountId, spaceId);
    const cleanName = name.trim().slice(0, 200);
    if (!cleanName) throw new Error("the file needs a name");
    if (size > MAX_FILE_BYTES) {
      await ctx.storage.delete(storageId);
      throw new Error("files up to 50 MB only");
    }
    const id = await ctx.db.insert("spaceFiles", { orgId: link.orgId, spaceId, storageId, name: cleanName, size, mime: mime.slice(0, 120), uploadedBy: link.userId, createdAt: Date.now() });
    return { id };
  },
});

export const deleteFile = mutation({
  args: { fileId: v.id("spaceFiles") },
  handler: async (ctx, { fileId }) => {
    const row = await ctx.db.get(fileId);
    if (!row) return;
    const me = await activeMembership(ctx, row.orgId);
    if (!me) throw new Error("you're not in that organization");
    if (row.uploadedBy !== me.userId && !isAdmin(me.role)) throw new Error("only the uploader or an admin can delete it");
    await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
  },
});

// Drops a file into a space's chat as a file line.
export const shareFile = mutation({
  args: { fileId: v.id("spaceFiles"), spaceId: v.id("spaces") },
  handler: async (ctx, { fileId, spaceId }) => {
    const row = await ctx.db.get(fileId);
    if (!row) throw new Error("that file is gone");
    const access = await spaceAccess(ctx, spaceId);
    if (!access?.member || access.space.orgId !== row.orgId) throw new Error("join the space first");
    if (row.spaceId && row.spaceId !== spaceId) throw new Error("that file belongs to another space");
    const now = Date.now();
    await ctx.db.insert("spaceMessages", { spaceId, authorId: access.userId, author: "user", kind: "file", text: row.name, runId: null, fileId: row._id, createdAt: now });
    await ctx.db.patch(spaceId, { lastMessageAt: now, lastMessage: `📎 ${row.name}` });
    await ctx.db.patch(access.member._id, { lastReadAt: now });
  },
});

// ---- Credentials ----

function credentialView(row: Doc<"spaceCredentials">, people: Map<string, { name: string }>, me: Id<"users">, admin: boolean, spaceNames: Map<string, string>) {
  return {
    id: row._id,
    spaceId: row.spaceId,
    spaceName: row.spaceId ? (spaceNames.get(row.spaceId) ?? "a space") : "",
    site: row.site,
    username: row.username,
    ciphertext: row.ciphertext,
    iv: row.iv,
    keyVersion: row.keyVersion,
    note: row.note,
    createdBy: people.get(row.createdBy)?.name ?? "Someone",
    canEdit: row.createdBy === me || admin,
    lastUsedAt: row.lastUsedAt,
    lastUsedBy: row.lastUsedBy ? (people.get(row.lastUsedBy)?.name ?? "Someone") : "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const credentials = query({
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
    const rows = await ctx.db
      .query("spaceCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", link.orgId))
      .collect();
    const out = [];
    for (const row of rows) {
      if (!(await mayRead(ctx, row.spaceId, link.userId))) continue;
      out.push(credentialView(row, people, link.userId, isAdmin(link.role), spaceNames));
    }
    out.sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username));
    return out;
  },
});

export const saveCredential = mutation({
  args: {
    accountId: v.string(),
    credentialId: v.optional(v.id("spaceCredentials")),
    spaceId: v.union(v.id("spaces"), v.null()),
    site: v.string(),
    username: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    keyVersion: v.number(),
    note: v.string(),
  },
  handler: async (ctx, { accountId, credentialId, spaceId, site, username, ciphertext, iv, keyVersion, note }) => {
    const link = await requireScope(ctx, accountId, spaceId);
    const cleanSite = site.trim().slice(0, 200);
    const cleanUser = username.trim().slice(0, 200);
    if (!cleanSite) throw new Error("say which site or tool this is for");
    if (!ciphertext || !iv) throw new Error("the password didn't encrypt");
    if (ciphertext.length > 20_000) throw new Error("that secret is too long");
    const now = Date.now();
    if (credentialId) {
      const row = await ctx.db.get(credentialId);
      if (!row || row.orgId !== link.orgId) throw new Error("that login is gone");
      if (row.createdBy !== link.userId && !isAdmin(link.role)) throw new Error("only whoever added it or an admin can change it");
      await ctx.db.patch(row._id, { spaceId, site: cleanSite, username: cleanUser, ciphertext, iv, keyVersion, note: note.slice(0, 500), updatedAt: now });
      return { id: row._id };
    }
    const id = await ctx.db.insert("spaceCredentials", {
      orgId: link.orgId,
      spaceId,
      site: cleanSite,
      username: cleanUser,
      ciphertext,
      iv,
      keyVersion,
      note: note.slice(0, 500),
      createdBy: link.userId,
      lastUsedAt: null,
      lastUsedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  },
});

export const deleteCredential = mutation({
  args: { credentialId: v.id("spaceCredentials") },
  handler: async (ctx, { credentialId }) => {
    const row = await ctx.db.get(credentialId);
    if (!row) return;
    const me = await activeMembership(ctx, row.orgId);
    if (!me) throw new Error("you're not in that organization");
    if (row.createdBy !== me.userId && !isAdmin(me.role)) throw new Error("only whoever added it or an admin can delete it");
    await ctx.db.delete(row._id);
  },
});

// Someone revealed or copied the secret; the vault shows who used it last.
export const touchCredential = mutation({
  args: { credentialId: v.id("spaceCredentials") },
  handler: async (ctx, { credentialId }) => {
    const row = await ctx.db.get(credentialId);
    if (!row) return;
    const me = await activeMembership(ctx, row.orgId);
    if (!me || !(await mayRead(ctx, row.spaceId, me.userId))) return;
    await ctx.db.patch(row._id, { lastUsedAt: Date.now(), lastUsedBy: me.userId });
  },
});

// ---- The Mac adding a document itself (a form it found on the web), over the sync secret ----
// The account's active membership stands in for the signed-in user: the Mac proves the account is
// linked by holding the deployment's secret, the same way its worker takes jobs.

async function memberFor(ctx: MutationCtx, accountId: string): Promise<Doc<"memberships"> | null> {
  const link = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountClientId", accountId))
    .first();
  return link && link.status === "active" ? link : null;
}

const loose = (name: string) => name.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, " ").trim();

export const uploadUrlForAccount = internalMutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    if (!(await memberFor(ctx, accountId))) return { ok: false as const, reason: "link this account to an organization first" };
    return { ok: true as const, url: await ctx.storage.generateUploadUrl() };
  },
});

export const saveFileForAccount = internalMutation({
  args: { accountId: v.string(), space: v.string(), storageId: v.id("_storage"), name: v.string(), mime: v.string() },
  handler: async (ctx, { accountId, space, storageId, name, mime }) => {
    const fail = async (reason: string) => {
      await ctx.storage.delete(storageId);
      return { ok: false as const, reason };
    };
    const link = await memberFor(ctx, accountId);
    if (!link) return await fail("link this account to an organization first");
    const cleanName = name.trim().slice(0, 200);
    if (!cleanName) return await fail("the file needs a name");
    const stored = await ctx.db.system.get(storageId);
    if (!stored) return { ok: false as const, reason: "the upload didn't arrive" };
    if (stored.size > MAX_FILE_BYTES) return await fail("files up to 50 MB only");

    // A space named loosely ("compliance", "#Compliance"); nothing named means the whole organization.
    let spaceId: Id<"spaces"> | null = null;
    let spaceName = "";
    if (space.trim()) {
      const wanted = loose(space);
      const spaces = await ctx.db.query("spaces").withIndex("by_org", (q) => q.eq("orgId", link.orgId)).collect();
      const found = spaces.find((s) => loose(s.name) === wanted) ?? spaces.find((s) => loose(s.name).includes(wanted) || wanted.includes(loose(s.name)));
      if (!found) return await fail(`there's no space called “${space.trim()}”`);
      const members = await ctx.db.query("spaceMembers").withIndex("by_space", (q) => q.eq("spaceId", found._id)).collect();
      if (!members.some((m) => m.userId === link.userId)) return await fail(`join #${found.name} first`);
      spaceId = found._id;
      spaceName = found.name;
    }

    // A fresh copy of the same document replaces the old one in the same place: forms get revised.
    // Only one's own copies, though (an admin's, anyone's): a colleague's file isn't overwritten by name.
    const admin = link.role === "owner" || link.role === "admin";
    const existing = await ctx.db.query("spaceFiles").withIndex("by_org", (q) => q.eq("orgId", link.orgId)).collect();
    const same = existing.filter((f) => f.spaceId === spaceId && f.name.toLowerCase() === cleanName.toLowerCase() && (admin || f.uploadedBy === link.userId));
    for (const old of same) {
      await ctx.storage.delete(old.storageId);
      await ctx.db.delete(old._id);
    }
    const now = Date.now();
    const id = await ctx.db.insert("spaceFiles", { orgId: link.orgId, spaceId, storageId, name: cleanName, size: stored.size, mime: mime.slice(0, 120) || "application/octet-stream", uploadedBy: link.userId, createdAt: now });
    if (spaceId) {
      await ctx.db.insert("spaceMessages", { spaceId, authorId: link.userId, author: "agent", kind: "file", text: cleanName, runId: null, fileId: id, createdAt: now });
      await ctx.db.patch(spaceId, { lastMessageAt: now, lastMessage: `📎 ${cleanName}` });
    }
    return { ok: true as const, id, spaceName, replaced: same.length > 0, size: stored.size, url: await ctx.storage.getUrl(storageId) };
  },
});
