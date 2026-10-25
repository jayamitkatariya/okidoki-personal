import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

// The Mac putting a document into the vault itself (a form it found on the web), over the sync
// secret, as the account's linked member.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;
const secret = "test-sync-secret";
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

async function team() {
  const t = convexTest(schema, modules);
  process.env.OKIDOKI_SYNC_SECRET = secret;
  const login = async (name: string) => {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name, email: `${name}@meridian.test` }));
    const as = t.withIdentity({ subject: `${userId}|session-${name}` });
    const accountId = `acct-${name}`;
    await as.mutation(api.accounts.claim, { accounts: [{ id: accountId, name, email: `${name}@meridian.test`, kind: "work", colorHex: "44E45E", createdAt: "2026-10-24" }] });
    return { as, accountId };
  };
  const jay = await login("jay");
  const sam = await login("sam");
  await jay.as.mutation(api.orgs.create, { name: "Meridian Trade Services", domain: "", accountId: jay.accountId });
  const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
  const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
  await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
  const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Compliance" });
  const post = (path: string, body: unknown, auth = headers) => t.fetch(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const pdf = (text: string) => t.run(async (ctx) => ctx.storage.store(new Blob([`%PDF-1.7 ${text}`], { type: "application/pdf" })));
  return { t, jay, sam, spaceId, post, pdf };
}

describe("vault from the Mac", () => {
  test("needs the secret and a linked account", async () => {
    const { post } = await team();
    expect((await post("/api/vault/upload-url", { accountId: "acct-jay" }, { ...headers, authorization: "Bearer wrong" })).status).toBe(401);
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
  });
});

describe("demo seed", () => {
  test("turns the linked org into Meridian once, however often it runs", async () => {
    const { t, jay } = await team();
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
