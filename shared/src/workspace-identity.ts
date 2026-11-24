import { z } from 'zod';

export const WORKSPACE_IDENTITY_AUDIENCE = 'okidoki:workspace';
export const AWS_SOURCE_IDENTITY_CLAIM = 'https://aws.amazon.com/source_identity';
export const WORKSPACE_TOKEN_TTL_SECONDS = 15 * 60;
export const WORKSPACE_IDENTITY_DISCOVERY_PATH = '/.well-known/openid-configuration';
export const WORKSPACE_IDENTITY_JWKS_PATH = '/.well-known/jwks.json';
export const IDENTITY_PROXY_PORT = 17323;
export const IDENTITY_TOKEN_PATH = '/token';

export const WORKSPACE_TOKEN_ENV = {
  TOKEN: 'OKIDOKI_WORKSPACE_TOKEN',
  AUDIENCE: 'OKIDOKI_WORKSPACE_TOKEN_AUDIENCE',
};

export const workspaceAudienceSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Audience must be a single printable token without spaces');

export const workspaceTokenRequestSchema = z.object({
  audience: workspaceAudienceSchema.optional(),
  aws_source_identity: z.boolean().optional(),
});

export const workspaceTokenClaimsSchema = z
  .object({
    iss: z.string(),
    sub: z.string(),
    aud: z.string(),
    iat: z.number().int(),
    nbf: z.number().int(),
    exp: z.number().int(),
    jti: z.string(),
    organization_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    environment_id: z.string().uuid(),
    creator_id: z.string().uuid().nullable(),
    creator_email: z.string().nullable().default(null),
    [AWS_SOURCE_IDENTITY_CLAIM]: z.string().uuid().optional(),
  })
  .passthrough();

export type WorkspaceTokenClaims = z.infer<typeof workspaceTokenClaimsSchema>;

export const workspaceTokenResponseSchema = z.object({
  issuer: z.string(),
  audience: z.string(),
  token: z.string(),
  expires_at: z.string(),
});

export type WorkspaceTokenResponse = z.infer<typeof workspaceTokenResponseSchema>;

export type EngineWorkspaceIdentityResponse =
  | { configured: false }
  | ({ configured: true } & WorkspaceTokenResponse);

/** Shape engines before 0.1.892 expect; retire once no sandbox runs an older engine. */
export const legacyWorkspaceTokenBundleSchema = z.object({
  version: z.literal(1),
  issuer: z.string(),
  default_audience: z.string(),
  tokens: z.record(z.string(), z.object({ token: z.string(), expires_at: z.string() })),
});
export type LegacyWorkspaceTokenBundle = z.infer<typeof legacyWorkspaceTokenBundleSchema>;

export const mcpWorkloadAuthSchema = z.strictObject({
  type: z.literal('workspace_identity'),
  audience: workspaceAudienceSchema,
});
export type McpWorkloadAuth = z.infer<typeof mcpWorkloadAuthSchema>;

export const mcpAuthSchema = z.discriminatedUnion('type', [
  mcpWorkloadAuthSchema,
  z.strictObject({ type: z.literal('oauth') }),
]);
export type McpAuth = z.infer<typeof mcpAuthSchema>;

const base64url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function identityTokenUrl(): string {
  return `http://127.0.0.1:${IDENTITY_PROXY_PORT}${IDENTITY_TOKEN_PATH}`;
}

export function identityRouteUrl(audience: string, target: string): string {
  return `http://127.0.0.1:${IDENTITY_PROXY_PORT}/identity/${base64url(audience)}/${base64url(target)}`;
}

export function mcpOAuthRouteUrl(environmentMcpId: string): string {
  return `http://127.0.0.1:${IDENTITY_PROXY_PORT}/mcp-oauth/${environmentMcpId}`;
}

export const engineMcpOAuthTokenRequestSchema = z.object({
  environment_mcp_id: z.string().uuid(),
  force_refresh: z.boolean().optional(),
});

export const engineMcpOAuthTokenResponseSchema = z.object({
  url: z.string(),
  access_token: z.string(),
  expires_at: z.string().nullable(),
});
export type EngineMcpOAuthTokenResponse = z.infer<typeof engineMcpOAuthTokenResponseSchema>;

/** Hierarchical so verifiers limited to `sub` matching (AWS IAM) can still scope by environment. */
export function workspaceTokenSubject(organizationId: string, environmentId: string, workspaceId: string): string {
  return `org:${organizationId}:env:${environmentId}:workspace:${workspaceId}`;
}
