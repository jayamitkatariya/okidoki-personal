import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { anyApi } from "convex/server";
import schema from "../convex/schema";

// Functions run against an in-memory Convex with a mocked login. A login is a row in `users`
// plus an identity whose subject is "<userId>|<sessionId>", which is what Convex Auth reads.

const modules = import.meta.glob("../convex/**/*.ts");
const api = anyApi as any;

// Unread counts compare timestamps, so let the clock move between messages.
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

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

describe("agent jobs and the worker", () => {
  const secret = "test-sync-secret";
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  async function team() {
    const { t, login } = await setup();
    process.env.OKIDOKI_SYNC_SECRET = secret;
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Ops" });
    await sam.as.mutation(api.spaces.join, { spaceId });
    const post = (path: string, body: unknown) => t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json());
    return { t, jay, sam, spaceId, post };
  }

  test("mentioning @okidoki queues a job with a run card; a member's Mac accepts and reports it", async () => {
    const { jay, sam, spaceId, post } = await team();
    const sent = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki compress the launch video for Discord" });
    expect(sent.jobId).toBeTruthy();
    const messages = await jay.as.query(api.chat.messages, { spaceId });
    expect(messages.map((m: any) => [m.author, m.kind])).toEqual([
      ["system", "system"],
      ["system", "system"],
      ["user", "text"],
      ["agent", "run"],
    ]);
    let jobs = await jay.as.query(api.jobs.forSpace, { spaceId });
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].prompt).toBe("compress the launch video for Discord");

    // Sam's Mac polls: it's a member, so it sees the job; the heartbeat registers it as a worker.
    const polled = await post("/api/worker/poll", { accountId: sam.accountId, device: "Sam's MacBook", kind: "thisMac", enabled: true });
    expect(polled.ok).toBe(true);
    expect(polled.jobs.map((j: any) => j.spaceName)).toEqual(["Ops"]);
    const workers = await jay.as.query(api.jobs.workersFor, { accountId: jay.accountId });
    expect(workers.map((w: any) => [w.name, w.online])).toEqual([["sam", true]]);

    const accepted = await post("/api/worker/accept", { accountId: sam.accountId, jobId: sent.jobId, device: "Sam's MacBook" });
    expect(accepted.job.prompt).toBe("compress the launch video for Discord");
    // second taker loses
    const again = await post("/api/worker/accept", { accountId: jay.accountId, jobId: sent.jobId, device: "Jay's Mac" });
    expect(again.job).toBeNull();

    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "running", runClientId: "run-1", title: "Compress video", steps: [{ title: "ffmpeg" }] });
    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "done", summary: "Saved launch-discord.mp4 (7.9 MB)", say: "Done: launch-discord.mp4 is 7.9 MB." });
    jobs = await jay.as.query(api.jobs.forSpace, { spaceId });
    expect([jobs[0].status, jobs[0].workerName, jobs[0].summary]).toEqual(["done", "sam", "Saved launch-discord.mp4 (7.9 MB)"]);
    const lines = (await jay.as.query(api.chat.messages, { spaceId })).filter((m: any) => m.author === "agent" && m.kind === "text").map((m: any) => m.text);
    expect(lines[0]).toMatch(/running on sam's Mac/);
    expect(lines[1]).toBe("Done: launch-discord.mp4 is 7.9 MB.");

    // a finished job ignores late updates, and a stranger's "update" does nothing
    await post("/api/worker/update", { accountId: sam.accountId, jobId: sent.jobId, status: "failed" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId: sent.jobId, status: "failed" });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("done");
  });

  test("approvals flow through the chat, and the wrong kind of worker is skipped", async () => {
    const { jay, sam, spaceId, post } = await team();
    const { jobId } = await sam.as.mutation(api.chat.send, { spaceId, text: "hey @okidoki, clean up my mac" });
    await post("/api/worker/accept", { accountId: jay.accountId, jobId, device: "Jay's Mac" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "waiting", preview: { summary: "Empty caches", risk: "medium" } });
    await expect(sam.as.mutation(api.jobs.decide, { jobId, decision: "maybe" })).rejects.toThrow(/unknown decision/);
    await sam.as.mutation(api.jobs.decide, { jobId, decision: "approve" });
    const polled = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true });
    expect(polled.held).toEqual([{ id: jobId, status: "waiting", decision: "approve", runClientId: null }]);
    // a second wait asks again
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "running" });
    await post("/api/worker/update", { accountId: jay.accountId, jobId, status: "waiting" });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].decision).toBe("");

    // a private-Mac space only hands jobs to private-Mac workers
    await jay.as.mutation(api.spaces.update, { spaceId, workerPolicy: "privateMac" });
    await sam.as.mutation(api.chat.send, { spaceId, text: "@okidoki export the deck as PDF" });
    const plain = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: true });
    expect(plain.jobs).toEqual([]);
    const vm = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "privateMac", enabled: true });
    expect(vm.jobs.map((j: any) => j.prompt)).toEqual(["export the deck as PDF"]);

    // a worker that switched itself off drops out of the online list and gets no jobs
    const off = await post("/api/worker/poll", { accountId: jay.accountId, device: "Jay's Mac", kind: "thisMac", enabled: false });
    expect(off.jobs).toEqual([]);
    expect((await sam.as.query(api.jobs.workersFor, { accountId: sam.accountId })).find((w: any) => w.name === "jay").online).toBe(false);

    // an outsider's Mac is refused at the door
    const stranger = await post("/api/worker/poll", { accountId: "acct-nobody", device: "x", kind: "thisMac", enabled: true });
    expect(stranger.ok).toBe(false);
    const unauthorized = await (await import("convex-test")).convexTest(schema, modules).fetch("/api/worker/poll", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
  });

  test("cancelling a queued job ends it; cancelling a held one tells the worker to stop", async () => {
    const { jay, sam, spaceId, post } = await team();
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki zip the reports folder" });
    await sam.as.mutation(api.jobs.cancel, { jobId });
    expect((await jay.as.query(api.jobs.forSpace, { spaceId }))[0].status).toBe("cancelled");
    expect((await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true })).jobs).toEqual([]);

    const { jobId: second } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki zip it again" });
    await post("/api/worker/accept", { accountId: sam.accountId, jobId: second, device: "m" });
    await jay.as.mutation(api.jobs.cancel, { jobId: second });
    const polled = await post("/api/worker/poll", { accountId: sam.accountId, device: "m", kind: "thisMac", enabled: true });
    expect(polled.held[0]).toMatchObject({ id: second, status: "accepted", decision: "decline" });
  });
});

describe("shared skills", () => {
  const steps = [
    { id: "s1", text: "Open Numbers", app: "Numbers", action: "click", label: "Numbers" },
    { id: "s2", text: "Type the client", app: "Numbers", action: "type", input: "{{client name}}" },
    { id: "s3", text: "Save", app: "Numbers", action: "key", input: "cmd+s" },
    { id: "s4", text: "Switch to Mail", app: "Mail", action: "switch" },
  ];

  async function org() {
    const { t, login } = await setup();
    process.env.OKIDOKI_SYNC_SECRET = "s";
    const jay = await login("jay", "jay@acme.com");
    const sam = await login("sam", "sam@acme.com");
    await jay.as.mutation(api.orgs.create, { name: "Acme", domain: "", accountId: jay.accountId });
    const orgId = (await jay.as.query(api.orgs.forAccount, { accountId: jay.accountId })).org.id;
    const { code } = await jay.as.mutation(api.orgs.createCode, { orgId, days: 7, maxUses: 5 });
    await sam.as.mutation(api.orgs.join, { code, accountId: sam.accountId });
    const { spaceId } = await jay.as.mutation(api.spaces.create, { accountId: jay.accountId, name: "Finance" });
    const post = (path: string, body: unknown) =>
      t.fetch(path, { method: "POST", headers: { authorization: "Bearer s", "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    return { t, jay, sam, spaceId, post };
  }

  test("publishing lists the apps it needs and its parameters; republishing bumps the version and keeps history", async () => {
    const { jay, sam, spaceId } = await org();
    const first = await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId: null, skill: { id: "skill-1", name: "Invoice flow", summary: "Bills a client", steps } });
    expect(first.version).toBe(1);
    let shared = await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: "Invoice flow", publishedBy: "sam", requires: ["Mail", "Numbers"], params: ["client name"], stepCount: 4, spaceName: "", isMine: false, canUnpublish: true });

    const second = await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId: null, skill: { id: "skill-1", name: "Invoice flow v2", summary: "", steps: steps.slice(0, 2) } });
    expect(second.version).toBe(2);
    shared = await sam.as.query(api.sharedSkills.list, { accountId: sam.accountId });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ name: "Invoice flow v2", version: 2, versions: 2, stepCount: 2, isMine: true });

    await sam.as.mutation(api.sharedSkills.rollback, { sharedId: shared[0].id });
    shared = await sam.as.query(api.sharedSkills.list, { accountId: sam.accountId });
    expect(shared[0]).toMatchObject({ version: 3, stepCount: 4, requires: ["Mail", "Numbers"] });
  });

  test("space skills need membership; a plain member can't unpublish someone else's, an admin can", async () => {
    const { jay, sam, spaceId, post } = await org();
    await expect(sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "Close the books", summary: "", steps } })).rejects.toThrow(/join the space/);
    await sam.as.mutation(api.spaces.join, { spaceId });
    await sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "Close the books", summary: "", steps } });
    const listed = await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId });
    expect(listed[0]).toMatchObject({ spaceName: "Finance", canUnpublish: true });
    await jay.as.mutation(api.sharedSkills.recordRun, { sharedId: listed[0].id });
    expect((await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId }))[0].runCount).toBe(1);

    // the worker gets the space's skills along with its job
    const { jobId } = await jay.as.mutation(api.chat.send, { spaceId, text: "@okidoki replay close the books" });
    const accepted = await post("/api/worker/accept", { accountId: sam.accountId, jobId, device: "m" });
    expect(accepted.job.sharedSkills.map((s: any) => [s.name, s.steps.length, s.version])).toEqual([["Close the books", 4, 1]]);

    await expect(sam.as.mutation(api.sharedSkills.publish, { accountId: sam.accountId, spaceId, skill: { id: "skill-2", name: "x", summary: "", steps: [] } })).rejects.toThrow(/no steps/);
    await jay.as.mutation(api.sharedSkills.unpublish, { sharedId: listed[0].id });
    expect(await jay.as.query(api.sharedSkills.list, { accountId: jay.accountId })).toEqual([]);
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

    await tick();
    await sam.as.mutation(api.spaces.join, { spaceId });
    const texts = (await sam.as.query(api.chat.messages, { spaceId })).map((m: any) => [m.author, m.text]);
    expect(texts).toEqual([
      ["system", "jay created the space"],
      ["user", "Welcome to Finance"],
      ["system", "sam joined"],
    ]);
    await tick();
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
