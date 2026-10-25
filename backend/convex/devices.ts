import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// Pairing a Mac with a login. The panel, signed in inside the Mac's web view, asks for a token
// once and hands it to the Mac, which sends it as a bearer on every HTTP route. The backend keeps
// only the token's hash, so a copy of the database can't impersonate a Mac; the route resolves the
// hash to the login that paired it and refuses any account that login doesn't own.

const TOKEN_PREFIX = "okd_";
// A token is only ever read in the action runtime, where Web Crypto is available.
const USED_EVERY_MS = 60_000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64url(new Uint8Array(digest));
}

export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length >= 40 && value.length <= 80;
}

// Mints a token for this Mac. Returned once; only its hash is kept.
export const pair = action({
  args: { device: v.string() },
  handler: async (ctx, { device }): Promise<{ token: string; userId: Id<"users"> }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = TOKEN_PREFIX + base64url(bytes);
    await ctx.runMutation(internal.devices.store, { userId, tokenHash: await hashToken(token), device: device.trim().slice(0, 120) || "mac" });
    return { token, userId };
  },
});

export const store = internalMutation({
  args: { userId: v.id("users"), tokenHash: v.string(), device: v.string() },
  handler: async (ctx, { userId, tokenHash, device }) => {
    const now = Date.now();
    await ctx.db.insert("deviceTokens", { tokenHash, userId, device, createdAt: now, lastUsedAt: now, revokedAt: null });
  },
});

// The login behind a token, or null. Marks the token used at most once a minute.
export const resolve = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("deviceTokens")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (!row || row.revokedAt) return null;
    const now = Date.now();
    if (now - row.lastUsedAt > USED_EVERY_MS) await ctx.db.patch(row._id, { lastUsedAt: now });
    return { userId: row.userId, device: row.device };
  },
});

/**
 * Whether the login behind a token owns the account named in a request. An account nobody has
 * claimed yet (a Mac added it a moment ago) becomes this login's, which is what the panel's
 * `accounts.claim` would do next; one that belongs to another login is refused.
 */
export const owns = internalMutation({
  args: { userId: v.id("users"), accountId: v.string() },
  handler: async (ctx, { userId, accountId }) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_client", (q) => q.eq("clientId", accountId))
      .first();
    if (!account) return true;
    if (account.ownerId === userId) return true;
    if (account.ownerId) return false;
    await ctx.db.patch(account._id, { ownerId: userId });
    return true;
  },
});

// This login's paired Macs, for the panel.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows
      .filter((row) => !row.revokedAt)
      .map((row) => ({ id: row._id, device: row.device, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  },
});

export const revoke = mutation({
  args: { tokenId: v.id("deviceTokens") },
  handler: async (ctx, { tokenId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in first");
    const row = await ctx.db.get(tokenId);
    if (!row || row.userId !== userId || row.revokedAt) return;
    await ctx.db.patch(row._id, { revokedAt: Date.now() });
  },
});

// Signing out on a Mac retires the token it was using, by the token itself.
export const revokeByHash = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("deviceTokens")
      .withIndex("by_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (row && !row.revokedAt) await ctx.db.patch(row._id, { revokedAt: Date.now() });
  },
});
