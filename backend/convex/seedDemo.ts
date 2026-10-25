import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { createJob, mentionsAgent } from "./jobs";

// Seeds the Meridian Trade Services demo (a U.S. customs brokerage) onto the organization a Mac work
// account is linked to. Internal: run it with the deploy key,
//   npx convex run seedDemo:meridian '{"accountId": "…", "skill": {…}}'
// (scripts/demo-meridian/seed.ts does). Safe to run again: everything is added only once.

const COLLEAGUES = [
  { name: "Priya Shah", email: "priya.shah@meridiantrade.test", role: "admin" },
  { name: "Marcus Lee", email: "marcus.lee@meridiantrade.test", role: "member" },
  { name: "Elena Ruiz", email: "elena.ruiz@meridiantrade.test", role: "member" },
];

const SPACES = [
  { name: "Entries", colorHex: "1F6FEB", people: ["Priya Shah", "Marcus Lee", "Elena Ruiz"] },
  { name: "Compliance", colorHex: "F59E0B", people: ["Priya Shah", "Marcus Lee"] },
  { name: "Lakeshore Electronics", colorHex: "14B8A6", people: ["Elena Ruiz", "Priya Shah"] },
];

// [space, author ("me" for the linked account), minutes ago, text]
const CHAT: [string, string, number, string][] = [
  ["Entries", "Priya Shah", 190, "Lakeshore has two containers landing at Newark this week: MTS-4471 (240 Quanta notebooks, MAEU) and MTS-4472 (Li-ion packs out of Penang, ONEY). Invoices and packing lists are in the vault."],
  ["Entries", "Marcus Lee", 150, "Harborview's truck from Toronto crossed at the Peace Bridge this morning, MTS-4473. Northern Polymer sent the USMCA certification, so it goes in with SPI S."],
  ["Entries", "me", 120, "Thanks. I'll get all three 7501s out today."],
  ["Compliance", "Marcus Lee", 300, "Reminder: FY2027 user fees are live since Oct 1 (CBP Dec. 26-14). MPF stays 0.3464%, now min $34.58 / max $670.86. The workbench is updated."],
  ["Compliance", "Priya Shah", 45, "Can someone pull the current CBP 3461 into the Compliance vault? We don't have it on file."],
  ["Lakeshore Electronics", "Elena Ruiz", 95, "Lakeshore's ops team wants the entry numbers for 4471 and 4472 by end of day for their ERP."],
];

async function userFor(ctx: MutationCtx, name: string, email: string): Promise<Id<"users">> {
  const existing = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).first();
  return existing?._id ?? (await ctx.db.insert("users", { name, email }));
}

export const meridian = internalMutation({
  args: {
    accountId: v.string(),
    orgName: v.optional(v.string()),
    skill: v.optional(v.object({ id: v.string(), name: v.string(), summary: v.string(), steps: v.any() })),
    // Vault documents to take out (by name), so the demo can add them live again.
    forget: v.optional(v.array(v.string())),
    // Clear the demo spaces' chat and jobs first, so a rehearsal's leftovers don't show.
    fresh: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountId, orgName, skill, forget, fresh }) => {
    const link = await ctx.db.query("memberships").withIndex("by_account", (q) => q.eq("accountClientId", accountId)).first();
    if (!link || link.status !== "active") throw new Error("that work account isn't linked to an organization");
    const orgId = link.orgId;
    const me = link.userId;
    const now = Date.now();
    await ctx.db.patch(orgId, { name: orgName ?? "Meridian Trade Services" });

    const people = new Map<string, Id<"users">>([["me", me]]);
    for (const person of COLLEAGUES) {
      const userId = await userFor(ctx, person.name, person.email);
      people.set(person.name, userId);
      const memberships = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
      if (!memberships.some((m) => m.orgId === orgId)) {
        await ctx.db.insert("memberships", { orgId, userId, role: person.role, status: "active", accountClientId: null, joinedAt: now - 86_400_000 * 40 });
      }
    }

    const existing = await ctx.db.query("spaces").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
    // The org's first space was a placeholder; it becomes Entries rather than sitting there empty.
    const placeholder = existing.find((s) => s.name === "Finance");
    if (placeholder && !existing.some((s) => s.name === "Entries")) await ctx.db.patch(placeholder._id, { name: "Entries", colorHex: "1F6FEB" });
    const spaces = new Map<string, Id<"spaces">>();
    for (const space of SPACES) {
      const found = (await ctx.db.query("spaces").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).find((s) => s.name === space.name);
      const spaceId = found?._id ?? (await ctx.db.insert("spaces", {
        orgId, name: space.name, colorHex: space.colorHex, workerPolicy: "thisMac", createdBy: me, createdAt: now - 86_400_000 * 30, lastMessageAt: now, lastMessage: "",
      }));
      spaces.set(space.name, spaceId);
      const members = await ctx.db.query("spaceMembers").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect();
      for (const who of ["me", ...space.people]) {
        const userId = people.get(who)!;
        if (!members.some((m) => m.userId === userId)) {
          await ctx.db.insert("spaceMembers", { spaceId, userId, role: who === "me" ? "owner" : "member", lastReadAt: now - 3_600_000 * 4, joinedAt: now - 86_400_000 * 30 });
        }
      }
    }

    if (fresh) {
      for (const spaceId of spaces.values()) {
        for (const message of await ctx.db.query("spaceMessages").withIndex("by_space_time", (q) => q.eq("spaceId", spaceId)).collect()) await ctx.db.delete(message._id);
        for (const job of await ctx.db.query("spaceRuns").withIndex("by_space", (q) => q.eq("spaceId", spaceId)).collect()) await ctx.db.delete(job._id);
        await ctx.db.patch(spaceId, { lastMessage: "", lastMessageAt: now - 86_400_000 });
      }
    }

    let posted = 0;
    for (const [spaceName, who, minutesAgo, text] of CHAT) {
      const spaceId = spaces.get(spaceName)!;
      const messages = await ctx.db.query("spaceMessages").withIndex("by_space_time", (q) => q.eq("spaceId", spaceId)).collect();
      if (messages.some((m) => m.text === text)) continue;
      const at = now - minutesAgo * 60_000;
      await ctx.db.insert("spaceMessages", { spaceId, authorId: people.get(who)!, author: "user", kind: "text", text, runId: null, fileId: null, createdAt: at });
      const space = await ctx.db.get(spaceId);
      if (space && at >= space.lastMessageAt - 1) await ctx.db.patch(spaceId, { lastMessageAt: at, lastMessage: text.slice(0, 140) });
      posted += 1;
    }

    let forgotten = 0;
    if (forget?.length) {
      const files = await ctx.db.query("spaceFiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      for (const file of files.filter((f) => forget.includes(f.name))) {
        await ctx.storage.delete(file.storageId);
        await ctx.db.delete(file._id);
        forgotten += 1;
      }
    }

    let published = "";
    if (skill) {
      const rows = await ctx.db.query("spaceSkills").withIndex("by_source", (q) => q.eq("sourceSkillId", skill.id)).collect();
      const row = rows.find((r) => r.orgId === orgId && r.spaceId === null);
      const requires = [...new Set((skill.steps as { app?: string }[]).map((s) => s.app ?? "").filter((a) => a && a !== "mac"))].sort();
      if (row) {
        await ctx.db.patch(row._id, { name: skill.name, summary: skill.summary, steps: skill.steps, requires, updatedAt: now });
      } else {
        await ctx.db.insert("spaceSkills", {
          orgId, spaceId: null, sourceSkillId: skill.id, name: skill.name, summary: skill.summary, steps: skill.steps, requires,
          publishedBy: me, version: 1, runCount: 0, history: [], createdAt: now, updatedAt: now,
        });
      }
      published = skill.name;
    }
    return { org: orgName ?? "Meridian Trade Services", colleagues: COLLEAGUES.length, spaces: [...spaces.keys()], posted, published, forgotten };
  },
});

// Rehearsal: what typing into a space's chat does, as the account's linked member. "@okidoki …"
// becomes a job exactly as it would from the panel.
//   npx convex run seedDemo:say '{"accountId": "…", "space": "Entries", "text": "@okidoki file the entry for MTS-4472"}'
export const say = internalMutation({
  args: { accountId: v.string(), space: v.string(), text: v.string() },
  handler: async (ctx, { accountId, space, text }) => {
    const link = await ctx.db.query("memberships").withIndex("by_account", (q) => q.eq("accountClientId", accountId)).first();
    if (!link || link.status !== "active") throw new Error("that work account isn't linked to an organization");
    const found = (await ctx.db.query("spaces").withIndex("by_org", (q) => q.eq("orgId", link.orgId)).collect())
      .find((s) => s.name.toLowerCase() === space.trim().replace(/^#/, "").toLowerCase());
    if (!found) throw new Error(`no space called ${space}`);
    const now = Date.now();
    const cleaned = text.trim().slice(0, 4000);
    await ctx.db.insert("spaceMessages", { spaceId: found._id, authorId: link.userId, author: "user", kind: "text", text: cleaned, runId: null, fileId: null, createdAt: now });
    await ctx.db.patch(found._id, { lastMessageAt: now, lastMessage: cleaned.slice(0, 120) });
    const jobId = mentionsAgent(cleaned) ? await createJob(ctx, found, link.userId, cleaned) : null;
    return { jobId };
  },
});

// The paperwork arrives before the conversation about it: file lines the seed's uploads posted are
// moved to just before the first seeded message, keeping their order.
export const settleFiles = internalMutation({
  args: { accountId: v.string() },
  handler: async (ctx, { accountId }) => {
    const link = await ctx.db.query("memberships").withIndex("by_account", (q) => q.eq("accountClientId", accountId)).first();
    if (!link || link.status !== "active") throw new Error("that work account isn't linked to an organization");
    const now = Date.now();
    const start = now - (Math.max(...CHAT.map((line) => line[2])) + 30) * 60_000;
    let moved = 0;
    for (const space of await ctx.db.query("spaces").withIndex("by_org", (q) => q.eq("orgId", link.orgId)).collect()) {
      if (!SPACES.some((s) => s.name === space.name)) continue;
      const messages = await ctx.db.query("spaceMessages").withIndex("by_space_time", (q) => q.eq("spaceId", space._id)).collect();
      const files = messages.filter((m) => m.kind === "file");
      for (const [i, file] of files.entries()) {
        await ctx.db.patch(file._id, { createdAt: start + i * 1000 });
        moved += 1;
      }
      const latest = (await ctx.db.query("spaceMessages").withIndex("by_space_time", (q) => q.eq("spaceId", space._id)).order("desc").first());
      if (latest) await ctx.db.patch(space._id, { lastMessageAt: latest.createdAt, lastMessage: latest.kind === "file" ? `📎 ${latest.text}` : latest.text.slice(0, 140) });
    }
    return { moved };
  },
});
