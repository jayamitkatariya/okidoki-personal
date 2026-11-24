import type { AgentProvider } from '../agent';
import type { SendChatMessageRequest } from '../engine/v1';
import type { SlackChannel } from './slack';

export interface SendDeferredChatMessageRequest
  extends Pick<SendChatMessageRequest, 'message' | 'messageId' | 'submittedAt' | 'model' | 'images' | 'canvasUploadIds' | 'goalMode' | 'fastMode' | 'ultrafastMode' | 'thinkingLevel' | 'source'> {
  provider: AgentProvider;
  chatId?: string;
  /** First message of a brand-new workspace: generate a name server-side and forward it to the engine once it boots. */
  generateName?: boolean;
  slackChannel?: Pick<SlackChannel, 'id' | 'name'>;
}

export interface SendDeferredChatMessageResponse {
  status: 'waking';
  chatId: string;
  messageId: string;
}
