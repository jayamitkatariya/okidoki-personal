import type { ApiKeyCredentialStatusResponse } from '../credentials/types';
import type { ModelCatalogResponse } from './model-catalog';

export type OpenRouterApiKeyCredentialStatusResponse = ApiKeyCredentialStatusResponse;
export type OpenRouterApiKeyUserCredentialStatusResponse = OpenRouterApiKeyCredentialStatusResponse;

export type OpenRouterModelCatalogSource = 'static' | 'openrouter';

export type GetOpenRouterModelsResponse = ModelCatalogResponse<OpenRouterModelCatalogSource>;
