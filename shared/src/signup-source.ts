import { z } from 'zod';

export const SIGNUP_SOURCE_COOKIE = 'okidoki_source';
export const SIGNUP_SOURCE_ENDPOINT = '/v1/user/signup-source';
export const SIGNUP_SOURCE_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

const SOCIAL_NETWORKS = [
  { name: 'X', domains: ['x.com', 'twitter.com', 't.co'], sources: ['x', 'twitter'] },
  { name: 'LinkedIn', domains: ['linkedin.com', 'lnkd.in'], sources: ['linkedin'] },
  { name: 'Reddit/HN', domains: ['reddit.com', 'news.ycombinator.com'], sources: ['reddit', 'hackernews', 'hn'] },
  { name: 'YouTube', domains: ['youtube.com'], sources: ['youtube'] },
];

function findSocialNetwork(value: string | null | undefined) {
  const host = value?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (!host) return undefined;
  return SOCIAL_NETWORKS.find(({ domains, sources }) => sources.includes(host) || domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}

export const socialNetwork = (value: string | null | undefined) => findSocialNetwork(value)?.name;
export const socialNetworkSource = (value: string | null | undefined) => findSocialNetwork(value)?.sources[0];

export const HEARD_ABOUT_OPTIONS = [
  { value: 'google', label: 'Google search', channel: 'search' },
  { value: 'ai_chat', label: 'AI chat (ChatGPT, Claude, Perplexity)', channel: 'ai_search' },
  { value: 'x', label: 'X / Twitter', channel: 'social' },
  { value: 'linkedin', label: 'LinkedIn', channel: 'social' },
  { value: 'friend', label: 'Friend or colleague', channel: 'referral' },
  { value: 'yc', label: 'YC', channel: 'yc' },
  { value: 'event', label: 'Event', channel: 'events' },
  { value: 'from_us', label: 'Something from us', channel: 'outbound' },
  { value: 'other', label: 'Other', channel: 'other' },
] as const;

const sourceText = z.string().trim().min(1).max(255).optional();

const signupTouchSchema = z.object({
  utm_source: sourceText,
  utm_medium: sourceText,
  utm_campaign: sourceText,
  utm_content: sourceText,
  utm_term: sourceText,
  referrer: sourceText,
  landing_path: z.string().max(512),
  at: z.iso.datetime(),
});

export type SignupTouch = z.infer<typeof signupTouchSchema>;

export const signupSourceCookieSchema = z.object({ first: signupTouchSchema, last: signupTouchSchema });

export const signupTouchpointMetadataSchema = z.object({
  first_touch: signupTouchSchema.optional(),
  last_touch: signupTouchSchema.optional(),
  posthog_distinct_id: z.string().optional(),
});

export const initializeSignupRequestSchema = z.object({
  source: signupSourceCookieSchema.optional(),
  posthogDistinctId: z.string().max(255).optional(),
});

export type InitializeSignupRequest = z.infer<typeof initializeSignupRequestSchema>;

export const updateSignupSourceRequestSchema = z.object({
  heardAbout: z.enum(HEARD_ABOUT_OPTIONS.map((option) => option.value)),
  heardAboutOther: z.string().trim().min(1).max(255).optional(),
}).refine((body) => body.heardAbout !== 'other' || body.heardAboutOther, { message: 'Tell us where you heard about Okidoki', path: ['heardAboutOther'] });

export type UpdateSignupSourceRequest = z.infer<typeof updateSignupSourceRequestSchema>;

export const HEARD_ABOUT_SKIPPED = 'skipped';

export type UserSignupSource = z.infer<typeof signupTouchpointMetadataSchema> & {
  heard_about: string | null;
  heard_about_other?: string;
};

export function describeSignupTouch(touch: SignupTouch): string {
  return [touch.utm_source, touch.utm_medium, touch.utm_campaign].filter(Boolean).join(' / ') || touch.referrer || 'Direct';
}
