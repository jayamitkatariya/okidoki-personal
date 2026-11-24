import { z } from 'zod';
import type { TokenUsageCounts } from './analytics/types';
import { isValidAgentProvider, STANDARD_THINKING_LEVELS, type AgentProvider } from './agent';

export const headlessAgentRequestSchema = z.object({
  mode: z.literal('structured'),
  agent: z.custom<AgentProvider>(
    (value) => typeof value === 'string' && isValidAgentProvider(value),
  ),
  model: z.string().min(1),
  prompt: z.string(),
  workingDirectory: z.string().min(1),
  timeoutSeconds: z.number().int().min(1).max(1800).default(300),
  thinkingLevel: z.enum(STANDARD_THINKING_LEVELS).optional(),
  codexOauthTokens: z.object({ accessToken: z.string(), accountId: z.string() }).optional(),
  outputSchema: z.record(z.string(), z.json()),
});

export type HeadlessAgentRequest = z.infer<typeof headlessAgentRequestSchema>;

export type HeadlessAgentUsage = Pick<TokenUsageCounts, 'inputTokens' | 'outputTokens'>;

/** A sidecar rather than a field of the output, so callers on older engines still parse the output unchanged. */
export const headlessAgentUsagePath = (outputPath: string) => `${outputPath}.usage`;
