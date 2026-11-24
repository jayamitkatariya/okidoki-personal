import { z } from 'zod';
import { sendChatMessageRequestSchema } from '../engine/v1';

export const generateWorkspaceNameWithImagesRequestSchema = z.object({
  prompt: z.string(),
  images: sendChatMessageRequestSchema.shape.images,
});

export type GenerateWorkspaceNameWithImagesRequest = z.infer<typeof generateWorkspaceNameWithImagesRequestSchema>;

export interface GenerateChatNameResponse {
  name: string | null;
}
