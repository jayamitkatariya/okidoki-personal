import {
  AWS_SOURCE_IDENTITY_CLAIM,
  WORKSPACE_IDENTITY_AUDIENCE,
  createErrorResult,
  createSuccessResult,
  isRecord,
  legacyWorkspaceTokenBundleSchema,
  workspaceAudienceSchema,
  workspaceTokenResponseSchema,
  type Result,
  type WorkspaceTokenResponse,
} from '@okidoki/shared';
import { monolithRequest } from './services/monolith-service';
import { TokenCache, requestToken } from './token-cache';
import { rememberSecret } from './utils/transcript-secrets';

const MIN_REMAINING_MS = 5 * 60 * 1000;
const MAX_CACHED_AUDIENCES = 32;

type WorkspaceTokenResult = Result<WorkspaceTokenResponse, 400 | 503>;

export class WorkspaceIdentityTokens {
  private readonly tokens = new TokenCache<WorkspaceTokenResponse, 400 | 503>(MAX_CACHED_AUDIENCES);

  constructor(private readonly request: typeof monolithRequest = monolithRequest) {}

  async get(audience = WORKSPACE_IDENTITY_AUDIENCE, awsSourceIdentity = false): Promise<WorkspaceTokenResult> {
    const parsed = workspaceAudienceSchema.safeParse(audience);
    if (!parsed.success) {
      return createErrorResult({ message: parsed.error.issues[0]?.message ?? 'Invalid audience', code: 400 });
    }
    // Audiences never contain spaces, so the suffix cannot collide with a real audience.
    const key = awsSourceIdentity ? `${audience} aws_source_identity` : audience;
    return this.tokens.get(key, () => this.mint(audience, awsSourceIdentity));
  }

  private async mint(audience: string, awsSourceIdentity: boolean): Promise<Result<{ token: WorkspaceTokenResponse; refreshAt: number }, 400 | 503>> {
    const requested = await requestToken(this.request, '/v1/engine/workspace-identity/token', { audience, aws_source_identity: awsSourceIdentity }, 'Workspace identity request failed');
    if (!requested.ok) return requested;
    const response = requested.data;
    if (!response.ok) {
      return createErrorResult({ message: `Workspace identity request failed: ${response.status} ${await response.text()}`, code: response.status === 400 ? 400 : 503 });
    }
    const data: unknown = await response.json().catch(() => null);
    if (isRecord(data) && data.configured === false) {
      return createErrorResult({ message: 'Workspace identity is not enabled for this workspace', code: 503 });
    }
    const parsed = workspaceTokenResponseSchema.safeParse(data);
    // Monoliths before this engine return the allowlist-era bundle; take the requested audience from it.
    const legacy = parsed.success ? null : legacyWorkspaceTokenBundleSchema.safeParse(data);
    const token: WorkspaceTokenResponse | null = parsed.success
      ? parsed.data
      : legacy?.success && legacy.data.tokens[audience]
        ? { issuer: legacy.data.issuer, audience, ...legacy.data.tokens[audience] }
        : null;
    if (!token) {
      return createErrorResult({ message: `Workspace identity token for ${audience} is unavailable from this Okidoki version`, code: 503 });
    }
    if (awsSourceIdentity) {
      // Monoliths before the source identity claim drop the flag and mint without it.
      const payload: unknown = JSON.parse(Buffer.from(token.token.split('.')[1] ?? '', 'base64url').toString() || 'null');
      if (!isRecord(payload) || typeof payload[AWS_SOURCE_IDENTITY_CLAIM] !== 'string') {
        return createErrorResult({ message: 'AWS source identity is unavailable from this Okidoki version', code: 503 });
      }
    }
    rememberSecret(`identity:${audience}:${awsSourceIdentity}`, token.token);
    return createSuccessResult({ token, refreshAt: Date.parse(token.expires_at) - MIN_REMAINING_MS });
  }
}

export const workspaceIdentityTokens = new WorkspaceIdentityTokens();
