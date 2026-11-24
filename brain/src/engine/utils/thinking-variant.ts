import type { ThinkingLevel } from '@okidoki/shared';

const VARIANT_CANDIDATES_BY_THINKING_LEVEL = {
  low: ['low'],
  medium: ['medium'],
  high: ['high'],
  xhigh: ['xhigh', 'high'],
  max: ['max', 'xhigh', 'high'],
  ultra: ['max', 'xhigh', 'high'],
  ultracode: ['max', 'xhigh', 'high'],
} satisfies Record<ThinkingLevel, string[]>;

export function thinkingVariant(supported: { has(value: string): boolean } | undefined, thinkingLevel: ThinkingLevel | undefined): string | undefined {
  return thinkingLevel ? VARIANT_CANDIDATES_BY_THINKING_LEVEL[thinkingLevel].find((variant) => supported?.has(variant)) : undefined;
}
