import { getProviderDisplayName, type AgentProvider } from '@okidoki/shared';

export class ChatNotFoundError extends Error {
  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = 'ChatNotFoundError';
  }
}

export class CodexThreadNotFoundError extends Error {
  constructor(threadId: string) {
    super(`Codex thread history not found: ${threadId}`);
    this.name = 'CodexThreadNotFoundError';
  }
}

export class DuplicateDefaultChatError extends Error {
  constructor(provider: AgentProvider) {
    super(`Default chat already exists for provider: ${provider}`);
    this.name = 'DuplicateDefaultChatError';
  }
}

export class ChatMessagePersistenceError extends Error {
  constructor(cause: unknown) {
    super(`Failed to persist user message: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ChatMessagePersistenceError';
    this.cause = cause;
  }
}

export class ChatBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatBusyError';
  }
}

export class ChatProviderUnavailableError extends Error {
  constructor(provider: AgentProvider) {
    super(`${getProviderDisplayName(provider, 'long')} is not connected in this workspace`);
    this.name = 'ChatProviderUnavailableError';
  }
}
