import { getTotalPages, parsePaginationParams, type PaginationMetadata } from '../types';

export type InferenceModelCatalogSource = 'aster' | 'openrouter' | 'opencode-go' | 'ollama';

export interface ModelCatalogItem {
  id: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  capabilities?: string[];
}

export interface ModelCatalogResponse<
  TSource extends string,
  TModel extends ModelCatalogItem = ModelCatalogItem,
> extends PaginationMetadata {
  source: TSource;
  models: TModel[];
  readOnly?: boolean;
  defaultModel?: string | null;
  moreModelCount?: number;
}

export interface ModelCatalogOptions {
  query?: string;
  page?: number;
  limit?: number;
}

export function createStaticModelCatalog(
  modelIds: readonly string[],
  labels: Record<string, string>,
): ModelCatalogItem[] {
  return modelIds.map((id) => ({ id, displayName: labels[id] ?? id }));
}

export function paginateModelCatalog<TSource extends string, TModel extends ModelCatalogItem>(
  source: TSource,
  models: TModel[],
  options: ModelCatalogOptions,
  getAdditionalSearchTerms?: (model: TModel) => readonly string[],
  maxLimit = 100,
): PaginationMetadata & { source: TSource; models: TModel[] } {
  const pagination = parsePaginationParams({
    page: options.page,
    limit: options.limit,
    defaultLimit: 20,
    maxLimit,
  });
  const query = options.query?.trim().toLowerCase() ?? '';
  const filtered = query
    ? models.filter((model) => [
        model.id,
        model.displayName,
        model.description,
        ...(getAdditionalSearchTerms?.(model) ?? []),
      ].filter(Boolean).join(' ').toLowerCase().includes(query))
    : models;

  return {
    source,
    models: filtered.slice(pagination.offset, pagination.offset + pagination.limit),
    page: pagination.page,
    total: filtered.length,
    limit: pagination.limit,
    totalPages: getTotalPages(filtered.length, pagination.limit),
  };
}
