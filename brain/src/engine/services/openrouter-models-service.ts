import { monolithService } from './monolith-service';

const OPENROUTER_MODELS_CACHE_MS = 60_000;
const OPENROUTER_MODELS_STALE_GRACE_MS = 10 * 60_000;

let cache: { models: readonly string[]; fetchedAt: number } | null = null;

/**
 * Org admins choose which OpenRouter models may run. The workspace holds the org's OpenRouter
 * key, so the engine is the last gate before a model is billed — a caller that posts a model
 * straight to the API never passes through the dashboard picker or automation validation.
 *
 * Falling back to the built-in defaults would widen the allowlist for an org that narrowed
 * below them, so an unreachable monolith reuses the last known list instead. That reuse is
 * capped: past the grace window a revoked model would stay billable for the whole outage, so
 * the engine fails closed rather than authorize a list nothing has confirmed, matching
 * command protection.
 */
export async function getAllowedOpenRouterModels(): Promise<readonly string[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < OPENROUTER_MODELS_CACHE_MS) return cache.models;

  // resolveOpenRouterModels substitutes the built-in defaults for an unset preference, so a
  // well-formed response is never empty: treat empty as a bad response, not as an org that
  // allows nothing.
  const models = await monolithService.getOpenRouterModels();
  if (models?.length) {
    cache = { models, fetchedAt: now };
    return models;
  }

  if (cache && now - cache.fetchedAt < OPENROUTER_MODELS_STALE_GRACE_MS) return cache.models;
  cache = null;
  throw new Error('Could not load the organization\'s allowed OpenRouter models; refusing to run an unverified model.');
}
