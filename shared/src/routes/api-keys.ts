import type { ResourceScope } from '../automations/types';

export type APIKeyScope = ResourceScope;

export interface APIKey {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export interface CreateAPIKeyRequest {
  name: string;
}

export interface CreateAPIKeyResponse {
  apiKey: APIKey;
  key: string;
}

export interface ListAPIKeysResponse {
  apiKeys: APIKey[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DeleteAPIKeyResponse {
  success: boolean;
}
