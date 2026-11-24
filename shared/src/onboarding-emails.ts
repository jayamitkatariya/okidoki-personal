export const EMAIL_KEYS = [
  'welcome',
  'no_repo_24h',
  'first_pr_merged',
  'day_5_shipped',
  'day_7_solo',
  'day_14_no_pr',
] as const;

export type EmailKey = (typeof EMAIL_KEYS)[number];

export const MANUAL_EMAIL_TEMPLATE_KEYS = ['product_update'] as const;
export const EMAIL_TEMPLATE_KEYS = [...EMAIL_KEYS, ...MANUAL_EMAIL_TEMPLATE_KEYS] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailTemplatePreview extends RenderedEmail {
  key: EmailTemplateKey;
}

export interface SentEventRecord {
  [key: string]: unknown;
  sent_at?: string;
  resend_id?: string;
  slack_pending_at?: string;
  slack_attempted_at?: string;
  slack_referrer?: string;
  slack_sent_at?: string;
  slack_ts?: string | null;
  skipped?: boolean;
  skipped_reason?: string;
}

export type SentEvents = Partial<Record<EmailKey, SentEventRecord>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseSentEvents(value: unknown): SentEvents {
  if (!isRecord(value)) return {};

  const sentEvents: SentEvents = {};
  for (const key of EMAIL_KEYS) {
    const event = value[key];
    if (!isRecord(event)) continue;

    const {
      sent_at,
      resend_id,
      slack_pending_at,
      slack_attempted_at,
      slack_referrer,
      slack_sent_at,
      slack_ts,
      skipped,
      skipped_reason,
      ...rest
    } = event;
    sentEvents[key] = {
      ...rest,
      ...(typeof sent_at === 'string' && { sent_at }),
      ...(typeof resend_id === 'string' && { resend_id }),
      ...(typeof slack_pending_at === 'string' && { slack_pending_at }),
      ...(typeof slack_attempted_at === 'string' && { slack_attempted_at }),
      ...(typeof slack_referrer === 'string' && { slack_referrer }),
      ...(typeof slack_sent_at === 'string' && { slack_sent_at }),
      ...((typeof slack_ts === 'string' || slack_ts === null) && { slack_ts }),
      ...(typeof skipped === 'boolean' && { skipped }),
      ...(typeof skipped_reason === 'string' && { skipped_reason }),
    };
  }
  return sentEvents;
}

export interface OnboardingEmailEnrollment {
  id: string;
  user_id: string;
  email: string;
  organization_id: string;
  enrolled_at: string;
  unsubscribed_at: string | null;
  unsubscribe_token: string;
  sent_events: SentEvents;
}
