import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// Serves an HTTP MCP server over stdio, so a client off the VM can use it while its URL and headers stay here.
if (!process.env.OKIDOKI_MCP_URL) throw new Error('OKIDOKI_MCP_URL is required');
const url = new URL(process.env.OKIDOKI_MCP_URL);
const headers = z.record(z.string(), z.string()).parse(JSON.parse(process.env.OKIDOKI_MCP_HEADERS ?? '{}'));
const write = (message: JSONRPCMessage) => process.stdout.write(serializeMessage(message));

async function open(kind: 'streamable' | 'sse'): Promise<Transport> {
  const opened = kind === 'streamable'
    ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
    : new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...headers, ...init?.headers } }) } });
  opened.onmessage = (message) => {
    // The SDK's Client normally does this after initialize; later requests must carry the negotiated version.
    if ('result' in message && typeof message.result.protocolVersion === 'string') opened.setProtocolVersion?.(message.result.protocolVersion);
    write(message);
  };
  opened.onerror = (error) => process.stderr.write(`${error.message}\n`);
  opened.onclose = () => process.exit(0);
  await opened.start();
  return opened;
}

// The managed config doesn't say which HTTP transport a server speaks, so a failed first request falls back to legacy SSE, as the MCP spec suggests.
let transport = await open('streamable');
let first: Promise<void> | null = null;
function send(message: JSONRPCMessage): Promise<void> {
  if (first) return first.catch(() => {}).then(() => transport.send(message));
  first = transport.send(message).catch(async () => {
    transport.onclose = undefined;
    await transport.close();
    transport = await open('sse');
    await transport.send(message);
  });
  return first;
}

const buffer = new ReadBuffer();
process.stdin.on('data', (chunk: Buffer) => {
  buffer.append(chunk);
  for (let message = buffer.readMessage(); message; message = buffer.readMessage()) {
    const sent = message;
    send(sent).catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      if (isJSONRPCRequest(sent)) write({ jsonrpc: '2.0', id: sent.id, error: { code: -32000, message: text } });
      else process.stderr.write(`${text}\n`);
    });
  }
});
process.stdin.on('end', () => void transport.close());
