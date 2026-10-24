import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemorySyncRequest, RecalledItem } from "./types";

// Short-term memory. Moss holds the recent conversation and "right now" notes, embeds them
// in-process, and saves the index on this Mac. Nothing is pushed to Moss's cloud.
// Durable account data (profile, runs, skills) lives in Convex. Images aren't indexed.

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
    const next = await mossEngine(request.projectId, request.projectKey, cacheDir);
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

const SHORT_TERM_MESSAGES = 48;

/** Recent turns plus "right now" notes. Profile, runs, skills and routines stay in Convex. */
export function toDocs(request: MemorySyncRequest): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const memory of request.memories ?? []) {
    if (memory.section !== "rightNow" || !memory.text?.trim()) continue;
    // Right-now notes are shared by every account on the Mac, so they carry no account.
    docs.push({ id: `memory:${memory.id}`, text: clip(memory.text, 2000), metadata: { type: "memory", account: "", section: "rightNow", date: day(memory.updatedAt) } });
  }
  const messages: { at: string; doc: MemoryDoc }[] = [];
  for (const thread of request.threads ?? []) {
    for (const message of thread.messages ?? []) {
      const text = clip(message.text, 2000);
      if (text.length < 3 || message.role === "system") continue;
      messages.push({
        at: String(message.createdAt ?? ""),
        doc: {
          id: `message:${message.id}`,
          text,
          metadata: { type: "message", account: String(thread.accountID ?? ""), role: String(message.role ?? ""), thread: clip(thread.title, 120), threadId: String(thread.id), date: day(message.createdAt) },
        },
      });
    }
  }
  messages.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const item of messages.slice(0, SHORT_TERM_MESSAGES)) docs.push(item.doc);
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
  return `Recent context (short-term memory; use it if it helps, ignore it if not):\n${lines.join("\n")}`;
}

export function memoryStatus() {
  return { ready: Boolean(engine), documents: known.size, error: lastError || undefined };
}

/** Loads the on-disk short-term index so the first question can recall it. Does not drop documents. */
export async function warmMemory(projectId: string, projectKey: string): Promise<void> {
  const run = async () => {
    await ensureEngine({ projectId, projectKey });
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  await result;
}

export async function closeMemory() {
  await engine?.close().catch(() => {});
  engine = null;
}
