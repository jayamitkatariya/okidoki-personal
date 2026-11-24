import { realpath, stat } from 'fs/promises';
import { resolve } from 'path';

export async function resolveContainedFile(
  root: string,
  relativePath: string,
): Promise<{ fullPath: string; sizeBytes: number } | null> {
  try {
    const [fullPath, resolvedRoot] = await Promise.all([
      realpath(resolve(root, relativePath)),
      realpath(root),
    ]);
    const fileStat = await stat(fullPath);
    const rootPrefix = resolvedRoot.endsWith('/') ? resolvedRoot : `${resolvedRoot}/`;
    return fullPath.startsWith(rootPrefix) && fileStat.isFile() ? { fullPath, sizeBytes: fileStat.size } : null;
  } catch {
    return null;
  }
}
