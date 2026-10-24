import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemorySyncRequest, RecalledItem } from "./types";

// Long-term recall over what okidoki already keeps on the Mac — memories, conversations, runs (with a
// short tail of their output), skills and routines — through a Moss session index. It embeds and
// searches in-process and is saved to disk on this Mac; nothing is pushed to Moss's cloud.
// Images aren't indexed: screenshots are never stored.

const INDEX_NAME = "okidoki-memory";

export interface MemoryDoc {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export interface MemoryEngine {
  add(docs: MemoryDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(text: string, topK: number): Promise<{ id: string; text: string; metadata: Record<string, string>; score: number }[]>;
  all(): Promise<MemoryDoc[]>;
  save(): Promise<void>;
  close(): Promise<void>;
}

function defaultCacheDir(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Okidoki", "moss")
    : join(homedir(), ".okidoki", "moss");
}

// The Moss SDK ships a native binary, so it's loaded lazily: a missing or broken binary turns recall
// off instead of taking the brain down with it.
async function mossEngine(projectId: string, projectKey: string, cacheDir: string): Promise<MemoryEngine> {
  const { MossClient } = await import("@moss-js/moss");
  const client = new MossClient(projectId, projectKey, { cachePath: cacheDir });
  const session = await client.session(INDEX_NAME, "moss-minilm");
  try {
    await session.loadFromDisk(cacheDir);
  } catch {
    // First run on this Mac (or an unreadable snapshot): start empty and rebuild from the Mac's data.
  }
  return {
    add: async (docs) => {
      await session.addDocs(docs, { upsert: true });
    },
    remove: async (ids) => {
      await session.deleteDocs(ids);
    },
    query: async (text, topK) => (await session.query(text, { topK })).docs.map((doc) => ({ ...doc, metadata: doc.metadata ?? {} })),
    all: async () => (await session.getDocs()).map((doc) => ({ id: doc.id, text: doc.text, metadata: doc.metadata ?? {} })),
    save: () => session.saveToDisk(cacheDir),
    close: async () => {
      await session.close();
      await client.close();
    },
  };
}

// Keys are sorted because Moss hands metadata back in its own order after a reload.
function fingerprint(doc: MemoryDoc): string {
  const metadata = Object.keys(doc.metadata)
    .sort()
    .map((key) => `${key}=${doc.metadata[key]}`)
    .join("\n");
  return createHash("sha1").update(doc.text).update("\0").update(metadata).digest("hex");
}

let engine: MemoryEngine | null = null;
let engineKey = "";
let starting: Promise<MemoryEngine> | null = null;
let lastError = "";
const known = new Map<string, string>(); // doc id → fingerprint of what the index holds
let queue: Promise<unknown> = Promise.resolve(); // index changes run one at a time

let makeEngine: (projectId: string, projectKey: string, cacheDir: string) => Promise<MemoryEngine> = mossEngine;

/** Tests swap in a fake engine; the app always uses Moss. */
export function useEngineFactory(factory: typeof makeEngine) {
  makeEngine = factory;
  engine = null;
  engineKey = "";
  starting = null;
  known.clear();
}

async function ensureEngine(request: MemorySyncRequest): Promise<MemoryEngine> {
  const cacheDir = request.cacheDir || defaultCacheDir();
  const key = `${request.projectId}\u0000${request.projectKey}\u0000${cacheDir}`;
  if (engine && engineKey === key) return engine;
  if (starting && engineKey === key) return starting;
  const previous = engine;
  engine = null;
  engineKey = key;
  known.clear();
  starting = (async () => {
    await previous?.close().catch(() => {});
    const next = await makeEngine(request.projectId, request.projectKey, cacheDir);
    for (const doc of await next.all()) known.set(doc.id, fingerprint(doc));
    engine = next;
    return next;
  })();
  try {
    return await starting;
  } catch (error) {
    engineKey = "";
    throw error;
  } finally {
    starting = null;
  }
}

// --- documents ---------------------------------------------------------------

const clip = (text: unknown, max: number) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};
const day = (value: unknown) => String(value ?? "").slice(0, 10);

/** Turns the Mac's items into index documents. Ids are prefixed by type so kinds never collide. */
export function toDocs(request: MemorySyncRequest): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const memory of request.memories ?? []) {
    if (!memory.text?.trim()) continue;
    // Memories are shared by every account on the Mac, so they carry no account.
    docs.push({ id: `memory:${memory.id}`, text: clip(memory.text, 2000), metadata: { type: "memory", account: "", section: String(memory.section ?? ""), date: day(memory.updatedAt) } });
  }
  for (const thread of request.threads ?? []) {
    for (const message of thread.messages ?? []) {
      const text = clip(message.text, 2000);
      if (text.length < 3 || message.role === "system") continue;
      docs.push({
        id: `message:${message.id}`,
        text,
        metadata: { type: "message", account: String(thread.accountID ?? ""), role: String(message.role ?? ""), thread: clip(thread.title, 120), threadId: String(thread.id), date: day(message.createdAt) },
      });
    }
  }
  for (const run of request.runs ?? []) {
    // The run's "log": what was asked, what happened, and the end of its output.
    const text = [run.title, run.prompt, run.summary, clip(String(run.output ?? "").slice(-1500), 1500)].filter((part) => String(part ?? "").trim()).join("\n");
    if (!text.trim()) continue;
    docs.push({
      id: `run:${run.id}`,
      text: clip(text, 4000),
      metadata: { type: "run", account: String(run.accountID ?? ""), kind: String(run.kind ?? ""), status: String(run.status ?? ""), title: clip(run.title, 120), date: day(run.createdAt) },
    });
  }
  for (const skill of request.skills ?? []) {
    const steps = (skill.steps ?? []).map((step) => step.text).filter(Boolean).join("; ");
    docs.push({ id: `skill:${skill.id}`, text: clip(`${skill.name}. ${skill.summary}. ${steps}`, 2000), metadata: { type: "skill", account: String(skill.accountID ?? ""), title: clip(skill.name, 120), date: day(skill.createdAt) } });
  }
  for (const routine of request.routines ?? []) {
    docs.push({
      id: `routine:${routine.id}`,
      text: clip(`${routine.name}: ${routine.prompt} (${routine.cadence})`, 1000),
      metadata: { type: "routine", account: String(routine.accountID ?? ""), title: clip(routine.name, 120), date: day(routine.createdAt) },
    });
  }
  return docs;
}

// --- sync + recall -------------------------------------------------------------

/** Brings the index in line with the Mac: embeds only new or changed items, drops removed ones. */
export async function syncMemory(request: MemorySyncRequest): Promise<{ ok: boolean; total: number; added: number; removed: number; error?: string }> {
  const run = async () => {
    const index = await ensureEngine(request);
    const docs = toDocs(request);
    const wanted = new Map(docs.map((doc) => [doc.id, doc]));
    const changed = docs.filter((doc) => known.get(doc.id) !== fingerprint(doc));
    const removed = [...known.keys()].filter((id) => !wanted.has(id));
    for (let start = 0; start < changed.length; start += 256) {
      const batch = changed.slice(start, start + 256);
      await index.add(batch);
      for (const doc of batch) known.set(doc.id, fingerprint(doc));
    }
    if (removed.length) {
      await index.remove(removed);
      for (const id of removed) known.delete(id);
    }
    if (changed.length || removed.length) await index.save();
    lastError = "";
    return { ok: true, total: known.size, added: changed.length, removed: removed.length };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  try {
    return await result;
  } catch (error) {
    lastError = error instanceof Error ? error.message : "memory index failed";
    return { ok: false, total: known.size, added: 0, removed: 0, error: lastError };
  }
}

/** The closest items for a request, from this account plus shared memories. Never throws; [] when off. */
export async function recall(text: string, accountId: string | undefined, limit = 8): Promise<RecalledItem[]> {
  const index = engine;
  if (!index || !text.trim()) return [];
  try {
    const hits = await Promise.race([
      index.query(text, limit * 4),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recall timed out")), 2000)),
    ]);
    return hits
      .filter((hit) => !hit.metadata.account || !accountId || hit.metadata.account === accountId)
      .slice(0, limit)
      .map((hit) => ({ type: hit.metadata.type ?? "memory", text: hit.text, title: hit.metadata.title ?? hit.metadata.thread ?? "", date: hit.metadata.date ?? "", score: hit.score }));
  } catch {
    return [];
  }
}

export function recallPrompt(items: RecalledItem[]): string {
  if (!items.length) return "";
  const lines = items.map((item) => {
    const label = [item.type, item.title, item.date].filter(Boolean).join(" · ");
    return `· [${label}] ${clip(item.text, 400)}`;
  });
  return `Related from their history (searched for this request; use it if it helps, ignore it if not):\n${lines.join("\n")}`;
}

export function memoryStatus() {
  return { ready: Boolean(engine), documents: known.size, error: lastError || undefined };
}

export async function closeMemory() {
  await engine?.close().catch(() => {});
  engine = null;
}
