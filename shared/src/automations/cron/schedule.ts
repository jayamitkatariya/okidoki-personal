export const SCHEDULE_INTERVAL_HOURS = [1, 2, 3, 4, 6];
export const LAST_DAY_OF_MONTH = 'L';

export type RepeatSchedule =
  | { kind: 'weekly'; days: number[]; hour: number; minute: number; every: number | null; lastHour: number }
  | { kind: 'monthly'; day: number | typeof LAST_DAY_OF_MONTH; hour: number; minute: number };

function formatCronDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return '*';
  const items: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let end = i;
    while (sorted[end + 1] === sorted[end] + 1) end++;
    if (end - i >= 2) {
      items.push(`${sorted[i]}-${sorted[end]}`);
      i = end;
    } else {
      items.push(String(sorted[i]));
    }
  }
  return items.join(',');
}

export function expandCronField(value: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const item of value.split(',')) {
    const match = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!match) return null;
    const start = match[1] === '*' ? min : Number(match[2]);
    const end = match[1] === '*' || match[4] !== undefined && match[3] === undefined ? max : Number(match[3] ?? match[2]);
    const step = Number(match[4] ?? 1);
    if (start < min || end > max || start > end || step < 1) return null;
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return [...values].sort((a, b) => a - b);
}

export function buildCronSchedule(schedule: RepeatSchedule): string {
  if (schedule.kind === 'monthly') return `${schedule.minute} ${schedule.hour} ${schedule.day} * *`;
  const { hour, lastHour, every } = schedule;
  const hours = every === null || lastHour === hour
    ? String(hour)
    : hour === 0 && lastHour + every > 23
      ? every === 1 ? '*' : `*/${every}`
      : `${hour}-${lastHour}${every === 1 ? '' : `/${every}`}`;
  return `${schedule.minute} ${hours} * * ${formatCronDays(schedule.days)}`;
}

export function parseCronSchedule(expression: string): RepeatSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, domField, monthField, dowField] = parts;
  if (monthField !== '*' || !/^\d+$/.test(minuteField) || Number(minuteField) > 59) return null;
  const minute = Number(minuteField);

  if (domField !== '*') {
    if (dowField !== '*' || !/^\d+$/.test(hourField) || Number(hourField) > 23) return null;
    const day = domField === LAST_DAY_OF_MONTH ? LAST_DAY_OF_MONTH : /^\d+$/.test(domField) && Number(domField) >= 1 && Number(domField) <= 28 ? Number(domField) : null;
    return day === null ? null : { kind: 'monthly', day, hour: Number(hourField), minute };
  }

  const days = expandCronField(dowField, 0, 7);
  if (!days) return null;
  const weekdays = [...new Set(days.map((d) => d % 7))];

  if (/^\d+$/.test(hourField)) {
    const hour = Number(hourField);
    return hour > 23 ? null : { kind: 'weekly', days: weekdays, hour, minute, every: null, lastHour: hour };
  }
  const match = hourField.match(/^(?:\*|(\d+)-(\d+))(?:\/(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1] ?? 0);
  const end = Number(match[2] ?? 23);
  const every = Number(match[3] ?? 1);
  if (end > 23 || start > end || !SCHEDULE_INTERVAL_HOURS.includes(every)) return null;
  return { kind: 'weekly', days: weekdays, hour: start, minute, every, lastHour: start + Math.floor((end - start) / every) * every };
}
