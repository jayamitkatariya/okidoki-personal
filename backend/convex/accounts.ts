import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

// An okidoki account (Personal, Work…) belongs to one signed-in user. Every query that reads an
// account's data goes through here, so nothing is readable without being its owner.
export async function ownedAccount(ctx: QueryCtx, accountId: string) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_client", (q) => q.eq("clientId", accountId))
    .first();
  return account && account.ownerId === userId ? account : null;
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user ? { id: userId, email: user.email ?? "" } : null;
  },
});

// The accounts this user owns, for the hosted panel's account switcher.
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    return accounts.map((account) => ({
      id: account.clientId,
      name: account.name,
      email: account.email,
      kind: account.kind,
      colorHex: account.colorHex,
      createdAt: account.createdAt,
    }));
  },
});

// Called by the panel inside the Mac app right after sign-in: the signed-in user takes ownership
// of this Mac's accounts. An account someone else already owns is left alone.
// Phase 1 trust model: account ids are random UUIDs only the Mac knows. Device pairing replaces this.
export const claim = mutation({
  args: { accounts: v.array(v.object({ id: v.string(), name: v.string(), email: v.string(), kind: v.string(), colorHex: v.string(), createdAt: v.string() })) },
  handler: async (ctx, { accounts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");
    const claimed: string[] = [];
    const taken: string[] = [];
    for (const account of accounts.slice(0, 20)) {
      const existing = await ctx.db
        .query("accounts")
        .withIndex("by_client", (q) => q.eq("clientId", account.id))
        .first();
      if (existing?.ownerId && existing.ownerId !== userId) {
        taken.push(account.id);
        continue;
      }
      if (existing) {
        if (existing.ownerId !== userId) await ctx.db.patch(existing._id, { ownerId: userId });
      } else {
        // Not synced yet: hold the place so the first sync lands under this owner.
        await ctx.db.insert("accounts", {
          clientId: account.id,
          name: account.name,
          email: account.email,
          kind: account.kind,
          colorHex: account.colorHex,
          createdAt: account.createdAt,
          updatedAt: Date.now(),
          ownerId: userId,
        });
      }
      claimed.push(account.id);
    }
    return { claimed, taken };
  },
});
