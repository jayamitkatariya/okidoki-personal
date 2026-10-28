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

/** Mirrors CodingAgentID in Sources/OkidokiCore/Models/Models.swift. */
export type CodingAgentID = "claude" | "opencode" | "omp" | "hermes" | "codex" | "gemini" | "cursor";

/** A coding agent on the Mac: on the PATH, and signed in to something that can answer. */
export interface AgentStatus {
  id: CodingAgentID;
  name: string;
  installed: boolean;
  signedIn: boolean;
  /** Who the CLI is signed in as, when it writes that down. Empty when unknown. */
  account: string;
  /** Providers the CLI holds credentials for, e.g. ["anthropic", "openrouter"]. */
  providers: string[];
  /** Where okidoki looked, e.g. "~/.claude/.credentials.json". */
  source: string;
  installHint: string;
  loginHint: string;
}

export interface Settings {
  okidokiEnabled: boolean;
  defaultInput: InputMode;
  voiceID: string;
  voiceSpeed: number;
  voiceEnabled: boolean;
  captions: boolean;
  confirmOK: boolean;
  selectedAgent: CodingAgentID;
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
  appleReminders: boolean;
  appleNotes: boolean;
  automationGranted: boolean;
  inputMonitoringGranted: boolean;
  onboardingComplete: boolean;
  tourComplete: boolean;
  showedWelcome: boolean;
  claudeModel: string;
  agentExtraArgs: Record<string, string>;
  /** Switch the default agent to one that's installed and signed in when the chosen one can't answer. */
  autoConnectAgents: boolean;
  lastWorkingDirectory: string;
  mcpServers: McpServer[];
  drivePace: "calm" | "fast";
  /** Where computer-use runs happen: this Mac, or okidoki's private Mac (a macOS VM). */
  computerTarget: "mac" | "vm";
  /** What a request typed at the cursor is for. Missing on older builds. */
  summonMode?: "auto" | "act" | "teach" | "chat";
  /** The vault folder on disk. Missing on older builds. */
  vaultFolder?: string;
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

export type RunKind = "answer" | "quick_action" | "terminal" | "coding" | "background" | "teach" | "watch" | "borrow" | "computer_use" | "routine" | "connector";
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
  agent?: string | null;
  workingDirectory?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
  freedBytes?: number | null;
  builtin?: string | null;
  pickedPath?: string | null;
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

export interface Skill {
  id: string;
  accountID: string;
  name: string;
  summary: string;
  steps: SkillStep[];
  createdAt: string;
  source: string;
  runCount: number;
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

export interface Tool {
  id: string;
  name: string;
  command: string;
  replaces: string;
  blurb: string;
  installed: boolean;
  installCommand: string;
  docs: string;
  license: string;
  category: string;
  examples: string[];
  popularity?: number;
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
  connectors: Connector[];
  tools: Tool[];
  installedAgents: string[];
  /** Missing on older builds; only the Mac can read its own login files. */
  agents?: AgentStatus[];
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
  savings: number;
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
  /** Missing on older builds. */
  notes?: Note[];
  reminders?: Reminder[];
}

/** A note on the Notes page. Markdown body. */
export interface Note {
  id: string;
  accountID: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ReminderRepeat = "never" | "daily" | "weekdays" | "weekly" | "monthly";

/** A reminder okidoki fires itself; one with a skill replays it when it's due. */
export interface Reminder {
  id: string;
  accountID: string;
  title: string;
  dueAt?: string | null;
  repeats: ReminderRepeat;
  done: boolean;
  doneAt?: string | null;
  skillID?: string | null;
  firedAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
