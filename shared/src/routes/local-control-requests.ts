import { z } from 'zod';

export const createLocalControlRequestSchema = z.object({
  reason: z.string().trim().max(500).optional().transform((value) => value || null),
  wait: z.boolean().default(true),
});

export const respondLocalControlRequestSchema = z.object({ action: z.enum(['allow', 'dismiss']) });
export type RespondLocalControlRequest = z.infer<typeof respondLocalControlRequestSchema>;

export const setLocalControlSchema = z.object({ enabled: z.boolean() });
export type SetLocalControlRequest = z.infer<typeof setLocalControlSchema>;

export interface CreateLocalControlRequestResponse {
  url: string;
  wait: boolean;
}

export interface PollLocalControlRequestResponse {
  pending: boolean;
}

/** Only the workspace's owner sees the request: it asks for their computer. */
export interface WorkspaceLocalControlRequestResponse {
  request: { reason: string | null } | null;
}

export const LOCAL_CONTROL_REQUESTS_QUERY_ROOT = 'local-control-request';

export const localControlRequestQueryKey = (organizationId: string | null, workspaceId: string | null) =>
  [LOCAL_CONTROL_REQUESTS_QUERY_ROOT, organizationId, workspaceId];
