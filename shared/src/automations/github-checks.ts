import { createErrorResult, createSuccessResult, type Result } from '../result';
import {
  AUTOMATION_GITHUB_CHECK_NAME_MAX_LENGTH,
  AUTOMATION_GITHUB_CHECK_NAMES_MAX,
  type AutomationTrigger,
} from './types';

/**
 * Restricted to the two conclusions a merge gate reads unambiguously. `neutral` and
 * `skipped` are deliberately absent: whether GitHub counts them as passing a *required*
 * check is exactly the ambiguity these checks exist to remove.
 */
export type AutomationCheckConclusion = 'success' | 'failure';

export const AUTOMATION_CHECK_CONCLUSIONS: AutomationCheckConclusion[] = ['success', 'failure'];

export function isAutomationCheckConclusion(value: unknown): value is AutomationCheckConclusion {
  return AUTOMATION_CHECK_CONCLUSIONS.some((conclusion) => conclusion === value);
}

export interface ReportAutomationCheckRequest {
  /**
   * The ownership token the dispatch was given for this check run. It names which
   * dispatch the verdict answers for, which the check run ID alone cannot: a workspace
   * reused for a follow-up event holds runs from more than one dispatch on the same
   * commit, and the server cannot otherwise tell a fresh verdict from a superseded one.
   */
  token: string;
  conclusion: AutomationCheckConclusion;
  title: string;
  summary?: string;
}

export interface ReportAutomationCheckResponse {
  /** False when a newer run has taken the check over and this verdict was discarded. */
  reported: boolean;
  name: string;
}

type AutomationGithubCheckNamesErrorCode =
  | 'invalid_type'
  | 'invalid_name'
  | 'too_many'
  | 'duplicate'
  | 'missing_trigger';

export function isAutomationGithubCheckEvent(event: string): boolean {
  return event === 'pull_request.opened' || event === 'pull_request.synchronize';
}

export function shouldCarryForwardAutomationGithubChecks(
  checkNames: string[],
  triggers: AutomationTrigger[],
): boolean {
  return checkNames.length > 0 &&
    triggers.some((trigger) =>
      trigger.type === 'github' && trigger.config.event === 'pull_request.opened') &&
    !triggers.some((trigger) =>
      trigger.type === 'github' && trigger.config.event === 'pull_request.synchronize');
}

export function normalizeAutomationGithubCheckNames(names: string[]): string[] {
  return names.map((name) => name.trim()).filter(Boolean);
}

export function validateAutomationGithubCheckNames(
  value: unknown,
  triggers: AutomationTrigger[],
): Result<string[], AutomationGithubCheckNamesErrorCode> {
  if (value === undefined) return createSuccessResult([]);
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    return createErrorResult({ code: 'invalid_type', message: 'github_check_names must be an array of strings' });
  }

  const names = normalizeAutomationGithubCheckNames(value);
  if (names.some((name) => name.length > AUTOMATION_GITHUB_CHECK_NAME_MAX_LENGTH || /[\r\n]/.test(name))) {
    return createErrorResult({
      code: 'invalid_name',
      message: `Check names must be a single line of ${AUTOMATION_GITHUB_CHECK_NAME_MAX_LENGTH} characters or fewer`,
    });
  }
  if (names.length > AUTOMATION_GITHUB_CHECK_NAMES_MAX) {
    return createErrorResult({
      code: 'too_many',
      message: `Add at most ${AUTOMATION_GITHUB_CHECK_NAMES_MAX} check names`,
    });
  }
  if (new Set(names).size !== names.length) {
    return createErrorResult({ code: 'duplicate', message: 'Check names must be unique' });
  }
  if (names.length > 0 && !triggers.some((trigger) => trigger.type === 'github' && isAutomationGithubCheckEvent(trigger.config.event))) {
    return createErrorResult({
      code: 'missing_trigger',
      message: 'Checks need a GitHub "PR opened" or "PR updated" trigger',
    });
  }
  return createSuccessResult(names);
}
