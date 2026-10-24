import { describe, expect, test } from "bun:test";
import { groupMessages } from "../src/pages/SpacesPage";
import type { SpaceMessage } from "../src/enterprise";

const base = Date.UTC(2026, 9, 24, 12, 0, 0);

function message(partial: Partial<SpaceMessage> & { id: string; createdAt: number }): SpaceMessage {
  return {
    author: "user",
    authorId: "u1",
    name: "Jay",
    colorHex: "",
    kind: "text",
    text: "hi",
    runId: null,
    fileId: null,
    isYou: false,
    ...partial,
  };
}

describe("space chat grouping", () => {
  test("a day marker opens the chat and consecutive messages share one header", () => {
    const groups = groupMessages([
      message({ id: "a", createdAt: base }),
      message({ id: "b", createdAt: base + 60_000 }),
      message({ id: "c", createdAt: base + 2 * 60_000, authorId: "u2", name: "Sam" }),
    ]);
    expect(groups[0].kind).toBe("day");
    expect(groups.slice(1).map((group) => (group.kind === "run" ? group.messages.length : group.kind))).toEqual([2, 1]);
  });

  test("five quiet minutes start a new header, and system lines never join a person's run", () => {
    const groups = groupMessages([
      message({ id: "a", createdAt: base }),
      message({ id: "s", createdAt: base + 1000, author: "system", authorId: null, kind: "system", text: "Sam joined" }),
      message({ id: "b", createdAt: base + 2000 }),
      message({ id: "c", createdAt: base + 6 * 60_000 }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["day", "run", "system", "run", "run"]);
  });

  test("agent messages group together regardless of author id", () => {
    const groups = groupMessages([
      message({ id: "a", createdAt: base, author: "agent", authorId: null, name: "okidoki" }),
      message({ id: "b", createdAt: base + 500, author: "agent", authorId: null, name: "okidoki", kind: "run" }),
    ]);
    const run = groups.find((group) => group.kind === "run");
    expect(run && run.kind === "run" ? run.author : null).toBe("agent");
    expect(run && run.kind === "run" ? run.messages.length : 0).toBe(2);
  });
});
