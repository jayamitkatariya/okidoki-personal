import { z } from 'zod';
import { agentCredentialSnapshotSchema } from '../analytics/types';
import { OKIDOKI_MODEL_PROVIDERS } from './models';

export const HARNESS_WORKER_PATH_PREFIX = '/v1/harness-worker';
/** Sent by workers that can run a call on our key, so a monolith deployed ahead of them never answers `{ method: 'okidoki' }` to one that can't. */
export const HARNESS_OKIDOKI_KEY_HEADER = 'x-harness-supports-okidoki-inference';

export const HARNESS_ENGINE_TOO_OLD_MESSAGE = "This workspace's engine is too old for Okidoki. Update the engine, then send your message again.";

export const harnessWorkerEngineRequestSchema = z.object({
  /** The engine we were given didn't answer, so the monolith checks the provider instead of trusting the workspace's status. */
  unreachable: z.boolean().optional(),
});
export type HarnessWorkerEngineRequest = z.infer<typeof harnessWorkerEngineRequestSchema>;

export const harnessWorkerEngineResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    engineUrl: z.string(),
    headers: z.record(z.string(), z.string()),
    /** Web search and page reads go to Context.dev, so an organization with a BAA doesn't get them. Absent from an older monolith, so off. */
    webAccess: z.boolean().default(false),
    /** Managers delegate to ships in their own workspaces rather than in-workspace subagents. Absent from an older monolith, so on. */
    subagents: z.boolean().default(true),
  }),
  z.object({ status: z.literal('waking') }),
]);
export type HarnessWorkerEngineResponse = z.infer<typeof harnessWorkerEngineResponseSchema>;

export const harnessWorkerCredentialRequestSchema = z.object({
  /** The credential the model rejected, so the monolith refreshes it or moves to the next one instead of handing it back. */
  failedCredential: agentCredentialSnapshotSchema.optional(),
  failure: z.enum(['auth', 'rate_limit', 'quota']).optional(),
  // A worker from before Claude models sends none, and only ever calls OpenAI.
  modelProvider: z.enum(OKIDOKI_MODEL_PROVIDERS).default('openai'),
});
export type HarnessWorkerCredentialRequest = z.infer<typeof harnessWorkerCredentialRequestSchema>;

export const harnessWorkerCredentialResponseSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('oauth'), accessToken: z.string(), expiresAt: z.string(), credential: agentCredentialSnapshotSchema }),
  z.object({ method: z.literal('api_key'), apiKey: z.string(), credential: agentCredentialSnapshotSchema }),
  /** Run the call on our own key, which the worker reads from its environment; it's billed to the organization at cost. */
  z.object({ method: z.literal('okidoki') }),
]);
export type HarnessWorkerCredentialResponse = z.infer<typeof harnessWorkerCredentialResponseSchema>;

export const harnessWorkerAccessResponseSchema = z.object({ allowed: z.boolean() });
export type HarnessWorkerAccessResponse = z.infer<typeof harnessWorkerAccessResponseSchema>;

export const harnessWorkerTurnCompleteRequestSchema = z.object({ errors: z.array(z.string()) });
export type HarnessWorkerTurnCompleteRequest = z.infer<typeof harnessWorkerTurnCompleteRequestSchema>;
