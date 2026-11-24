import { SUPPORTED_AGENT_PROVIDERS_HEADER, VALID_AGENT_PROVIDERS } from './agent';
import { KNOWN_WORKSPACE_KINDS_HEADER, WORKSPACE_KINDS } from './routes/workspaces';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export async function fetchWithRedirects(
  url: string,
  init: RequestInit,
  attempt = 0
): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });

  if (REDIRECT_STATUSES.has(response.status)) {
    if (attempt >= MAX_REDIRECTS) {
      throw new Error('Too many redirects while contacting the Okidoki API');
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Redirect status ${response.status} missing Location header`);
    }

    const nextUrl = new URL(location, url).toString();
    const shouldForceGet =
      response.status === 303 &&
      init.method !== undefined &&
      init.method.toUpperCase() !== 'GET';

    return fetchWithRedirects(
      nextUrl,
      { ...init, method: shouldForceGet ? 'GET' : init.method, body: shouldForceGet ? undefined : init.body },
      attempt + 1
    );
  }

  return response;
}

export async function readApiErrorBody(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  const body: Record<string, unknown> = payload && typeof payload === 'object' ? Object.fromEntries(Object.entries(payload)) : {};
  const field = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined);
  return { error: field('error'), code: field('code'), details: field('details'), organizationId: field('organization_id') };
}

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: string) {
    super(message);
  }
}

export async function apiRequest<T>({
  monolithUrl,
  token,
  path,
  organizationId,
  body,
  method = 'GET',
  signal,
}: {
  monolithUrl: string;
  token: string;
  path: string;
  organizationId?: string;
  body?: unknown;
  method?: string;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await fetchWithRedirects(`${monolithUrl}${path}`, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      [SUPPORTED_AGENT_PROVIDERS_HEADER]: VALID_AGENT_PROVIDERS.join(','),
      [KNOWN_WORKSPACE_KINDS_HEADER]: WORKSPACE_KINDS.join(','),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(organizationId ? { 'Okidoki-Org-Id': organizationId } : {}),
    },
    body: body instanceof FormData || body === undefined ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const { error, code, details } = await readApiErrorBody(response);
    throw new ApiRequestError(error ?? 'Request failed', response.status, code, details);
  }
  return (await response.json()) as T;
}
