import http from 'node:http';
import https from 'node:https';
import { IDENTITY_TOKEN_PATH, workspaceTokenRequestSchema } from '@okidoki/shared';
import type { WorkspaceIdentityTokens } from './workspace-identity-tokens';
import type { McpOAuthTokens } from './mcp-oauth-tokens';

const STRIPPED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);
const MAX_TOKEN_REQUEST_BYTES = 4096;

const decode = (segment: string) => Buffer.from(segment, 'base64url').toString('utf8');

export function resolveIdentityRoute(requestUrl: string): { target: URL; audience: string } | null {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const [, kind, encodedAudience, encodedTarget, ...rest] = url.pathname.split('/');
  if (kind !== 'identity' || !encodedAudience || !encodedTarget) return null;
  let target: URL;
  try {
    target = new URL(decode(encodedTarget));
  } catch {
    return null;
  }
  const loopback = target.hostname === 'localhost' || target.hostname === '127.0.0.1';
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) return null;
  target.pathname = [target.pathname.replace(/\/$/, ''), ...rest].join('/') || '/';
  target.search = url.search;
  return { target, audience: decode(encodedAudience) };
}

export function resolveMcpOAuthRoute(requestUrl: string): { environmentMcpId: string; rest: string[]; search: string } | null {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const [, kind, environmentMcpId, ...rest] = url.pathname.split('/');
  return kind === 'mcp-oauth' && environmentMcpId ? { environmentMcpId, rest, search: url.search } : null;
}

const MAX_MCP_OAUTH_BODY_BYTES = 10 * 1024 * 1024;

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer | 'too_large' | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) resolve('too_large');
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(null));
  });
}

function forward(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  target: URL,
  token: string,
  onResponse: (incoming: http.IncomingMessage) => void = (incoming) => pipeResponse(incoming, response),
): http.ClientRequest {
  const headers: http.OutgoingHttpHeaders = { host: target.host };
  for (const [name, value] of Object.entries(request.headers)) {
    if (!STRIPPED_HEADERS.has(name) && !name.startsWith('x-okidoki-') && value !== undefined) headers[name] = value;
  }
  headers.authorization = `Bearer ${token}`;
  const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers }, onResponse);
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  response.on('close', () => upstream.destroy());
  return upstream;
}

function pipeResponse(incoming: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(incoming.statusCode ?? 502, incoming.headers);
  incoming.pipe(response);
  response.on('close', () => incoming.destroy());
}

async function proxyMcpOAuth(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  tokens: Pick<McpOAuthTokens, 'get'>,
  route: NonNullable<ReturnType<typeof resolveMcpOAuthRoute>>,
): Promise<void> {
  // Buffered so the request can be replayed once if the provider rejects a token before its expiry.
  const body = await readBody(request, MAX_MCP_OAUTH_BODY_BYTES);
  if (body === 'too_large') {
    response.writeHead(413, { connection: 'close' }).end();
    return;
  }
  if (!body) {
    response.writeHead(400).end();
    return;
  }
  const send = async (forceRefresh: boolean): Promise<void> => {
    const token = await tokens.get(route.environmentMcpId, forceRefresh);
    if (!token.ok) {
      response.writeHead(token.error.code ?? 503).end(token.error.message);
      return;
    }
    const target = new URL(token.data.url);
    if (route.rest.length) target.pathname = [target.pathname.replace(/\/$/, ''), ...route.rest].join('/');
    target.search = route.search;
    forward(request, response, target, token.data.access_token, (incoming) => {
      if (incoming.statusCode === 401 && !forceRefresh) {
        incoming.resume();
        void send(true);
        return;
      }
      pipeResponse(incoming, response);
    }).end(body);
  };
  await send(false);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(request, MAX_TOKEN_REQUEST_BYTES);
  if (!body || body === 'too_large') return null;
  const text = body.toString('utf8').trim();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

export function createIdentityProxy(tokens: Pick<WorkspaceIdentityTokens, 'get'>, mcpOAuthTokens: Pick<McpOAuthTokens, 'get'>) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === IDENTITY_TOKEN_PATH) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const body = workspaceTokenRequestSchema.safeParse(await readJsonBody(request));
      if (!body.success) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Body must be JSON with an optional printable "audience" string and optional boolean "aws_source_identity"' }));
        return;
      }
      const result = await tokens.get(body.data.audience, body.data.aws_source_identity);
      response.writeHead(result.ok ? 200 : result.error.code ?? 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result.ok ? result.data : { error: result.error.message }));
      return;
    }
    const mcpOAuthRoute = resolveMcpOAuthRoute(request.url ?? '/');
    if (mcpOAuthRoute) {
      await proxyMcpOAuth(request, response, mcpOAuthTokens, mcpOAuthRoute);
      return;
    }
    const route = resolveIdentityRoute(request.url ?? '/');
    if (!route) {
      response.writeHead(404).end('Unknown identity route');
      return;
    }
    const token = await tokens.get(route.audience);
    if (!token.ok) {
      response.writeHead(token.error.code ?? 503).end(token.error.message);
      return;
    }
    request.pipe(forward(request, response, route.target, token.data.token));
  });
}
