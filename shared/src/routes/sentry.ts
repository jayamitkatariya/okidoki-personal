import { z } from 'zod';

export interface SentryStartOAuthResponse {
  authorizationUrl: string;
}

export interface SentryCredentialStatusResponse {
  hasCredentials: boolean;
  organizationSlug?: string;
  organizationName?: string;
  lastFetchedAt?: string;
  selfHosted?: {
    baseUrl: string;
    webhookUrl: string;
    webhooksEnabled: boolean;
  };
}

export const sentrySelfHostedConnectRequestSchema = z.object({
  baseUrl: z.string().min(1),
  token: z.string().trim().min(1),
  webhookSecret: z.string().trim().optional(),
});
export type SentrySelfHostedConnectRequest = z.infer<typeof sentrySelfHostedConnectRequestSchema>;

export interface SentryCredentialDeleteResponse {
  success: boolean;
}

export interface SentryProjectSummary {
  id: string;
  slug: string;
  name: string;
}

export interface SentryProjectsResponse {
  projects: SentryProjectSummary[];
}
