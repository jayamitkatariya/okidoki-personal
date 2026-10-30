export type RiskLevel = "low" | "medium" | "high";

export type DecisionKind =
  | "answer"
  | "quick_action"
  | "background"
  | "borrow"
  | "watch"
  | "memory"
  | "routine"
  | "computer_use"
  | "browser"
  | "overlay"
  | "connector";

export interface QuickAction {
  type: "event" | "move_event" | "click";
  title: string;
  body?: string;
  date?: string;
  hour?: number;
  weekday?: number;
}

export interface Decision {
  kind: DecisionKind;
  title: string;
  answer: string;
  speak?: string;
  risk?: RiskLevel;
  previewSummary?: string;
  previewSteps?: string[];
  commands?: string[];
  apps?: string[];
  files?: string[];
  memory?: string[];
  routineName?: string;
  routineCadence?: "hourly" | "daily" | "weekdays" | "weekly" | "manual";
  routineWeekday?: number;
  routineHour?: number;
  routineMinute?: number;
  clarification?: string;
  actions?: string[];
  quickAction?: QuickAction;
  pickFile?: "video" | "pdf" | "document" | "images" | "folder";
  builtin?: string;
  overlayHTML?: string;
  overlayTitle?: string;
  overlayWidth?: number;
  overlayHeight?: number;
  connectorCall?: ConnectorCall;
  // The same call as a JSON string: the Mac app keeps it opaque and hands it back to /connector/run.
  connectorCallJSON?: string;
}

export type ConnectorCall =
  | { connector: "apify"; actor: string; input: Record<string, unknown> }
  | { connector: "mcp"; server: string; tool: string; arguments: Record<string, unknown> };

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  // Secrets come from the Mac's key file on every request; the sidecar never stores them.
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ConnectorsContext {
  apify?: boolean;
  mcpServers?: McpServerConfig[];
}

export interface ConnectorRunRequest {
  runId: string;
  prompt: string;
  call: ConnectorCall;
  apifyToken?: string;
  mcpServers?: McpServerConfig[];
  spendingLimit?: number;
  settings?: { claudeModel?: string };
}

export interface ConnectorRunResult {
  ok: boolean;
  answer: string;
  summary: string;
  output: string;
  error?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

export interface NativeContext {
  now: string;
  events?: { title: string; start: string }[];
  frontWindow?: string;
  /** The browser tab in front, when the current app is a browser. */
  pageTitle?: string;
  pageURL?: string;
  /** True when the screenshot is the whole display at summon time, not something they circled. */
  screenshotIsDisplay?: boolean;
}

export interface ThinkRequest {
  text: string;
  appName?: string;
  bundleID?: string;
  threadID?: string;
  source?: string;
  account?: { name: string; kind: string };
  settings?: {
    claudeModel?: string;
    customInstructions?: string;
    defaultInput?: string;
    voiceEnabled?: boolean;
  };
  memory?: string[];
  history?: HistoryMessage[];
  screenshotBase64?: string;
  screenshotMediaType?: string;
  documentText?: string;
  documentName?: string;
  clipboardText?: string;
  nativeContext?: NativeContext;
  connectors?: ConnectorsContext;
  /** The current okidoki account, so recall stays within it (plus shared memories). */
  accountId?: string;
  /** What the person picked on the cursor card: act or chat. Missing means decide. */
  mode?: "act" | "chat";
}

/** What the Mac sends to keep the memory index current: the parts of its items the index uses.
 * Older Macs also send run output and routines; both are ignored. */
export interface MemorySyncRequest {
  projectId: string;
  projectKey: string;
  cacheDir?: string;
  /** No accountID (older Macs): the note is shared by every account. */
  memories?: { id: string; accountID?: string; text: string; section?: string; updatedAt?: string }[];
  threads?: { id: string; accountID?: string; title?: string; messages?: { id: string; role?: string; text?: string; createdAt?: string }[] }[];
  runs?: { id: string; accountID?: string; kind?: string; title?: string; prompt?: string; summary?: string; output?: string; status?: string; createdAt?: string }[];
  skills?: { id: string; accountID?: string; name?: string; summary?: string; steps?: { text?: string }[]; createdAt?: string }[];
  routines?: { id: string; accountID?: string; name?: string; prompt?: string; cadence?: string; createdAt?: string }[];
}

export interface RecalledItem {
  /** memory · message · run · skill */
  type: string;
  text: string;
  title: string;
  date: string;
  score: number;
  /** Notes: aboutYou or rightNow. */
  section?: string;
  /** Runs: how the task ended. */
  status?: string;
}

export interface ComputerHistoryEntry {
  type: string;
  x?: number;
  y?: number;
  app?: string;
  text?: string;
  key?: string;
  script?: string;
  target?: string;
  result: string;
}

export interface ComputerControl {
  role: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface ComputerRequest {
  goal: string;
  step: number;
  app?: string;
  windowTitle?: string;
  screen: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  history: ComputerHistoryEntry[];
  /** Clickable controls of the frontmost app, centers in screenshot pixels. */
  controls?: ComputerControl[];
  /** Abridged AppleScript dictionary of the frontmost app, or empty. */
  scripting?: string;
  /** The screen as it was before the last action. */
  previousScreenshotBase64?: string;
  /** What the target looked like when a skill was recorded: a crop around the click point. */
  referenceBase64?: string;
  /** A magnified crop requested by the last zoom action. */
  zoomBase64?: string;
  zoom?: { x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number };
  screenshotBase64?: string;
  /** image/png (default) or image/jpeg. */
  screenshotMediaType?: string;
  previousMediaType?: string;
  canClick?: boolean;
  canSee?: boolean;
  /** True when driving okidoki's private Mac (a VM): no scripts or accessibility, only clicks and keys. */
  remote?: boolean;
  settings?: {
    claudeModel?: string;
  };
}

/** What the Mac sees at one step of a v2 run. */
export interface DriveObservation {
  app?: string;
  windowTitle?: string;
  imageWidth: number;
  imageHeight: number;
  screenshotBase64?: string;
  /** image/png or image/jpeg. */
  mediaType?: string;
  /** Numbered controls of the frontmost app, centers in screenshot pixels. */
  controls?: Array<ComputerControl & { id?: number }>;
  scripting?: string;
  canClick?: boolean;
  canSee?: boolean;
  /** Short facts from the Mac, e.g. that the screen changed during the last batch. */
  notes?: string[];
}

/** The outcome of one action from the model's last batch. */
export interface DriveResult {
  /** The tool_use id the action came with. */
  id: string;
  result: string;
  isError?: boolean;
  /** Not run because an earlier action in the batch failed. */
  skipped?: boolean;
  /** A zoom crop, for zoom results. */
  imageBase64?: string;
  mediaType?: string;
}

export interface DriveRequest {
  runID: string;
  goal: string;
  step: number;
  observation: DriveObservation;
  results?: DriveResult[];
  /** Compact history, used only to restart the conversation if the brain lost it. */
  history?: ComputerHistoryEntry[];
  /** The previous run in the same thread, for "again" and "continue". `asked`: it paused on a question, and `goal` here is the user's answer. */
  previous?: { goal: string; summary?: string; steps?: string[]; asked?: boolean };
  /** The plan the user approved before the run started, when it says more than the goal. */
  plan?: string;
  remote?: boolean;
  /** Use the stronger model for this one turn. */
  escalate?: boolean;
  effort?: "none" | "low" | "medium" | "high";
  settings?: { claudeModel?: string };
}

/** One action for the Mac, in the field names ComputerAction decodes, tagged with its tool call. */
export interface DriveAction {
  id: string;
  tool: string;
  member: boolean;
  type: string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  width?: number;
  height?: number;
  dx?: number;
  dy?: number;
  text?: string;
  key?: string;
  times?: number;
  seconds?: number;
  script?: string;
  lang?: string;
  app?: string;
  element?: number;
  button?: string;
  modifiers?: string;
  summary?: string;
  reason?: string;
}

export type ComputerAct = {
  type:
    | "open_app"
    | "activate"
    | "open_url"
    | "script"
    | "click"
    | "double_click"
    | "right_click"
    | "middle_click"
    | "move"
    | "drag"
    | "type"
    | "key"
    | "scroll"
    | "wait"
    | "done"
    | "fail"
    | string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  app?: string;
  text?: string;
  key?: string;
  script?: string;
  lang?: string;
  target?: string;
  width?: number;
  height?: number;
  times?: number;
  modifiers?: string;
  dx?: number;
  dy?: number;
  seconds?: number;
  reason?: string;
  summary?: string;
  say?: string;
};
