import type { EngineAuthMethod } from '@okidoki/shared';

export function applyAuthEnvTransition<K extends string>(params: {
  prevMethod: EngineAuthMethod;
  authKeys: readonly K[];
  authKeysByMethod: Record<EngineAuthMethod, readonly K[]>;
  newEnvVars: Partial<Record<K, string>>;
  envs: readonly object[];
}): void {
  const prevOwned = new Set(params.authKeysByMethod[params.prevMethod]);

  for (const key of params.authKeys) {
    const value = params.newEnvVars[key];
    if (value !== undefined) {
      for (const env of params.envs) {
        (env as Record<string, string | undefined>)[key] = value;
      }
    } else if (prevOwned.has(key)) {
      for (const env of params.envs) {
        delete (env as Record<string, string | undefined>)[key];
      }
    }
  }
}
