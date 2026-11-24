import { shouldRefreshPullRequests, type PullRequestToolResult } from '@okidoki/shared';

import { publishedPullRequestUrls } from './published-pull-request-urls';

export async function notifyPostToolUse(
  toolName: string, toolInput: unknown, result?: Pick<PullRequestToolResult, 'output' | 'success'>,
): Promise<boolean> {
  const publication = result ? { toolName, toolInput, ...result } : undefined;
  if (!shouldRefreshPullRequests(toolName, toolInput) && (!publication || publishedPullRequestUrls(publication).length === 0)) return false;
  const port = process.env.OKIDOKI_ENGINE_PORT;
  const secret = process.env.OKIDOKI_ENGINE_SECRET;
  if (!port || !secret) throw new Error('Okidoki engine connection is unavailable.');
  const response = await fetch(`http://127.0.0.1:${port}/pull-requests/check`, {
    method: 'POST',
    headers: { 'X-Okidoki-Engine-Secret': secret, ...(publication ? { 'Content-Type': 'application/json' } : {}) },
    ...(publication ? { body: JSON.stringify(publication) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Okidoki pull request check failed (${response.status}).`);
  return true;
}
