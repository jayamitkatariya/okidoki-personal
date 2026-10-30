import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "okidoki-mcp-"));
let server: ReturnType<typeof Bun.serve>;
const seen: { path: string; auth: string | null; body: unknown }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, auth: request.headers.get("authorization"), body: request.method === "POST" ? await request.json() : null });
      if (url.pathname === "/skills") return Response.json({ skills: [{ id: "s1", name: "expense report", parameters: ["amount"] }] });
      if (url.pathname === "/replay") return Response.json({ ok: true });
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

test("the MCP server lists its tools and calls the Mac's control endpoint with the token", async () => {
  const { handle } = await import("../../mcp/okidoki-mcp");
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  expect((init?.result as { serverInfo: { name: string } }).serverInfo.name).toBe("okidoki");

  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (list?.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  expect(names).toContain("replay_skill");
  expect(names).toContain("vault_search");
  expect(names).toContain("ask_okidoki");
  for (const gone of ["add_note", "search_notes", "add_reminder"]) expect(names).not.toContain(gone);

  const skills = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_skills", arguments: {} } });
  expect(JSON.stringify(skills?.result)).toContain("expense report");
  await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "replay_skill", arguments: { skill: "expense report", values: { amount: "42" } } } });
  expect(seen.at(-1)).toEqual({ path: "/replay", auth: "Bearer secret", body: { skill: "expense report", values: { amount: "42" } } });

  const missing = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "vault_search", arguments: { query: "x" } } });
  expect((missing?.result as { isError?: boolean }).isError).toBe(true);
  expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
});
