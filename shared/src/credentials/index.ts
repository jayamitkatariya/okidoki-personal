export * from './ollama';
export * from './services';
export * from './ollama-models';
export { buildScopedCredentialPath, CREDENTIAL_SCOPE, CREDENTIAL_SCOPES, CREDENTIAL_SCOPE_PRIORITY } from './types';
export type { CredentialFailureKind } from './types';
export {
  AGENT_CREDENTIAL_METHODS_IN_ORDER,
  CREDENTIAL_METHOD,
  CREDENTIAL_TYPE,
  detectEnvironmentAuthMethod,
  ENVIRONMENT_AUTH_REQUIRED_KEYS,
  getAgentCredentialType,
  getAgentCredentialTypes,
  getCredentialMethodLabel,
  INFERENCE_PROVIDER_LABELS,
  isEnvironmentKeySet,
  agentCredentialMethods,
  rankAgentCredentialMethods,
  resolveCredentialMethodOrder,
  sanitizeCredentialPriority,
} from './agents';

export type { AgentCredentialMethod, AgentCredentialMethodEntry, AuthMethod, EnvironmentAuthAgent, CredentialPriority, SandboxAuth, SandboxAuthFile } from './agents';

export type {
  // Common
  ApiKeyCredentials,
  CredentialScope,
  ApiKeyCredentialUploadResponse,
  ApiKeyCredentialStatusResponse,
  ApiKeyCredentialDeleteResponse,
  // Claude
  ClaudeProfile,
  ClaudeCredentials,
  // Codex
  CodexUserInfo,
  CodexCredentials,
  MuseCredentials,
  GeminiCredentials,
  CodexIdTokenClaims,
  // Bedrock
  BedrockCredentials,
  ClaudeFoundryCredentials,
  CodexFoundryCredentials,
  // Anthropic API Key
  AnthropicApiKeyCredentials,
  AnthropicCompatibleCredentials,
  // OpenAI API Key
  OpenAIApiKeyCredentials,
  OpenAICompatibleCredentials,
  OpenAICompatibleCredentialValues,
  OpenRouterApiKeyCredentials,
  AsterApiKeyCredentials,
  OpenCodeGoCredentials,
  CursorApiKeyCredentials,
} from './types';

export {
  hasOpenAICompatibleCredential,
  listOpenAICompatibleModels,
  normalizeOpenAICompatibleCredential,
  openAICompatibleAuthEnv,
  openAICompatibleAuthEnvKeys,
  parseOpenAICompatibleModels,
  readOpenAICompatibleAuthEnv,
  resolveOpenAICompatibleModelsUrl,
  type OpenAICompatibleEnvAgent,
} from './openai';
