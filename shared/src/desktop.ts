import { designColors, type Theme, type Mode, type ThemePreference } from './design-tokens';
import type { Result } from './result';
import type { WorkspaceTurnCompletion } from './routes/workspace-events';
export type { ThemePreference } from './design-tokens';
export type { WorkspaceTurnCompletion } from './routes/workspace-events';


// Desktop builds up to 0.1.38 reject notifications without workspaceName, and they load the current web app.
export type DesktopTurnCompletionNotification = Pick<WorkspaceTurnCompletion, 'workspaceName' | 'completedAt'> & {
  workspaceId: string;
  notice: { title: string; body: string; path: string };
  silent?: boolean;
  urgent?: boolean;
};

export const DESKTOP_WORKSPACE_STATUS_KINDS = ['input', 'working', 'ready'] as const;

export interface DesktopWorkspaceStatus {
  workspaceId: string;
  workspaceName: string;
  kind: (typeof DESKTOP_WORKSPACE_STATUS_KINDS)[number];
}

export interface DesktopPortForwardRequest {
  workspaceId: string;
  accessToken: string;
  organizationId: string;
}

export interface DesktopLocalControlRequest {
  accessToken: string;
  organizationId: string;
  /** The running workspaces the signed-in user owns and let run commands on this computer. */
  workspaceIds: string[];
}

interface DesktopLocalControlApi {
  set(request: DesktopLocalControlRequest | null): void;
  /** The access token was refused, so a link can't reconnect until `set` brings a fresh one. */
  onTokenExpired(listener: () => void): () => void;
  openFullDiskAccess?(): void;
  onFullDiskAccessNeeded?(listener: (path: string) => void): () => void;
}

interface DesktopNotificationsApi {
  /** Shown even while the window is focused. Resolves false when the system refused to show it. */
  test(): Promise<boolean>;
  /** Only where the system has one page for the app's notifications. */
  openSystemSettings?(): void;
  /** Fires at most once until the app restarts, so a system that blocks notifications doesn't warn on every alert. */
  onBlocked(listener: () => void): () => void;
}

export interface DesktopWorkspacePort {
  port: number;
  forwarded: boolean;
}

export interface DesktopCrash {
  process: string;
  reason: string;
  exitCode: number;
  /** The page's first path segment, such as `workspace`. Never the IDs after it, since the crash may be reported under another organization. */
  route: string | null;
  at: string;
}

export const WINDOW_COLOR_KEYS = ['background', 'foreground', 'mutedForeground', 'border', 'selected'] as const;
export type WindowColors = Record<Mode, Record<(typeof WINDOW_COLOR_KEYS)[number], string>>;

export const pickWindowColors = ({ background, foreground, mutedForeground, border, selected }: WindowColors[Mode]) => ({ background, foreground, mutedForeground, border, selected });

export const windowColors = (theme: Omit<Theme, 'mode'>): WindowColors => ({
  dark: pickWindowColors(designColors({ ...theme, mode: 'dark' })),
  light: pickWindowColors(designColors({ ...theme, mode: 'light' })),
});

export const MEDIA_COMMANDS = ['playpause', 'next', 'previous'] as const;
export type MediaCommand = (typeof MEDIA_COMMANDS)[number];
export const MEDIA_APPS = ['Spotify', 'Music'] as const;
export type MediaApp = (typeof MEDIA_APPS)[number];

export type MediaPlayback =
  | { status: 'denied' }
  | { status: 'playing' | 'paused'; app: MediaApp | null; name: string; artist: string; artworkUrl: string | null };

export const APPSHOT_SHORTCUTS = ['command', 'option', 'shift'] as const;
export type AppshotShortcut = (typeof APPSHOT_SHORTCUTS)[number];
export const APPSHOT_DESTINATIONS = ['automatic', 'last-chat', 'new-workspace'] as const;
export type AppshotDestination = (typeof APPSHOT_DESTINATIONS)[number];

export interface AppshotApp {
  appName: string;
  appIcon?: string;
}

export interface AppshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Appshot extends AppshotApp {
  windowTitle: string;
  image: string;
  /** Absent when Okidoki isn't allowed to use Accessibility. */
  text?: string;
  textTruncated?: boolean;
  /** The window's text is still being read; `appshots.text(textId)` resolves with it. */
  textId?: string;
  flightId?: string;
}

export type AppshotText = Required<Pick<Appshot, 'text' | 'textTruncated'>>;

/** Where the composer card's thumbnail is, in page pixels, for the capture to land on. */
export interface AppshotFlightTarget extends AppshotRect {
  radius: number;
}

export interface AppshotShortcutCapture {
  result: AppshotResult;
  awayMs: number;
}

export interface AppshotPermissions {
  screen: boolean;
  accessibility: boolean;
}

export type AppshotErrorCode = 'screen-recording' | 'no-window' | 'capture-failed';
export type AppshotResult = Result<Appshot, AppshotErrorCode>;

interface DesktopAppshotsApi {
  configure(settings: { shortcut: AppshotShortcut | null; sound: boolean }): void;
  capture(): Promise<AppshotResult>;
  text(textId: string): Promise<AppshotText | null>;
  target(): Promise<AppshotApp | null>;
  onShortcutCapture(listener: (capture: AppshotShortcutCapture) => void): () => void;
  /** `null` puts the capture away without landing it. */
  land(flightId: string, target: AppshotFlightTarget | null): Promise<void>;
  /** Removes the landed capture once the card is showing under it. */
  finishFlight(flightId: string): void;
  permissions(): Promise<AppshotPermissions>;
  requestPermission(permission: keyof AppshotPermissions): void;
}

export const DESKTOP_BROWSER_COMMANDS = ['back', 'forward', 'reload', 'stop', 'devtools'] as const;
export type DesktopBrowserCommand = (typeof DESKTOP_BROWSER_COMMANDS)[number];

export interface DesktopBrowserState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

interface DesktopBrowserApi {
  load(id: string, url: string): void;
  place(id: string, bounds: AppshotRect | null): void;
  capture(id: string): Promise<string | null>;
  command(id: string, command: DesktopBrowserCommand): void;
  onState(listener: (id: string, state: DesktopBrowserState | null) => void): () => void;
}

export interface OkidokiDesktopApi {
  titleBar?: {
    isFullScreen(): boolean;
    zoomFactor(): number;
    onFullScreenChange(listener: (fullScreen: boolean) => void): () => void;
  };
  setTheme(theme: ThemePreference): void;
  setWindowColors?(colors: WindowColors): void;
  menuBar?: {
    getEnabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<boolean>;
  };
  silentNotifications?: boolean;
  notifyTurnCompleted(notification: DesktopTurnCompletionNotification): void;
  notifications?: DesktopNotificationsApi;
  /** The page alone can't tell: focus inside the Browser tab, a page of its own, blurs it. */
  isWindowFocused?(): boolean;
  getSystemIdleSeconds?(): Promise<number>;
  takeCrashes?(): Promise<DesktopCrash[]>;
  setWorkspaceStatuses?(statuses: DesktopWorkspaceStatus[]): void;
  onNavigate?(listener: (path: string) => void): () => void;
  forwardWorkspacePorts?(request: DesktopPortForwardRequest | null): void;
  onForwardedPortsChanged?(listener: (ports: DesktopWorkspacePort[]) => void): () => void;
  // Named for Spotify, its first player, because shipped desktop builds expose these names.
  getSpotifyPlayback?(): Promise<MediaPlayback | null>;
  controlSpotify?(command: MediaCommand, app?: MediaApp): Promise<MediaPlayback | null>;
  appshots?: DesktopAppshotsApi;
  localControl?: DesktopLocalControlApi;
  browser?: DesktopBrowserApi;
}

declare global {
  interface Window {
    okidokiDesktop?: OkidokiDesktopApi;
  }
}
