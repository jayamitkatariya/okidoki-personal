import { listScheduleRuns } from './runs';
import { expandCronField, LAST_DAY_OF_MONTH } from './schedule';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface CronParts {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

function splitCronParts(schedule: string): CronParts | null {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

function formatTime(hour: number, minute: number): string {
  if (hour === 0 && minute === 0) return 'midnight';
  if (hour === 12 && minute === 0) return 'noon';
  const period = hour >= 12 ? 'PM' : 'AM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:${String(minute).padStart(2, '0')} ${period}`;
}

export function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

function joinList(items: string[]): string {
  return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function describeDays(days: number[]): { every: string; on: string } | null {
  const key = days.join(',');
  if (days.length === 7) return null;
  if (key === '1,2,3,4,5') return { every: 'Every weekday', on: 'weekdays' };
  if (key === '0,6') return { every: 'Every weekend', on: 'weekends' };
  if (days.length === 1) return { every: `Every ${WEEKDAY_NAMES[days[0]]}`, on: `${WEEKDAY_NAMES[days[0]]}s` };
  const short = days.map((d) => WEEKDAY_NAMES[d].slice(0, 3));
  const isRun = days.length > 2 && days[days.length - 1] - days[0] === days.length - 1;
  const label = isRun ? `${short[0]}–${short[short.length - 1]}` : short.join(', ');
  return { every: label, on: label };
}

/**
 * Return a natural-language description for a 5-field cron expression.
 * Returns the original expression if the pattern is not one we phrase.
 */
export function describeCronSchedule(schedule: string): string {
  const trimmed = schedule.trim();
  const parts = splitCronParts(trimmed);
  if (!parts || parts.month !== '*') return trimmed;

  if (parts.hour === '*' && parts.dom === '*' && parts.dow === '*') {
    if (parts.minute === '*') return 'Every minute';
    const step = parts.minute.match(/^\*\/(\d+)$/);
    if (step) return Number(step[1]) === 1 ? 'Every minute' : `Every ${Number(step[1])} minutes`;
  }

  if (!/^\d+$/.test(parts.minute) || Number(parts.minute) > 59) return trimmed;
  const minute = Number(parts.minute);
  const hours = expandCronField(parts.hour, 0, 23);
  const dowValues = expandCronField(parts.dow, 0, 7);
  if (!hours || !dowValues) return trimmed;
  const days = describeDays([...new Set(dowValues.map((d) => d % 7))].sort((a, b) => a - b));

  if (/[*-]/.test(parts.hour)) {
    if (parts.dom !== '*') return trimmed;
    const every = hours.length > 1 ? hours[1] - hours[0] : 1;
    if (hours.some((h, i) => i > 0 && h - hours[i - 1] !== every)) return trimmed;
    const allDay = hours[0] === 0 && 24 - hours[hours.length - 1] === every;
    const base = every === 1 ? 'Every hour' : `Every ${every} hours`;
    const window = allDay
      ? minute === 0 ? '' : ` at :${String(minute).padStart(2, '0')}`
      : ` from ${formatTime(hours[0], minute)} to ${formatTime(hours[hours.length - 1], minute)}`;
    return `${base}${window}${days ? ` on ${days.on}` : ''}`;
  }

  const times = `at ${joinList(hours.map((h) => formatTime(h, minute)))}`;
  if (parts.dom === '*') return `${days?.every ?? 'Every day'} ${times}`;
  if (parts.dow !== '*') return trimmed;
  if (parts.dom === LAST_DAY_OF_MONTH) return `On the last day of every month ${times}`;
  if (/^\d+$/.test(parts.dom) && Number(parts.dom) >= 1 && Number(parts.dom) <= 31) {
    return `On the ${ordinal(Number(parts.dom))} of every month ${times}`;
  }
  return trimmed;
}

// ---- timezone conversion ---------------------------------------------------

export interface LocalizedCronDescription {
  /** Natural-language description with hour/minute in the displayed timezone. */
  description: string;
  /** Short timezone abbreviation (e.g. "PDT", "UTC"). Empty when the schedule has no specific time. */
  timezoneAbbreviation: string;
  /** True if the displayed time is in the browser's timezone (vs the cron's source timezone). */
  isLocal: boolean;
}

function isWildcardOrStep(field: string): boolean {
  return field === '*' || /^\*\/\d+$/.test(field);
}

function getWallTimeInZone(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map(x => [x.type, x.value]));
  let hour = Number(p.hour);
  if (hour === 24) hour = 0;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour, minute: Number(p.minute) };
}

// Devices and engines name UTC differently (Hermes says "GMT", Android can report "Etc/UTC"), so every alias is one zone, called UTC.
const UTC_ALIAS = /^(Etc\/)?(UTC|UCT|GMT|Universal|Zulu|Greenwich)$/;

export const isSameTimezone = (a: string, b: string) => a === b || (UTC_ALIAS.test(a) && UTC_ALIAS.test(b));

function getShortTimezoneAbbreviation(timeZone: string, referenceDate: Date): string {
  if (UTC_ALIAS.test(timeZone)) return 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(referenceDate);
    return parts.find(p => p.type === 'timeZoneName')?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * Rewrite a cron schedule's hour/minute fields from `fromTz` into `toTz`.
 * Returns `null` when the rewrite isn't possible or isn't safe:
 *   - minute/hour aren't concrete integers
 *   - the conversion would shift the calendar date AND the schedule has a
 *     day-of-week or day-of-month constraint (we don't rewrite those fields)
 *   - timezone is invalid (Intl throws)
 */
function rewriteScheduleToTimezone(
  parts: CronParts,
  fromTz: string,
  toTz: string,
  referenceDate: Date,
): { schedule: string; at: Date } | null {
  if (!/^\d+$/.test(parts.minute) || !/^\d+$/.test(parts.hour)) return null;

  let run: Date | undefined;
  let toWall: ReturnType<typeof getWallTimeInZone>;
  let dayOffset: number;
  try {
    // Converted at the next run, not now: across a clock change the two zones' offsets differ, and that run is what "Next" shows.
    [run] = listScheduleRuns([{ schedule: [parts.minute, parts.hour, parts.dom, parts.month, parts.dow].join(' '), timezone: fromTz }], { from: referenceDate });
    if (!run) return null;
    if (fromTz === toTz) return { schedule: [parts.minute, parts.hour, parts.dom, parts.month, parts.dow].join(' '), at: run };
    const fromWall = getWallTimeInZone(run, fromTz);
    toWall = getWallTimeInZone(run, toTz);
    dayOffset = Math.round((Date.UTC(toWall.year, toWall.month - 1, toWall.day) - Date.UTC(fromWall.year, fromWall.month - 1, fromWall.day)) / 86400000);
  } catch {
    return null;
  }

  const hasDayConstraint = parts.dom !== '*' || parts.dow !== '*';
  if (dayOffset !== 0 && hasDayConstraint) return null;

  return { schedule: [String(toWall.minute), String(toWall.hour), parts.dom, parts.month, parts.dow].join(' '), at: run };
}

/**
 * Return a natural-language description of `schedule` with hour/minute
 * converted to `browserTimezone` when safe. Falls back to source-tz display
 * for weekly/monthly schedules whose calendar day would shift in the viewer's
 * timezone (the weekday/day-of-month field would mislabel otherwise).
 */
export function describeCronInBrowserTimezone(
  schedule: string,
  cronTimezone: string | undefined,
  browserTimezone: string,
  referenceDate: Date = new Date(),
): LocalizedCronDescription {
  const sourceTz = cronTimezone || 'UTC';
  const trimmed = schedule.trim();
  const parts = splitCronParts(trimmed);

  // Malformed cron, or no specific clock time (every-N-minutes / every-hour).
  if (!parts || isWildcardOrStep(parts.minute) || isWildcardOrStep(parts.hour)) {
    return { description: describeCronSchedule(trimmed), timezoneAbbreviation: '', isLocal: false };
  }

  const rewritten = rewriteScheduleToTimezone(parts, sourceTz, browserTimezone, referenceDate);
  if (!rewritten) {
    return {
      description: describeCronSchedule(trimmed),
      timezoneAbbreviation: getShortTimezoneAbbreviation(sourceTz, referenceDate),
      isLocal: sourceTz === browserTimezone,
    };
  }

  return {
    description: describeCronSchedule(rewritten.schedule),
    timezoneAbbreviation: getShortTimezoneAbbreviation(browserTimezone, rewritten.at),
    isLocal: true,
  };
}
