import { z } from 'zod';

export const WEB_AUTH_HANDOFF_ENDPOINT = '/v1/web-auth/handoff';
export const WEB_AUTH_REDEEM_ENDPOINT = '/v1/web-auth/handoff/redeem';
export const WEB_AUTH_SIGN_OUT_ENDPOINT = '/v1/web-auth/sign-out';

export interface WebAuthHandoffRequest {
  path: string;
  organizationId?: string;
}

export interface WebAuthHandoffResponse {
  url: string;
}

export const webAuthRedeemResponseSchema = z.object({
  path: z.string(),
  organizationId: z.string().nullable(),
  session: z.object({ access_token: z.string(), refresh_token: z.string(), user: z.object({ id: z.string(), email: z.string() }) }).nullable(),
});

export type WebAuthRedeemResponse = z.infer<typeof webAuthRedeemResponseSchema>;
