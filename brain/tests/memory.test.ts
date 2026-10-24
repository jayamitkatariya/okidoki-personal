import { expect, test } from "bun:test";
import { anthropicKey, mossCredentials } from "../src/keys";
import { toDocs } from "../src/memory";

test("anthropic and moss credentials prefer the request, then the environment", () => {
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedId = process.env.MOSS_PROJECT_ID;
  const savedKey = process.env.MOSS_PROJECT_KEY;
  process.env.ANTHROPIC_API_KEY = "env-anthropic";
  process.env.MOSS_PROJECT_ID = "env-id";
  process.env.MOSS_PROJECT_KEY = "env-key";
  try {
    expect(anthropicKey("  from-header  ")).toBe("from-header");
    expect(anthropicKey("")).toBe("env-anthropic");
    expect(mossCredentials(" id ", " key ")).toEqual({ projectId: "id", projectKey: "key" });
    expect(mossCredentials("", "")).toEqual({ projectId: "env-id", projectKey: "env-key" });
    expect(mossCredentials()).toEqual({ projectId: "env-id", projectKey: "env-key" });
  } finally {
    if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedId === undefined) delete process.env.MOSS_PROJECT_ID;
    else process.env.MOSS_PROJECT_ID = savedId;
    if (savedKey === undefined) delete process.env.MOSS_PROJECT_KEY;
    else process.env.MOSS_PROJECT_KEY = savedKey;
  }
});

test("moss short-term memory keeps right-now notes and the newest turns", () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    id: `m${index}`,
    role: "user",
    text: `turn ${index} is long enough`,
    createdAt: `2026-10-24T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const docs = toDocs({
    projectId: "p",
    projectKey: "k",
    memories: [
      { id: "about", text: "I study at Purdue", section: "aboutYou", updatedAt: "2026-10-01" },
      { id: "now", text: "shipping the notch this week", section: "rightNow", updatedAt: "2026-10-24" },
    ],
    threads: [{ id: "t1", accountID: "acct", title: "today", messages }],
    runs: [{ id: "r1", accountID: "acct", title: "old run", prompt: "do the thing", summary: "done" }],
    skills: [{ id: "s1", accountID: "acct", name: "export", summary: "exports a file" }],
  });
  const ids = docs.map((doc) => doc.id);
  expect(ids).toContain("memory:now");
  expect(ids).not.toContain("memory:about");
  expect(ids).not.toContain("run:r1");
  expect(ids).not.toContain("skill:s1");
  expect(ids.filter((id) => id.startsWith("message:")).length).toBe(48);
  expect(ids).toContain("message:m59");
  expect(ids).not.toContain("message:m0");
  expect(docs.find((doc) => doc.id === "message:m59")?.metadata.account).toBe("acct");
});
