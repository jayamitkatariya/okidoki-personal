import type { TriggerDefinition } from '../types';

export const CRON_TRIGGER: TriggerDefinition = {
  type: 'cron',
  label: 'Schedule',
  description: 'Run once or on a recurring schedule',
  icon: 'clock',
};

export { describeCronSchedule, describeCronInBrowserTimezone, isSameTimezone, ordinal } from './format';
export { SCHEDULE_INTERVAL_HOURS, LAST_DAY_OF_MONTH, buildCronSchedule, parseCronSchedule, type RepeatSchedule } from './schedule';
export * from './draft';
export * from './timezones';
