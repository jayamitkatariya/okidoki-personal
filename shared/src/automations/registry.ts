import type {
  AutomationTrigger,
  AutomationTriggerType,
  EventTriggerType,
  TriggerDefinition,
  TriggerEventDefinition,
} from './types';
import { CRON_TRIGGER } from './cron';
import { GITHUB_TRIGGER, REVIEW_REQUESTED_EVENT } from './github';
import { GITLAB_TRIGGER } from './gitlab';
import { SLACK_TRIGGER } from './slack';
import { SENTRY_TRIGGER } from './sentry';
import { LINEAR_TRIGGER, type LinearStateType } from './linear';
import { CUSTOM_TRIGGER } from './custom';

/** Assembled trigger registry — import integrations and combine here. */
export const TRIGGER_REGISTRY: TriggerDefinition[] = [
  CRON_TRIGGER,
  GITHUB_TRIGGER,
  GITLAB_TRIGGER,
  SLACK_TRIGGER,
  SENTRY_TRIGGER,
  LINEAR_TRIGGER,
  CUSTOM_TRIGGER,
];

/** Look up an integration definition by type. */
export function getTriggerDefinition(type: string): TriggerDefinition | undefined {
  return TRIGGER_REGISTRY.find(t => t.type === type);
}

/** Look up a specific event definition within an integration. */
export function getTriggerEvent(type: string, eventId: string): TriggerEventDefinition | undefined {
  return getTriggerDefinition(type)?.events?.find(e => e.id === eventId);
}

/** Get a human-readable label for a specific event. */
export function getTriggerEventLabel(type: string, eventId: string): string {
  return getTriggerEvent(type, eventId)?.label ?? eventId;
}

/** Get a human-readable label for an integration. */
export function getTriggerLabel(type: string): string {
  return getTriggerDefinition(type)?.label ?? type;
}

export function getDominantTriggerType(triggers: AutomationTrigger[]): AutomationTriggerType | null {
  const counts = new Map<AutomationTriggerType, number>();
  for (const trigger of triggers) counts.set(trigger.type, (counts.get(trigger.type) ?? 0) + 1);
  return triggers.reduce<AutomationTriggerType | null>((best, trigger) => (best === null || (counts.get(trigger.type) ?? 0) > (counts.get(best) ?? 0) ? trigger.type : best), null);
}

/**
 * Build a trigger key from its parts. Use this when you only have a type
 * and optional event id (e.g. the editor checking whether a specific event
 * is already attached). Call sites that have a full trigger should use
 * `getTriggerUniqueKey` — both routes must produce identical keys.
 */
export function makeTriggerKey(type: string, event?: string | null): string {
  return event ? `${type}:${event}` : type;
}

/**
 * Unique key identifying a trigger's event for duplicate detection.
 *
 * Two triggers are duplicates iff they share the same key. Integrations whose
 * config carries an `event` field (like GitHub) key on `type:event`; schedules
 * key on their timing; other integrations key on type alone. New event-based
 * integrations get correct per-event dedup for free by following the
 * convention of placing the event id in `config.event`.
 */
export function getTriggerUniqueKey(trigger: AutomationTrigger): string {
  if (trigger.type === 'cron') {
    return makeTriggerKey('cron', `${trigger.config.schedule ?? trigger.config.run_at}@${trigger.config.timezone || 'UTC'}`);
  }
  const config = trigger.config as unknown as Record<string, unknown> | undefined;
  const event = typeof config?.event === 'string' ? config.event : null;
  return makeTriggerKey(trigger.type, event);
}

/** Human-readable label for a trigger instance (integration + event). */
export function describeTrigger(trigger: AutomationTrigger): string {
  const config = trigger.config as unknown as Record<string, unknown> | undefined;
  const event = typeof config?.event === 'string' ? config.event : null;
  const typeLabel = getTriggerLabel(trigger.type);
  if (!event) return typeLabel;
  const eventLabel = getTriggerEventLabel(trigger.type, event);
  return `${typeLabel} ${eventLabel}`;
}

/**
 * Return the first duplicate trigger found in the array, or null if none.
 *
 * Duplication is defined by `getTriggerUniqueKey` — e.g. two GitHub triggers
 * for different events are allowed, but two for `pull_request.opened` are not.
 */
export function findDuplicateTrigger(
  triggers: AutomationTrigger[]
): { key: string; label: string } | null {
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const key = getTriggerUniqueKey(trigger);
    if (seen.has(key)) {
      return { key, label: describeTrigger(trigger) };
    }
    seen.add(key);
  }
  return null;
}

export function isTriggerTypeFullyUsed(type: AutomationTriggerType, triggers: AutomationTrigger[]): boolean {
  const used = new Set(triggers.map(getTriggerUniqueKey));
  const events = getTriggerDefinition(type)?.events;
  return events?.length ? events.every((event) => used.has(makeTriggerKey(type, event.id))) : used.has(makeTriggerKey(type));
}

export function buildEventTrigger({ type, event, ids, excludedActors, reviewerLogins, level, stateTypes = [] }: { type: EventTriggerType; event: string | null; ids: string[]; excludedActors: string[]; reviewerLogins: string[]; level: string | null; stateTypes?: LinearStateType[] }): AutomationTrigger | null {
  if (!event) return null;
  const filter = ids.length > 0 ? ids : undefined;
  const excluded_actors = excludedActors.length > 0 ? excludedActors : undefined;
  if (type === 'github') {
    if (event === REVIEW_REQUESTED_EVENT && reviewerLogins.length === 0) return null;
    return { type, config: { event, repository_ids: filter, excluded_actors, reviewer_logins: event === REVIEW_REQUESTED_EVENT ? reviewerLogins : undefined } };
  }
  if (type === 'gitlab') return { type, config: { event, repository_ids: filter, excluded_actors } };
  if (type === 'slack') return { type, config: { event, channel_ids: filter, group_thread_replies: true } };
  if (type === 'linear') return { type, config: { event, team_ids: filter, state_types: stateTypes.length > 0 ? stateTypes : undefined } };
  const levelShown = getTriggerEvent(type, event)?.parameters?.some((parameter) => parameter.type === 'level');
  return { type, config: { event, project_slugs: filter, min_level: (levelShown && level) || undefined } };
}
