import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isVersionBelow } from '@okidoki/shared';
import { AspClient } from './asp-client';
import { execFileAsync } from '../../utils/exec';
import type { CodexAspOauthOptions, CodexAspOauthTokens } from '../codex-token-manager';
import type {
  ClientNotification,
  InitializeParams,
  InitializeResponse,
  v2,
} from '@okidoki/shared/codex-asp-types';

interface AppServerProcessOptions extends CodexAspOauthOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  binary?: string;
  args?: string[];
  /** Appended as `-c key=value` pairs, so a caller can add overrides without restating the defaults. */
  configOverrides?: string[];
}

interface AppServerStartResult {
  client: AspClient;
}

const DEFAULT_CODEX_BINARY = 'codex';
const DEFAULT_CODEX_ARGS = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'features.memories=false',
  '-c',
  'memories.use_memories=false',
  '-c',
  'memories.generate_memories=false',
];
// OpenAI gates model availability on the Codex CLI version (old binaries get
// "model requires a newer version of Codex" 400s, and API-key requests are
// silently rerouted to older models). Sandbox images can carry a stale
// install, so self-heal by upgrading in place before spawning app-server.
// Keep in sync with the @openai/codex pin in Dockerfile.sandbox.
const MIN_CODEX_CLI_VERSION = '0.167.0';
const CODEX_UPGRADE_TIMEOUT_MS = 120_000;
// Single-flight guard: concurrent AppServerProcess starts on the same engine
// share one version check/upgrade instead of racing parallel npm installs.
let codexCliVersionEnsured: Promise<void> | null = null;

// Kept free of engine-env imports: headless-agent loads this module without an engine environment.
export function getCodexModelProvider(method: string | undefined): string {
  if (method === 'foundry') return 'azure';
  return method === 'ollama' || method === 'openai-compatible' ? 'okidoki_openai_compatible' : 'openai';
}

// Keep in sync with engine/package.json; resolveJsonModule is disabled.
const ENGINE_PACKAGE_VERSION = '0.1.1774';
const INITIALIZE_METHOD = 'initialize';
const INITIALIZED_NOTIFICATION: ClientNotification['method'] = 'initialized';
const ACCOUNT_LOGIN_START_METHOD: 'account/login/start' = 'account/login/start';

export class AppServerProcess {
  private readonly binary: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly chatgptAuthTokens: CodexAspOauthTokens | undefined;
  private readonly refreshChatgptAuthTokens: CodexAspOauthOptions['refreshChatgptAuthTokens'];
  private readonly emitter = new EventEmitter();
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: AspClient | null = null;
  private shuttingDown = false;
  private invalidating = false;

  constructor(options: AppServerProcessOptions) {
    this.binary = options.binary ?? DEFAULT_CODEX_BINARY;
    let baseArgs = options.args ?? DEFAULT_CODEX_ARGS;
    if (!options.args && options.env.OKIDOKI_CODEX_AUTH_METHOD === 'foundry') {
      baseArgs = [
          ...DEFAULT_CODEX_ARGS,
          '-c', `model=${JSON.stringify(options.env.CODEX_FOUNDRY_MODEL)}`,
          '-c', `model_provider=${JSON.stringify(getCodexModelProvider(options.env.OKIDOKI_CODEX_AUTH_METHOD))}`,
          '-c', 'model_providers.azure.name="Azure OpenAI"',
          '-c', `model_providers.azure.base_url=${JSON.stringify(options.env.CODEX_FOUNDRY_BASE_URL)}`,
          '-c', 'model_providers.azure.env_key="AZURE_OPENAI_API_KEY"',
          '-c', 'model_providers.azure.wire_api="responses"',
        ];
    } else if (!options.args && (options.env.OKIDOKI_CODEX_AUTH_METHOD === 'openai-compatible' || options.env.OKIDOKI_CODEX_AUTH_METHOD === 'ollama')) {
      baseArgs = [
        ...DEFAULT_CODEX_ARGS,
        ...(options.env.OKIDOKI_CODEX_AUTH_METHOD === 'ollama' ? [
          '-c', 'web_search="disabled"',
        ] : []),
        '-c', `model_provider=${JSON.stringify(getCodexModelProvider(options.env.OKIDOKI_CODEX_AUTH_METHOD))}`,
        '-c', 'model_providers.okidoki_openai_compatible.name="OpenAI Compatible"',
        '-c', `model_providers.okidoki_openai_compatible.base_url=${JSON.stringify(options.env.CODEX_OPENAI_BASE_URL)}`,
        '-c', 'model_providers.okidoki_openai_compatible.wire_api="responses"',
        ...(options.env.CODEX_OPENAI_AUTHORIZATION_HEADER
          ? ['-c', 'model_providers.okidoki_openai_compatible.env_http_headers={ Authorization = "CODEX_OPENAI_AUTHORIZATION_HEADER" }']
          : ['-c', 'model_providers.okidoki_openai_compatible.env_key="OPENAI_API_KEY"']),
      ];
    }
    this.args = [...baseArgs, ...(options.configOverrides ?? []).flatMap((override) => ['-c', override])];
    this.env = options.env;
    this.cwd = options.cwd;
    this.chatgptAuthTokens = options.chatgptAuthTokens;
    this.refreshChatgptAuthTokens = options.refreshChatgptAuthTokens;
  }

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.emitter.on(event, listener);
  }

  async start(): Promise<AppServerStartResult> {
    if (this.child && this.client) {
      return { client: this.client };
    }

    this.shuttingDown = false;
    this.invalidating = false;
    await this.ensureMinCodexCliVersion();
    const child = spawn(this.binary, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim().length > 0) {
          console.error(`[codex-app-server] ${line}`);
        }
      }
    });

    child.on('exit', (code, signal) => {
      this.client?.dispose(new Error(`the Codex app-server process exited (${signal ?? `code ${code}`})`));
      this.client = null;
      this.child = null;
      if (!this.shuttingDown) {
        if (!this.invalidating) {
          console.warn(`[AppServerProcess] codex app-server exited unexpectedly code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        }
        this.emitter.emit('exit', code, signal);
      }
    });

    const client = new AspClient({ stdin: child.stdin, stdout: child.stdout });
    this.client = client;
    client.on('serverRequest', (serverRequest) => {
      if (serverRequest.method !== 'account/chatgptAuthTokens/refresh') return;
      if (!this.refreshChatgptAuthTokens) {
        client.reject(serverRequest.id, -32603, 'Codex OAuth refresh is not configured');
        return;
      }
      void this.refreshChatgptAuthTokens(serverRequest.params)
        .then((tokens) => {
          client.respond(serverRequest.id, tokens);
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'CodexAspAuthMethodChangedError') {
            this.invalidating = true;
            client.dispose(error);
            if (!child.killed) child.kill('SIGTERM');
            return;
          }
          client.reject(
            serverRequest.id,
            -32603,
            error instanceof Error ? error.message : 'Failed to refresh Codex OAuth credentials',
          );
        });
    });

    let cleanupEarlyFailureHandlers = (): void => {};
    const earlyFailure = new Promise<never>((_resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        reject(new Error(`codex app-server exited before initialize completed code=${code ?? 'null'} signal=${signal ?? 'null'}`));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      cleanupEarlyFailureHandlers = () => {
        child.off('error', onError);
        child.off('exit', onExit);
      };
    });

    try {
      const initializeParams: InitializeParams = {
        clientInfo: {
          name: 'okidoki_engine',
          title: 'Okidoki Engine',
          version: ENGINE_PACKAGE_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
        },
      };
      await Promise.race([
        client.request<InitializeResponse>(INITIALIZE_METHOD, initializeParams),
        earlyFailure,
      ]);
      cleanupEarlyFailureHandlers();
      client.notify(INITIALIZED_NOTIFICATION);
      await this.loginWithConfiguredCredentials(client);
      return { client };
    } catch (error) {
      cleanupEarlyFailureHandlers();
      client.dispose();
      await this.killAfterFailedStart();
      throw error;
    }
  }

  async stop(reason = new Error('ASP process stopped')): Promise<void> {
    const child = this.child;
    this.shuttingDown = true;
    this.client?.dispose(reason);
    this.client = null;
    this.child = null;
    if (!child || child.killed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private ensureMinCodexCliVersion(): Promise<void> {
    codexCliVersionEnsured ??= this.runEnsureMinCodexCliVersion().catch((error) => {
      // Reset so a later start can retry; the current start proceeds with the
      // installed binary since the upgrade is best-effort.
      codexCliVersionEnsured = null;
      console.warn('[AppServerProcess] Failed to ensure minimum codex CLI version, continuing with installed binary:', error);
    });
    return codexCliVersionEnsured;
  }

  private async runEnsureMinCodexCliVersion(): Promise<void> {
    const { stdout } = await execFileAsync(this.binary, ['--version'], { env: this.env });
    // `codex --version` prints a line like "codex-cli 0.144.0". If no semver
    // triple is found we treat the install as suspect and upgrade to the known
    // pin rather than trusting an unrecognizable binary.
    const version = stdout.match(/(\d+\.\d+\.\d+)/)?.[1];
    if (version && !isVersionBelow(version, MIN_CODEX_CLI_VERSION)) {
      return;
    }
    console.warn(`[AppServerProcess] codex CLI ${version ?? 'unknown'} is below ${MIN_CODEX_CLI_VERSION}; upgrading @openai/codex`);
    await execFileAsync(
      'npm',
      ['install', '-g', '--no-audit', '--no-fund', `@openai/codex@${MIN_CODEX_CLI_VERSION}`],
      { env: this.env, timeout: CODEX_UPGRADE_TIMEOUT_MS },
    );
    console.warn(`[AppServerProcess] upgraded codex CLI to ${MIN_CODEX_CLI_VERSION}`);
  }

  private async loginWithConfiguredCredentials(client: AspClient): Promise<void> {
    if (this.env.OKIDOKI_CODEX_AUTH_METHOD === 'oauth') {
      if (!this.chatgptAuthTokens) {
        throw new Error('Codex OAuth credentials were not prepared before app-server startup');
      }
      const params: v2.LoginAccountParams = {
        type: 'chatgptAuthTokens',
        ...this.chatgptAuthTokens,
      };
      await client.request<v2.LoginAccountResponse>(ACCOUNT_LOGIN_START_METHOD, params);
      return;
    }

    if (
      this.env.OKIDOKI_CODEX_AUTH_METHOD !== 'api_key'
      || this.env.CODEX_OPENAI_BASE_URL
      || !this.env.OPENAI_API_KEY
    ) return;

    const params: v2.LoginAccountParams = {
      type: 'apiKey',
      apiKey: this.env.OPENAI_API_KEY,
    };
    await client.request<v2.LoginAccountResponse>(ACCOUNT_LOGIN_START_METHOD, params);
  }

  private async killAfterFailedStart(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.client = null;
    if (!child || child.killed) {
      return;
    }
    this.shuttingDown = true;
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });
  }
}
