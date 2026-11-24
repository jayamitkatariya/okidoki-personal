import type { TriggerDefinition, TriggerParameterDefinition } from '../types';

interface SlackTriggerParameterDefinition extends TriggerParameterDefinition {
  type: 'channel_ids' | 'boolean';
}

const CHANNEL_FILTER_PARAM: SlackTriggerParameterDefinition = {
  id: 'channel_ids',
  label: 'Filter by channel',
  type: 'channel_ids',
};

const GROUP_THREAD_REPLIES_PARAM: SlackTriggerParameterDefinition = {
  id: 'group_thread_replies',
  label: 'Group thread replies',
  type: 'boolean',
};

export const SLACK_TRIGGER: TriggerDefinition = {
  type: 'slack',
  label: 'Slack',
  description: 'Trigger on channel messages',
  icon: 'slack',
  events: [
    { id: 'message', label: 'New message in channel', parameters: [CHANNEL_FILTER_PARAM, GROUP_THREAD_REPLIES_PARAM] },
  ],
};
