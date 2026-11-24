import type { ApiKeyCredentialStatusResponse } from '../credentials/types';
import type { ModelCatalogResponse } from './model-catalog';

export type GetOpenCodeGoModelsResponse = ModelCatalogResponse<'opencode-go' | 'static'>;

export type OpenCodeGoCredentialStatusResponse = ApiKeyCredentialStatusResponse;
export type OpenCodeGoUserCredentialStatusResponse = OpenCodeGoCredentialStatusResponse;
