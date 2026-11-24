const SKIP_LABELS = new Set(['okidoki-skip', 'skip-okidoki', 'okidoki-ignore', 'no-okidoki']);

const SKIP_MARKER = /\[\s*(?:skip[\s_-]*okidoki|okidoki[\s_-]*skip|no[\s_-]*okidoki)\s*\]/i;

function normalizeLabel(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export type PullRequestSkipMetadata = {
  labels?: ReadonlyArray<{ name?: string | null } | string> | null;
  title?: string | null;
  body?: string | null;
};

// Gates only Okidoki' *automatic* behavior (automations + auto-respond);
// explicit actions like `/okidoki run` and `@okidoki` mentions are checked
// separately and intentionally override the marker.
export function shouldSkipOkidokiForPR(pr: PullRequestSkipMetadata): boolean {
  for (const label of pr.labels ?? []) {
    const name = typeof label === 'string' ? label : label?.name;
    if (name && SKIP_LABELS.has(normalizeLabel(name))) return true;
  }
  return SKIP_MARKER.test(pr.title ?? '') || SKIP_MARKER.test(pr.body ?? '');
}
