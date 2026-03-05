import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1/search";

type Platform = "resy" | "opentable";

interface SearchParams {
  cuisine: string;
  date: string;
  time: string;
  partySize: number;
  city: string;
  state: string;
  lat?: number;
  lng?: number;
}

interface FirecrawlResult {
  url: string;
  title?: string;
  description?: string;
  markdown?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, lat, lng, location } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");

    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    const [resyCandidates, otCandidates] = await Promise.all([
      fetchPlatformCandidates(params, FIRECRAWL_API_KEY, "resy"),
      fetchPlatformCandidates(params, FIRECRAWL_API_KEY, "opentable"),
    ]);

    const resyResults = buildPlatformResults("resy", resyCandidates, params);
    const otResults = buildPlatformResults("opentable", otCandidates, params);

    const merged = dedupeAndSortByRating([...resyResults, ...otResults]);

    console.log(
      `Returning ${merged.length} results (Resy: ${resyResults.length}, OpenTable: ${otResults.length})`
    );

    return new Response(
      JSON.stringify({ results: merged, params }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Search error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Search failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function parseQuery(
  query: string,
  lat: number | undefined,
  lng: number | undefined,
  location: string | undefined,
  apiKey: string
): Promise<SearchParams> {
  const now = new Date();
  const parsePrompt = `You parse restaurant reservation search queries.

Current date: ${now.toISOString().split("T")[0]}
Current day of week: ${now.toLocaleDateString("en-US", { weekday: "long" })}
User location hint: ${location || "unknown"}
Coordinates: lat=${lat || "unknown"}, lng=${lng || "unknown"}

Rules:
- Convert suburbs to major metro city for booking platforms (e.g. "North Druid Hills" => "Atlanta").
- "tomorrow" MUST map to the next calendar day.
- dinner/tonight defaults to time "19:00"

Return JSON:
- cuisine: string ("" if unspecified)
- date: YYYY-MM-DD
- time: HH:MM (24h)
- partySize: number (default 2)
- city: major city string
- state: 2-letter state code

User query: "${query}"`;

  const aiResp = await fetch(AI_GATEWAY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: parsePrompt }],
      tools: [
        {
          type: "function",
          function: {
            name: "extract_search_params",
            description: "Extract structured restaurant search parameters",
            parameters: {
              type: "object",
              properties: {
                cuisine: { type: "string" },
                date: { type: "string" },
                time: { type: "string" },
                partySize: { type: "number" },
                city: { type: "string" },
                state: { type: "string" },
              },
              required: ["cuisine", "date", "time", "partySize", "city", "state"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_search_params" } },
    }),
  });

  if (!aiResp.ok) {
    const errText = await aiResp.text();
    console.error("AI parse error:", aiResp.status, errText);
    throw new Error("Failed to parse search query");
  }

  const aiData = await aiResp.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Failed to parse search query");

  const parsed = JSON.parse(toolCall.function.arguments) as SearchParams;

  parsed.city = parsed.city?.trim() || "Atlanta";
  parsed.state = parsed.state?.trim() || "GA";
  parsed.cuisine = parsed.cuisine?.trim() || "";
  parsed.time = /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : "19:00";
  parsed.partySize = Number(parsed.partySize) > 0 ? Number(parsed.partySize) : 2;

  // Always trust parsed date and propagate exactly to booking links.
  return parsed;
}

async function fetchPlatformCandidates(
  params: SearchParams,
  firecrawlKey: string,
  platform: Platform
): Promise<FirecrawlResult[]> {
  const cuisineTerm = params.cuisine ? ` ${params.cuisine}` : "";

  const queries =
    platform === "resy"
      ? [
          `site:resy.com/cities ${params.city}${cuisineTerm} reserve`,
          `site:resy.com ${params.city}${cuisineTerm} resy restaurant`,
        ]
      : [
          `site:opentable.com/r ${params.city}${cuisineTerm} reserve`,
          `site:opentable.com ${params.city}${cuisineTerm} opentable`,
        ];

  console.log(`Firecrawl ${platform} queries:`, JSON.stringify(queries));

  const results = await Promise.all(
    queries.map(async (query) => {
      const resp = await fetch(FIRECRAWL_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firecrawlKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, limit: 25 }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        console.error(`${platform} search failed:`, resp.status, JSON.stringify(data).slice(0, 300));
        return [] as FirecrawlResult[];
      }

      return (data?.data || []) as FirecrawlResult[];
    })
  );

  const merged = dedupeCandidates(results.flat());
  console.log(`${platform} candidates fetched:`, merged.length);
  return merged;
}

function buildPlatformResults(
  platform: Platform,
  candidates: FirecrawlResult[],
  params: SearchParams
) {
  const normalized = candidates
    .map((c) => normalizeCandidate(platform, c, params))
    .filter(Boolean) as Array<{
    id: string;
    name: string;
    cuisine: string;
    neighborhood: string;
    rating?: number;
    priceRange?: string;
    imageUrl: string | null;
    platform: "resy" | "opentable";
    platformUrl: string;
    timeSlots: [];
    _availabilitySignal: boolean;
  }>;

  // Keep only entries that show reservation/availability intent in page snippet.
  const withAvailability = normalized.filter((r) => r._availabilitySignal);
  const finalRows = withAvailability.length > 0 ? withAvailability : normalized;

  return finalRows.map(({ _availabilitySignal, ...row }) => row);
}

function normalizeCandidate(platform: Platform, c: FirecrawlResult, params: SearchParams) {
  const canonicalUrl = extractCanonicalRestaurantUrl(platform, c.url);
  if (!canonicalUrl) return null;

  const sourceText = `${c.title || ""} ${c.description || ""} ${c.markdown || ""}`.toLowerCase();
  const availabilitySignal = /(reserve|reservation|book now|available|tables?)/i.test(sourceText);

  const rating = extractRating(`${c.title || ""} ${c.description || ""} ${c.markdown || ""}`);
  const priceRange = extractPriceRange(`${c.title || ""} ${c.description || ""} ${c.markdown || ""}`);

  const name = extractName(c.title, canonicalUrl, platform);
  const bookingUrl =
    platform === "resy"
      ? buildResyBookingUrl(canonicalUrl, params)
      : buildOpenTableBookingUrl(canonicalUrl, params);

  return {
    id: `${platform}-${hashKey(canonicalUrl)}`,
    name,
    cuisine: params.cuisine || "Restaurant",
    neighborhood: params.city,
    rating,
    priceRange,
    imageUrl: null,
    platform,
    platformUrl: bookingUrl,
    timeSlots: [],
    _availabilitySignal: availabilitySignal,
  };
}

function extractCanonicalRestaurantUrl(platform: Platform, rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname;

    if (platform === "resy") {
      // Supports:
      // /cities/atlanta/restaurant-slug
      // /cities/atlanta-ga/venues/restaurant-slug
      const cityVenue = path.match(/^\/cities\/[^/]+\/venues\/[^/?#]+/i);
      if (cityVenue) return `https://resy.com${cityVenue[0]}`;

      const cityRestaurant = path.match(/^\/cities\/[^/]+\/[^/?#]+/i);
      if (cityRestaurant) return `https://resy.com${cityRestaurant[0]}`;

      return null;
    }

    // OpenTable supports /r/... and /restref/client
    const rPath = path.match(/^\/r\/[^/?#]+/i);
    if (rPath) return `https://www.opentable.com${rPath[0]}`;

    if (path.startsWith("/restref/client")) {
      return `https://www.opentable.com${path}${u.search}`;
    }

    return null;
  } catch {
    return null;
  }
}

function buildResyBookingUrl(baseRestaurantUrl: string, params: SearchParams): string {
  try {
    const u = new URL(baseRestaurantUrl);
    u.searchParams.set("date", params.date);
    u.searchParams.set("seats", String(params.partySize));
    return u.toString();
  } catch {
    return baseRestaurantUrl;
  }
}

function buildOpenTableBookingUrl(baseRestaurantUrl: string, params: SearchParams): string {
  try {
    const u = new URL(baseRestaurantUrl);

    // Standard OpenTable restaurant page
    if (u.pathname.startsWith("/r/")) {
      u.searchParams.set("dateTime", `${params.date}T${params.time}`);
      u.searchParams.set("covers", String(params.partySize));
      return u.toString();
    }

    // Legacy restref booking endpoint
    if (u.pathname.startsWith("/restref/client")) {
      u.searchParams.set("dateTime", `${params.date}T${params.time}`);
      u.searchParams.set("covers", String(params.partySize));
      u.searchParams.set("destination", "reservations");
      return u.toString();
    }

    return baseRestaurantUrl;
  } catch {
    return baseRestaurantUrl;
  }
}

function dedupeCandidates(rows: FirecrawlResult[]): FirecrawlResult[] {
  const map = new Map<string, FirecrawlResult>();
  for (const row of rows) {
    if (!row?.url) continue;
    const key = row.url.split("?")[0].toLowerCase();
    if (!map.has(key)) map.set(key, row);
  }
  return Array.from(map.values());
}

function dedupeAndSortByRating(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.platform}:${row.platformUrl.split("?")[0].toLowerCase()}`;
    if (!map.has(key)) map.set(key, row);
  }

  return Array.from(map.values())
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 80);
}

function extractName(title: string | undefined, canonicalUrl: string, platform: Platform): string {
  if (title) {
    const cleaned = title
      .replace(/^book your\s+/i, "")
      .replace(/\s+reservation now on resy.*$/i, "")
      .replace(/\s*\|\s*resy.*/i, "")
      .replace(/\s*\|\s*opentable.*/i, "")
      .replace(/\s*-\s*opentable.*/i, "")
      .replace(/\s*-\s*atlanta,?\s*ga$/i, "")
      .trim();
    if (cleaned.length > 1) return cleaned;
  }

  const parts = canonicalUrl.split("/");
  const slug = parts[parts.length - 1] || "restaurant";
  return slug
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function extractRating(text: string): number | undefined {
  const normalized = text.replace(/,/g, " ");
  const patterns = [
    /([0-5](?:\.[0-9])?)\s*\/\s*5/i,
    /([0-5](?:\.[0-9])?)\s*stars?/i,
    /rating\s*[:\-]?\s*([0-5](?:\.[0-9])?)/i,
    /rated\s*([0-5](?:\.[0-9])?)/i,
  ];

  for (const p of patterns) {
    const m = normalized.match(p);
    if (m) {
      const v = Number(m[1]);
      if (!Number.isNaN(v) && v >= 0 && v <= 5) return v;
    }
  }
  return undefined;
}

function extractPriceRange(text: string): string | undefined {
  const m = text.match(/\${1,4}/);
  return m?.[0];
}

function slugify(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hashKey(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) {
    h = (h << 5) - h + v.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
