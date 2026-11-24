import type { TriggerDefinition } from '../types';

export const CUSTOM_TRIGGER: TriggerDefinition = {
  type: 'custom',
  label: 'Custom webhook',
  description: 'Trigger via a unique webhook URL with any JSON payload',
  icon: 'webhook',
};

export const buildAutomationWebhookUrl = (monolithUrl: string, token: string) => `${monolithUrl.replace(/\/$/, '')}/v1/automations/webhook/${token}`;
