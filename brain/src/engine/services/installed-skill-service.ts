import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createProviderSlashCommand,
  parseFrontmatter,
  type AgentProvider,
  type FrontmatterMetadata,
  type SlashCommand,
} from '@okidoki/shared';

type InstalledSkill = Required<FrontmatterMetadata>;

const installedSkillsByHome = new Map<string, Promise<InstalledSkill[]>>();

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}

async function loadInstalledSkills(homeDir: string): Promise<InstalledSkill[]> {
  const skillsDir = join(homeDir, '.agents/skills');
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (!isNotFoundError(error)) console.warn('[InstalledSkills] Failed to list installed skills:', error);
    return [];
  }

  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map(async (entry) => {
      try {
        const metadata = parseFrontmatter(await readFile(join(skillsDir, entry.name, 'SKILL.md'), 'utf8'));
        return metadata.name && metadata.description ? metadata : null;
      } catch (error) {
        if (!isNotFoundError(error)) console.warn(`[InstalledSkills] Failed to read ${entry.name}:`, error);
        return null;
      }
    }));
  return skills.filter((skill): skill is InstalledSkill => skill !== null);
}

export async function getInstalledSkillsAsSlashCommands(
  homeDir: string,
  provider: AgentProvider,
): Promise<SlashCommand[]> {
  let installedSkills = installedSkillsByHome.get(homeDir);
  if (!installedSkills) {
    installedSkills = loadInstalledSkills(homeDir);
    installedSkillsByHome.set(homeDir, installedSkills);
  }

  return (await installedSkills).flatMap(({ name, description }) => {
    const command = createProviderSlashCommand(provider, name, description);
    return command ? [command] : [];
  });
}
