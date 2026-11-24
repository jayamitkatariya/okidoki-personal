import type { AgentProvider, AuthMethod, CredentialScope, MessageSource } from '@okidoki/shared';

export interface AgentChatTurnContext {
  chatId: string;
  turnId: string;
  provider: AgentProvider;
  model: string;
  senderUserId?: string;
  source?: MessageSource;
  automationId?: string;
  environmentId?: string;
  credentialMethod?: AuthMethod;
  credentialScope?: CredentialScope;
}
