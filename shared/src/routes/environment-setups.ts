import { z } from 'zod';
import type { AutomationRecord, AutomationTrigger } from '../automations/types';
import { cronTriggerSchema, githubTriggerSchema, gitlabTriggerSchema } from '../automations/trigger-schemas';
import { formatList } from '../format';
import { isRecord } from '../type-guards';
import { UUID_RE } from '../uuid';
import type { EnvironmentHookRunKind } from './environment-hook-runs';
import type { EnvironmentRecord } from './environment';
import type { RepositoryRecord } from './repositories';
import type { WorkspaceRecord } from './workspaces';

export const ENVIRONMENT_SETUP_STEPS = [
  { key: 'understand', label: 'Understand the codebase' },
  { key: 'install', label: 'Install dependencies and run the app' },
  { key: 'verify', label: 'Verify checks and record a walkthrough' },
  { key: 'configure', label: 'Draft hooks, system prompt, and automations' },
  { key: 'propose', label: 'Propose the configuration for review' },
] as const;

type EnvironmentSetupStepKey = (typeof ENVIRONMENT_SETUP_STEPS)[number]['key'];

export const ENVIRONMENT_SETUP_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export type EnvironmentSetupStepStatus = (typeof ENVIRONMENT_SETUP_STEP_STATUSES)[number];
export type EnvironmentSetupSteps = Partial<Record<EnvironmentSetupStepKey, EnvironmentSetupStepStatus>>;

export function isEnvironmentSetupStepKey(value: unknown): value is EnvironmentSetupStepKey {
  return ENVIRONMENT_SETUP_STEPS.some((step) => step.key === value);
}

export function isEnvironmentSetupStepStatus(value: unknown): value is EnvironmentSetupStepStatus {
  return ENVIRONMENT_SETUP_STEP_STATUSES.some((status) => status === value);
}

const ENVIRONMENT_SETUP_RUN_STATUSES = ['running', 'proposed', 'applied', 'failed', 'cancelled', 'expired'] as const;
export type EnvironmentSetupRunStatus = (typeof ENVIRONMENT_SETUP_RUN_STATUSES)[number];
export type EnvironmentSetupStoppedOutcome = Exclude<EnvironmentSetupRunStatus, 'running' | 'proposed' | 'applied'>;

const ENVIRONMENT_SETUP_AUTOMATION_ACTIONS = ['create', 'update', 'keep', 'disable'] as const;
export type EnvironmentSetupAutomationAction = (typeof ENVIRONMENT_SETUP_AUTOMATION_ACTIONS)[number];

const ENVIRONMENT_SETUP_VERIFICATION_STATUSES = ['passed', 'failed', 'skipped'] as const;
export type EnvironmentSetupVerificationStatus = (typeof ENVIRONMENT_SETUP_VERIFICATION_STATUSES)[number];

export const ENVIRONMENT_SETUP_LIMITS = {
  summaryChars: 600,
  stackItems: 30,
  nameChars: 120,
  descriptionChars: 1_000,
  systemPromptChars: 20_000,
  hookChars: 50_000,
  variables: 50,
  variableKeyChars: 128,
  variableDescriptionChars: 500,
  automations: 8,
  automationKeyChars: 80,
  automationPromptChars: 10_000,
  automationTriggers: 5,
  automationNoteChars: 300,
  verificationItems: 8,
  verificationDetailChars: 300,
  mediaItems: 8,
  repositories: 20,
};

type EnvironmentSetupLimits = Partial<typeof ENVIRONMENT_SETUP_LIMITS>;

export const VARIABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const text = (max?: number) => (max === undefined ? z.string().trim() : z.string().trim().max(max));
const requiredText = (max?: number) => text(max).min(1, 'must not be empty');
const optionalText = (max?: number) => text(max).nullish().transform((value) => value || null);
// Omitted keeps the environment's current value; null or empty removes it.
const clearableText = (max?: number) => text(max).nullish().transform((value) => (value === undefined ? undefined : value || null));
const list = <T extends z.ZodType>(item: T, max?: number) => (max === undefined ? z.array(item) : z.array(item).max(max));

// Agents may only author these trigger families; other families (Slack, Sentry, custom webhook, ...)
// can only be carried over from the existing automation on keep, disable, and update entries.
export const ENVIRONMENT_SETUP_AUTHORED_TRIGGER_TYPES = ['cron', 'github', 'gitlab'] as const;
export function isEnvironmentSetupAuthoredTriggerType(type: string): boolean {
  return ENVIRONMENT_SETUP_AUTHORED_TRIGGER_TYPES.some((authored) => authored === type);
}
const proposalTriggerSchema: z.ZodType<AutomationTrigger> = z.discriminatedUnion('type', [cronTriggerSchema, githubTriggerSchema, gitlabTriggerSchema]);
const existingTriggerSchema = z.custom<AutomationTrigger>(
  (value) => isRecord(value) && typeof value.type === 'string' && isRecord(value.config),
  'must be an automation trigger',
);
const carriedTriggerSchema = existingTriggerSchema.refine(
  (trigger) => !isEnvironmentSetupAuthoredTriggerType(trigger.type),
);

// Keep and disable rows echo an existing automation, which has no size limits, so only agent-authored
// content (create/update) is held to the proposal limits and trigger families.
function automationSchema(limits: EnvironmentSetupLimits) {
  const authored = z.object({
    name: text(limits.nameChars),
    description: text(limits.descriptionChars),
    prompt: text(limits.automationPromptChars),
    triggers: list(proposalTriggerSchema, limits.automationTriggers),
  });
  const updated = authored.extend({ triggers: list(z.union([proposalTriggerSchema, carriedTriggerSchema]), limits.automationTriggers) });
  return z.object({
    key: requiredText(limits.automationKeyChars),
    action: z.enum(ENVIRONMENT_SETUP_AUTOMATION_ACTIONS).default('create'),
    automation_id: z.string().regex(UUID_RE, 'must be an automation id').nullable().default(null),
    name: text().default(''),
    description: optionalText().transform((value) => value ?? ''),
    prompt: text().default(''),
    triggers: list(existingTriggerSchema).default([]),
    note: optionalText(limits.automationNoteChars),
  }).superRefine((automation, ctx) => {
    if (automation.action === 'create' && automation.automation_id) {
      ctx.addIssue({ code: 'custom', path: ['automation_id'], message: 'belongs on an update, keep, or disable entry' });
    }
    if (automation.action !== 'create' && !automation.automation_id) {
      ctx.addIssue({ code: 'custom', path: ['automation_id'], message: 'must be the id of an automation attached to this environment' });
    }
    if (automation.action === 'create' || automation.action === 'update') {
      if (!automation.name) ctx.addIssue({ code: 'custom', path: ['name'], message: 'must not be empty' });
      if (!automation.prompt) ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'must not be empty' });
      if (automation.triggers.length === 0) ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'must not be empty' });
    }
  }).transform((automation, ctx) => {
    if (automation.action === 'keep' || automation.action === 'disable') return automation;
    const content = (automation.action === 'update' ? updated : authored).safeParse(automation);
    if (content.success) return { ...automation, ...content.data };
    for (const issue of content.error.issues) ctx.addIssue({ ...issue, code: 'custom' });
    return z.NEVER;
  });
}

// Every existing automation needs a decision, so only new automations count toward the limit.
function automationListSchema(limits: EnvironmentSetupLimits) {
  return list(automationSchema(limits)).default([]).superRefine((automations, ctx) => {
    if (new Set(automations.map((automation) => automation.key)).size !== automations.length) {
      ctx.addIssue({ code: 'custom', message: 'must have unique keys' });
    }
    const targets = automations.flatMap((automation) => automation.automation_id ?? []);
    if (new Set(targets).size !== targets.length) {
      ctx.addIssue({ code: 'custom', message: 'must mention each existing automation once' });
    }
    if (limits.automations !== undefined && automations.filter((automation) => automation.action === 'create').length > limits.automations) {
      ctx.addIssue({ code: 'custom', message: `must create at most ${limits.automations} new automations` });
    }
  });
}

function environmentSchema(limits: EnvironmentSetupLimits) {
  return z.object({
    name: optionalText(limits.nameChars).transform((value) => value ?? undefined),
    description: clearableText(limits.descriptionChars),
    system_prompt: clearableText(limits.systemPromptChars),
    start_hook: clearableText(limits.hookChars),
    warm_hook: clearableText(limits.hookChars),
  });
}

function proposalSchema(limits: EnvironmentSetupLimits) {
  return z.object({
    summary: requiredText(limits.summaryChars),
    stack: list(text(), limits.stackItems).default([]).transform((items) => items.filter(Boolean)),
    environment: environmentSchema(limits),
    variables: list(z.object({
      key: z.string().regex(VARIABLE_KEY_RE, 'must be a valid environment variable name').max(limits.variableKeyChars ?? Number.POSITIVE_INFINITY),
      description: optionalText(limits.variableDescriptionChars).transform((value) => value ?? ''),
      required: z.boolean().default(false),
    }), limits.variables).default([]),
    automations: automationListSchema(limits),
    verification: list(z.object({
      label: requiredText(limits.nameChars),
      status: z.enum(ENVIRONMENT_SETUP_VERIFICATION_STATUSES),
      detail: optionalText(limits.verificationDetailChars).transform((value) => value ?? undefined),
    }), limits.verificationItems).default([]),
    media: list(z.object({
      media_id: z.string().regex(UUID_RE, 'must be a media id'),
      title: requiredText(limits.nameChars),
    }), limits.mediaItems).default([]),
  });
}

// Stored proposals stay readable when submission limits are tightened, so only submissions carry the limits.
const environmentSetupProposalSchema = proposalSchema({});
export const environmentSetupProposalSubmissionSchema = proposalSchema(ENVIRONMENT_SETUP_LIMITS);

export type EnvironmentSetupProposal = z.infer<typeof environmentSetupProposalSchema>;
export type EnvironmentSetupAutomationProposal = EnvironmentSetupProposal['automations'][number];

export const environmentSetupRunStateSchema = z.object({
  status: z.enum(ENVIRONMENT_SETUP_RUN_STATUSES),
  steps: z.partialRecord(z.enum(ENVIRONMENT_SETUP_STEPS.map((step) => step.key)), z.enum(ENVIRONMENT_SETUP_STEP_STATUSES)).default({}),
  proposal: environmentSetupProposalSchema.nullable().default(null),
  applied: z.object({
    applied_at: z.string(),
    automation_ids: z.array(z.string()),
  }).nullable().default(null),
});

export interface EnvironmentSetupRunRecord extends z.infer<typeof environmentSetupRunStateSchema> {
  id: string;
  organization_id: string;
  environment_id: string;
  workspace_id: string;
  user_id: string | null;
  error: string | null;
  fix_hook_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export const applyEnvironmentSetupRequestSchema = z.object({
  environment: environmentSchema(ENVIRONMENT_SETUP_LIMITS).extend({ name: requiredText(ENVIRONMENT_SETUP_LIMITS.nameChars) }),
  variables: list(z.object({ key: z.string().regex(VARIABLE_KEY_RE), value: z.string() }), ENVIRONMENT_SETUP_LIMITS.variables)
    .default([])
    .refine((variables) => new Set(variables.map((variable) => variable.key)).size === variables.length, 'must have unique keys')
    .transform((variables) => variables.filter((variable) => variable.value.length > 0)),
  automations: automationListSchema(ENVIRONMENT_SETUP_LIMITS),
});

export type ApplyEnvironmentSetupRequest = z.infer<typeof applyEnvironmentSetupRequestSchema>;

interface EnvironmentSetupAutomationDraft {
  enabled: boolean;
  name: string;
  prompt: string;
}

interface EnvironmentSetupReviewDraft {
  name: string;
  description: string;
  systemPrompt: string;
  startHook: string;
  warmHook: string;
  variables: Record<string, string>;
  automations: Record<string, EnvironmentSetupAutomationDraft>;
}

export type EnvironmentSetupReviewField = 'name' | 'description' | 'systemPrompt' | 'startHook' | 'warmHook';

// Only what the user typed is stored, so a revised proposal from the agent fills in everything they did not touch.
export interface EnvironmentSetupReviewEdits {
  fields: Partial<Pick<EnvironmentSetupReviewDraft, EnvironmentSetupReviewField>>;
  variables: Record<string, string>;
  automations: Record<string, Partial<EnvironmentSetupAutomationDraft>>;
}

// Saving replaces the whole configuration, so a field the proposal omits falls back to what the environment has today; null clears it.
const proposedOrCurrent = (proposal: EnvironmentSetupProposal, field: 'description' | 'system_prompt' | 'start_hook' | 'warm_hook', current: string) => {
  const proposed = proposal.environment[field];
  return proposed === undefined ? current : proposed ?? '';
};

export function environmentSetupReviewDraft(
  proposal: EnvironmentSetupProposal,
  environment: EnvironmentRecord,
  current: { startHook: string; warmHook: string },
  edits: EnvironmentSetupReviewEdits,
): EnvironmentSetupReviewDraft {
  return {
    name: edits.fields.name ?? proposal.environment.name ?? environment.name,
    description: edits.fields.description ?? proposedOrCurrent(proposal, 'description', environment.description ?? ''),
    systemPrompt: edits.fields.systemPrompt ?? proposedOrCurrent(proposal, 'system_prompt', environment.system_prompt ?? ''),
    startHook: edits.fields.startHook ?? proposedOrCurrent(proposal, 'start_hook', current.startHook),
    warmHook: edits.fields.warmHook ?? proposedOrCurrent(proposal, 'warm_hook', current.warmHook),
    variables: edits.variables,
    automations: Object.fromEntries(proposal.automations.map((automation) => [
      automation.key,
      { enabled: true, name: automation.name, prompt: automation.prompt, ...edits.automations[automation.key] },
    ])),
  };
}

export const missingRequiredSetupVariables = (proposal: EnvironmentSetupProposal, draft: EnvironmentSetupReviewDraft, savedKeys: ReadonlySet<string>) =>
  proposal.variables.filter((variable) => variable.required && !savedKeys.has(variable.key) && !draft.variables[variable.key]?.trim());

export const selectedSetupAutomations = (proposal: EnvironmentSetupProposal, draft: EnvironmentSetupReviewDraft) =>
  proposal.automations.filter((automation) => automation.action !== 'keep' && draft.automations[automation.key]?.enabled);

export function environmentSetupApplyRequest(proposal: EnvironmentSetupProposal, draft: EnvironmentSetupReviewDraft): ApplyEnvironmentSetupRequest {
  return {
    environment: {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      system_prompt: draft.systemPrompt.trim() || null,
      start_hook: draft.startHook.trim() || null,
      warm_hook: draft.warmHook.trim() || null,
    },
    variables: proposal.variables
      .map((variable) => ({ key: variable.key, value: draft.variables[variable.key] ?? '' }))
      .filter((variable) => variable.value.length > 0),
    automations: selectedSetupAutomations(proposal, draft).map((automation) => ({
      ...automation,
      name: draft.automations[automation.key].name.trim() || automation.name,
      prompt: draft.automations[automation.key].prompt.trim() || automation.prompt,
      enabled: true,
    })),
  };
}

export function suggestEnvironmentSetupName(repositories: Array<{ name: string }>): string {
  return repositories.map((repository) => repository.name.split('/').pop() ?? repository.name).join(' + ');
}

export interface CreateEnvironmentSetupRequest {
  environment_id?: string;
  repository_ids?: string[];
  name?: string;
  fix?: { run_id: string };
}

export interface EnvironmentSetupFix {
  hook: EnvironmentHookRunKind;
  script: string | null;
  inheritedScript: string | null;
  log: string;
  exitCode: number | null;
  cause: string;
}

function describeFix(fix: EnvironmentSetupFix): string {
  const hook = `${fix.hook} hook`;
  const effect = fix.hook === 'warm'
    ? "so the environment's latest changes aren't reaching new workspaces"
    : 'in workspaces as they start';
  return `The ${hook} for this environment is failing ${effect}. Fix it first, then continue with the workflow below.

Likely cause: ${fix.cause}

Current ${hook}:
\`\`\`bash
${fix.script ?? '(not set)'}
\`\`\`
${fix.inheritedScript ? `
The ${hook}s of the environments this one builds on run before it, in the same log:
\`\`\`bash
${fix.inheritedScript}
\`\`\`

If the failure comes from one of those, don't work around it in this environment: tell the user what to change in that environment's ${hook} and stop.
` : ''}
End of the failing run's log${fix.exitCode === null ? '' : ` (exit code ${fix.exitCode})`}:
\`\`\`
${fix.log}
\`\`\`

Reproduce the failure in this workspace, fix the ${hook} (or what it depends on), run it cleanly from a fresh shell, and propose the corrected ${hook}.
`;
}

export interface CreateEnvironmentSetupResponse {
  run: EnvironmentSetupRunRecord;
  workspace: WorkspaceRecord;
  environment: EnvironmentRecord;
}

export interface GetEnvironmentSetupResponse {
  run: EnvironmentSetupRunRecord;
  environment: EnvironmentRecord;
  repositories: RepositoryRecord[];
}

export interface UpdateEnvironmentSetupStepsRequest {
  steps: EnvironmentSetupSteps;
}

export interface EnvironmentSetupRunResponse {
  run: EnvironmentSetupRunRecord;
}

export interface ApplyEnvironmentSetupResponse {
  run: EnvironmentSetupRunRecord;
  environment: EnvironmentRecord;
  automations: AutomationRecord[];
}

interface EnvironmentSetupExistingConfiguration {
  startHook: boolean;
  warmHook: boolean;
  systemPrompt: boolean;
  variableKeys: string[];
  automationNames: string[];
}

function describeExistingConfiguration(existing: EnvironmentSetupExistingConfiguration): string | null {
  const parts = [
    existing.startHook && 'a start hook',
    existing.warmHook && 'a warm hook',
    existing.systemPrompt && 'a system prompt',
    existing.variableKeys.length > 0 && `${existing.variableKeys.length} variable${existing.variableKeys.length === 1 ? '' : 's'} (${existing.variableKeys.join(', ')})`,
    existing.automationNames.length > 0 && `${existing.automationNames.length} automation${existing.automationNames.length === 1 ? '' : 's'} (${existing.automationNames.join(', ')})`,
  ].filter((part): part is string => typeof part === 'string');
  if (parts.length === 0) return null;
  return `This environment is already configured: it has ${formatList(parts)}. Treat this as an improvement pass. Read the current configuration before changing anything, keep what works, and change only what you can justify from what you find. List every existing automation in the proposal with a decision to keep, update, or disable it, and say why.`;
}

export function buildEnvironmentSetupPrompt(params: {
  environmentName: string;
  repositories: Array<{ name: string; defaultBranch: string }>;
  existing: EnvironmentSetupExistingConfiguration;
  fix?: EnvironmentSetupFix;
}): string {
  const repositories = params.repositories
    .map((repo) => `- ${repo.name} (default branch \`${repo.defaultBranch}\`)`)
    .join('\n');
  const existing = describeExistingConfiguration(params.existing);
  return `${params.fix ? `${describeFix(params.fix)}\n` : ''}Set up the Okidoki environment "${params.environmentName}" so background agents can run, test, verify, and demo changes in this codebase like an engineer would.

Follow the "Environment setup" workflow in the okidoki-agent skill (\`references/ENVIRONMENT-SETUP.md\`) end to end:
1. Understand the codebase: README, agent instructions, manifests, tool versions, CI, and recent pull requests and commits. As soon as you know which secrets the app needs, ask for them with \`okidoki environment vars request <KEY>... --no-wait\` and keep working; wait for a value only at the point you actually need it.
2. Install dependencies and run the application in this workspace.
3. Verify it works: run the canonical checks, exercise a real user flow in the browser, and record a short walkthrough video.
4. Draft the environment configuration (start hook, warm hook, system prompt, required variables) and propose automations that fit this repository, building on any that already exist.
5. Submit everything with \`okidoki environment-setup propose\` and finish with the summary message the workflow describes.

Report progress with \`okidoki environment-setup step\` as you go. Do not apply configuration yourself: the proposal is reviewed, edited, and saved by the user in the Environment panel next to this chat.
${existing ? `\n${existing}\n` : ''}
${repositories ? `Repositories in this environment:\n${repositories}` : 'This environment has no repositories.'}`;
}
