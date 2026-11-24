import { AGENT, detectEnvironmentAuthMethod, type EngineAuthMethod } from '@okidoki/shared';
import { ENGINE_ENV } from '../engine-env';

export function detectCodexAuthMethod(): EngineAuthMethod {
  return ENGINE_ENV.OKIDOKI_CODEX_AUTH_METHOD
    ?? detectEnvironmentAuthMethod(AGENT.CODEX, process.env)
    ?? 'none';
}
