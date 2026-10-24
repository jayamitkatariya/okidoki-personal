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
}

export interface TeachPlanStep {
  say: string;
  marks: TeachMark[];
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
  // Secrets come from the Mac's Keychain on every request; the sidecar never stores them.
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
}

export interface ThinkResponse {
  decision: Decision;
  usedModel: boolean;
  error?: string;
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
  result: string;
}

export interface ComputerRequest {
  goal: string;
  step: number;
  app?: string;
  screen: { x: number; y: number; width: number; height: number };
  imageWidth: number;
  imageHeight: number;
  history: ComputerHistoryEntry[];
  screenshotBase64?: string;
  settings?: {
    claudeModel?: string;
  };
}

export type ComputerAct = {
  type: "open_app" | "activate" | "click" | "double_click" | "right_click" | "drag" | "type" | "key" | "scroll" | "wait" | "done" | "fail" | string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  app?: string;
  text?: string;
  key?: string;
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
