import { expect, test } from "bun:test";
import { joinCommand, splitCommand } from "../src/mcp";

test("MCP arguments survive opening and saving the command field unchanged", () => {
  const words = ["/path with spaces/server", "", "a'b", 'a"b', "back\\slash", "héllo 世界", "$(literal)", "--config={\"x\":\"a b\"}"];
  expect(splitCommand(joinCommand(words))).toEqual(words);
  expect(splitCommand('npx -y server --path="a b" escaped\\ space')).toEqual(["npx", "-y", "server", "--path=a b", "escaped space"]);
});

test("incomplete MCP commands cannot be saved", () => {
  for (const input of ['server "unfinished', "server 'unfinished", "server \\"]) expect(splitCommand(input)).toBeNull();
  expect(splitCommand("   ")).toEqual([]);
});

test("README MCP snippets preserve typed arguments and reject malformed configurations", async () => {
  const { parseServerJSON } = await import("../src/mcp");
  const source = { command: "node", args: ["/path with spaces/server.js", "", "a'b"], env: { TOKEN: "test-only" } };
  const parsed = parseServerJSON(JSON.stringify({ mcpServers: { fixture: source } }));
  expect(parsed?.name).toBe("fixture");
  expect(parsed?.args).toEqual(source.args);
  expect(splitCommand(joinCommand([parsed!.command!, ...parsed!.args!]))).toEqual([source.command, ...source.args]);
  for (const value of [null, [], {}, { command: 42 }, { command: "node", args: [1] }, { command: "node", env: { TOKEN: 42 } }, { mcpServers: null }]) expect(parseServerJSON(JSON.stringify(value))).toBeNull();
});

import { serversFromConfig } from "../src/mcp";

test("a pasted Claude Desktop config becomes servers, with secrets kept apart", () => {
  const found = serversFromConfig(JSON.stringify({
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "t" } },
      "Team Wiki": { url: "https://wiki.example.com/mcp", headers: { Authorization: "Bearer x" } },
      broken: { nothing: true },
    },
  }));
  expect(found.map((item) => item.server.id)).toEqual(["mcp-github", "mcp-team-wiki"]);
  expect(found[0].server).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
  expect(found[0].secrets.env).toEqual({ GITHUB_TOKEN: "t" });
  expect(found[1].server).toMatchObject({ transport: "http", url: "https://wiki.example.com/mcp" });
  expect(found[1].secrets.headers).toEqual({ Authorization: "Bearer x" });
});
