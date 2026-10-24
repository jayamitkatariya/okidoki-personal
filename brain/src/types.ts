export type RiskLevel = "low" | "medium" | "high";

export type DecisionKind =
  | "answer"
  | "quick_action"
  | "terminal"
  | "coding"
  | "background"
  | "teach"
  | "borrow"
  | "watch"
  | "memory"
  | "routine"
  | "computer_use"
  | "overlay"
  | "connector";

export interface TeachMark {
  kind: "circle" | "box" | "arrow" | "label" | "dim" | "cursor" | "ink";
  target?: string;
  point?: [number, number];
  rect?: [number, number, number, number];
  to?: [number, number];
  text?: string;
  seconds?: number;
  /** "window" (default) is the app window. "screen" is the whole display. */
  space?: "window" | "screen";
}

export interface TeachPlanStep {
  say: string;
  marks: TeachMark[];
}

/** What happened on one live tutoring step: what was taught and what the learner did. */
export interface TeachLogEntry {
  say: string;
  action: string;
  label?: string;
  outcome: string;
}

/** A control the Mac can see through accessibility, with its center in screenshot pixels. */
export interface TeachControlHint {
  label: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TeachStepRequest {
  topic: string;
  app?: string;
  outline?: string[];
  log: TeachLogEntry[];
  stepNumber: number;
  imageWidth: number;
  imageHeight: number;
  screenshotBase64?: string;
  controls?: TeachControlHint[];
  model?: string;
}

/** Zoomed second look at one control, to land the ring on the exact pixels. */
export interface TeachRefineRequest {
  cropBase64: string;
  cropWidth: number;
  cropHeight: number;
  describe: string;
  model?: string;
}

/** One live tutoring step. Coordinates are pixels in the screenshot, origin top-left. */
export interface TeachStep {
  previous_done: boolean;
  action: "click" | "double_click" | "right_click" | "drag" | "type" | "key" | "scroll" | "look" | "open_app" | "done";
  say: string;
  why?: string;
  label?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  target?: string;
  key?: string;
  text?: string;
  app?: string;
  summary?: string;
  remaining?: number;
  /** An optional second region worth a glance, e.g. where the result will appear. */
  also_x?: number;
  also_y?: number;
  also_w?: number;
  also_h?: number;
  also_label?: string;
}

export interface QuickAction {
  type: "reminder" | "note" | "event" | "move_event" | "click";
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
  teachSteps?: string[];
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
  teachPlan?: TeachPlanStep[];
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
  reminders?: string[];
  frontWindow?: string;
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
    selectedAgent?: string;
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
  installedTools?: string[];
  nativeContext?: NativeContext;
  connectors?: ConnectorsContext;
  /** The current okidoki account, so recall stays within it (plus shared memories). */
  accountId?: string;
}

/** What the Mac sends to keep the memory index current: its own items, as stored. */
export interface MemorySyncRequest {
  projectId: string;
  projectKey: string;
  cacheDir?: string;
  memories?: { id: string; text: string; section?: string; updatedAt?: string }[];
  threads?: { id: string; accountID?: string; title?: string; messages?: { id: string; role?: string; text?: string; createdAt?: string }[] }[];
  runs?: { id: string; accountID?: string; kind?: string; title?: string; prompt?: string; summary?: string; output?: string; status?: string; createdAt?: string }[];
  skills?: { id: string; accountID?: string; name?: string; summary?: string; steps?: { text?: string }[]; createdAt?: string }[];
  routines?: { id: string; accountID?: string; name?: string; prompt?: string; cadence?: string; createdAt?: string }[];
}

export interface RecalledItem {
  type: string;
  text: string;
  title: string;
  date: string;
  score: number;
}

export interface ExecuteRequest {
  runId: string;
  kind: "terminal" | "background" | "coding";
  commands?: string[];
  agent?: "claude" | "opencode" | "omp" | "hermes";
  prompt?: string;
  workingDirectory?: string;
  model?: string;
  extraArgs?: string;
  toolId?: string;
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
  /** The screen as it was before the last action. */
  previousScreenshotBase64?: string;
  /** A magnified crop requested by the last zoom action. */
  zoomBase64?: string;
  zoom?: { x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number };
  screenshotBase64?: string;
  canClick?: boolean;
  canSee?: boolean;
  settings?: {
    claudeModel?: string;
  };
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

export interface ToolSpec {
  id: string;
  name: string;
  command: string;
  replaces: string;
  blurb: string;
  examples: string[];
  installCommand: string;
  docs: string;
  license: string;
  category: string;
}
