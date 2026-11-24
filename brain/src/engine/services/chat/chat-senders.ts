import { isChatMessageSender, type ChatMessageSender } from '@okidoki/shared';
import { join } from 'path';
import { ENGINE_DIR } from './history-paths';

export const CHAT_SENDERS_DIR = join(ENGINE_DIR, 'chat-senders');

export function chatMessageSendersFilePath(chatId: string): string {
  return join(CHAT_SENDERS_DIR, `${chatId}.jsonl`);
}

export function parseChatMessageSendersJsonl(content: string): ChatMessageSender[] {
  return content.split('\n').flatMap((line): ChatMessageSender[] => {
    if (!line.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isChatMessageSender(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
