// Finds a document on the web and hands back a link straight to the file: the model searches,
// then a landing page ("/document/forms/…") is opened and its PDF link taken. The Mac downloads it.

export interface FoundDocument {
  ok: true;
  title: string;
  /** Direct link to the PDF. */
  url: string;
  /** The page it was found on, when that isn't the PDF itself. */
  page?: string;
}

export type FindResult = FoundDocument | { ok: false; error: string };

type Fetch = typeof fetch;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

export async function findDocument(query: string, key: string | undefined, fetchImpl: Fetch = fetch, model = "claude-haiku-5-5"): Promise<FindResult> {
  const wanted = query.trim().slice(0, 300);
  if (!wanted) return { ok: false, error: "say what to look for" };
  if (!key) return { ok: false, error: "web search needs the model, and it isn't available right now" };
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{
          role: "user",
          content: `Find the official, current PDF for: ${wanted}\n\nPrefer the issuing agency or publisher's own site (for customs forms: cbp.gov, cbsa-asfc.gc.ca). `
            + `Reply with only JSON: {"title": "<the document's real title>", "url": "<direct .pdf link if you found one, otherwise the page that links to it>"}.`
            + ` If nothing official exists, reply {"title": "", "url": ""}.`,
        }],
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError" ? "the web search took too long" : "couldn't reach the web search" };
  }
  if (!response.ok) return { ok: false, error: `web search failed (${response.status})` };
  const data = (await response.json()) as { content?: { type: string; text?: string; content?: unknown }[] };
  const blocks = data.content ?? [];
  const answer = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  const seen = blocks.flatMap((b) =>
    b.type === "web_search_tool_result" && Array.isArray(b.content)
      ? (b.content as { url?: string; title?: string }[]).filter((r) => typeof r.url === "string").map((r) => ({ url: r.url!, title: r.title ?? "" }))
      : []);
  const picked = parseAnswer(answer);
  const candidates = [
    ...(picked?.url ? [{ url: picked.url, title: picked.title }] : []),
    ...seen.filter((r) => /\.pdf($|[?#])/i.test(r.url)),
    ...seen.filter((r) => !/\.pdf($|[?#])/i.test(r.url)),
  ];
  const tried = new Set<string>();
  for (const candidate of candidates.slice(0, 6)) {
    if (tried.has(candidate.url)) continue;
    tried.add(candidate.url);
    const pdf = await resolvePdf(candidate.url, wanted, fetchImpl);
    if (pdf) {
      const title = (picked?.url === candidate.url && picked.title) || candidate.title || titleFromURL(pdf);
      return { ok: true, title: clean(title), url: pdf, ...(pdf !== candidate.url ? { page: candidate.url } : {}) };
    }
  }
  return { ok: false, error: `couldn't find a PDF for “${wanted}”` };
}

export function parseAnswer(text: string): { title: string; url: string } | null {
  const match = text.match(/\{[\s\S]*?"url"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { title?: unknown; url?: unknown };
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return null;
    return { title: typeof parsed.title === "string" ? parsed.title.trim() : "", url };
  } catch {
    return null;
  }
}

/** The URL itself when it serves a PDF; otherwise the best PDF linked from the page. */
export async function resolvePdf(url: string, query: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { "user-agent": BROWSER_UA }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("pdf")) {
    await response.body?.cancel().catch(() => {});
    return response.url || url;
  }
  if (!type.includes("html")) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const html = (await response.text()).slice(0, 2_000_000);
  const base = response.url || url;
  const links: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.pdf(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      links.push({ href: new URL(m[1]!, base).toString(), text: m[2]!.replace(/<[^>]+>/g, " ") });
    } catch {}
  }
  if (!links.length) return null;
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const score = (l: { href: string; text: string }) => {
    const hay = `${safeDecode(l.href)} ${l.text}`.toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  const best = links.map((l) => ({ l, s: score(l) })).sort((a, b) => b.s - a.s)[0]!.l.href;
  // Confirm it's really a PDF before handing it over.
  try {
    const check = await fetchImpl(best, { method: "HEAD", headers: { "user-agent": BROWSER_UA }, redirect: "follow", signal: AbortSignal.timeout(8_000) });
    if (check.ok && !(check.headers.get("content-type") ?? "pdf").includes("pdf")) return null;
  } catch {}
  return best;
}

/** decodeURIComponent that shrugs at a malformed escape (one bad link mustn't sink the whole search). */
function safeDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

function titleFromURL(url: string): string {
  const last = safeDecode(new URL(url).pathname.split("/").pop() ?? "document.pdf");
  return last.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
}

function clean(title: string): string {
  return title.replace(/\s*\|\s*U\.S\. Customs and Border Protection\s*$/i, "").replace(/\s+/g, " ").trim().slice(0, 160);
}
