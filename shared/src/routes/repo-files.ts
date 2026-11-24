export interface RepoFileEntry {
  repoName: string;
  path: string;
  displayPath: string;
  status: 'changed' | 'untouched';
  score: number;
  indexedAt: string;
  stale: boolean;
}

export const MAX_REPO_FILE_CONTENT_BYTES = 256 * 1024;

export interface SearchRepoFilesResponse {
  files: RepoFileEntry[];
  nextCursor: string | null;
  indexedAt: string;
  stale: boolean;
  unsupported?: boolean;
  truncated?: boolean;
  refreshing?: boolean;
}

export interface RepoFileSearchRepository {
  name: string;
  paths: readonly string[];
  changedPaths: ReadonlySet<string>;
  indexedAt: string;
  stale: boolean;
}

export function searchRepoFileIndex(
  repos: readonly RepoFileSearchRepository[],
  params: { q?: string; prefix?: string; limit?: number; cursor?: string },
  multiRepo: boolean,
): Pick<SearchRepoFilesResponse, 'files' | 'nextCursor'> {
  const { q = '', prefix = '' } = params;
  const limit = Math.min(Math.max(Number.isNaN(params.limit) ? 50 : params.limit ?? 50, 1), 5000);
  let offset = 0;
  try {
    offset = Math.max(0, parseInt(atob(params.cursor ?? ''), 10) || 0);
  } catch {
    offset = 0;
  }
  const files: RepoFileEntry[] = [];
  for (const repo of repos) {
    for (const path of repo.paths) {
      if (prefix && !path.startsWith(prefix)) continue;
      const score = q ? scoreRepoFileMatch(q, path) : 0;
      if (q && !score) continue;
      files.push({
        repoName: repo.name,
        path,
        displayPath: multiRepo ? `${repo.name}/${path}` : path,
        status: repo.changedPaths.has(path) ? 'changed' : 'untouched',
        score,
        indexedAt: repo.indexedAt,
        stale: repo.stale,
      });
    }
  }
  files.sort((a, b) => b.score - a.score || a.displayPath.localeCompare(b.displayPath));
  return {
    files: files.slice(offset, offset + limit),
    nextCursor: offset + limit < files.length ? btoa(String(offset + limit)) : null,
  };
}

export interface GetRepoFileContentResponse {
  repoName: string;
  path: string;
  content: string | null;
  language: string | null;
  sizeBytes: number;
  binary: boolean;
  tooLarge: boolean;
  base64?: string;
  mimeType?: string;
  revision?: string;
  unsupported?: boolean;
}

export interface UpdateTextFileRequest {
  content: string;
  expectedRevision: string;
}

export type UpdateTextFileResponse =
  | { saved: true; revision: string; sizeBytes: number }
  | {
      saved: false;
      current: { content: string; revision: string; sizeBytes: number };
    };

export type RepoSymbolAction = 'hover' | 'definition' | 'references';

export interface RepoSymbolLocation {
  repoName: string;
  path: string;
  line: number;
  character: number;
  endCharacter: number;
  preview: string;
}

export interface RepoSymbolResponse {
  symbol: string;
  detail: string | null;
  documentation: string | null;
  locations: RepoSymbolLocation[];
  provider: 'language-server' | 'workspace';
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'out', 'vendor', '.turbo', '__pycache__']);

export function isExcludedRepoFilePath(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.some(seg => EXCLUDED_DIRS.has(seg));
}

export function scoreRepoFileMatch(query: string, filePath: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  const segments = lowerPath.split('/');
  const basename = segments[segments.length - 1] ?? '';

  if (basename === lowerQuery) return 100;
  if (basename.startsWith(lowerQuery)) return 90;
  if (segments.some(seg => seg === lowerQuery)) return 80;
  if (basename.includes(lowerQuery)) return 70;
  if (segments.some(seg => seg.includes(lowerQuery))) return 60;
  if (lowerPath.includes(lowerQuery)) return 50;
  return 0;
}
