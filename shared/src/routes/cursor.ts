import type { ApiKeyCredentialStatusResponse } from '../credentials/types';
import type { ModelCatalogItem, ModelCatalogResponse } from './model-catalog';

export type CursorApiKeyCredentialStatusResponse = ApiKeyCredentialStatusResponse;
export type CursorApiKeyUserCredentialStatusResponse = CursorApiKeyCredentialStatusResponse;

export type CursorModelCatalogSource = 'static' | 'cursor';

export interface CursorModelCatalogItem extends ModelCatalogItem {
  aliases?: string[];
}

export type GetCursorModelsResponse = ModelCatalogResponse<CursorModelCatalogSource, CursorModelCatalogItem>;

export const CURSOR_AUTH_ENV_KEYS = ['CURSOR_API_KEY'];
