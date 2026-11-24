import { normalizeOpenAICompatibleCredential } from './openai';
import { createErrorResult, createSuccessResult, type Result } from '../result';
import type { ApiKeyCredentialStatusResponse, ApiKeyCredentials } from './types';

export const OLLAMA_BASE_URL = 'https://ollama.com';
export const OLLAMA_AGENTS = ['claude', 'codex', 'opencode', 'pi'] as const;
export type OllamaAgent = (typeof OLLAMA_AGENTS)[number];

export interface OllamaCredentials extends ApiKeyCredentials {
  baseUrl: string;
  models?: string[];
}

export interface OllamaCredentialStatusResponse extends ApiKeyCredentialStatusResponse {
  baseUrl?: string;
  models?: string[];
}

export function normalizeOllamaCredential(values: OllamaCredentials): Result<OllamaCredentials> {
  if (values.models !== undefined && (!Array.isArray(values.models) || values.models.length === 0
    || values.models.length > 500 || values.models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 200))) {
    return createErrorResult({ message: 'Choose at least one model, or use all available models.' });
  }
  const normalized = normalizeOpenAICompatibleCredential({
    ...values,
    baseUrl: values.baseUrl.trim() || OLLAMA_BASE_URL,
    modelsUrl: '',
    authorizationHeader: '',
  });
  if (!normalized.ok) return normalized;
  return createSuccessResult({
    apiKey: normalized.data.apiKey,
    baseUrl: normalized.data.baseUrl.replace(/\/v1$/, ''),
    ...(values.models ? { models: [...new Set(values.models.map((model) => model.trim()))] } : {}),
  });
}

export function ollamaAuthEnvKeys(agent: OllamaAgent): string[] {
  return ['API_KEY', 'BASE_URL'].map((key) => `OKIDOKI_${agent.toUpperCase()}_OLLAMA_${key}`);
}

export function ollamaAuthEnv(agent: OllamaAgent, credential: OllamaCredentials): Record<string, string> {
  const [key, url] = ollamaAuthEnvKeys(agent);
  return { [key]: credential.apiKey, [url]: credential.baseUrl };
}

export function readOllamaAuthEnv(agent: OllamaAgent, env: Record<string, string | undefined>): OllamaCredentials | null {
  const [key, url] = ollamaAuthEnvKeys(agent);
  const apiKey = env[key];
  const baseUrl = env[url];
  return apiKey && baseUrl ? { apiKey, baseUrl } : null;
}
