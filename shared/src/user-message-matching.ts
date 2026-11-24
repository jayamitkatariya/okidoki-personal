import { USER_MESSAGE_MATCH_GRACE_PERIOD_MS } from './display-message/constants';

interface UserMessageMatchCandidate {
  content: string;
  timestamp: string | number;
}

const parsedTimestamps = new Map<string, number>();

export function parseTimestampMs(timestamp: string | number): number {
  if (typeof timestamp === 'number') return Number.isFinite(timestamp) ? timestamp : 0;
  let value = parsedTimestamps.get(timestamp);
  if (value === undefined) {
    const parsed = Date.parse(timestamp);
    value = Number.isFinite(parsed) ? parsed : 0;
    if (parsedTimestamps.size >= 50_000) parsedTimestamps.clear();
    parsedTimestamps.set(timestamp, value);
  }
  return value;
}

export function areUserMessagesWithinMatchWindow(
  a: UserMessageMatchCandidate,
  b: UserMessageMatchCandidate,
): boolean {
  return a.content === b.content
    && Math.abs(parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp)) <= USER_MESSAGE_MATCH_GRACE_PERIOD_MS;
}
