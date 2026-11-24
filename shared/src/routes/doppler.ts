// Doppler integration types

export interface DopplerCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  apiHost?: string;
  project?: string;
  config?: string;
  lastFetchedAt?: string;
}

export interface DopplerSaveCredentialsRequest {
  serviceToken: string;
  project: string;
  config: string;
  apiHost?: string;
  environment_id: string;
}

export interface DopplerSaveCredentialsResponse {
  success: boolean;
}

export interface DopplerCredentialDeleteResponse {
  success: boolean;
}

export interface DopplerSyncSecretsResponse {
  secrets: Array<{ key: string; value: string }>;
  count: number;
}

export interface DopplerCloneCredentialsRequest {
  source_environment_id: string;
  target_environment_id: string;
  /** When true, deletes the source connection after a successful clone (move semantics). */
  deleteSource?: boolean;
}

export interface DopplerCloneCredentialsResponse {
  success: boolean;
}
