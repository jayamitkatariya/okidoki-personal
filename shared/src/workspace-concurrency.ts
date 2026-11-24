import type { PlanType } from './pricing';

export const WORKSPACE_CONCURRENCY_LIMITS: Record<PlanType, number> = {
  trial: 50,
  developer: 150,
  team: 500,
  enterprise: 500,
};
