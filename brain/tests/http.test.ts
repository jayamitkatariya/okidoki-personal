import { test, expect } from "bun:test";
const token = crypto.randomUUID();
process.env.OKIDOKI_BRAIN_TOKEN = token;
const { handleRequest } = await import("../src/server");
const base = "http://127.0.0.1:4319";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
// Exercise the real HTTP handler and streamed Responses without binding a socket.
const fetch = (url: string, init?: RequestInit) => handleRequest(new Request(url, init));

test("sidecar rejects unauthenticated and browser-origin requests", async () => {
  expect((await fetch(base + "/health")).status).toBe(401);
  expect((await fetch(base + "/execute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "untrusted", kind: "terminal", commands: ["echo forbidden"] }) })).status).toBe(401);
  expect((await fetch(base + "/execute", { method: "POST", headers: { ...headers, origin: "https://example.com" }, body: "{}" })).status).toBe(401);
});

test("think and computer use refuse without an anthropic key", async () => {
  const think = await fetch(base + "/think", { method: "POST", headers, body: JSON.stringify({ text: "teach me figma" }) });
  expect(think.ok).toBe(true);
  const thought = await think.json() as { decision: { kind: string; answer: string }; usedModel: boolean };
  expect(thought.usedModel).toBe(false);
  expect(thought.decision.kind).toBe("answer");
  expect(thought.decision.answer.toLowerCase()).toContain("anthropic key");
  const drive = await fetch(base + "/computer", { method: "POST", headers, body: JSON.stringify({ goal: "open figma", step: 0, history: [] }) });
  expect(drive.ok).toBe(true);
  const acted = await drive.json() as { action: { type: string; reason?: string }; usedModel: boolean };
  expect(acted.usedModel).toBe(false);
  expect(acted.action.type).toBe("fail");
  expect(acted.action.reason?.toLowerCase()).toContain("anthropic key");
});

test("an approved plan streams output and success", async () => {
  const result = await fetch(base + "/execute", { method: "POST", headers, body: JSON.stringify({ runId: crypto.randomUUID(), kind: "terminal", commands: ["printf okidoki"] }) });
  expect(result.headers.get("content-type")).toBe("text/event-stream");
  const stream = await result.text();
  expect(stream).toContain("event: started");
  expect(stream).toContain("event: output");
  expect(stream).toContain("okidoki");
  expect(stream).toContain("event: done");
  expect(stream).toContain('"code":0');
  expect(stream).not.toContain("event: error");
});

test("teach grounding without a key returns no marks", async () => {
  const response = await fetch(base + "/teach/ground", {
    method: "POST",
    headers,
    body: JSON.stringify({ topic: "figma", say: "press F", stepIndex: 0, stepCount: 6, space: "screen" }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { marks: unknown[] };
  expect(body.marks).toEqual([]);
});

test("a live teach step needs a topic and refuses without a key", async () => {
  const missing = await fetch(base + "/teach/step", { method: "POST", headers, body: JSON.stringify({ log: [] }) });
  expect(missing.status).toBe(400);
  const response = await fetch(base + "/teach/step", {
    method: "POST",
    headers,
    body: JSON.stringify({ topic: "auto layout", app: "Figma", outline: ["press F"], log: [], stepNumber: 1, imageWidth: 0, imageHeight: 0 }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { step: unknown; usedModel: boolean; error?: string };
  expect(body.step).toBeNull();
  expect(body.usedModel).toBe(false);
  expect(body.error?.toLowerCase()).toContain("anthropic key");
});

test("a zoomed refine needs a crop and keeps the first guess without a key", async () => {
  const missing = await fetch(base + "/teach/refine", { method: "POST", headers, body: JSON.stringify({ describe: "frame tool" }) });
  expect(missing.status).toBe(400);
  const response = await fetch(base + "/teach/refine", {
    method: "POST",
    headers,
    body: JSON.stringify({ cropBase64: "aGk=", cropWidth: 680, cropHeight: 460, describe: "frame tool" }),
  });
  expect(response.ok).toBe(true);
  const body = await response.json() as { found: boolean };
  expect(body.found).toBe(false);
});

test("HTTP rejects malformed commands before opening an event stream", async () => {
  for (const body of [{}, { runId: "bad", kind: "terminal", commands: ["cat {{file}}"] }, { runId: "bad", kind: "terminal", commands: ["rm -rf /"] }]) {
    const response = await fetch(base + "/execute", { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
});
