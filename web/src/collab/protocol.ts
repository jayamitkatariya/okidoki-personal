/**
 * The shared-session wire contract, mirrored by the host's CollabServer (Swift). See docs/collab.md.
 * The joiner page talks to the host over the LAN with these shapes; a mock implements the same contract
 * for the browser preview and the tests, so the client is provable without a Mac.
 */

export const COLLAB_PORT = 4331;
export const CHAT_MAX = 2000;
export const PARTICIPANT_MAX = 8;

export interface Participant {
  id: string;
  name: string;
  colorHex: string;
  joinedAt: string;
  isHost?: boolean;
}

export type ChatKind = "chat" | "ask" | "okidoki" | "system";

export interface ChatMessage {
  id: string;
  authorID: string;
  authorName: string;
  colorHex: string;
  text: string;
  kind: ChatKind;
  at: string;
}

export interface RunStep {
  index: number;
  say: string;
  kind: string;
  detail: string;
  result: string;
  status: string;
}

export interface RunSnapshot {
  id: string;
  title: string;
  status: string;
  goal: string;
  requestedBy?: string | null;
  /** What the run waits on from the host, in words. Null when nothing. */
  needs?: string | null;
  steps: RunStep[];
}

export interface SkillInput {
  name: string;
  description: string;
}

export interface SkillCard {
  id: string;
  name: string;
  summary: string;
  intent?: string | null;
  inputs: SkillInput[];
}

export interface VMState {
  phase: string;
  running: boolean;
}

export interface SessionSnapshot {
  hostName: string;
  startedAt: string;
  participants: Participant[];
  wheelHolder?: string | null;
  wheelHolderName?: string | null;
  vm: VMState;
  run: RunSnapshot | null;
  skills: SkillCard[];
  chat: ChatMessage[];
}

export interface JoinResponse {
  token: string;
  you: Participant;
  session: SessionSnapshot;
}

export type CollabEvent =
  | { type: "hello"; you: Participant; session: SessionSnapshot }
  | { type: "chat"; message: ChatMessage }
  | { type: "presence"; participants: Participant[] }
  | { type: "run"; run: RunSnapshot | null }
  | { type: "vm"; phase: string; running: boolean }
  | { type: "skills"; skills: SkillCard[] }
  | { type: "wheel"; holder: string | null; holderName: string | null }
  | { type: "ended" };

/** The host dashboard's view of its own session (NativeState.collab). */
export interface CollabHostState {
  active: boolean;
  code?: string | null;
  url?: string | null;
  port?: number;
  participants?: Participant[];
  wheelHolder?: string | null;
  runID?: string | null;
  error?: string | null;
}

export function asksOkidoki(text: string): boolean {
  return /^\s*okidoki\b/i.test(text);
}

export function stripAskPrefix(text: string): string {
  return text.replace(/^\s*okidoki[,:]?\s*/i, "").trim();
}
