import type { PushQuestion } from './routes/push';

export const WORKSPACE_ATTENTION_REASONS = ['question', 'plan', 'variables', 'blocked', 'setup', 'deploy_failed'] as const;

export type WorkspaceAttentionReason = (typeof WORKSPACE_ATTENTION_REASONS)[number];

export const CHAT_ATTENTION_REASONS = ['question', 'blocked'] as const;

export const INPUT_REQUEST_REASONS = ['question', 'plan'] as const;

export const NEEDS_YOU_SUMMARY_MAX = 60;

type NeedsYouAction =
  | { kind: 'answer'; toolRequestId: string | null; question?: PushQuestion }
  | { kind: 'approve'; toolRequestId: string }
  | { kind: 'add'; requestId: string; variables: string[] }
  | { kind: 'retry' }
  /** The failed create deleted its sandbox, so only a new workspace can replace it. */
  | { kind: 'recreate' };

export interface NeedsYouItem {
  /** Stable while the same thing needs the user: the chat, `chat:request`, `variables:request` or `setup`. */
  id: string;
  workspaceId: string;
  chatId: string | null;
  reason: WorkspaceAttentionReason;
  since: string;
  /** Changes whenever the item is written again, so a held push can tell it's no longer what it announced. */
  raisedAt: string;
  summary: string;
  text: string | null;
  action: NeedsYouAction;
}
