import { ENGINE_ENV } from '../../engine-env';
import { buildCodexAgentEnv } from '../../utils/codex-agent-env';
import { codexTokenManager } from '../codex-token-manager';
import { AppServerProcess } from './app-server-process';
import type { AspClient } from './asp-client';
import { MODEL_LIST_METHOD } from './mappers';
import { withTimeout } from '@okidoki/shared';
import type { v2 } from '@okidoki/shared/codex-asp-types';
import { getOpenAICompatibleCodexModelCatalogConfig } from './openai-compatible-model-catalog';

export interface CodexAspHost {
  client: AspClient;
}

export const CODEX_ULTRAFAST_SERVICE_TIER = 'ultrafast';
// Environment details only need this for the optional Ultrafast list, so it must not hold them up.
const MODEL_LIST_TIMEOUT_MS = 3_000;
const PROBE_RETRY_MS = 10 * 60_000;

let hostPromise: Promise<CodexAspHost> | null = null;
let activeProcess: AppServerProcess | null = null;
let restartPromise: Promise<void> | null = null;
// The catalog depends on the signed-in account, so it lives exactly as long as the host's client.
let modelCatalog: { client: AspClient; models: Promise<v2.Model[]> } | null = null;
let probedCatalog: { credentialId: string; models: Promise<v2.Model[]>; failedAt?: number } | null = null;

async function createAppServerProcess(): Promise<AppServerProcess> {
  // Preparing OAuth can fall back to another login, which the env and config below must reflect.
  const oauthOptions = await codexTokenManager.prepareAspOauthOptions();
  return new AppServerProcess({
    cwd: ENGINE_ENV.WORKSPACE_ROOT,
    env: buildCodexAgentEnv(),
    configOverrides: await getOpenAICompatibleCodexModelCatalogConfig(),
    ...oauthOptions,
  });
}

export async function getCodexAspHost(): Promise<CodexAspHost> {
  if (restartPromise) {
    await restartPromise;
  }

  hostPromise ??= (async () => {
    try {
      const process = await createAppServerProcess();
      const { client } = await process.start();
      activeProcess = process;
      process.on('exit', () => {
        if (activeProcess === process) {
          activeProcess = null;
        }
        hostPromise = null;
      });
      return { client };
    } catch (error) {
      // Clear the cached rejection so the next caller retries instead of replaying it.
      hostPromise = null;
      throw error;
    }
  })();

  return hostPromise;
}

export async function restartCodexAspHost(reason?: Error): Promise<void> {
  if (restartPromise) {
    return restartPromise;
  }

  restartPromise = (async () => {
    const process = activeProcess;
    hostPromise = null;
    activeProcess = null;
    if (process) {
      await process.stop(reason);
    }
  })();

  try {
    await restartPromise;
  } finally {
    restartPromise = null;
  }
}

export async function restartCodexAspHostIfRunning(): Promise<void> {
  if (activeProcess) await restartCodexAspHost();
}

async function requestCodexModels(client: AspClient): Promise<v2.Model[]> {
  const models: v2.Model[] = [];
  let cursor: string | null = null;
  do {
    const response: v2.ModelListResponse = await client.request<v2.ModelListResponse>(
      MODEL_LIST_METHOD,
      { cursor, includeHidden: true },
    );
    models.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return models;
}

export function listCodexModels(host: CodexAspHost): Promise<v2.Model[]> {
  if (modelCatalog?.client !== host.client) {
    const models = requestCodexModels(host.client);
    modelCatalog = { client: host.client, models };
    models.catch(() => {
      if (modelCatalog?.models === models) modelCatalog = null;
    });
  }
  return modelCatalog.models;
}

// Only ChatGPT plans offer Ultrafast, and a resident host costs ~250MB, so other logins never probe.
export async function listCodexModelsForDetails(): Promise<v2.Model[] | undefined> {
  let models: Promise<v2.Model[]> | undefined;
  if (activeProcess && hostPromise) {
    models = hostPromise.then(listCodexModels);
  } else {
    const codex = ENGINE_ENV.OKIDOKI_AGENT_CREDENTIALS.codex;
    if (ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD !== 'oauth' || !codex?.credentialId) return undefined;
    // The revision changes when the login is reconnected, which is when a plan change shows up.
    const credentialId = `${codex.credentialId}:${codex.revision ?? ''}`;
    if (
      probedCatalog?.credentialId !== credentialId
      || (probedCatalog.failedAt && Date.now() - probedCatalog.failedAt > PROBE_RETRY_MS)
    ) {
      const probe: NonNullable<typeof probedCatalog> = { credentialId, models: probeCodexModels() };
      probe.models.catch(() => { probe.failedAt = Date.now(); });
      probedCatalog = probe;
    }
    models = probedCatalog.models;
  }
  try {
    return await withTimeout(models, MODEL_LIST_TIMEOUT_MS, 'Codex model list timed out');
  } catch {
    return undefined;
  }
}

async function probeCodexModels(): Promise<v2.Model[]> {
  const process = await createAppServerProcess();
  try {
    const { client } = await process.start();
    return await requestCodexModels(client);
  } finally {
    await process.stop();
  }
}
