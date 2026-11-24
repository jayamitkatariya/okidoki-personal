import type { OkidokiAgentAbilityDescriptor } from './types';
import { COMPUTER_ABILITY } from './abilities/computer';
import { DOCKER_ABILITY } from './abilities/docker';
import { ENVIRONMENT_SETUP_ABILITY } from './abilities/environment-setup';
import { GITHUB_ABILITY } from './abilities/github';
import { GITLAB_ABILITY } from './abilities/gitlab';
import { GPU_ABILITY } from './abilities/gpu';
import { ISSUES_ABILITY } from './abilities/issues';
import { LINEAR_ABILITY } from './abilities/linear';
import { LOCAL_COMPUTER_ABILITY } from './abilities/local-computer';
import { MACOS_ABILITY } from './abilities/macos';
import { MEDIA_ABILITY } from './abilities/media';
import { PREVIEWS_ABILITY } from './abilities/previews';
import { PLUGINS_ABILITY } from './abilities/plugins';
import { OKIDOKI_ABILITY } from './abilities/okidoki';
import { SENTRY_ABILITY } from './abilities/sentry';
import { SESSION_HISTORY_ABILITY } from './abilities/session-history';
import { SLACK_ABILITY } from './abilities/slack';
import { VISUALS_ABILITY } from './abilities/visuals';

// `okidoki` is first so SKILL.md teaches the platform context before
// drilling into integrations; UI accordion mirrors the order.
export const OKIDOKI_AGENT_ABILITY_REGISTRY = {
  okidoki: OKIDOKI_ABILITY,
  memory: SESSION_HISTORY_ABILITY,
  computer: COMPUTER_ABILITY,
  docker: DOCKER_ABILITY,
  environment_setup: ENVIRONMENT_SETUP_ABILITY,
  github: GITHUB_ABILITY,
  gitlab: GITLAB_ABILITY,
  gpu: GPU_ABILITY,
  issues: ISSUES_ABILITY,
  linear: LINEAR_ABILITY,
  local_computer: LOCAL_COMPUTER_ABILITY,
  macos: MACOS_ABILITY,
  media: MEDIA_ABILITY,
  plugins: PLUGINS_ABILITY,
  previews: PREVIEWS_ABILITY,
  sentry: SENTRY_ABILITY,
  slack: SLACK_ABILITY,
  visuals: VISUALS_ABILITY,
} as const satisfies Record<string, OkidokiAgentAbilityDescriptor>;

export type OkidokiAgentAbility = keyof typeof OKIDOKI_AGENT_ABILITY_REGISTRY;

export const OKIDOKI_AGENT_ABILITIES = Object.keys(
  OKIDOKI_AGENT_ABILITY_REGISTRY,
) as OkidokiAgentAbility[];

export type OkidokiAgentAbilityFlags = Record<OkidokiAgentAbility, boolean>;
