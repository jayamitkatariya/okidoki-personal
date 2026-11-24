// Bedrock credential status response (for both org and user scopes)
export interface BedrockCredentialStatusResponse {
  hasCredentials: boolean;
  credentialId?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsRegion?: string;
  smallFastModelRegion?: string | null;
  lastFetchedAt?: string;
}

export interface BedrockCredentialUploadResponse {
  success: boolean;
  credentialId?: string;
  awsRegion?: string;
  error?: string;
}

export interface BedrockCredentialDeleteResponse {
  success: boolean;
}

// Type aliases for user-scoped credentials (same structure as org)
export type BedrockUserCredentialStatusResponse = BedrockCredentialStatusResponse;
export type BedrockUserCredentialUploadResponse = BedrockCredentialUploadResponse;
export type BedrockUserCredentialDeleteResponse = BedrockCredentialDeleteResponse;
