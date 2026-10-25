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
  convexSiteURL: string;
  syncEnabled: boolean;
  lastSyncAt?: string | null;
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
  /** Enterprise: this Mac takes jobs the agent is given in the work account's spaces. Missing on older builds. */
  workerEnabled?: boolean;
  /** A join code waiting for the sync login (onboarding, a nearby Mac, managed configuration). Missing on older builds. */
  pendingJoinCode?: string;
  pendingJoinOrgName?: string;
  /** Where a request typed at the cursor goes by default: "" for this Mac, else a space id. */
  askScope?: string;
}

/** Enterprise: this Mac as a worker for its spaces. Missing on Convex snapshots and in the demo. */
export interface WorkerState {
  status: string;
  /** off · paused · ready, as told to the organization on the last poll. Missing on older builds. */
  state?: "off" | "paused" | "ready";
  /** The work account the worker runs as, which may not be the one in front. */
  accountID?: string | null;
  activeJob?: string | null;
  activeSpace?: string | null;
  lastPollAt?: string | null;
  jobsDone: number;
  device: string;
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

/** The brain, Convex sync, the Moss index and MCP as the Mac sees them right now. */
export interface ServicesState {
  brain: { status: string; ready: boolean; version?: string | null; port: number };
  convex: {
    enabled: boolean;
    configured: boolean;
    hasSecret: boolean;
    siteURL: string;
    /** Native's own words: "synced just now", "sync secret rejected", "local only"… */
    status: string;
    lastSyncAt?: string | null;
  };
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
  /** Missing on Convex snapshots and older builds. */
  memorySources?: MemorySource[];
  skills: Skill[];
  routines: Routine[];
  connectors: Connector[];
  tools: Tool[];
  installedAgents: string[];
  /** Missing on Convex snapshots and older builds; only the Mac can read its own login files. */
  agents?: AgentStatus[];
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
  /** Missing on Convex snapshots and older builds. */
  services?: ServicesState | null;
  /** Missing on Convex snapshots: only the Mac knows what's in its key file. */
  keyProviders?: KeyProvider[];
  mcpStatus?: Record<string, McpStatus>;
  mcpSecretNames?: Record<string, string[]>;
  /** Missing on Convex snapshots and in the demo, where there is no VM to report on. */
  privateMac?: PrivateMacState | null;
  worker?: WorkerState | null;
  nearby?: NearbyState | null;
  /** Enterprise: the organization as the Mac last heard it. Missing on Convex snapshots and older builds. */
  enterprise?: NativeEnterpriseState | null;
}

/** A colleague's run waiting on an okay in one of my spaces, as the Mac reports it. */
export interface NativeApproval {
  id: string;
  spaceId: string;
  spaceName: string;
  prompt: string;
  title: string;
  requestedBy: string;
  workerName: string;
  workerIsYou: boolean;
  summary: string;
  risk: "low" | "medium" | "high";
  createdAt: string;
}

export interface NativeSpace {
  id: string;
  name: string;
  colorHex: string;
  joined: boolean;
  unread: number;
  lastMessage: string;
  lastMessageAt: string;
}

/**
 * Enterprise, from the Mac rather than from Convex directly: every approval across my spaces
 * (the Convex query only covers the open one), unread counts, and whether the account is linked.
 * It keeps flowing while the panel is closed, so Home is whole the moment it opens.
 */
export interface NativeEnterpriseState {
  linked: boolean;
  orgId?: string | null;
  orgName?: string | null;
  role?: string | null;
  pendingJoins: number;
  approvals: NativeApproval[];
  spaces: NativeSpace[];
  unread: number;
  sharedSkills: number;
  updatedAt?: string | null;
  lastError?: string | null;
}

/** Enterprise: an organization inviting over this network. */
export interface NearbyInvite {
  orgId: string;
  orgName: string;
  code: string;
  device: string;
}

export interface NearbyState {
  invites: NearbyInvite[];
  advertising?: NearbyInvite | null;
  browsing: boolean;
  error?: string | null;
}

export interface Toast {
  id: string;
  title: string;
  detail?: string;
  kind?: "success" | "info" | "warning" | "approval";
}
