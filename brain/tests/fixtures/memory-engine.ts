import type { MemoryDoc, MemoryEngine, MemoryFilter } from "../../src/memory";

// An in-memory stand-in for the Moss session: same calls, word-overlap scores, and Moss's
// metadata filter syntax ({ field, condition: { $eq | $ne | $in } } and { $and: [...] }).

export interface FakeEngine extends MemoryEngine {
  docs: Map<string, MemoryDoc>;
  saves: number;
  closed: boolean;
  added: string[];
  removed: string[];
  queries: { text: string; topK: number; filter?: MemoryFilter }[];
}

function matches(filter: MemoryFilter | undefined, metadata: Record<string, string>): boolean {
  if (!filter) return true;
  if ("$and" in filter) return filter.$and.every((part) => matches(part, metadata));
  const value = metadata[filter.field] ?? "";
  const condition = filter.condition;
  if ("$eq" in condition) return value === condition.$eq;
  if ("$ne" in condition) return value !== condition.$ne;
  if ("$in" in condition) return condition.$in.includes(value);
  return true;
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));

export function fakeEngine(seed: MemoryDoc[] = []): FakeEngine {
  const docs = new Map(seed.map((doc) => [doc.id, { ...doc, metadata: { ...doc.metadata } }]));
  const engine: FakeEngine = {
    docs,
    saves: 0,
    closed: false,
    added: [],
    removed: [],
    queries: [],
    async add(batch) {
      for (const doc of batch) {
        docs.set(doc.id, { ...doc, metadata: { ...doc.metadata } });
        engine.added.push(doc.id);
      }
    },
    async remove(ids) {
      for (const id of ids) {
        docs.delete(id);
        engine.removed.push(id);
      }
    },
    async query(text, topK, minScore, filter) {
      engine.queries.push({ text, topK, filter });
      const asked = words(text);
      return [...docs.values()]
        .filter((doc) => matches(filter, doc.metadata))
        .map((doc) => {
          const have = words(doc.text);
          const overlap = [...asked].filter((word) => have.has(word)).length;
          return { ...doc, score: asked.size ? overlap / asked.size : 0 };
        })
        .filter((hit) => hit.score > 0 && hit.score >= (minScore ?? 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async all() {
      return [...docs.values()];
    },
    async save() {
      engine.saves += 1;
    },
    async close() {
      engine.closed = true;
    },
  };
  return engine;
}
