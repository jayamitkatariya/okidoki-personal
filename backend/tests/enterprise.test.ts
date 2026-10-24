import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

// Functions run against an in-memory Convex with a mocked login. A login is a row in `users`
// plus an identity whose subject is "<userId>|<sessionId>", which is what Convex Auth reads.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;

async function setup() {
  const t = convexTest(schema, modules);
  const people: Record<string, { as: ReturnType<typeof t.withIdentity>; accountId: string }> = {};
  const login = async (name: string, email: string) => {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { name, email }));
    const as = t.withIdentity({ subject: `${userId}|session-${name}` });
    const accountId = `acct-${name}`;
    // Each Mac work account is claimed by its login, exactly as the Mac app does after sign-in.
    await as.mutation(api.accounts.claim, { accounts: [{ id: accountId, name, email, kind: "work", colorHex: "44E45E", createdAt: "2026-10-24" }] });
    people[name] = { as, accountId };
    return people[name];
  };
  return { t, login, people };
}

describe("organizations", () => {
  test("creating an organization makes the creator its owner and links the work account", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "acme.com", accountId: jay.accountId });
    const view = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(view.org.name).toBe("Acme");
    expect(view.role).toBe("owner");
    expect(view.members.map((m: any) => [m.name, m.role, m.isYou])).toEqual([["jay", "owner", true]]);
  });

  test("a join code brings a colleague in as a member, counts its use, and stops when spent", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    const pat = await login("pat", "pat@elsewhere.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 1 });
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const joined = await sam.as.mutation(api.orgs.join, { code: code.toLowerCase(), accountId: sam.accountId });
    expect(joined.name).toBe("Acme");
    const samView = await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId });
    expect(samView.role).toBe("member");
    // members don't see join codes or requests
    expect(samView.codes).toEqual([]);

    await expect(pat.as.mutation(api.orgs.join, { code, accountId: pat.accountId })).rejects.toThrow(/isn't valid/);
    const jayView = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(jayView.codes).toEqual([]);
    expect(jayView.members.map((m: any) => m.name)).toEqual(["jay", "sam"]);
  });

  test("domain requests wait for an admin; the last owner can't leave or be demoted", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "Acme.com", accountId: jay.accountId });
    expect((await sam.as.query(api.orgs.byMyDomain, {})).name).toBe("Acme");
    const request = await sam.as.mutation(api.orgs.requestByDomain, { accountId: sam.accountId });
    expect(request.status).toBe("pending");
    expect(await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId })).toBeNull();

    const jayView = await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId });
    expect(jayView.pending.map((m: any) => m.email)).toEqual(["sam@acme.com"]);
    await jay.as.mutation(api.orgs.approve, { membershipId: jayView.pending[0].id });
    expect((await sam.as.query(api.orgs.forAccount, { accountId: sam.accountId })).role).toBe("member");

    const mine = jayView.members.find((m: any) => m.isYou);
    await expect(jay.as.mutation(api.orgs.setRole, { membershipId: mine.id, role: "member" })).rejects.toThrow(/at least one owner/);
    await expect(jay.as.mutation(api.orgs.leave, { orgId: jayView.org.id })).rejects.toThrow(/someone else an owner/);

    // a member can't manage people
    await expect(sam.as.mutation(api.orgs.createCode, { orgId: jayView.org.id, days: 1, maxUses: 1 })).rejects.toThrow(/owner or admin/);
  });

  test("nobody can link an account their login doesn't own", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    await expect(sam.as.mutation(api.orgs.link, { orgId, accountId: jay.accountId })).rejects.toThrow(/isn't linked to this login/);
    expect(await sam.as.query(api.orgs.forAccount, { accountId: jay.accountId })).toBeNull();
  });
});

describe("spaces and chat", () => {
  test("members of the organization see a space, but only those who joined read its chat", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    const pat = await login("pat", "pat@elsewhere.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });

    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    await jay.as.mutation(api.chat.send, { spaceId, text: "Welcome to Finance" });

    const samList = await sam.as.query(api.spaces.list, { accountId: sam.accountId });
    expect(samList.map((s: any) => [s.name, s.joined, s.members.length])).toEqual([["Finance", false, 1]]);
    expect(await sam.as.query(api.chat.messages, { spaceId })).toEqual([]);
    await expect(sam.as.mutation(api.chat.send, { spaceId, text: "hi" })).rejects.toThrow(/join the space/);

    await sam.as.mutation(api.spaces.join, { spaceId });
    const texts = (await sam.as.query(api.chat.messages, { spaceId })).map((m: any) => [m.author, m.text]);
    expect(texts).toEqual([
      ["system", "jay created the space"],
      ["user", "Welcome to Finance"],
      ["system", "sam joined"],
    ]);
    await sam.as.mutation(api.chat.send, { spaceId, text: "Thanks!" });

    // unread counts follow lastReadAt; sending marks your own chat read
    const jayList = await jay.as.query(api.spaces.list, { accountId: jay.accountId });
    expect(jayList[0].unread).toBe(2);
    await jay.as.mutation(api.spaces.markRead, { spaceId });
    expect((await jay.as.query(api.spaces.list, { accountId: jay.accountId }))[0].unread).toBe(0);

    // outside the organization nothing is visible or writable
    expect(await pat.as.query(api.spaces.list, { accountId: pat.accountId })).toEqual([]);
    expect(await pat.as.query(api.chat.messages, { spaceId })).toEqual([]);
    await expect(pat.as.mutation(api.spaces.join, { spaceId })).rejects.toThrow(/not in that organization/);
  });

  test("the space owner or an org admin can delete a space; a plain member can't", async () => {
    const { login } = await setup();
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });

    const { spaceId } = await sam.as.mutation(api.spaces.create, { accountId: sam.accountId, name: "Sam's corner" });
    const { spaceId: other } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Launch" });
    await sam.as.mutation(api.spaces.join, { spaceId: other });
    await expect(sam.as.mutation(api.spaces.remove, { spaceId: other })).rejects.toThrow(/owner or an organization admin/);
    await sam.as.mutation(api.spaces.update, { spaceId, workerPolicy: "privateMac", name: "Sam's room" });
    await expect(sam.as.mutation(api.spaces.update, { spaceId, workerPolicy: "mainframe" })).rejects.toThrow(/unknown worker/);

    // an org admin deletes a space they never joined
    expect((await jay.as.mutation(api.spaces.remove, { spaceId })).done).toBe(true);
    expect((await jay.as.query(api.spaces.list, { accountId: jay.accountId })).map((s: any) => s.name)).toEqual(["Launch"]);
  });
});
