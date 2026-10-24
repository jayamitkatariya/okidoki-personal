import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
// Non-protocol startup logs must not crash the client.
console.log("null");
console.log("42");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (!message.id) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Local test tool", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: JSON.stringify({ ...message.params.arguments, secret: process.env.OKIDOKI_FIXTURE_SECRET, pid: process.pid }) }] };
  const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  if (message.params?.arguments?.delay) setTimeout(respond, message.params.arguments.delay);
  else respond();
}
