import type { TriggerDefinition, TriggerParameterDefinition } from '../types';

export const SENTRY_DEFAULT_EVENT = 'issue.created';

export const SENTRY_LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'] as const;
export type SentryLevel = (typeof SENTRY_LEVELS)[number];

interface SentryTriggerParameterDefinition extends TriggerParameterDefinition {
  type: 'project_slugs' | 'level';
}

const PROJECT_FILTER_PARAM: SentryTriggerParameterDefinition = {
  id: 'project_slugs',
  label: 'Filter by project',
  type: 'project_slugs',
};

const MIN_LEVEL_PARAM: SentryTriggerParameterDefinition = {
  id: 'min_level',
  label: 'Minimum level',
  type: 'level',
};

export const SENTRY_TRIGGER: TriggerDefinition = {
  type: 'sentry',
  label: 'Sentry',
  description: 'Trigger on Sentry errors and alerts',
  icon: 'sentry',
  events: [
    { id: 'event_alert.triggered', label: 'Issue alert fired', parameters: [PROJECT_FILTER_PARAM] },
    { id: SENTRY_DEFAULT_EVENT, label: 'New issue created', parameters: [PROJECT_FILTER_PARAM, MIN_LEVEL_PARAM] },
    { id: 'error.created', label: 'New error event', parameters: [PROJECT_FILTER_PARAM, MIN_LEVEL_PARAM] },
  ],
};
