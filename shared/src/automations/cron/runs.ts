import { CronExpressionParser } from 'cron-parser';
import { getTriggerUniqueKey } from '../registry';
import type { CronTriggerConfig } from '../types';
import { scheduleDraftConfig, type ScheduleDraft } from './draft';

export function listScheduleRuns(configs: CronTriggerConfig[], { from = new Date(), count = 1, until }: { from?: Date; count?: number; until?: Date } = {}): Date[] {
  const runs = new Map<number, Date>();
  for (const config of configs) {
    if (config.run_at) {
      const runAt = new Date(config.run_at);
      if (runAt > from && (!until || runAt <= until)) runs.set(runAt.getTime(), runAt);
    } else if (config.schedule) {
      const interval = CronExpressionParser.parse(config.schedule, { tz: config.timezone || 'UTC', currentDate: from, endDate: until });
      for (let i = 0; i < count && interval.hasNext(); i++) {
        const run = interval.next().toDate();
        runs.set(run.getTime(), run);
      }
    }
  }
  return [...runs.values()].sort((a, b) => a.getTime() - b.getTime()).slice(0, count);
}

export function checkScheduleDraft(draft: ScheduleDraft, takenKeys: Set<string>) {
  const config = scheduleDraftConfig(draft);
  let nextRuns: Date[] = [];
  let cronInvalid = false;
  try {
    nextRuns = listScheduleRuns([config], { count: 3 });
  } catch {
    cronInvalid = true;
  }
  const onceInPast = draft.mode === 'once' && nextRuns.length === 0;
  const duplicate = takenKeys.has(getTriggerUniqueKey({ type: 'cron', config }));
  return { config, nextRuns, cronInvalid, onceInPast, duplicate, valid: !cronInvalid && !onceInPast && !duplicate && (draft.mode !== 'cron' || Boolean(draft.cron.trim())) };
}
