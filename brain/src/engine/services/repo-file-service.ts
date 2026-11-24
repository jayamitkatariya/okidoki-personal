import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { readFile, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { extname, isAbsolute, join, resolve } from 'path';
import { classifyCanvasFilename, detectLanguageByPath, MAX_CANVAS_FILE_BYTES, MAX_CANVAS_PREVIEW_BYTES, MAX_REPO_FILE_CONTENT_BYTES, isExcludedRepoFilePath, searchRepoFileIndex } from '@okidoki/shared';
import type { RepoFileSearchRepository, RepoSymbolAction, RepoSymbolLocation, RepoSymbolResponse, SearchRepoFilesResponse, GetRepoFileContentResponse, UpdateTextFileResponse } from '@okidoki/shared';
import { resolveDiffBase, UNQUOTED_PATHS_CONFIG } from '../git/commands';
import type { GitService } from '../git/service';
import { AsyncLock } from '../utils/async-lock';
import { resolveContainedFile } from '../utils/contained-file';
import { fileRevision } from '../utils/file-revision';
import { writeRevisionedTextFile } from '../utils/revisioned-text-file';
import { canvasDirectories } from './canvas-service';
import { LanguageServerService } from './language-server-service';

const CACHE_TTL_MS = 30_000;
const SEARCH_TIMEOUT_MS = 15_000;

interface RepoCache {
  files: string[];
  changedFiles: Set<string>;
  timestamp: number;
}

function isBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  const binaryExts = new Set([
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a',
    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg',
    '.sqlite', '.db', '.lock',
  ]);
  return classifyCanvasFilename(filePath).kind === 'image' || binaryExts.has(ext);
}

// Sizes from stat can't be trusted: /proc files report 0 bytes however much they hold.
async function readUpTo(path: string, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path, { end: maxBytes })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  return bytes.length > maxBytes ? null : bytes;
}

function execGitAsync(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...UNQUOTED_PATHS_CONFIG, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.end();
  });
}

export class RepoFileService {
  private readonly cache = new Map<string, RepoCache>();
  private readonly gitService: GitService;
  private indexInflight: Promise<void> | null = null;
  private readonly writeLock = new AsyncLock();
  private readonly languageServers = new LanguageServerService();

  constructor(gitService: GitService, private readonly homeDir = homedir()) {
    this.gitService = gitService;
  }

  async search(params: {
    q?: string;
    prefix?: string;
    limit?: number;
    cursor?: string;
    refresh?: boolean;
  }): Promise<SearchRepoFilesResponse> {
    const { refresh = false } = params;

    let stale = false;
    let indexedAt = '';

    try {
      if (!this.indexInflight || refresh) {
        const inflight = this.indexAll(refresh);
        const wrapped = inflight.finally(() => {
          if (this.indexInflight === wrapped) this.indexInflight = null;
        });
        this.indexInflight = wrapped;
      }
      await this.indexInflight;
    } catch {
      stale = true;
    }

    const repos = await this.gitService.listRepositories();
    const multiRepo = repos.length > 1;
    const indexes: RepoFileSearchRepository[] = [];

    for (const repo of repos) {
      const cached = this.cache.get(repo.name);
      if (!cached) continue;

      if (!indexedAt || cached.timestamp > new Date(indexedAt).getTime()) {
        indexedAt = new Date(cached.timestamp).toISOString();
      }

      const isStale = Date.now() - cached.timestamp > CACHE_TTL_MS;
      if (isStale) stale = true;

      indexes.push({
        name: repo.name,
        paths: cached.files,
        changedPaths: cached.changedFiles,
        indexedAt: new Date(cached.timestamp).toISOString(),
        stale: isStale,
      });
    }

    return {
      ...searchRepoFileIndex(indexes, params, multiRepo),
      indexedAt: indexedAt || new Date().toISOString(),
      stale,
    };
  }

  async readFile(repoName: string, filePath: string): Promise<GetRepoFileContentResponse | null> {
    const resolved = await this.resolveFile(repoName, filePath);
    if (!resolved) return null;
    const file = await this.readResolvedFile(repoName, filePath, resolved);
    return typeof file?.content === 'string' ? { ...file, revision: fileRevision(file.content) } : file;
  }

  /** Read-only: files outside the repos carry no revision, so the viewer never offers to edit them. */
  async readWorkspaceFile(filePath: string): Promise<GetRepoFileContentResponse | null> {
    // Agents name files relative to where they ran, and `/src/app.ts` often means a repo root, so a path missing from `/` is looked up where agents work.
    const repos = await this.gitService.listRepositories();
    const roots = [
      ...(isAbsolute(filePath) ? ['/'] : []),
      ...repos.map(repo => repo.path),
      ...await canvasDirectories(repos),
      join(this.homeDir, 'workspaces'),
      this.homeDir,
    ];
    for (const root of roots) {
      const path = resolve(root, filePath.replace(/^\/+/, ''));
      const file = await realpath(path).then(async fullPath => ({ fullPath, stats: await stat(fullPath) })).catch(() => null);
      if (file?.stats.isFile()) return await this.readResolvedFile('', path, { fullPath: file.fullPath, sizeBytes: file.stats.size });
    }
    return null;
  }

  private async readResolvedFile(
    repoName: string,
    filePath: string,
    { fullPath, sizeBytes }: { fullPath: string; sizeBytes: number },
  ): Promise<GetRepoFileContentResponse | null> {
    try {
      if (isBinaryExtension(filePath)) {
        const { kind, mimeType } = classifyCanvasFilename(filePath);
        if (kind === 'image' || kind === 'pdf' || kind === 'docx') {
          const maxPreviewBytes = kind === 'image' ? MAX_CANVAS_FILE_BYTES : MAX_CANVAS_PREVIEW_BYTES;
          const bytes = sizeBytes > maxPreviewBytes ? null : await readUpTo(fullPath, maxPreviewBytes);
          return {
            repoName, path: filePath, content: null,
            language: null, sizeBytes, binary: true, tooLarge: !bytes, mimeType,
            ...(bytes && { base64: bytes.toString('base64') }),
          };
        }
        return {
          repoName, path: filePath, content: null,
          language: null, sizeBytes, binary: true, tooLarge: false,
        };
      }

      const bytes = sizeBytes > MAX_REPO_FILE_CONTENT_BYTES ? null : await readUpTo(fullPath, MAX_REPO_FILE_CONTENT_BYTES);
      if (!bytes) {
        return {
          repoName, path: filePath, content: null,
          language: detectLanguageByPath(filePath), sizeBytes, binary: false, tooLarge: true,
        };
      }
      if (bytes.includes(0)) {
        return {
          repoName, path: filePath, content: null,
          language: null, sizeBytes, binary: true, tooLarge: false,
        };
      }
      return {
        repoName, path: filePath, content: bytes.toString('utf-8'),
        language: detectLanguageByPath(filePath), sizeBytes, binary: false, tooLarge: false,
      };
    } catch {
      return null;
    }
  }

  async updateFile(
    repoName: string,
    filePath: string,
    content: string,
    expectedRevision: string,
  ): Promise<UpdateTextFileResponse | null> {
    if (
      filePath.includes('..') ||
      filePath.startsWith('/') ||
      isBinaryExtension(filePath) ||
      Buffer.byteLength(content) > MAX_REPO_FILE_CONTENT_BYTES
    ) return null;

    return this.writeLock.run(async () => {
      const resolved = await this.resolveFile(repoName, filePath);
      if (!resolved) return null;

      try {
        const result = await writeRevisionedTextFile(resolved.fullPath, content, expectedRevision);
        if (result.saved) this.cache.delete(repoName);
        return result;
      } catch {
        return null;
      }
    });
  }

  async inspectSymbol(
    repoName: string,
    filePath: string,
    line: number,
    character: number,
    action: RepoSymbolAction,
  ): Promise<RepoSymbolResponse | null> {
    const resolved = await this.resolveFile(repoName, filePath);
    if (!resolved || line < 1 || character < 0 || isBinaryExtension(filePath)) return null;
    const content = await readFile(resolved.fullPath, 'utf8');
    const sourceLine = content.split('\n')[line - 1];
    if (sourceLine === undefined) return null;
    const symbolMatch = Array.from(sourceLine.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu))
      .find(match => character >= match.index && character <= match.index + match[0].length);
    if (!symbolMatch) return { symbol: '', detail: null, documentation: null, locations: [], provider: 'workspace' };
    const symbol = symbolMatch[0];
    const repo = await this.gitService.findTrackedRepository(repoName);
    if (!repo) return null;
    const languageServerResult = await this.languageServers.inspect(
      repoName,
      repo.path,
      resolved.fullPath,
      content,
      line,
      character,
      action,
    );
    if (languageServerResult && (languageServerResult.detail || languageServerResult.locations.length > 0)) {
      return { ...languageServerResult, symbol };
    }

    let output = '';
    try {
      output = await execGitAsync(['grep', '-n', '-I', '-w', '--', symbol], repo.path, SEARCH_TIMEOUT_MS);
    } catch {
      return { symbol, detail: null, documentation: null, locations: [], provider: 'workspace' };
    }
    const definitionPattern = new RegExp(`(?:class|interface|type|enum|function|def|fn|func|struct|trait|module|const|let|var|public|private|protected|static|async|export|[A-Za-z_$][\\w$<>?, .:*&[\\]]*)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const locations: RepoSymbolLocation[] = output.split('\n').flatMap(value => {
      const match = value.match(/^(.+?):(\d+):(.*)$/);
      if (!match?.[1] || !match[2] || match[3] === undefined) return [];
      const matchCharacter = match[3].indexOf(symbol);
      return [{ repoName, path: match[1], line: Number(match[2]), character: Math.max(0, matchCharacter), endCharacter: Math.max(0, matchCharacter) + symbol.length, preview: match[3].trim() }];
    });
    const definitions = locations.filter(location => definitionPattern.test(location.preview));
    const selected = action === 'definition' ? definitions.slice(0, 20) : action === 'references' ? locations.slice(0, 100) : [];
    return {
      symbol,
      detail: definitions[0]?.preview ?? `${locations.length} workspace reference${locations.length === 1 ? '' : 's'}`,
      documentation: null,
      locations: selected,
      provider: 'workspace',
    };
  }

  private async resolveFile(repoName: string, filePath: string): Promise<{ fullPath: string; sizeBytes: number } | null> {
    if (filePath.includes('..') || filePath.startsWith('/')) return null;

    const repo = await this.gitService.findTrackedRepository(repoName);
    if (!repo) return null;

    return await resolveContainedFile(repo.path, filePath);
  }

  private async indexAll(refresh: boolean): Promise<void> {
    const repos = await this.gitService.listRepositories();

    for (const repo of repos) {
      const cached = this.cache.get(repo.name);
      const isFresh = cached && (Date.now() - cached.timestamp < CACHE_TTL_MS);

      if (isFresh && !refresh) continue;

      try {
        const [files, changedFiles] = await Promise.all([
          this.listRepoFiles(repo.path),
          this.listChangedFiles(repo.path, repo.defaultBranch),
        ]);

        this.cache.set(repo.name, {
          files,
          changedFiles,
          timestamp: Date.now(),
        });
      } catch {
        // Keep the last good index. A transient git timeout should not turn a
        // previously populated repository into an empty folder in the UI.
      }
    }
  }

  private async listRepoFiles(repoPath: string): Promise<string[]> {
    const [output, deletedOutput] = await Promise.all([
      execGitAsync(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repoPath, SEARCH_TIMEOUT_MS),
      execGitAsync(['ls-files', '-z', '--deleted'], repoPath, SEARCH_TIMEOUT_MS),
    ]);
    // --cached keeps listing files removed from the working tree until the deletion is staged.
    const deleted = new Set(deletedOutput.split('\0'));

    return output
      .split('\0')
      .filter(f => f.length > 0 && !deleted.has(f) && !isExcludedRepoFilePath(f));
  }

  private async listChangedFiles(repoPath: string, defaultBranch: string): Promise<Set<string>> {
    const changedFiles = new Set<string>();

    try {
      const diffBase = await resolveDiffBase(repoPath, defaultBranch);
      const diffOutput = await execGitAsync(
        ['diff', '--name-only', '-M', diffBase],
        repoPath,
        SEARCH_TIMEOUT_MS,
      );
      for (const file of diffOutput.split('\n')) {
        if (file.length > 0) {
          changedFiles.add(file);
        }
      }
    } catch {
      // Ignore diff failures; untracked files can still be marked below.
    }

    try {
      const untrackedOutput = await execGitAsync(
        ['ls-files', '--others', '--exclude-standard'],
        repoPath,
        SEARCH_TIMEOUT_MS,
      );
      for (const file of untrackedOutput.split('\n')) {
        if (file.length > 0) {
          changedFiles.add(file);
        }
      }
    } catch {
      // Ignore failures and return any diff results already collected.
    }

    return changedFiles;
  }
}
