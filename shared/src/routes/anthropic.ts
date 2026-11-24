import type {
  ApiKeyCredentialStatusResponse,
} from '../credentials/types';

export type AnthropicApiKeyCredentialStatusResponse = ApiKeyCredentialStatusResponse;
export type AnthropicApiKeyUserCredentialStatusResponse = AnthropicApiKeyCredentialStatusResponse;
export interface AnthropicCompatibleCredentialStatusResponse extends ApiKeyCredentialStatusResponse {
  baseUrl?: string;
}
