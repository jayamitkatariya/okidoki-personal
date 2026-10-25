import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

// The Mac putting a document into the vault itself (a form it found on the web), as the paired
// login's linked member.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;

async function team() {
  const t = convexTest(schema, modules);
  const tokens: Record<string, string> = {};
  const login = async (name: string) => {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name, email: `${name}@meridian.test` }));
    const as = t.withIdentity({ subject: `${userId}|session-${name}` });
    const accountId = `acct-${name}`;
    await as.mutation(api.accounts.claim, { accounts: [{ id: accountId, name, email: `${name}@meridian.test`, kind: "work", colorHex: "44E45E", createdAt: "2026-10-24" }] });
    tokens[accountId] = (await as.action(api.devices.pair, { device: `${name}'s Mac` })).token;
    return { as, accountId };
  };
  const headersFor = (body: unknown) => ({ authorization: `Bearer ${tokens[String((body as { accountId?: unknown })?.accountId)] ?? tokens["acct-jay"]}`, "content-type": "application/json" });
  const jay = await login("jay");
  const sam = await login("sam");
  await jay.as.mutation(api.orgs.create, { name: "Meridian Trade Services", domain: "", accountId: jay.accountId });
  const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
  const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
  await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
  const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Compliance" });
  const post = (path: string, body: unknown, auth?: Record<string, string>) => t.fetch(path, { method: "POST", headers: auth ?? headersFor(body), body: JSON.stringify(body) });
  const pdf = (text: string) => t.run(async (ctx) => ctx.storage.store(new Blob([`%PDF-1.7 ${text}`], { type: "application/pdf" })));
  const headers = headersFor({ accountId: jay.accountId });
  return { t, jay, sam, spaceId, post, pdf, headers };
}

describe("vault from the Mac", () => {
  test("needs a paired Mac and a linked account", async () => {
    const { post, headers } = await team();
    expect((await post("/api/vault/upload-url", { accountId: "acct-jay" }, { ...headers, authorization: "Bearer okd_wrong-token-that-nobody-paired-00000000000" })).status).toBe(401);
    // another login's account, even with a good token
    expect((await post("/api/vault/upload-url", { accountId: "acct-sam" }, headers)).status).toBe(403);
    expect(await (await post("/api/vault/upload-url", { accountId: "acct-nobody" })).json()).toEqual({ ok: false, reason: "link this account to an organization first" });
    const ok = await (await post("/api/vault/upload-url", { accountId: "acct-jay" })).json();
    expect(ok.ok).toBe(true);
    expect(typeof ok.url).toBe("string");
  });

  test("files org-wide or into a space by name, posts it to that space, and replaces an older copy", async () => {
    const { jay, sam, spaceId, post, pdf } = await team();
    const first = await (await post("/api/vault/save", { accountId: jay.accountId, storageId: await pdf("v1"), name: "CBP Form 3461.pdf", mime: "application/pdf", space: "#compliance" })).json();
    expect(first).toMatchObject({ ok: true, spaceName: "Compliance", replaced: false });
    const again = await (await post("/api/vault/save", { accountId: jay.accountId, storageId: await pdf("v2 longer"), name: "CBP Form 3461.pdf", mime: "application/pdf", space: "Compliance" })).json();
    expect(again).toMatchObject({ ok: true, replaced: true });
    const files = await jay.as.query(api.vault.files, { accountId: jay.accountId });
    expect(files.map((f: any) => [f.name, f.spaceName, f.size])).toEqual([["CBP Form 3461.pdf", "Compliance", 18]]);
    const chat = await jay.as.query(api.chat.messages, { spaceId });
    expect(chat.filter((m: any) => m.kind === "file").map((m: any) => m.text)).toEqual(["CBP Form 3461.pdf", "CBP Form 3461.pdf"]);

    const wide = await (await post("/api/vault/save", { accountId: jay.accountId, storageId: await pdf("7501"), name: "CBP Form 7501.pdf", mime: "application/pdf", space: "" })).json();
    expect(wide).toMatchObject({ ok: true, spaceName: "" });
    // Sam isn't in #Compliance: he sees the org-wide form only, and can't file into the space.
    expect((await sam.as.query(api.vault.files, { accountId: sam.accountId })).map((f: any) => f.name)).toEqual(["CBP Form 7501.pdf"]);
    expect(await (await post("/api/vault/save", { accountId: sam.accountId, storageId: await pdf("x"), name: "x.pdf", mime: "application/pdf", space: "compliance" })).json())
      .toEqual({ ok: false, reason: "join #Compliance first" });
    expect(await (await post("/api/vault/save", { accountId: jay.accountId, storageId: await pdf("x"), name: "x.pdf", mime: "application/pdf", space: "Legal" })).json())
      .toEqual({ ok: false, reason: "there's no space called “Legal”" });

    // A plain member's same-named upload sits beside the owner's org-wide form instead of replacing it.
    const beside = await (await post("/api/vault/save", { accountId: sam.accountId, storageId: await pdf("sam's"), name: "CBP Form 7501.pdf", mime: "application/pdf", space: "" })).json();
    expect(beside).toMatchObject({ ok: true, replaced: false });
    const wideNow = (await jay.as.query(api.vault.files, { accountId: jay.accountId })).filter((f: any) => f.name === "CBP Form 7501.pdf");
    expect(wideNow.map((f: any) => f.uploadedBy).sort()).toEqual(["jay", "sam"]);
    // The owner (an admin) revising it replaces both.
    const revised = await (await post("/api/vault/save", { accountId: jay.accountId, storageId: await pdf("7501 v2"), name: "CBP Form 7501.pdf", mime: "application/pdf", space: "" })).json();
    expect(revised).toMatchObject({ ok: true, replaced: true });
    expect((await jay.as.query(api.vault.files, { accountId: jay.accountId })).filter((f: any) => f.name === "CBP Form 7501.pdf")).toHaveLength(1);
  });
});

describe("demo seed", () => {
  test("turns the linked org into Meridian once, however often it runs", async () => {
    const { t, jay, headers } = await team();
    const skill = { id: "skill-ace", name: "file ACE entry", summary: "7501", steps: [{ id: "s1", text: "switch to Safari", app: "Safari", action: "switch" }] };
    const first = await t.mutation(api.seedDemo.meridian, { accountId: jay.accountId, skill });
    const again = await t.mutation(api.seedDemo.meridian, { accountId: jay.accountId, skill });
    expect(first.posted).toBe(6);
    expect(again.posted).toBe(0);
    const view = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(view.org.name).toBe("Meridian Trade Services");
    expect(view.members.map((m: any) => m.name).sort()).toEqual(["Elena Ruiz", "Marcus Lee", "Priya Shah", "jay", "sam"]);
    const shared = await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId });
    expect(shared.map((s: any) => [s.name, s.requires, s.version])).toEqual([["file ACE entry", ["Safari"], 1]]);
    await expect(t.mutation(api.seedDemo.meridian, { accountId: "acct-nobody" })).rejects.toThrow(/isn't linked/);
    const live = await t.run(async (ctx) => ctx.storage.store(new Blob(["%PDF-1.7"], { type: "application/pdf" })));
    await (await t.fetch("/api/vault/save", { method: "POST", headers, body: JSON.stringify({ accountId: jay.accountId, storageId: live, name: "CBP Form 3461 (Entry-Immediate Delivery).pdf", space: "Compliance" }) })).json();
    const reset = await t.mutation(api.seedDemo.meridian, { accountId: jay.accountId, forget: ["CBP Form 3461 (Entry-Immediate Delivery).pdf"] });
    expect(reset.forgotten).toBe(1);
    expect(await jay.as.query(api.vault.files, { accountId: jay.accountId })).toEqual([]);
  });
});

describe("demo seed, fresh", () => {
  test("clears the demo spaces' chat and jobs, then tells the story again", async () => {
    const { t, jay } = await team();
    await t.mutation(api.seedDemo.meridian, { accountId: jay.accountId });
    const { jobId } = await t.mutation(api.seedDemo.say, { accountId: jay.accountId, space: "Entries", text: "@okidoki file the entry for MTS-4471" });
    expect(jobId).toBeTruthy();
    const again = await t.mutation(api.seedDemo.meridian, { accountId: jay.accountId, fresh: true });
    expect(again.posted).toBe(6);
    const jobs = await t.run(async (ctx) => ctx.db.query("spaceRuns").collect());
    expect(jobs).toEqual([]);
  });
});

describe("vault order", () => {
  test("files saved in the same millisecond come back newest first", async () => {
    const { t, jay } = await team();
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").collect())[0]!._id;
      for (const name of ["first.pdf", "second.pdf", "third.pdf"]) {
        const storageId = await ctx.storage.store(new Blob(["%PDF-1.7"], { type: "application/pdf" }));
        await ctx.db.insert("spaceFiles", { orgId, spaceId: null, storageId, name, size: 8, mime: "application/pdf", uploadedBy: userId, createdAt: 1_792_900_000_000 });
      }
    });
    expect((await jay.as.query(api.vault.files, { accountId: jay.accountId })).map((f: any) => f.name)).toEqual(["third.pdf", "second.pdf", "first.pdf"]);
  });
});
