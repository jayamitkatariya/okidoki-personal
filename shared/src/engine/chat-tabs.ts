import { DEFAULT_CHAT_TITLES, getInitialChatId, isDefaultChat, isPullRequestFeedbackChat, isPullRequestSideChat } from './types';
import { isEngineAgentProvider, type AgentProvider } from '../agent';
import type { ChatSummary } from './v1';
import type { EngineEnvironmentDetails } from './environment';
import { getChatContinuation, getContinuedChatIds } from '../chat-fork';

/**
 * Pure chat-tab policy shared by the web tab strip and the engine's delete
 * flow. Keep this module free of UI and IO concerns so the rules stay
 * independently testable.
 */

export function hasChatStarted(chat: ChatSummary): boolean {
  return chat.processing
    || Boolean(chat.awaitingInput)
    || Boolean(chat.goal)
    || Boolean(chat.lastMessageText)
    || chat.updatedAt > chat.createdAt;
}

export function canForkChat(chat: ChatSummary, environment: EngineEnvironmentDetails | undefined): boolean {
  return environment?.supportsDeferredChatForking === true && isEngineAgentProvider(chat.provider) && hasChatStarted(chat);
}

export function getMostRecentlyUsedChat(chats: ChatSummary[]): ChatSummary | undefined {
  let mostRecent: ChatSummary | undefined;
  for (const chat of chats) {
    if (chat.parentChatId !== null || chat.deletedAt || isPullRequestSideChat(chat) || !hasChatStarted(chat)) continue;
    if (!mostRecent || chat.updatedAt > mostRecent.updatedAt) mostRecent = chat;
  }
  return mostRecent;
}

export function isPristineDefaultChat(chat: ChatSummary): boolean {
  return isDefaultChat(chat) && !hasChatStarted(chat);
}

export function getVisibleChats(chats: ChatSummary[], openChatId: string | null): ChatSummary[] {
  const continued = getContinuedChatIds(chats);
  return chats.filter((chat) =>
    chat.parentChatId === null
    && !chat.deletedAt
    && (!isPristineDefaultChat(chat) || chat.id === openChatId)
    && !continued.has(chat.id)
  );
}

// Deleted chats are counted so that deleting one doesn't rename every later tab.
export function getChatTabLabels(chats: ChatSummary[], deletedChats: ChatSummary[] = []): Map<string, string> {
  const all = [...chats, ...deletedChats];
  return new Map(chats.map((chat) => {
    const title = DEFAULT_CHAT_TITLES[chat.provider];
    if (chat.displayName || isDefaultChat(chat)) return [chat.id, chat.displayName ?? title];
    const number = all.filter((other) => !isDefaultChat(other) && other.provider === chat.provider
      && (other.createdAt < chat.createdAt || (other.createdAt === chat.createdAt && other.id < chat.id))).length + 1;
    return [chat.id, `${title} ${number}`];
  }));
}

export function getOpeningChatId(chats: ChatSummary[], rememberedChatId: string | null, preferredProvider?: AgentProvider): string | null {
  const remembered = getChatContinuation(chats, rememberedChatId)?.id ?? rememberedChatId;
  const visible = getVisibleChats(chats, remembered);
  return visible.find((chat) => chat.id === remembered && !isPullRequestFeedbackChat(chat))?.id
    ?? getInitialChatId(visible, preferredProvider);
}

export type ChatDeletionDecision =
  | { canDelete: true; interruptsActiveTurn: boolean }
  | { canDelete: false; reason: 'chat-not-found' | 'only-open-chat' };

export function getChatDeletionDecision(
  chats: ChatSummary[],
  chatId: string,
  openChatId: string | null,
): ChatDeletionDecision {
  const chat = chats.find((entry) => entry.id === chatId && !entry.deletedAt);
  if (!chat) {
    return { canDelete: false, reason: 'chat-not-found' };
  }
  const visible = getVisibleChats(chats, openChatId);
  if (visible.length === 1 && visible[0]?.id === chatId) {
    return { canDelete: false, reason: 'only-open-chat' };
  }
  return { canDelete: true, interruptsActiveTurn: chat.processing };
}

/**
 * Which chat to select once `deletedChatId` is gone: the current selection if
 * it survives, otherwise the deleted chat's right neighbor, then its left.
 * `chats` must be in tab order.
 */
export function getNextSelectedChatId(
  chats: ChatSummary[],
  deletedChatId: string,
  selectedChatId: string | null,
): string | null {
  if (selectedChatId !== deletedChatId) {
    return selectedChatId;
  }
  const visible = getVisibleChats(chats, selectedChatId);
  const deletedIndex = visible.findIndex((chat) => chat.id === deletedChatId);
  const remaining = visible.filter((chat) => chat.id !== deletedChatId);
  if (remaining.length === 0) {
    return null;
  }
  return remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)]?.id ?? null;
}

export function getRestorableChats(deletedChats: ChatSummary[] | null | undefined): ChatSummary[] {
  return (deletedChats ?? [])
    .filter((chat) => Boolean(chat.deletedAt) && hasChatStarted(chat))
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}
