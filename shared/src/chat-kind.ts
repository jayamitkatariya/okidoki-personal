export const CHAT_KINDS = ['standard', 'pull_request_fixes', 'pull_request_review', 'pull_request_tour'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export function isChatKind(value: unknown): value is ChatKind {
  return CHAT_KINDS.some((kind) => kind === value);
}

export function getChatKind(chat: { title: string; kind?: ChatKind }): ChatKind {
  if (chat.kind !== undefined) return chat.kind;
  // TRANSITION: chats from engines and servers that predate `kind` are only identifiable by their original title.
  const purpose = /^(?:PR #|MR !)\d+ (fixes|review|tour)$/.exec(chat.title)?.[1];
  return CHAT_KINDS.find((kind) => kind === `pull_request_${purpose}`) ?? 'standard';
}
