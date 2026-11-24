import { z } from 'zod';
import { UUID_RE } from '../uuid';
import type { AutomationTrigger } from './types';
import { REVIEW_REQUESTED_EVENT } from './github';
import { LINEAR_ISSUE_MATCHED_EVENT, LINEAR_STATE_TYPES, linearIssueFiltersSchema } from './linear';

export function getReviewerLoginsError(event: string, logins: string[] | undefined): string | null {
  const isReviewRequested = event === REVIEW_REQUESTED_EVENT;
  if (isReviewRequested === !!logins?.some((login) => login.trim().replace(/^@+/, ''))) return null;
  return isReviewRequested
    ? 'The PR review requested trigger needs at least one GitHub username'
    : 'Requested reviewers only apply to the PR review requested trigger';
}

const repositoryTriggerConfigSchema = z.object({
  event: z.string(),
  repository_ids: z.array(z.string().regex(UUID_RE, 'must be a repository id')).optional(),
  group_pr_events: z.boolean().optional(),
  excluded_actors: z.array(z.string()).optional(),
  reviewer_logins: z.array(z.string()).optional(),
});

export const cronTriggerSchema = z.object({ type: z.literal('cron'), config: z.object({ schedule: z.string(), timezone: z.string().optional() }) });
export const githubTriggerSchema = z.object({
  type: z.literal('github'),
  config: repositoryTriggerConfigSchema.superRefine((config, ctx) => {
    const message = getReviewerLoginsError(config.event, config.reviewer_logins);
    if (message) ctx.addIssue({ code: 'custom', message, path: ['reviewer_logins'] });
  }),
});
export const gitlabTriggerSchema = z.object({ type: z.literal('gitlab'), config: repositoryTriggerConfigSchema });

export const linearTriggerConfigSchema = linearIssueFiltersSchema.extend({
  event: z.string(),
  team_ids: z.array(z.string()).optional(),
  state_types: z.array(z.enum(LINEAR_STATE_TYPES)).optional(),
}).superRefine((config, ctx) => {
  // Labels, projects and members belong to a team, so these filters pick one.
  if (config.event === LINEAR_ISSUE_MATCHED_EVENT && config.team_ids?.length !== 1) ctx.addIssue({ code: 'custom', message: 'The Linear issue matches trigger needs exactly one team', path: ['team_ids'] });
});

export const automationTriggerSchema = z.discriminatedUnion('type', [
  cronTriggerSchema,
  githubTriggerSchema,
  gitlabTriggerSchema,
  z.object({ type: z.literal('slack'), config: z.object({ event: z.string(), channel_ids: z.array(z.string()).optional(), group_thread_replies: z.boolean().optional() }) }),
  z.object({ type: z.literal('sentry'), config: z.object({ event: z.string(), project_slugs: z.array(z.string()).optional(), min_level: z.string().optional() }) }),
  z.object({ type: z.literal('linear'), config: linearTriggerConfigSchema }),
  z.object({ type: z.literal('custom'), config: z.object({}) }),
]) satisfies z.ZodType<AutomationTrigger>;
