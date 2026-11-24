import { readFile } from 'fs/promises';
import {
  readOllamaAuthEnv,
  readOpenAICompatibleAuthEnv,
  AGENT_CREDENTIAL_METHODS_IN_ORDER,
  createErrorResult,
  createSuccessResult,
  type AgentCredentialMethod,
  type Result,
} from '@okidoki/shared';
import { isRecord } from '../utils/type-guards';
import { PI_AUTH_PATH } from './agent-auth-paths';

export async function getPiProviderCredentials(): Promise<Result<{ provider: AgentCredentialMethod<'pi'>; apiKey: string }>> {
  const ollama = readOllamaAuthEnv('pi', process.env);
  if (ollama) return createSuccessResult({ provider: 'ollama', apiKey: ollama.apiKey });
  const compatible = readOpenAICompatibleAuthEnv('pi', process.env);
  if (compatible) return createSuccessResult({ provider: 'openai-compatible', apiKey: compatible.apiKey ?? '' });
  let credentials: unknown;
  try {
    credentials = JSON.parse(await readFile(PI_AUTH_PATH, 'utf8'));
  } catch {
    return createErrorResult({ message: 'Pi credentials are unavailable.' });
  }
  if (isRecord(credentials)) {
    for (const { method: provider } of AGENT_CREDENTIAL_METHODS_IN_ORDER.pi) {
      const credential = credentials[provider];
      if (isRecord(credential) && credential.type === 'api_key' && typeof credential.key === 'string') {
        return createSuccessResult({ provider, apiKey: credential.key });
      }
    }
  }
  return createErrorResult({ message: 'Pi API key is not configured.' });
}
