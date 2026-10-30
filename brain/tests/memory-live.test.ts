import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMemory, memoryStatus, recall, syncMemory, warmMemory } from "../src/memory";

// Against the real Moss engine, in a throwaway folder. Opt-in, like smoke:api: it needs the Moss key
// (from the repo's .env) and signs in to Moss once; documents are embedded and searched on this Mac.
//   OKIDOKI_LIVE_MOSS=1 bun --env-file=../.env test tests/memory-live.test.ts

const projectId = process.env.MOSS_PROJECT_ID ?? "";
const projectKey = process.env.MOSS_PROJECT_KEY ?? "";
const live = process.env.OKIDOKI_LIVE_MOSS === "1" && Boolean(projectId && projectKey);
const cacheDir = mkdtempSync(join(tmpdir(), "okidoki-moss-live-"));

afterAll(async () => {
  await closeMemory();
  rmSync(cacheDir, { recursive: true, force: true });
});

test.skipIf(!live)(
  "the real engine embeds every kind of item, recalls within the account, and reloads from disk",
  async () => {
    const now = new Date().toISOString();
    const result = await syncMemory({
      projectId,
      projectKey,
      cacheDir,
      memories: [
        { id: "mine", accountID: "personal", text: "My launch videos go to the Discord server for the design club", section: "aboutYou", updatedAt: now },
        { id: "theirs", accountID: "work", text: "Work launch videos need a legal review before they're posted", section: "aboutYou", updatedAt: now },
      ],
      threads: [{ id: "t1", accountID: "personal", title: "trip", messages: [{ id: "m1", role: "user", text: "plan a weekend trip to Chicago with a museum day", createdAt: now }] }],
      runs: [{ id: "r1", accountID: "personal", kind: "computer_use", status: "done", title: "compress video", prompt: "compress the launch video for discord", summary: "24 MB", createdAt: now }],
      skills: [{ id: "s1", accountID: "personal", name: "expense report", summary: "files my receipts in Concur", steps: [{ text: "open Concur" }, { text: "attach receipts" }], createdAt: now }],
    });
    expect(result.ok).toBe(true);
    expect(memoryStatus()).toMatchObject({ ready: true, notes: 2, messages: 1, runs: 1, skills: 1 });

    const video = await recall("where should the launch video be posted", "personal");
    const texts = video.map((item) => item.text);
    expect(texts.some((text) => text.includes("Discord server"))).toBe(true);
    expect(texts.some((text) => text.includes("legal review"))).toBe(false);

    const expenses = await recall("file my expense receipts again", "personal");
    expect(expenses[0]?.type).toBe("skill");

    // A new brain process: the saved index answers before the Mac has sent anything.
    await closeMemory();
    await warmMemory(projectId, projectKey, cacheDir);
    expect(memoryStatus().notes).toBe(2);
    const again = await recall("where should the launch video be posted", "personal");
    expect(again.some((item) => item.text.includes("Discord server"))).toBe(true);
  },
  180_000,
);
