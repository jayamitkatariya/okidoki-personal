import { parse as parseYaml } from 'yaml';

export interface FrontmatterMetadata {
  name?: string;
  description?: string;
}

export function parseFrontmatter(content: string): FrontmatterMetadata {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  try {
    const parsed: unknown = parseYaml(match[1]);
    if (typeof parsed !== 'object' || parsed === null) return {};

    return {
      ...('name' in parsed && typeof parsed.name === 'string' ? { name: parsed.name.trim() } : {}),
      ...('description' in parsed && typeof parsed.description === 'string'
        ? { description: parsed.description.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}
