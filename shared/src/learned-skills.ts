import { z } from 'zod';
import { parseFrontmatter } from './frontmatter';
import { createErrorResult, createSuccessResult, type Result } from './result';
import { SANDBOX_PATHS } from './sandbox';

export const LEARNED_SKILLS_ROOT = `${SANDBOX_PATHS.OKIDOKI_DIR}/learned-skills`;
export const LEARNED_SKILLS_MANIFEST_PATH = `${LEARNED_SKILLS_ROOT}/manifest.json`;
/** Namespaces installed skill directories so stale ones can be removed without touching other skills. */
export const LEARNED_SKILL_DIR_PREFIX = 'okidoki-learned__';
export const MAX_LEARNED_SKILLS = 50;
export const MAX_LEARNED_SKILL_DESCRIPTION_CHARS = 500;
export const MAX_LEARNED_SKILL_CONTENT_CHARS = 20_000;
export const MAX_LEARNED_SKILL_TITLE_CHARS = 80;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_CHARS = 64;
export const isValidLearnedSkillName = (name: string) => NAME_RE.test(name) && name.length <= MAX_NAME_CHARS;

export const learnedSkillsManifestSchema = z.object({
  skills: z.array(z.object({ name: z.string(), sha256: z.string() })),
});
export type LearnedSkillsManifest = z.infer<typeof learnedSkillsManifestSchema>;

export const LEARNED_SKILL_SUGGESTION_STATUSES = ['pending', 'accepted', 'dismissed', 'restored'] as const;
export type LearnedSkillSuggestionStatus = typeof LEARNED_SKILL_SUGGESTION_STATUSES[number];
export const LEARNED_SKILL_SUGGESTION_KINDS = ['save', 'delete'] as const;

export interface LearnedSkill {
  id: string;
  name: string;
  title: string;
  description: string;
  content: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearnedSkillSuggestion {
  id: string;
  name: string;
  description: string;
  title: string;
  content: string;
  kind: typeof LEARNED_SKILL_SUGGESTION_KINDS[number];
  status: LearnedSkillSuggestionStatus;
  workspaceId: string | null;
  suggestedBy: string | null;
  existingContent: string | null;
  createdAt: string;
}

export const DREAM_ACTION_KINDS = ['create', 'update', 'merge', 'delete'] as const;
export type DreamActionKind = typeof DREAM_ACTION_KINDS[number];
const dreamVerdictChecksSchema = z.object({
  repeatable: z.boolean(),
  realInstruction: z.boolean(),
  noContradiction: z.boolean(),
  formatExact: z.boolean(),
  humanOnly: z.boolean(),
  actionable: z.boolean(),
  durable: z.boolean(),
});
export const DREAM_VERDICT_CHECKS = dreamVerdictChecksSchema.keyof().options;
export const dreamVerdictSchema = dreamVerdictChecksSchema.extend({ approve: z.boolean(), reason: z.string() });
export type DreamVerdict = z.infer<typeof dreamVerdictSchema>;
export type SaveLearnedSkillResponse = Pick<LearnedSkill, 'id' | 'name'>;

export interface LearnedSkillChange {
  id: string;
  kind: DreamActionKind;
  skillName: string;
  targets: string[];
  title: string | null;
  content: string | null;
  reverted: boolean;
  quotes: string[];
  createdAt: string;
}

export interface ListLearnedSkillsResponse {
  skills: LearnedSkill[];
  suggestions: LearnedSkillSuggestion[];
  changes: LearnedSkillChange[];
}

export type PendingLearnedSkillSuggestion = Pick<LearnedSkillSuggestion, 'id' | 'title' | 'description'>;

export interface ListPendingLearnedSkillSuggestionsResponse {
  suggestions: PendingLearnedSkillSuggestion[];
}

export interface LearnedSkillSuggestionResponse {
  suggestion: LearnedSkillSuggestion;
}

export interface LearnedSkillContentRequest {
  title: string;
  content: string;
}

export interface LearnedSkillRemovalRequest {
  remove: string;
}

/** The reviewer confirms the kind they saw, so a pending suggestion replaced by the other kind is never accepted unseen. */
export type AcceptLearnedSkillSuggestionRequest = LearnedSkillContentRequest & { remove?: boolean };

export interface CreateLearnedSkillSuggestionResponse {
  id: string;
  name: string;
  update: boolean;
}

export function parseLearnedSkillContent(content: string): Result<{ name: string; description: string }> {
  if (content.length > MAX_LEARNED_SKILL_CONTENT_CHARS) {
    return createErrorResult({ message: `SKILL.md must be at most ${MAX_LEARNED_SKILL_CONTENT_CHARS} characters` });
  }
  const { name, description } = parseFrontmatter(content);
  if (!name || !isValidLearnedSkillName(name)) {
    return createErrorResult({
      message: `SKILL.md frontmatter needs a name of lowercase letters, digits, and hyphens (at most ${MAX_NAME_CHARS} characters)`,
    });
  }
  if (!description) {
    return createErrorResult({ message: 'SKILL.md frontmatter needs a description saying when to use the skill' });
  }
  if (description.length > MAX_LEARNED_SKILL_DESCRIPTION_CHARS) {
    return createErrorResult({
      message: `The description must be at most ${MAX_LEARNED_SKILL_DESCRIPTION_CHARS} characters`,
    });
  }
  return createSuccessResult({ name, description });
}

export function parseLearnedSkillTitle(value: unknown): Result<string> {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) return createErrorResult({ message: 'A title is required, e.g. "Always use Conventional Commits"' });
  if (title.length > MAX_LEARNED_SKILL_TITLE_CHARS) {
    return createErrorResult({ message: `The title must be at most ${MAX_LEARNED_SKILL_TITLE_CHARS} characters` });
  }
  return createSuccessResult(title);
}

export const learnedSkillFormatInstruction = (speaker: string) =>
  `Write a SKILL.md whose frontmatter has a kebab-case \`name\` and a short \`description\` that starts with "Use when" and names the situations it applies to; the body records only what ${speaker} actually said, restated as a direct instruction, usually one to three lines. Every line of a learning is loaded into future sessions, so leave out anything an agent could infer on its own: no headings, explanations, rules, or examples unless ${speaker} stated those specifics themselves. For "from now on, use Conventional Commits", the body is just "Use Conventional Commits for every commit message and PR title."`;
