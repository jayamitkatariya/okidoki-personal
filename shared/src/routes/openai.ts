import type { ApiKeyCredentialStatusResponse } from '../credentials/types';
import type { ModelCatalogResponse } from './model-catalog';

export type OpenAIApiKeyCredentialStatusResponse = ApiKeyCredentialStatusResponse;
export type OpenAIApiKeyUserCredentialStatusResponse = OpenAIApiKeyCredentialStatusResponse;

export interface OpenAICompatibleCredentialStatusResponse extends ApiKeyCredentialStatusResponse {
  baseUrl?: string;
  modelsUrl?: string;
  hasAuthorizationHeader?: boolean;
}
export interface OpenAICompatibleUserCredentialStatusResponse extends OpenAICompatibleCredentialStatusResponse {
  authorizationHeader?: string;
}

export type GetOpenAIModelsResponse = ModelCatalogResponse<'static' | 'openai-compatible' | 'ollama'>;
