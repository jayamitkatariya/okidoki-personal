export const SKILL_REGISTRY_MANIFEST_VERSION = 1;

export interface SkillRegistryEntry {
  index: number;
  name: string;
  url: string;
  checkoutPath: string;
  /** Revision whose skills are installed; absent until the first install succeeds. */
  head?: string;
}

export interface SkillRegistryManifest {
  version: typeof SKILL_REGISTRY_MANIFEST_VERSION;
  registries: SkillRegistryEntry[];
}

export function isSkillRegistryManifest(value: unknown): value is SkillRegistryManifest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('version' in value) || value.version !== SKILL_REGISTRY_MANIFEST_VERSION) return false;
  if (!('registries' in value) || !Array.isArray(value.registries)) return false;

  return value.registries.every((entry: unknown) =>
    typeof entry === 'object'
    && entry !== null
    && 'index' in entry && typeof entry.index === 'number'
    && 'name' in entry && typeof entry.name === 'string'
    && 'url' in entry && typeof entry.url === 'string'
    && 'checkoutPath' in entry && typeof entry.checkoutPath === 'string'
    && (!('head' in entry) || typeof entry.head === 'string')
  );
}
