import type { CredentialFallbackNotice } from '../event';
import type { AgentCredentialMethod } from '../credentials/agents';
import type { AgentCredentialSnapshots } from '../analytics/types';
import type { Mode } from '../design-tokens';
import { isRecord } from '../type-guards';

export const ENGINE_PORT = 3737;
export const SSH_BRIDGE_PORT = 8081;
export const DESKTOP_STREAM_PORT = 6080;

export const DESKTOP_COMPUTER_SOCKET = '/tmp/okidoki-desktop-computer.sock';
export const DESKTOP_COMPUTER_VIEW_SOCKET = '/tmp/okidoki-desktop-computer-view.sock';

/** Each message on the view socket is a one-byte kind, a big-endian UInt32 length, then the payload: `ComputerViewState` JSON or a JPEG of the agent's window. */
export const COMPUTER_VIEW_STATE = 1;
export const COMPUTER_VIEW_FRAME = 2;

export type ComputerViewState =
  | { status: 'waiting' }
  | { status: 'blocked' }
  | { status: 'active'; app: string; action: string | null; actedAt: number | null };

export function parseComputerViewState(value: unknown): ComputerViewState | null {
  if (!isRecord(value)) return null;
  if (value.status === 'waiting' || value.status === 'blocked') return { status: value.status };
  if (value.status !== 'active' || typeof value.app !== 'string') return null;
  return {
    status: 'active',
    app: value.app,
    action: typeof value.action === 'string' ? value.action : null,
    actedAt: typeof value.actedAt === 'number' ? value.actedAt : null,
  };
}

export const DEVICES_DIR = '.ssh/okidoki-devices';
export const DEVICE_SCREEN_FILE_SUFFIX = '.screen.json';
export const LOCAL_CONTROL_FILE_PREFIX = 'desktop-';

export interface DeviceScreenCredentials {
  username: string;
  password: string;
}

export type DeviceScreenState =
  | { state: 'connecting' }
  | { state: 'connected'; width: number; height: number }
  | { state: 'failed'; reason: string };

export function parseDeviceScreenState(value: unknown): DeviceScreenState | null {
  if (!isRecord(value)) return null;
  if (value.state === 'connected' && typeof value.width === 'number' && typeof value.height === 'number') {
    return { state: 'connected', width: value.width, height: value.height };
  }
  if (value.state === 'failed' && typeof value.reason === 'string') return { state: 'failed', reason: value.reason };
  return value.state === 'connecting' ? { state: 'connecting' } : null;
}

export function getDesktopViewerUrl(publicUrl: string): string {
  const url = new URL(`${publicUrl.replace(/\/$/, '')}/`);
  url.searchParams.set('v', '15');
  return url.toString();
}

export const DESKTOP_VIEWER_WIDTH = 1920;
export const DESKTOP_VIEWER_HEIGHT = 1080;

export type ResolvedTheme = Mode;

export type EnvironmentExecutionStatus = 'yes' | 'no' | 'n/a';
export type EngineAuthMethod = 'none' | 'oauth' | 'api_key' | 'anthropic-compatible' | 'openai-compatible' | 'ollama' | 'bedrock' | 'foundry';
export type EngineCredentialAuthMethod = Exclude<EngineAuthMethod, 'none'>;

export interface EnvironmentExecutionItem {
  status: EnvironmentExecutionStatus;
  details?: string | null;
}

export interface RepositoryEnvironmentExecution {
  repositoryName: string;
  warmHookCompleted: EnvironmentExecutionStatus;
  startHookCompleted: EnvironmentExecutionStatus;
}

export interface EngineEnvironmentDetails {
  engineVersion: string;
  /** The image release this engine shipped with. Absent on older engines. */
  engineImage?: string;
  /** Present only on engines new enough to expose the `turn/steer` route; absent on older engines. */
  supportsMidTurnSteering?: boolean;
  supportsClaudeMidTurnSteering?: boolean;
  supportsCursorMidTurnSteering?: boolean;
  supportsPiMidTurnSteering?: boolean;
  supportsSendNow?: boolean;
  /** Present only on engines where Send now stops a Codex turn for a waiting message; older engines answer it and do nothing. */
  supportsCodexSendNow?: boolean;
  /** Present only on engines that set Claude Code goals; older engines send goal prompts as plain messages. */
  supportsClaudeGoals?: boolean;
  /** Present only on engines new enough to expose goal update controls; absent on older engines. */
  supportsGoalUpdates?: boolean;
  /** Present only on engines new enough to edit queued messages; absent on older engines. */
  supportsQueuedMessageEditing?: boolean;
  /** Present only on engines that publish `chat.queue.changed`; older engines' queues must be polled. */
  supportsQueueEvents?: boolean;
  /** Present only on engines that expose the chat fork route; absent on older engines. */
  supportsChatForking?: boolean;
  supportsChatForkMessage?: boolean;
  supportsDeferredChatForking?: boolean;
  supportsMessageEditing?: boolean;
  supportsHarnessSwitch?: boolean;
  supportsSideChats?: boolean;
  /** Older side-chat engines replace a chat's side chat instead of keeping several. */
  supportsMultipleSideChats?: boolean;
  supportsCredentialSwitching?: boolean;
  /** Older engines never report a chat's own credential, so their DMs would show the workspace's. */
  supportsChatCredentials?: boolean;
  /** Codex models whose account catalog offers the Ultrafast service tier. Absent on older engines and before Codex starts. */
  codexUltrafastModels?: string[];
  agentCredentials?: AgentCredentialSnapshots;
  /** Always n/a. Older web bundles and monoliths read it without a guard. */
  globalWarmHookCompleted?: EnvironmentExecutionItem;
  environmentWarmHookCompleted: EnvironmentExecutionItem;
  environmentStartHookCompleted: EnvironmentExecutionItem;
  repositories: RepositoryEnvironmentExecution[];
  filesUploaded: string[];
  envVarsSet: string[];
  skillsInstalled: string[];
  mcpsInstalled: string[];
  gitIdentityConfigured: boolean;
  githubCredentialsConfigured: boolean;
  gitlabCredentialsConfigured: boolean;
  linearAccessConfigured: boolean;
  slackAccessConfigured: boolean;
  githubAccessConfigured: boolean;
  gitlabAccessConfigured: boolean;
  claudeAuthMethod: EngineAuthMethod;
  codexAuthMethod: EngineAuthMethod;
  cursorAuthMethod: EngineAuthMethod;
  /** Absent when the image has no Antigravity CLI, so the workspace cannot run Gemini. */
  geminiAuthMethod?: EngineAuthMethod;
  museAuthMethod?: EngineAuthMethod;
  opencodeAuthMethod: EngineAuthMethod;
  piAuthMethod?: EngineAuthMethod;
  piInferenceProvider?: AgentCredentialMethod<'pi'>;
  /** Agents that ran out of quota and moved onto another credential. Absent on older engines. */
  credentialFallbacks?: CredentialFallbackNotice[];
  lastUpdatedAt: string;
}

export interface EngineEnvironmentTrackRequest {
  filesUploaded?: string[];
  envVarsSet?: string[];
  skillsInstalled?: string[];
  mcpsInstalled?: string[];
}

export interface EngineVersionResponse {
  version: string;
}

// Warm hook log types

export interface WarmHookLogEntry {
  hookType: 'environment' | 'repository';
  hookName: string;
  hookScript: string;
  // Truncated to a preview when returned by the list endpoint. Use the full-log
  // endpoint to fetch the entire stored output.
  output: string;
  outputTruncated: boolean;
  outputTotalChars: number;
  exitCode: number;
  timedOut: boolean;
  executedAt: string;
}

export interface WarmHookLogsResponse {
  logs: WarmHookLogEntry[];
}

export interface WarmHookFullLogResponse {
  output: string;
}

// Start hook log types

export interface StartHookLogEntry {
  hookType: 'environment' | 'repository';
  hookName: string;
  /** @deprecated Use `hookName` instead. Retained for backwards compatibility — equals `hookName` for repository hooks and `'environment'` for the environment hook. */
  repoName: string;
  hookCommands: string[];
  output: string;
  outputTruncated: boolean;
  outputTotalChars: number;
  exitCode: number;
  timedOut: boolean;
  executedAt: string;
}

export interface StartHookLogsResponse {
  logs: StartHookLogEntry[];
}

export interface StartHookFullLogResponse {
  output: string;
}
