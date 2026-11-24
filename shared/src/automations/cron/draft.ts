import type { CronTriggerConfig } from '../types';
import { LAST_DAY_OF_MONTH, buildCronSchedule, parseCronSchedule } from './schedule';

type ScheduleMode = 'weekly' | 'monthly' | 'once' | 'cron';

export const SCHEDULE_MODES: { value: ScheduleMode; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'once', label: 'Once' },
  { value: 'cron', label: 'Cron' },
];

export const SCHEDULE_WEEK = [1, 2, 3, 4, 5, 6, 0];
export const SCHEDULE_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const SCHEDULE_MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

export interface ScheduleDraft {
  mode: ScheduleMode;
  days: number[];
  time: string;
  every: number | null;
  lastHour: number;
  monthDay: number | typeof LAST_DAY_OF_MONTH;
  date: string;
  cron: string;
  timezone: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const toScheduleTime = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
export const toScheduleDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const splitScheduleTime = (time: string) => time.split(':').map(Number);
const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function snapLastHour(start: number, every: number, target: number): number {
  const latest = start + Math.floor((23 - start) / every) * every;
  return Math.min(latest, Math.max(start + every, start + Math.floor((target - start) / every) * every));
}

export function initialScheduleDraft(config: CronTriggerConfig | undefined): ScheduleDraft {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const draft: ScheduleDraft = {
    mode: 'weekly',
    days: [1, 2, 3, 4, 5],
    time: '09:00',
    every: null,
    lastHour: 17,
    monthDay: 1,
    date: toScheduleDate(tomorrow),
    cron: '',
    timezone: config?.timezone || deviceTimezone(),
  };
  if (config?.run_at) {
    const runAt = new Date(config.run_at);
    return { ...draft, mode: 'once', date: toScheduleDate(runAt), time: toScheduleTime(runAt.getHours(), runAt.getMinutes()) };
  }
  if (!config?.schedule) return draft;
  const parsed = parseCronSchedule(config.schedule);
  if (!parsed) return { ...draft, mode: 'cron', cron: config.schedule };
  const time = toScheduleTime(parsed.hour, parsed.minute);
  return parsed.kind === 'monthly'
    ? { ...draft, mode: 'monthly', monthDay: parsed.day, time, cron: config.schedule }
    : { ...draft, days: parsed.days, time, every: parsed.every, lastHour: parsed.every ? parsed.lastHour : draft.lastHour, cron: config.schedule };
}

function buildSchedule(draft: ScheduleDraft): string {
  const [hour, minute] = splitScheduleTime(draft.time);
  if (draft.mode === 'monthly') return buildCronSchedule({ kind: 'monthly', day: draft.monthDay, hour, minute });
  if (draft.mode === 'cron') return draft.cron.trim();
  return buildCronSchedule({ kind: 'weekly', days: draft.days, hour, minute, every: draft.every, lastHour: draft.every ? draft.lastHour : hour });
}

export function scheduleDraftConfig(draft: ScheduleDraft): CronTriggerConfig {
  if (draft.mode !== 'once') return { schedule: buildSchedule(draft), timezone: draft.timezone };
  const [year, month, day] = draft.date.split('-').map(Number);
  const [hour, minute] = splitScheduleTime(draft.time);
  return { run_at: new Date(year, month - 1, day, hour, minute).toISOString(), timezone: deviceTimezone() };
}

export function scheduleUntilHours(draft: ScheduleDraft): number[] {
  const [startHour] = splitScheduleTime(draft.time);
  const every = draft.every;
  return every ? Array.from({ length: Math.floor((23 - startHour) / every) + 1 }, (_, i) => startHour + i * every) : [];
}

export function switchScheduleMode(draft: ScheduleDraft, mode: ScheduleMode): Partial<ScheduleDraft> {
  if (mode === 'cron') return { mode, cron: draft.mode === 'once' && draft.cron ? draft.cron : buildSchedule(draft) };
  if (draft.mode !== 'cron') return { mode };
  const parsed = parseCronSchedule(draft.cron);
  if (!parsed) return { mode };
  const time = toScheduleTime(parsed.hour, parsed.minute);
  return parsed.kind === 'monthly'
    ? { mode, monthDay: parsed.day, time }
    : { mode, days: parsed.days, time, every: parsed.every, lastHour: parsed.every ? parsed.lastHour : draft.lastHour };
}

export function setScheduleEvery(draft: ScheduleDraft, every: number | null): Partial<ScheduleDraft> {
  const [startHour] = splitScheduleTime(draft.time);
  return { every, lastHour: every ? snapLastHour(startHour, every, draft.lastHour) : draft.lastHour };
}

export function setScheduleStart(draft: ScheduleDraft, time: string): Partial<ScheduleDraft> {
  const [hour] = splitScheduleTime(time);
  return { time, lastHour: draft.every ? snapLastHour(hour, draft.every, draft.lastHour) : draft.lastHour };
}
