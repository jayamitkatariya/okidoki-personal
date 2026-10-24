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
  selectedAgent: "claude" | "opencode" | "omp" | "hermes";
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
  appleCalendar: boolean;
  appleReminders: boolean;
  appleNotes: boolean;
  automationGranted: boolean;
  inputMonitoringGranted: boolean;
  convexSiteURL: string;
  syncEnabled: boolean;
  lastSyncAt?: string | null;
  onboardingComplete: boolean;
  tourComplete: boolean;
  showedWelcome: boolean;
  claudeModel: string;
  agentExtraArgs: Record<string, string>;
  lastWorkingDirectory: string;
  mcpServers: McpServer[];
  drivePace: "calm" | "fast";
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

export type RunKind = "answer" | "quickAction" | "terminal" | "coding" | "background" | "teach" | "watch" | "borrow" | "computer_use" | "routine" | "connector";
export type RunStatus = "previewing" | "waiting" | "running" | "paused" | "done" | "failed" | "cancelled";
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
  /** Missing on Convex snapshots, which don't carry live recorder state. */
  watching?: Watching;
  /** The current or last driving run. Missing on Convex snapshots and when nothing has been driven. */
  live?: LiveState | null;
  accounts: Account[];
  currentAccountID: string;
  settings: Settings;
  runs: Run[];
  threads: Thread[];
  memories: Memory[];
  skills: Skill[];
  routines: Routine[];
  connectors: Connector[];
  tools: Tool[];
  installedAgents: string[];
  keys: Record<string, boolean>;
  permissions: Record<string, string>;
  signedOut: boolean;
  inCall: boolean;
  onboardingOpen: boolean;
  dashboardOpen: boolean;
  sidecar: string;
  version: string;
  savings: number;
  convexConfigured: boolean;
  mcpStatus?: Record<string, McpStatus>;
  mcpSecretNames?: Record<string, string[]>;
}

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  kind?: "success" | "info" | "warning" | "approval";
}
