import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "okidoki-cli-"));
let server: ReturnType<typeof Bun.serve>;
const seen: { path: string; auth: string | null; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, auth: request.headers.get("authorization"), body: request.method === "POST" ? await request.json() : null });
      if (url.pathname === "/skills") return Response.json({ skills: [{ id: "s1", name: "expense report", parameters: ["amount"] }] });
      if (url.pathname.startsWith("/skills/") && url.pathname.endsWith("/run")) return Response.json({ id: "r2", status: "done", done: true, result: "filed" });
      if (url.pathname === "/tasks") return Response.json({ id: "r1", status: "paused", done: false, needs: "the person to get past a captcha in okidoki's browser", thread: "t1" });
      if (url.pathname === "/runs/r1/takeback") return Response.json({ id: "r1", status: "running", done: false });
      if (url.pathname === "/browser/screenshot") return Response.json({ tab: 3, png: "iVBORw0KGgo=" });
      return Response.json({ error: "no such route" }, { status: 404 });
    },
  });
  writeFileSync(join(dir, "control.json"), JSON.stringify({ port: server.port, token: "secret" }));
  process.env.OKIDOKI_SUPPORT_DIR = dir;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("the client calls the Mac's control endpoint with the token: skills, replay, a task and what it needs", async () => {
  const { api } = await import("../../mcp/client");
  const skills = await api.skills();
  expect(JSON.stringify(skills)).toContain("expense report");
  expect(seen.at(-1)).toMatchObject({ path: "/skills", auth: "Bearer secret" });

  const replay = await api.replay("expense report", { values: { amount: "42" }, wait: 300 });
  expect(seen.at(-1)).toEqual({ path: "/skills/expense%20report/run", auth: "Bearer secret", body: { values: { amount: "42" }, wait: 300 } });
  expect(replay.result).toBe("filed");

  const task = await api.task("check my order", "browser", 180);
  expect(seen.at(-1)).toEqual({ path: "/tasks", auth: "Bearer secret", body: { text: "check my order", mode: "browser", wait: 180 } });
  expect(String(task.needs)).toContain("captcha");
  expect(task.thread).toBe("t1");

  await expect(api.vault("x")).rejects.toThrow("no such route");
});

test("steering and screenshots go through the client too", async () => {
  const { api } = await import("../../mcp/client");
  const back = await api.control("r1", "takeback");
  expect(seen.at(-1)?.path).toBe("/runs/r1/takeback");
  expect(back.status).toBe("running");

  const shot = await api.screenshot(3);
  expect(seen.at(-1)?.path).toBe("/browser/screenshot?tab=3");
  expect(shot.png).toBe("iVBORw0KGgo=");
});

test("the CLI exits 2 when a run needs the person", async () => {
  const { main } = await import("../../mcp/okidoki");
  const log = console.log;
  console.log = () => {};
  try {
    expect(await main(["browse", "check", "my", "order", "--wait", "5"])).toBe(2);
  } finally {
    console.log = log;
  }
});

test("the CLI reads items and values the way a person types them", async () => {
  const { parse } = await import("../../mcp/okidoki");
  const { words, flags } = parse(["replay", "file a return", "--item", "name=Asha", "pan=AB1", "--item", "name=Ravi", "--set", "year=2026", "--wait", "60", "--json"]);
  expect(words).toEqual(["replay", "file a return"]);
  expect((flags.item as string[]).map((s) => JSON.parse(s))).toEqual([{ name: "Asha", pan: "AB1" }, { name: "Ravi" }]);
  expect(JSON.parse((flags.set as string[])[0])).toEqual({ year: "2026" });
  expect(flags.wait).toBe("60");
  expect(flags.json).toBe(true);
});
