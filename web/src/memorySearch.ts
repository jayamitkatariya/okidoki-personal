import type { Memory, MemorySearch } from "./types";

/** Folded for case and accents, so "cafe" finds "Café". */
export const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

const words = (text: string) => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How well a memory's words match what was typed: the whole phrase, or every word (as a prefix). 0 when it doesn't. */
export function wordScore(memory: Memory, query: string): number {
  const needle = fold(query).trim();
  if (!needle) return 0;
  const hay = fold(memory.text);
  if (hay.includes(needle)) return 3;
  const wanted = words(query);
  if (!wanted.length) return 0;
  const have = words(memory.text);
  const found = wanted.filter((word) => have.some((w) => w.startsWith(word)));
  return found.length === wanted.length ? 2 : 0;
}

export interface MemorySearchResult {
  /** Best first: word matches, then the index's matches by meaning that words missed. */
  memories: Memory[];
  /** Ids that matched only by meaning. */
  related: Set<string>;
  /** The index's answer for this exact query hasn't come back yet. */
  pending: boolean;
}

/** Filters the page's memories by a search. `semantic` is the Mac's last search by meaning, used only when it answers this query. */
export function searchMemories(memories: Memory[], query: string, semantic?: MemorySearch | null, indexed = false): MemorySearchResult {
  const q = query.trim();
  if (!q) return { memories, related: new Set(), pending: false };
  const scored = memories
    .map((memory, order) => ({ memory, order, score: wordScore(memory, q) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const picked = scored.map((entry) => entry.memory);
  const related = new Set<string>();
  const answered = semantic && semantic.query.trim() === q && Array.isArray(semantic.ids);
  if (answered) {
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    const have = new Set(picked.map((memory) => memory.id));
    for (const id of semantic.ids ?? []) {
      const memory = byId.get(id);
      if (!memory || have.has(id)) continue;
      have.add(id);
      related.add(id);
      picked.push(memory);
    }
  }
  return { memories: picked, related, pending: indexed && !answered };
}

/** Pinned first, then newest. */
export function orderMemories(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
}
