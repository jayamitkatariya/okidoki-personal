// Apify: run ready-made actors (scrapers) and bring back their dataset items.
// https://docs.apify.com/api/v2 — run-sync-get-dataset-items waits for the run and returns the results.

const API = "https://api.apify.com/v2";

// Actors okidoki knows the inputs for. The model may pick others; these keep it from guessing shapes.
export const KNOWN_ACTORS = [
  {
    id: "apify/google-search-scraper",
    use: "Google results for a search",
    input: `{"queries": "best espresso grinder 2026", "resultsPerPage": 10, "maxPagesPerQuery": 1}`,
  },
  {
    id: "apify/website-content-crawler",
    use: "the text of a website or docs pages",
    input: `{"startUrls": [{"url": "https://example.com"}], "maxCrawlPages": 10}`,
  },
  {
    id: "compass/crawler-google-places",
    use: "places, ratings and reviews from Google Maps",
    input: `{"searchStringsArray": ["coffee near Lafayette IN"], "maxCrawledPlacesPerSearch": 10}`,
  },
];

export interface ApifyRun {
  items: unknown[];
}

function actorPath(actor: string): string {
  // "user/actor" is addressed as "user~actor" in the API.
  return encodeURIComponent(actor.trim().replace("/", "~"));
}

export async function runActor(
  token: string,
  actor: string,
  input: Record<string, unknown>,
  options: { limit?: number; timeoutSecs?: number; maxChargeUsd?: number; signal?: AbortSignal } = {},
): Promise<ApifyRun> {
  const limit = options.limit ?? 50;
  const timeoutSecs = options.timeoutSecs ?? 240;
  const query = new URLSearchParams({ timeout: String(timeoutSecs), limit: String(limit), clean: "true", format: "json" });
  // Caps pay-per-event actors at the person's per-task spending limit (Settings › Safety).
  if (options.maxChargeUsd && options.maxChargeUsd > 0) query.set("maxTotalChargeUsd", String(options.maxChargeUsd));
  const response = await fetch(`${API}/acts/${actorPath(actor)}/run-sync-get-dataset-items?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: AbortSignal.any([AbortSignal.timeout((timeoutSecs + 30) * 1000), ...(options.signal ? [options.signal] : [])]),
  });
  if (response.status === 401) throw new Error("Apify rejected the key. Check it in Keys.");
  if (response.status === 404) throw new Error(`Apify has no actor called ${actor}.`);
  if (response.status === 408) throw new Error(`${actor} didn't finish in ${timeoutSecs}s. Try a smaller job.`);
  if (response.status === 402) throw new Error("Your Apify account is out of credits.");
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Apify answered ${response.status}: ${apifyMessage(detail)}`);
  }
  const items = (await response.json()) as unknown;
  return { items: Array.isArray(items) ? items : [items] };
}

export async function checkToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const response = await fetch(`${API}/users/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: response.status === 401 ? "Apify rejected the key" : `Apify answered ${response.status}` };
    const json = (await response.json()) as { data?: { username?: string } };
    return { ok: true, username: json.data?.username };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "couldn't reach Apify" };
  }
}

function apifyMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } };
    if (json.error?.message) return json.error.message;
  } catch {}
  return body.slice(0, 160);
}
