import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { v2 } from '@okidoki/shared/codex-asp-types';
import { isSkillRegistryManifest, type SkillRegistryEntry, type SkillRegistryManifest } from '@okidoki/shared';
import type { AspClient } from '../managers/codex-asp/asp-client';

const REGISTRY_ROOT_DIR = '.okidoki/skill-registries';
const REGISTRY_MANIFEST = 'manifest.json';

interface ScannedRegistryContents {
  claudePluginRoots: string[];
  standaloneSkills: StandaloneRegistrySkill[];
  codexMarketplaceCwds: string[];
}

interface StandaloneRegistrySkill {
  source: string;
  skillDir: string;
}

interface ScannedSkillRegistry extends SkillRegistryEntry, ScannedRegistryContents {}

interface SkillRegistryInventory extends ScannedRegistryContents {
  registryRoot: string;
  registries: ScannedSkillRegistry[];
}

async function getSkillRegistryInventory(homeDir: string): Promise<SkillRegistryInventory> {
  const registryRoot = getRegistryRoot(homeDir);
  const manifest = await readManifest(homeDir);
  if (!manifest) {
    return emptyInventory(registryRoot);
  }

  const registries: ScannedSkillRegistry[] = [];
  for (const registry of manifest.registries) {
    if (!isPathInside(registryRoot, registry.checkoutPath)) {
      console.warn(`[SkillRegistry] Ignoring registry outside root: ${registry.checkoutPath}`);
      continue;
    }

    if (!await directoryExists(registry.checkoutPath)) {
      console.warn(`[SkillRegistry] Ignoring missing registry checkout: ${registry.checkoutPath}`);
      continue;
    }

    const contents = await scanRegistry(registry.checkoutPath);
    registries.push({ ...registry, ...contents });
  }

  return {
    registryRoot,
    registries,
    claudePluginRoots: uniqueFlat(registries, (registry) => registry.claudePluginRoots),
    standaloneSkills: uniqueStandaloneSkills(registries.flatMap((registry) => registry.standaloneSkills)),
    codexMarketplaceCwds: uniqueFlat(registries, (registry) => registry.codexMarketplaceCwds),
  };
}

export async function buildClaudeRegistryConfig(homeDir: string): Promise<{
  plugins: SdkPluginConfig[];
  enableAllSkills: boolean;
}> {
  const inventory = await getSkillRegistryInventory(homeDir);

  return {
    plugins: inventory.claudePluginRoots.map((path) => ({ type: 'local', path })),
    enableAllSkills: inventory.claudePluginRoots.length > 0 || inventory.standaloneSkills.length > 0,
  };
}

export async function applyCodexSkillRegistries(params: {
  client: Pick<AspClient, 'request'>;
  homeDir: string;
}): Promise<void> {
  const inventory = await getSkillRegistryInventory(params.homeDir);
  if (inventory.registries.length === 0) return;

  await installCodexRegistryPlugins(params.client, inventory);
}

async function scanRegistry(registryDir: string): Promise<ScannedRegistryContents> {
  const claudePluginRoots = await findClaudePluginRoots(registryDir);
  const skillCollections = await findSkillCollections(registryDir);
  const topLevelSkills = await findTopLevelSkills(registryDir);
  const codexMarketplaceCwds = await hasCodexMarketplace(registryDir) ? [registryDir] : [];

  return {
    claudePluginRoots,
    standaloneSkills: uniqueStandaloneSkills([
      ...skillCollections.flatMap((collection) => collection.skillDirs.map((skillDir) => ({
        source: collection.source,
        skillDir,
      }))),
      ...topLevelSkills,
    ]),
    codexMarketplaceCwds,
  };
}

async function findSkillCollections(registryDir: string): Promise<Array<{ source: string; root: string; skillDirs: string[] }>> {
  const candidateRoots: Array<{ source: string; root: string }> = [
    { source: 'skills', root: join(registryDir, 'skills') },
    { source: 'agents', root: join(registryDir, '.agents', 'skills') },
    { source: 'codex', root: join(registryDir, '.codex', 'skills') },
    { source: 'claude', root: join(registryDir, '.claude', 'skills') },
  ];

  const collections: Array<{ source: string; root: string; skillDirs: string[] }> = [];
  for (const { source, root } of candidateRoots) {
    const skillDirs = await findSkillDirsInRoot(root);
    if (skillDirs.length > 0) {
      collections.push({ source, root, skillDirs });
    }
  }
  return collections;
}

async function findSkillDirsInRoot(root: string): Promise<string[]> {
  const skillDirs: string[] = [];
  for (const dirent of await safeReadDir(root)) {
    const skillDir = join(root, dirent.name);
    if (!await isDirectoryDirent(dirent, skillDir)) continue;
    if (await fileExists(join(skillDir, 'SKILL.md'))) {
      skillDirs.push(skillDir);
    }
  }
  return skillDirs;
}

async function findTopLevelSkills(registryDir: string): Promise<StandaloneRegistrySkill[]> {
  const skills: StandaloneRegistrySkill[] = [];
  for (const dirent of await safeReadDir(registryDir)) {
    if (dirent.name.startsWith('.') || dirent.name === 'skills' || dirent.name === 'plugins') continue;

    const skillDir = join(registryDir, dirent.name);
    if (!await isDirectoryDirent(dirent, skillDir)) continue;
    if (await fileExists(join(skillDir, 'SKILL.md'))) {
      skills.push({ source: 'root', skillDir });
    }
  }
  return skills;
}

async function findClaudePluginRoots(registryDir: string): Promise<string[]> {
  const roots: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const dirent of await safeReadDir(dir)) {
      if (dirent.name === '.git') continue;

      const child = join(dir, dirent.name);
      if (!await isDirectoryDirent(dirent, child)) continue;

      if (dirent.name === '.claude-plugin') {
        if (await fileExists(join(child, 'plugin.json'))) {
          roots.push(dirname(child));
        }
        continue;
      }

      await walk(child);
    }
  }

  await walk(registryDir);
  return uniqueStrings(roots);
}

async function hasCodexMarketplace(registryDir: string): Promise<boolean> {
  return await fileExists(join(registryDir, '.agents', 'plugins', 'marketplace.json'))
    || await fileExists(join(registryDir, '.codex', 'plugins', 'marketplace.json'));
}

async function installCodexRegistryPlugins(
  client: Pick<AspClient, 'request'>,
  inventory: SkillRegistryInventory,
): Promise<void> {
  const cwds = inventory.codexMarketplaceCwds;
  if (cwds.length === 0) return;

  try {
    const response = await client.request<v2.PluginListResponse>('plugin/list', { cwds });
    for (const marketplace of response.marketplaces) {
      if (!marketplace.path || !isPathInside(inventory.registryRoot, marketplace.path)) continue;

      for (const plugin of marketplace.plugins) {
        if (plugin.installed || plugin.installPolicy === 'NOT_AVAILABLE' || plugin.availability !== 'AVAILABLE') {
          continue;
        }

        try {
          await client.request<v2.PluginInstallResponse>('plugin/install', {
            marketplacePath: marketplace.path,
            pluginName: plugin.name,
          });
        } catch (error) {
          console.warn(`[SkillRegistry] Failed to install Codex registry plugin ${plugin.name}:`, error);
        }
      }
    }
  } catch (error) {
    console.warn('[SkillRegistry] Failed to list Codex registry plugins:', error);
  }
}

async function readManifest(homeDir: string): Promise<SkillRegistryManifest | null> {
  try {
    const raw = await readFile(getManifestPath(homeDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isSkillRegistryManifest(parsed)) {
      console.warn('[SkillRegistry] Ignoring invalid skill registry manifest.');
      return null;
    }
    return parsed;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function getRegistryRoot(homeDir: string): string {
  return join(homeDir, REGISTRY_ROOT_DIR);
}

function getManifestPath(homeDir: string): string {
  return join(getRegistryRoot(homeDir), REGISTRY_MANIFEST);
}

function emptyInventory(registryRoot: string): SkillRegistryInventory {
  return {
    registryRoot,
    registries: [],
    claudePluginRoots: [],
    standaloneSkills: [],
    codexMarketplaceCwds: [],
  };
}

function uniqueFlat<T>(items: T[], getValues: (item: T) => string[]): string[] {
  return uniqueStrings(items.flatMap(getValues));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function uniqueStandaloneSkills(skills: StandaloneRegistrySkill[]): StandaloneRegistrySkill[] {
  const seen = new Set<string>();
  const unique: StandaloneRegistrySkill[] = [];
  for (const skill of skills) {
    const key = `${skill.source}\0${skill.skillDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(skill);
  }
  return unique;
}

async function safeReadDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

async function isDirectoryDirent(dirent: Dirent, path: string): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  return directoryExists(path);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const pathStat = await stat(path);
    return pathStat.isFile();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = resolve(parentPath);
  const child = resolve(childPath);
  const childRelativePath = relative(parent, child);
  return childRelativePath === '' || (!childRelativePath.startsWith('..') && !isAbsolute(childRelativePath));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
