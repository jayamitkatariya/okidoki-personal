import type { GetTermsAcceptanceResponse } from './routes/user';

const TERMS_RECENT_UPDATE_DATE = '2026-10-25T04:50:00.000Z';

export function formatLegalUpdateDate(date = TERMS_RECENT_UPDATE_DATE): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(date));
}

export function requiresTermsAcceptance(acceptance: GetTermsAcceptanceResponse | undefined): boolean {
  return !acceptance?.acceptedAt || Date.parse(acceptance.acceptedAt) < Date.parse(TERMS_RECENT_UPDATE_DATE);
}
