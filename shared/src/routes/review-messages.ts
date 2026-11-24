import { z } from 'zod';
import { VALID_AGENT_PROVIDERS } from '../agent';
import { sendChatMessageRequestSchema } from '../engine/v1';

// Kept out of ./reviews, which engine/types imports, because this needs engine/v1 at runtime.
// A fresh object strips unpicked fields like goalMode instead of passing them through to the chat.
export const sendPullRequestReviewMessageRequestSchema = z.object({
  ...sendChatMessageRequestSchema.pick({
    message: true,
    messageId: true,
    submittedAt: true,
    model: true,
    images: true,
    canvasUploadIds: true,
    thinkingLevel: true,
    fastMode: true,
    ultrafastMode: true,
  }).shape,
  /** Starts a new chat instead of continuing the PR's review chat. The provider only applies to a new chat. */
  newChat: z.boolean().optional(),
  provider: z.enum(VALID_AGENT_PROVIDERS).optional(),
});

export type SendPullRequestReviewMessageRequest = z.infer<typeof sendPullRequestReviewMessageRequestSchema>;
