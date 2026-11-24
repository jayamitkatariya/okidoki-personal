import { z } from 'zod';

export const presenceStatusSchema = z.enum(['online', 'typing']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

export const presenceLocationSchema = z.object({
  workspaceId: z.string().optional(),
});
export type PresenceLocation = z.infer<typeof presenceLocationSchema>;

export const presenceEntrySchema = z.object({
  userId: z.string(),
  status: presenceStatusSchema,
  location: presenceLocationSchema,
  ts: z.string(),
});
export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

export interface GetPresenceResponse {
  presence: PresenceEntry[];
}

export const updatePresenceRequestSchema = z.object({
  status: presenceStatusSchema,
  location: presenceLocationSchema.optional(),
});

export type UpdatePresenceRequest = z.infer<typeof updatePresenceRequestSchema>;

export interface UpdatePresenceResponse {
  success: boolean;
}
