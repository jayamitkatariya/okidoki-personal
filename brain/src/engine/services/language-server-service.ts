import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectLanguageByPath, type RepoSymbolAction, type RepoSymbolLocation, type RepoSymbolResponse } from '@okidoki/shared';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js';

type JsonObject = Record<string, unknown>;
type LspPosition = { line: number; character: number };
type LspLocation = { uri: string; range: { start: LspPosition; end: LspPosition } };
type LspLocationLink = { targetUri: string; targetSelectionRange: { start: LspPosition; end: LspPosition } };
type LspResult = { contents?: unknown } | LspLocation | LspLocationLink | (LspLocation | LspLocationLink)[] | null;

const require = createRequire(import.meta.url);
const SERVER_TIMEOUT_MS = 10_000;

const LANGUAGE_SERVERS: Record<string, { package?: string; bin?: string; command?: string; args: string[]; languageId?: string }> = {
  typescript: { package: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'] },
  tsx: { package: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'], languageId: 'typescriptreact' },
  javascript: { package: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'] },
  jsx: { package: 'typescript-language-server', bin: 'typescript-language-server', args: ['--stdio'], languageId: 'javascriptreact' },
  python: { package: 'pyright', bin: 'pyright-langserver', args: ['--stdio'] },
  rust: { command: 'rust-analyzer', args: [] },
  c: { command: 'clangd', args: ['--background-index'] },
  cpp: { command: 'clangd', args: ['--background-index'] },
  go: { command: 'gopls', args: ['serve'] },
  ruby: { command: 'solargraph', args: ['stdio'] },
  php: { command: 'intelephense', args: ['--stdio'] },
  java: { command: 'jdtls', args: [] },
  csharp: { command: 'csharp-ls', args: [] },
  kotlin: { command: 'kotlin-language-server', args: [] },
  lua: { command: 'lua-language-server', args: [] },
  swift: { command: 'sourcekit-lsp', args: [] },
  dart: { command: 'dart', args: ['language-server', '--protocol=lsp'] },
  zig: { command: 'zls', args: [] },
  terraform: { command: 'terraform-ls', args: ['serve'] },
  toml: { command: 'taplo', args: ['lsp', 'stdio'] },
  bash: { package: 'bash-language-server', bin: 'bash-language-server', args: ['start'], languageId: 'shellscript' },
  json: { package: 'vscode-langservers-extracted', bin: 'vscode-json-language-server', args: ['--stdio'] },
  html: { package: 'vscode-langservers-extracted', bin: 'vscode-html-language-server', args: ['--stdio'] },
  css: { package: 'vscode-langservers-extracted', bin: 'vscode-css-language-server', args: ['--stdio'] },
  scss: { package: 'vscode-langservers-extracted', bin: 'vscode-css-language-server', args: ['--stdio'] },
  less: { package: 'vscode-langservers-extracted', bin: 'vscode-css-language-server', args: ['--stdio'] },
  yaml: { package: 'yaml-language-server', bin: 'yaml-language-server', args: ['--stdio'] },
  dockerfile: { package: 'dockerfile-language-server-nodejs', bin: 'docker-langserver', args: ['--stdio'] },
};

function packageBin(packageName: string, binName: string): string {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin: string | Record<string, string> };
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin[binName];
  if (!bin) throw new Error(`Missing ${binName} binary`);
  return `${dirname(packageJsonPath)}/${bin}`;
}

function markdownText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(markdownText).filter(Boolean).join('\n\n') || null;
  if (value && typeof value === 'object' && 'value' in value && typeof value.value === 'string') return value.value;
  return null;
}

class LanguageServerClient {
  private process: ChildProcessWithoutNullStreams;
  private connection: MessageConnection;
  private opened = new Map<string, string>();
  readonly ready: Promise<void>;

  constructor(command: string, args: string[], private rootPath: string) {
    this.process = spawn(command, args, {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(command.includes('rust-analyzer') && { RA_LOG: 'rust_analyzer=error' }) },
    });
    if (process.env.OKIDOKI_LSP_DEBUG) this.process.stderr.pipe(process.stderr);
    else this.process.stderr.resume();
    this.connection = createMessageConnection(
      new StreamMessageReader(this.process.stdout),
      new StreamMessageWriter(this.process.stdin),
    );
    this.connection.onRequest('workspace/workspaceFolders', () => [
      { uri: pathToFileURL(this.rootPath).href, name: this.rootPath.split('/').at(-1) },
    ]);
    this.connection.onRequest('workspace/configuration', (params: { items?: unknown[] }) =>
      Array.from({ length: params.items?.length ?? 0 }, () => null));
    this.connection.listen();
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(rootPath).href,
      capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] }, definition: { linkSupport: true } } },
      initializationOptions: command.includes('rust-analyzer') ? { cargo: { buildScripts: { enable: false }, noDeps: true }, procMacro: { enable: false }, check: { enable: false } } : {},
      workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: rootPath.split('/').at(-1) }],
    }).then(() => this.connection.sendNotification('initialized', {}));
  }

  async inspect(filePath: string, languageId: string, content: string, line: number, character: number, action: RepoSymbolAction): Promise<LspResult> {
    await this.ready;
    const uri = pathToFileURL(filePath).href;
    if (this.opened.get(uri) !== content) {
      if (this.opened.has(uri)) this.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: Date.now() }, contentChanges: [{ text: content }] });
      else this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: content } });
      this.opened.set(uri, content);
    }
    return this.request<LspResult>(`textDocument/${action}`, {
      textDocument: { uri },
      position: { line: line - 1, character },
      ...(action === 'references' && { context: { includeDeclaration: true } }),
    });
  }

  private request<T = unknown>(method: string, params: JsonObject): Promise<T> {
    return Promise.race([
      this.connection.sendRequest<T>(method, params),
      setTimeout(SERVER_TIMEOUT_MS, undefined, { ref: false }).then(() => {
        throw new Error(`Language server timed out: ${method}`);
      }),
    ]);
  }

  dispose(): void {
    this.connection.dispose();
    this.process.kill();
  }
}

export class LanguageServerService {
  private clients = new Map<string, LanguageServerClient>();

  async inspect(repoName: string, repoPath: string, filePath: string, content: string, line: number, character: number, action: RepoSymbolAction): Promise<RepoSymbolResponse | null> {
    const language = detectLanguageByPath(filePath);
    const config = language ? LANGUAGE_SERVERS[language] : undefined;
    if (!language || !config) return null;
    const languageId = config.languageId ?? language;
    let command: string | undefined;
    if (config.package && config.bin) command = process.execPath;
    else if (config.command) {
      const commandName = config.command;
      command = process.env.PATH?.split(delimiter).map(directory => join(directory, commandName)).find(existsSync);
    }
    const args = config.package && config.bin ? [packageBin(config.package, config.bin), ...config.args] : config.args;
    if (!command) return null;
    const key = `${repoPath}:${languageId}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new LanguageServerClient(command, args, repoPath);
      this.clients.set(key, client);
    }
    try {
      const result = await client.inspect(filePath, languageId, content, line, character, action);
      if (action === 'hover') {
        const detail = result && !Array.isArray(result) && 'contents' in result ? markdownText(result.contents) : null;
        return detail ? { symbol: '', detail, documentation: null, locations: [], provider: 'language-server' } : null;
      }
      const rawLocations = Array.isArray(result)
        ? result
        : result && ('uri' in result || 'targetUri' in result) ? [result] : [];
      const locations: RepoSymbolLocation[] = rawLocations.flatMap(location => {
        const uri = 'targetUri' in location ? location.targetUri : location.uri;
        const range = 'targetSelectionRange' in location ? location.targetSelectionRange : location.range;
        const absolutePath = fileURLToPath(uri);
        const path = relative(repoPath, absolutePath);
        if (path.startsWith('..')) return [];
        const preview = readFileSync(absolutePath, 'utf8').split('\n')[range.start.line]?.trim() ?? '';
        return [{ repoName, path, line: range.start.line + 1, character: range.start.character, endCharacter: range.end.character, preview }];
      });
      return { symbol: '', detail: null, documentation: null, locations, provider: 'language-server' };
    } catch {
      client.dispose();
      this.clients.delete(key);
      return null;
    }
  }
}
