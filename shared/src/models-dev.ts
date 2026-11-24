import { z } from 'zod';
import { withTimeout } from './async';

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_DEV_CACHE_MS = 5 * 60_000;
const MODELS_DEV_TIMEOUT_MS = 5000;

const modelsDevCatalogSchema = z.record(z.string(), z.object({
  models: z.record(z.string(), z.object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
    provider: z.object({ npm: z.string().optional() }).optional(),
    cost: z.object({
      input: z.number().finite().nonnegative().optional(),
      output: z.number().finite().nonnegative().optional(),
      cache_read: z.number().finite().nonnegative().optional(),
      cache_write: z.number().finite().nonnegative().optional(),
    }).optional(),
  })),
}));

type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>;

let catalogCache: { catalog: ModelsDevCatalog; expiresAt: number } | undefined;
let catalogRequest: Promise<ModelsDevCatalog> | undefined;

export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog> {
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.catalog;

  // fetch's own abort signal once failed to fire in production and every caller after it hung, so the deadline doesn't rely on it.
  catalogRequest ??= withTimeout((async () => {
    const response = await fetch(MODELS_DEV_API_URL, { signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Failed to load models.dev catalog (${response.status})`);
    return modelsDevCatalogSchema.parse(await response.json());
  })(), MODELS_DEV_TIMEOUT_MS, 'Timed out loading models.dev catalog').then((catalog) => {
    catalogCache = { catalog, expiresAt: Date.now() + MODELS_DEV_CACHE_MS };
    return catalog;
  }).finally(() => {
    catalogRequest = undefined;
  });

  if (!catalogCache) return catalogRequest;
  catalogRequest.catch(() => undefined);
  return catalogCache.catalog;
}
