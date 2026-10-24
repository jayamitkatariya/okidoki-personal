// Apify: run ready-made actors (scrapers) and bring back their dataset items.
// https://docs.apify.com/api/v2 — run-sync-get-dataset-items waits for the run and returns the results.

const API = "https://api.apify.com/v2";

// Actors okidoki knows the inputs for. The model may pick others; these keep it from guessing shapes.
// `cost` is the store's rough rate so the preview can say what a run will spend.
export const KNOWN_ACTORS = [
  // Search and the open web
  {
    id: "apify/google-search-scraper",
    use: "Google results for a search",
    input: `{"queries": "best espresso grinder 2026", "maxPagesPerQuery": 1}`,
    cost: "platform usage only",
  },
  {
    id: "apify/rag-web-browser",
    use: "search the web and bring back the text of the top pages in one go — best for 'what does the web say about X'",
    input: `{"query": "espresso grinder reviews 2026", "maxResults": 5}`,
    cost: "~$1.3 per 1k pages",
  },
  {
    id: "apify/website-content-crawler",
    use: "the text of a website or docs pages",
    input: `{"startUrls": [{"url": "https://example.com"}], "maxCrawlPages": 10}`,
    cost: "platform usage only",
  },
  {
    id: "vdrmota/contact-info-scraper",
    use: "emails, phone numbers and social links found on a website",
    input: `{"startUrls": [{"url": "https://example.com"}], "maxDepth": 1, "maxRequestsPerStartUrl": 10}`,
    cost: "~$1 per 1k pages",
  },
  // LinkedIn (no cookies or account needed)
  {
    id: "harvestapi/linkedin-profile-scraper",
    use: "a LinkedIn person's profile: headline, experience, education, skills",
    input: `{"queries": ["https://www.linkedin.com/in/williamhgates"], "profileScraperMode": "Profile details no email ($4 per 1k)"}`,
    cost: "~$4 per 1k profiles",
  },
  {
    id: "harvestapi/linkedin-job-search",
    use: "LinkedIn job listings by title, location or company",
    input: `{"jobTitles": ["software engineer"], "locations": ["Lafayette, IN"], "maxItems": 10}`,
    cost: "~$1 per 1k jobs",
  },
  {
    id: "harvestapi/linkedin-company",
    use: "a LinkedIn company page: size, industry, description, locations",
    input: `{"companies": ["https://www.linkedin.com/company/anthropic"]}`,
    cost: "~$3 per 1k companies",
  },
  // Social
  {
    id: "apify/instagram-scraper",
    use: "Instagram posts from a profile, hashtag or post URL",
    input: `{"directUrls": ["https://www.instagram.com/nasa/"], "resultsType": "posts", "resultsLimit": 10}`,
    cost: "~$1.5 per 1k results",
  },
  {
    id: "clockworks/tiktok-scraper",
    use: "TikTok videos by hashtag or profile",
    input: `{"hashtags": ["coffee"], "resultsPerPage": 10}`,
    cost: "~$1.7 per 1k results",
  },
  {
    id: "apidojo/tweet-scraper",
    use: "X / Twitter posts by search term or handle",
    input: `{"searchTerms": ["openai"], "maxItems": 20, "sort": "Latest"}`,
    cost: "~$0.4 per 1k tweets",
  },
  {
    id: "streamers/youtube-scraper",
    use: "YouTube videos for a search, or from a channel",
    input: `{"searchQueries": ["how to tune a bike derailleur"], "maxResults": 10}`,
    cost: "~$2.4 per 1k videos",
  },
  {
    id: "trudax/reddit-scraper-lite",
    use: "Reddit posts and comments from a subreddit, search or thread",
    input: `{"startUrls": [{"url": "https://www.reddit.com/r/espresso/"}], "maxItems": 10, "maxComments": 5}`,
    cost: "~$3.4 per 1k results",
  },
  {
    id: "apify/facebook-posts-scraper",
    use: "posts from a public Facebook page",
    input: `{"startUrls": [{"url": "https://www.facebook.com/nasa/"}], "resultsLimit": 10}`,
    cost: "~$2 per 1k posts",
  },
  // Places, shopping and housing
  {
    id: "compass/crawler-google-places",
    use: "places, ratings and reviews from Google Maps",
    input: `{"searchStringsArray": ["coffee near Lafayette IN"], "maxCrawledPlacesPerSearch": 10}`,
    cost: "platform usage only",
  },
  {
    id: "compass/google-maps-reviews-scraper",
    use: "the reviews of one Google Maps place",
    input: `{"startUrls": [{"url": "https://www.google.com/maps/place/..."}], "maxReviews": 20, "language": "en"}`,
    cost: "~$0.3 per 1k reviews",
  },
  {
    id: "junglee/amazon-crawler",
    use: "Amazon products, prices and ratings for a search or product URL",
    input: `{"categoryOrProductUrls": [{"url": "https://www.amazon.com/s?k=keyboard"}], "maxItemsPerStartUrl": 10}`,
    cost: "~$3 per 1k results",
  },
  {
    id: "tri_angle/airbnb-scraper",
    use: "Airbnb listings and prices for a place",
    input: `{"locationQueries": ["Chicago"], "currency": "USD", "maxResults": 10}`,
    cost: "~$1 per 1k listings",
  },
  {
    id: "maxcopell/zillow-scraper",
    use: "Zillow homes for sale or rent from a Zillow search URL",
    input: `{"searchUrls": [{"url": "https://www.zillow.com/lafayette-in/"}], "resultsLimit": 10}`,
    cost: "~$1.3 per 1k results",
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
  if (response.status === 401) throw new Error("Apify rejected the key this build ships.");
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
