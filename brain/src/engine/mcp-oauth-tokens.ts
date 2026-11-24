import {
  createErrorResult,
  createSuccessResult,
  engineMcpOAuthTokenResponseSchema,
  isRecord,
  type EngineMcpOAuthTokenResponse,
  type Result,
} from '@okidoki/shared';
import { monolithRequest } from './services/monolith-service';
import { TokenCache, requestToken } from './token-cache';
import { rememberSecret } from './utils/transcript-secrets';

const MIN_REMAINING_MS = 60 * 1000;
// Rechecked well before expiry so a disconnect or reconnect reaches running workspaces within minutes.
const MAX_CACHE_MS = 5 * 60 * 1000;

type McpOAuthTokenResult = Result<EngineMcpOAuthTokenResponse, number>;

export class McpOAuthTokens {
  private readonly tokens = new TokenCache<EngineMcpOAuthTokenResponse, number>();

  constructor(private readonly request: typeof monolithRequest = monolithRequest) {}

  get(environmentMcpId: string, forceRefresh = false): Promise<McpOAuthTokenResult> {
    return this.tokens.get(environmentMcpId, () => this.fetch(environmentMcpId, forceRefresh), forceRefresh);
  }

  private async fetch(
    environmentMcpId: string,
    forceRefresh: boolean,
  ): Promise<Result<{ token: EngineMcpOAuthTokenResponse; refreshAt: number }, number>> {
    const requested = await requestToken(
      this.request,
      '/v1/engine/mcp-oauth/token',
      { environment_mcp_id: environmentMcpId, force_refresh: forceRefresh },
      'MCP OAuth token request failed',
    );
    if (!requested.ok) return requested;
    const response = requested.data;
    const data: unknown = await response.json().catch(() => null);
    const parsed = engineMcpOAuthTokenResponseSchema.safeParse(data);
    if (!response.ok || !parsed.success) {
      const message = isRecord(data) && typeof data.error === 'string' ? data.error : `MCP OAuth token request failed: ${response.status}`;
      return createErrorResult({ message, code: response.ok ? 502 : response.status });
    }
    rememberSecret(`mcp:${environmentMcpId}`, parsed.data.access_token);
    const remaining = parsed.data.expires_at ? Date.parse(parsed.data.expires_at) - Date.now() : Infinity;
    // Short-lived tokens are cached for half their remaining lifetime instead of being refetched on every request.
    return createSuccessResult({
      token: parsed.data,
      refreshAt: Date.now() + Math.min(Math.max(remaining - MIN_REMAINING_MS, remaining / 2), MAX_CACHE_MS),
    });
  }
}

export const mcpOAuthTokens = new McpOAuthTokens();
