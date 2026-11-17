const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_RESULTS = 5;
const MAX_PAGE_CHARS = 4000;
const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

export const toolSchemas = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns up to 5 results with title, URL and snippet.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page (http/https) and return its text, truncated to 4000 characters.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL" } },
        required: ["url"],
      },
    },
  },
];

export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|nbsp|#x27|#39);/g, (m) => ENTITIES[m]);
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded>&rut=...
export function unwrapDdgUrl(href) {
  const decoded = decodeEntities(href);
  try {
    const u = new URL(decoded, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ?? u.href;
  } catch {
    return decoded;
  }
}

export function parseDdgHtml(html) {
  const results = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1]));
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    results.push({
      title: stripTags(m[2]),
      url: unwrapDdgUrl(m[1]),
      snippet: snippets[i] ?? "",
    });
    i++;
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

export async function webSearch({ query }) {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("web_search requires a non-empty string 'query'");
  }
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const results = parseDdgHtml(await res.text());
  if (results.length === 0) return "No results.";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n");
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPage({ url }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetch_page: invalid URL "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`fetch_page only allows http and https, got "${parsed.protocol}"`);
  }
  const res = await fetch(parsed.href, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`fetch_page: HTTP ${res.status} for ${parsed.href}`);
  return htmlToText(await res.text()).slice(0, MAX_PAGE_CHARS);
}

export const toolImpls = { web_search: webSearch, fetch_page: fetchPage };
