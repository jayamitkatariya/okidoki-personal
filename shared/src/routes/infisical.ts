// Infisical integration types

export interface InfisicalCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  siteUrl?: string;
  projectId?: string;
  environment?: string;
  lastFetchedAt?: string;
}

export interface InfisicalSaveCredentialsRequest {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath?: string;
  siteUrl?: string;
  environment_id: string;
}

export interface InfisicalSaveCredentialsResponse {
  success: boolean;
}

export interface InfisicalCredentialDeleteResponse {
  success: boolean;
}

export interface InfisicalSyncSecretsResponse {
  secrets: Array<{ key: string; value: string }>;
  count: number;
}

export type EngineInfisicalRefreshResponse = {
  configured: false;
} | {
  configured: true;
  token: string;
  expiresAt: string;
  projectId: string;
  environment: string;
  siteUrl: string;
};

export interface InfisicalCloneCredentialsRequest {
  source_environment_id: string;
  target_environment_id: string;
  /** When true, deletes the source connection after a successful clone (move semantics). */
  deleteSource?: boolean;
}

export interface InfisicalCloneCredentialsResponse {
  success: boolean;
}
