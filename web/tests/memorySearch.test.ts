import { expect, test } from "bun:test";
import { orderMemories, searchMemories } from "../src/memorySearch";
import type { Memory } from "../src/types";

const memory = (id: string, text: string, extra: Partial<Memory> = {}): Memory => ({
  id, text, section: "aboutYou", source: "you", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...extra,
});
const all = [
  memory("seat", "I prefer aisle seats"),
  memory("passport", "My passport number is in the vault file passport.pdf"),
  memory("manager", "My manager is Priya"),
  memory("cafe", "Mi café favorito está en São Paulo"),
];

test("an empty search shows everything", () => {
  expect(searchMemories(all, "  ").memories).toHaveLength(4);
});

test("words match by phrase or by every word as a prefix, folding accents", () => {
  expect(searchMemories(all, "aisle seat").memories.map((m) => m.id)).toEqual(["seat"]);
  expect(searchMemories(all, "pass vault").memories.map((m) => m.id)).toEqual(["passport"]);
  expect(searchMemories(all, "cafe sao").memories.map((m) => m.id)).toEqual(["cafe"]);
  expect(searchMemories(all, "boss").memories).toEqual([]);
});

test("matches by meaning are added after word matches, only for the query they answer", () => {
  const result = searchMemories(all, "boss", { query: "boss", ids: ["manager", "gone"] }, true);
  expect(result.memories.map((m) => m.id)).toEqual(["manager"]);
  expect([...result.related]).toEqual(["manager"]);
  expect(result.pending).toBe(false);
  const stale = searchMemories(all, "boss", { query: "bos", ids: ["manager"] }, true);
  expect(stale.memories).toEqual([]);
  expect(stale.pending).toBe(true);
  expect(searchMemories(all, "boss", { query: "boss", ids: null }, false).pending).toBe(false);
});

test("pinned memories come first, then newest", () => {
  const ordered = orderMemories([
    memory("a", "a", { updatedAt: "2026-11-03T00:00:00Z" }),
    memory("b", "b", { updatedAt: "2026-11-01T00:00:00Z", pinned: true }),
    memory("c", "c", { updatedAt: "2026-11-05T00:00:00Z" }),
  ]);
  expect(ordered.map((m) => m.id)).toEqual(["b", "c", "a"]);
});
