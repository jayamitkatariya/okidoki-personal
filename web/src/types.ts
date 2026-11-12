export type AccountKind = "personal" | "work";

export interface Account {
  id: string;
  name: string;
  email: string;
  kind: AccountKind;
  colorHex: string;
  createdAt: string;
}

export type InputMode = "voice" | "typing";
export type Appearance = "system" | "light" | "dark";
export type NotificationStyle = "everything" | "approvalsAndDone" | "silent";
export type DrawingStyle = "ink" | "marker" | "pencil";

export interface Settings {
  okidokiEnabled: boolean;
  defaultInput: InputMode;
  voiceID: string;
  voiceSpeed: number;
  voiceEnabled: boolean;
  captions: boolean;
  confirmOK: boolean;
  customInstructions: string;
  backgroundMode: boolean;
  screenBorrowing: boolean;
  proactiveNudges: boolean;
  quietMode: boolean;
  notchEnabled: boolean;
  notificationStyle: NotificationStyle;
  notchExternalPosition: string;
  appearance: Appearance;
  cursorGlowHex: string;
  glowEnabled: boolean;
  shakeSensitivity: number;
  drawingStyle: DrawingStyle;
  drawingColorHex: string;
  blockedApps: string[];
  alwaysAsk: string[];
  alwaysAllow: string[];
  spendingLimit: number;
  hideInScreenshots: boolean;
  /** Send the front window, browser tab and a small screenshot with every request so the brain knows what's on screen. */
  screenContext?: boolean;
  appleCalendar: boolean;
  automationGranted: boolean;
  inputMonitoringGranted: boolean;
  onboardingComplete: boolean;
  tourComplete: boolean;
  showedWelcome: boolean;
  claudeModel: string;
  mcpServers: McpServer[];
  drivePace: "calm" | "fast";
  /** Where computer-use runs happen: this Mac, or okidoki's private Mac (a macOS VM). */
  computerTarget: "mac" | "vm";
  /** What a request typed at the cursor is for. Missing on older builds. */
  summonMode?: "auto" | "act" | "browser" | "chat";
  /** The vault folder on disk. Missing on older builds. */
  vaultFolder?: string;
  /** Hybrid replay: skills bind values from documents, check steps, pick themselves, and hand off to the agent. */
  hybridReplay?: boolean;
  /** Shaking the mouse opens summon. */
  shakeToSummon?: boolean;
  /** Global summon shortcut, like "option+space". Empty turns it off. */
  summonHotkey?: string;
}

export type PrivateMacPhase = "unsupported" | "notSetUp" | "downloading" | "installing" | "stopped" | "starting" | "running" | "stopping" | "failed";

export interface PrivateMacState {
  supported: boolean;
  phase: PrivateMacPhase;
  /** 0–1 while downloading or installing. */
  progress: number;
  /** One human line for the current phase. */
  status: string;
  error?: string | null;
  /** True until the user has clicked through macOS Setup Assistant once. */
  needsFirstBoot: boolean;
  macOSVersion: string;
  cpuCount: number;
  memoryGB: number;
  bytesOnDisk: number;
  downloadGB: number;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  enabled: boolean;
}

export interface McpStatus {
  id: string;
  ok: boolean;
  error?: string | null;
  tools: { name: string; description: string }[];
}

/** The brain, the Moss index and MCP as the Mac sees them right now. */
export interface ServicesState {
  brain: { status: string; ready: boolean; version?: string | null; port: number };
  memory: {
    configured: boolean;
    ready: boolean;
    documents: number;
    notes: number;
    messages: number;
    tools: number;
    lastSyncAt?: string | null;
    error?: string | null;
  };
  mcp: { enabled: boolean; servers: number; connected: number; checkedAt?: string | null };
}

export interface KeyProvider {
  id: string;
  name: string;
  blurb: string;
  placeholder: string;
  url: string;
  optional: boolean;
  set: boolean;
  /** Shipped with the build; removing a saved key falls back to it. */
  builtin: boolean;
}

export type RunKind = "answer" | "quick_action" | "watch" | "borrow" | "computer_use" | "browser" | "routine" | "connector";
export type RunStatus = "previewing" | "waiting" | "running" | "paused" | "done" | "failed" | "cancelled" | "asked";
export type Risk = "low" | "medium" | "high";

export interface PreviewStep {
  id: string;
  text: string;
}

export interface ActionPreview {
  summary: string;
  risk: Risk;
  steps: PreviewStep[];
  commands: string[];
  apps: string[];
  files: string[];
  createdAt: string;
}

export interface RunStep {
  id: string;
  title: string;
  detail: string;
  status: RunStatus;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface Run {
  id: string;
  accountID: string;
  kind: RunKind;
  title: string;
  prompt: string;
  threadID?: string | null;
  status: RunStatus;
  preview?: ActionPreview | null;
  steps: RunStep[];
  output: string;
  summary: string;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  freedBytes?: number | null;
  builtin?: string | null;
  pickedPath?: string | null;
  /** The user's reply when the run had paused on a question. */
  answer?: string | null;
  /** When the person last looked at it; a run that ended after this is unread. */
  seenAt?: string | null;
  updatedAt?: string | null;
  /** While paused: what the person is doing for the run. */
  waitingFor?: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  runID?: string | null;
}

export interface Thread {
  id: string;
  accountID: string;
  title: string;
  app: string;
  topic: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  /** When the person last opened it. */
  seenAt?: string | null;
}

export interface Memory {
  id: string;
  section: "aboutYou" | "rightNow";
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** Another assistant whose memory can be brought in. `files` are the memory files it keeps on this Mac; empty for hosted ones. */
export interface MemorySource {
  id: string;
  name: string;
  blurb: string;
  files: string[];
}

export type StepAction = "click" | "double-click" | "right-click" | "middle-click" | "drag" | "type" | "key" | "scroll" | "switch";

export interface SkillStep {
  id: string;
  text: string;
  app: string;
  x?: number | null;
  y?: number | null;
  action?: StepAction | null;
  label?: string | null;
  input?: string | null;
  toX?: number | null;
  toY?: number | null;
  delay?: number | null;
  /** App that owns the control when it isn't `app` (Dock, menu bar extras). */
  owner?: string | null;
  /** Accessibility role of the control, e.g. AXButton. */
  role?: string | null;
  /** Frame of the control's window when recorded, so replay can follow a moved window. */
  winX?: number | null;
  winY?: number | null;
  winW?: number | null;
  winH?: number | null;
}

/** Live recorder state while okidoki is learning a skill. */
export interface Watching {
  recording: boolean;
  startedAt?: string | null;
  name: string;
  steps: SkillStep[];
  replaying: boolean;
}

export interface SkillInput {
  name: string;
  description: string;
  kind: string;
  source?: string;
}

export interface Skill {
  id: string;
  accountID: string;
  name: string;
  summary: string;
  steps: SkillStep[];
  createdAt: string;
  source: string;
  runCount: number;
  /** Smart replay: the values each pass needs. */
  inputs?: SkillInput[];
  intent?: string;
  itemNoun?: string;
  /** A library template: the first run follows `outline`, then it's a learned skill. */
  template?: boolean;
  learned?: boolean;
  outline?: string[];
  alwaysConfirm?: boolean;
}

/** A ready-made skill in the library. */
export interface LibraryEntry {
  id: string;
  name: string;
  summary: string;
  intent: string;
  surface: "browser" | "mac";
  tags: string[];
  inputs: string[];
  confirms: boolean;
  added: boolean;
  learned: boolean;
}

export type Cadence = "hourly" | "daily" | "weekdays" | "weekly" | "manual";

export interface Routine {
  id: string;
  accountID: string;
  name: string;
  prompt: string;
  cadence: Cadence;
  weekday: number;
  hour: number;
  minute: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

export interface Connector {
  id: string;
  name: string;
  kind: string;
  blurb: string;
  enabled: boolean;
  installed: boolean;
  installCommand: string;
  docs: string;
}

export interface LiveStep {
  index: number;
  say: string;
  kind: "script" | "pointer" | "keys" | "app" | "look" | "";
  detail: string;
  result: string;
  frame?: string | null;
  aimX?: number | null;
  aimY?: number | null;
  zoomFrame?: string | null;
  script?: string | null;
  status: "acting" | "done";
  at: string;
}

export interface LiveState {
  active: boolean;
  runID?: string | null;
  target: string;
  goal: string;
  stepIndex: number;
  steps: LiveStep[];
}

export interface NativeState {
  /** Missing in the demo. */
  watching?: Watching;
  /** The current or last driving run. Missing when nothing has been driven. */
  live?: LiveState | null;
  accounts: Account[];
  currentAccountID: string;
  settings: Settings;
  runs: Run[];
  threads: Thread[];
  memories: Memory[];
  /** Missing on older builds. */
  memorySources?: MemorySource[];
  skills: Skill[];
  routines: Routine[];
  /** The skill library. Missing on older builds. */
  library?: LibraryEntry[];
  connectors: Connector[];
  keys: Record<string, boolean>;
  permissions: Record<string, string>;
  signedOut: boolean;
  inCall: boolean;
  onboardingOpen: boolean;
  dashboardOpen: boolean;
  sidecar: string;
  version: string;
  /** This Mac's name. Missing on older builds. */
  hostName?: string;
  /** Missing on older builds. */
  services?: ServicesState | null;
  /** Only the Mac knows what's in its key file. */
  keyProviders?: KeyProvider[];
  mcpStatus?: Record<string, McpStatus>;
  mcpSecretNames?: Record<string, string[]>;
  /** Missing in the demo, where there is no VM to report on. */
  privateMac?: PrivateMacState | null;
  /** The vault folder and sealed logins. Missing in the browser preview. */
  vault?: VaultState | null;
  /** Browsers to import passwords from, and the last import. Missing in older builds. */
  vaultImport?: VaultImportState | null;
  /** okidoki's browser, for the shell's sidebar and toolbar. Missing on older builds. */
  browser?: BrowserState | null;
  /** Sites pinned in the sidebar, in order. */
  pins?: Pin[];
  bookmarks?: Bookmark[];
  /** Runs with a thumbnail: id → when it was last taken, in seconds. */
  thumbs?: Record<string, number>;
}

export interface BrowserTab {
  id: string;
  number: number;
  title: string;
  address: string;
  host: string;
  loading: boolean;
  blank: boolean;
  /** The agent's or a replay's line while one works here; null when it's the person's tab. */
  status?: string | null;
  ownerRunID?: string | null;
  threadID?: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  hasLogin: boolean;
  loadError?: string | null;
  bookmarked: boolean;
}

export interface BrowserState {
  activeID?: string | null;
  recording: boolean;
  recordedSteps: number;
  tabs: BrowserTab[];
}

export interface Pin {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

/** A Chromium-family browser found on this Mac. Counts only, never a secret. */
export interface DetectedBrowser {
  id: string;
  name: string;
  profiles: string[];
  /** Saved logins across its profiles; missing when they couldn't be counted. */
  logins?: number | null;
  /** Why it can't be read (macOS blocked the folder, …). */
  error?: string | null;
}

export interface VaultImportReport {
  source: string;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  finishedAt: string;
}

export interface VaultImportState {
  sources: DetectedBrowser[];
  scanned: boolean;
  scanning: boolean;
  /** Browser id being imported, or "csv". */
  busy?: string | null;
  last?: VaultImportReport | null;
  /** An imported CSV still on disk with passwords in the clear. */
  csvToTrash?: string | null;
  /** Browser id whose sign-ins (cookies) are being brought over. */
  cookiesBusy?: string | null;
  lastCookies?: CookieImportReport | null;
}

/** Sign-ins brought into okidoki's browser from another browser. Counts only. */
export interface CookieImportReport {
  source: string;
  cookies: number;
  sites: number;
  skipped: number;
  errors: string[];
  finishedAt: string;
}

/** A document in the vault folder. `id` is its path inside the folder. */
export interface VaultFile {
  id: string;
  name: string;
  /** Subfolder, relative to the vault folder; "" for the top level. */
  folder: string;
  size: number;
  modifiedAt: string;
  mime: string;
}

/** A login in the vault: the password is a sealed box only the vault passphrase opens. */
export interface VaultLogin {
  id: string;
  site: string;
  username: string;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  note: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
}

export interface VaultState {
  folder: string;
  available: boolean;
  truncated: boolean;
  files: VaultFile[];
  folders: string[];
  logins: VaultLogin[];
  salt: string;
  /** Set when "remember on this Mac" is on. */
  rememberedPassphrase: string;
}

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  kind?: "success" | "info" | "warning" | "approval";
}
