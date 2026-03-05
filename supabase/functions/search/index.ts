import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";

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

interface TimeSlot {
  time: string;
  type?: string;
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

    // Step 1: Parse user query
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Step 2: Find candidate restaurants via Firecrawl search
    const [resyCandidates, otCandidates] = await Promise.all([
      fetchPlatformCandidates(params, FIRECRAWL_API_KEY, "resy"),
      fetchPlatformCandidates(params, FIRECRAWL_API_KEY, "opentable"),
    ]);

    const resyResults = buildPlatformResults("resy", resyCandidates, params);
    const otResults = buildPlatformResults("opentable", otCandidates, params);
    const allCandidates = dedupeByUrl([...resyResults, ...otResults]);

    console.log(`Found ${allCandidates.length} unique candidates. Scraping for availability...`);

    // Step 3: Scrape each candidate's actual page for time slots
    const withAvailability = await scrapeAvailability(allCandidates, FIRECRAWL_API_KEY, params);
    console.log(`${withAvailability.length} restaurants have available time slots`);

    // Step 4: Enrich with AI for ratings, cuisine, neighborhood, coords
    const enriched = await enrichWithAI(withAvailability, LOVABLE_API_KEY, params);

    console.log(`Returning ${enriched.length} results with verified availability`);

    return new Response(
      JSON.stringify({ results: enriched, params }),
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

// ─── Scrape individual restaurant pages for real time slots ───

async function scrapeAvailability(
  candidates: any[],
  firecrawlKey: string,
  params: SearchParams
): Promise<any[]> {
  // Limit to top 30 to keep Firecrawl usage reasonable
  const toScrape = candidates.slice(0, 30);

  const results = await Promise.allSettled(
    toScrape.map(async (candidate) => {
      try {
        const pageUrl = candidate.platformUrl; // already has date/party params
        console.log(`Scraping: ${pageUrl}`);

        const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: pageUrl,
            formats: ["markdown"],
            waitFor: 3000, // wait for JS-rendered availability widgets
          }),
        });

        const data = await resp.json();
        if (!resp.ok) {
          console.error(`Scrape failed for ${candidate.name}:`, resp.status);
          return null;
        }

        const markdown = data?.data?.markdown || data?.markdown || "";
        const slots = extractTimeSlots(markdown, candidate.platform, params);

        if (slots.length === 0) {
          console.log(`No slots found for ${candidate.name}`);
          return null;
        }

        console.log(`Found ${slots.length} slots for ${candidate.name}: ${slots.map(s => s.time).join(", ")}`);
        return { ...candidate, timeSlots: slots };
      } catch (err) {
        console.error(`Error scraping ${candidate.name}:`, err);
        return null;
      }
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
    .map((r) => r.value);
}

function extractTimeSlots(markdown: string, platform: Platform, params: SearchParams): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();

  // Common patterns for time slots on reservation pages:
  // "7:00 PM", "7:30 PM", "8:00 PM" etc.
  // Resy: often shows as buttons like "7:00 PM" "7:15 PM" with types like "Dining Room", "Bar"
  // OpenTable: shows time buttons like "7:00 PM", "7:30 PM"

  // Match time patterns: "H:MM PM/AM" or "HH:MM PM/AM"
  const timePattern = /\b(1?[0-9]):([0-5][0-9])\s*(PM|AM)\b/gi;
  let match;

  while ((match = timePattern.exec(markdown)) !== null) {
    const hour = parseInt(match[1]);
    const minute = match[2];
    const ampm = match[3].toUpperCase();

    // Convert to 24h for comparison
    let h24 = hour;
    if (ampm === "PM" && hour !== 12) h24 += 12;
    if (ampm === "AM" && hour === 12) h24 = 0;

    // Only include times that are reasonable for dining (11 AM - 11 PM)
    if (h24 < 11 || h24 > 23) continue;

    const timeStr = `${match[1]}:${minute} ${ampm}`;
    if (!seen.has(timeStr)) {
      seen.add(timeStr);

      // Try to detect seating type from surrounding text
      const idx = match.index;
      const context = markdown.substring(Math.max(0, idx - 100), idx + 30);
      let type: string | undefined;

      const typeMatch = context.match(/(dining room|bar|patio|outdoor|terrace|lounge|counter|chef'?s? table|main|garden)/i);
      if (typeMatch) {
        type = typeMatch[1].replace(/\b\w/g, c => c.toUpperCase());
      }

      slots.push({ time: timeStr, type });
    }
  }

  // Sort by time
  slots.sort((a, b) => {
    const toMin = (t: string) => {
      const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!m) return 0;
      let h = parseInt(m[1]);
      if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
      if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
      return h * 60 + parseInt(m[2]);
    };
    return toMin(a.time) - toMin(b.time);
  });

  return slots;
}

// ─── Query parsing ───

async function parseQuery(
  query: string,
  lat: number | undefined,
  lng: number | undefined,
  location: string | undefined,
  apiKey: string
): Promise<SearchParams> {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const todayIdx = now.getDay();
  const dateRef: string[] = [];
  for (let d = 0; d <= 13; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + d);
    const label = d === 0 ? "today" : d === 1 ? "tomorrow" : "";
    dateRef.push(`${dayNames[dt.getDay()]} ${dt.toISOString().split("T")[0]}${label ? ` (${label})` : ""}`);
  }

  const parsePrompt = `You parse restaurant reservation search queries.

Current date: ${now.toISOString().split("T")[0]} (${dayNames[todayIdx]})
User location hint: ${location || "unknown"}
Coordinates: lat=${lat || "unknown"}, lng=${lng || "unknown"}

CALENDAR for next 14 days:
${dateRef.join("\n")}

Rules:
- "today" or "tonight" = ${now.toISOString().split("T")[0]}
- "tomorrow" = the day AFTER today
- "next Tuesday" = the FIRST Tuesday that appears AFTER today in the calendar above
- "this Friday" = the FIRST Friday on or after today
- Convert suburbs to major metro city (e.g. "North Druid Hills" => "Atlanta")
- dinner/tonight defaults to time "19:00", lunch = "12:00"

Return JSON:
- cuisine: string ("" if unspecified)
- date: YYYY-MM-DD (MUST match a date from the calendar above)
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

  if (lat) parsed.lat = lat;
  if (lng) parsed.lng = lng;

  if ((!parsed.lat || parsed.lat === 0) && parsed.city) {
    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.city + ", " + (parsed.state || ""))}&format=json&limit=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const geoData = await geoResp.json();
      if (geoData?.[0]) {
        parsed.lat = parseFloat(geoData[0].lat);
        parsed.lng = parseFloat(geoData[0].lon);
      }
    } catch (_e) { /* ignore */ }
  }

  return parsed;
}

// ─── Firecrawl candidate discovery ───

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
      const resp = await fetch(`${FIRECRAWL_API}/search`, {
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

// ─── Candidate normalization ───

function buildPlatformResults(
  platform: Platform,
  candidates: FirecrawlResult[],
  params: SearchParams
) {
  return candidates
    .map((c) => normalizeCandidate(platform, c, params))
    .filter(Boolean) as any[];
}

function normalizeCandidate(platform: Platform, c: FirecrawlResult, params: SearchParams) {
  const canonicalUrl = extractCanonicalRestaurantUrl(platform, c.url);
  if (!canonicalUrl) return null;

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
    rating: undefined as number | undefined,
    priceRange: undefined as string | undefined,
    imageUrl: null,
    platform,
    platformUrl: bookingUrl,
    timeSlots: [] as TimeSlot[],
    distanceMiles: null as number | null,
  };
}

function extractCanonicalRestaurantUrl(platform: Platform, rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname;

    if (platform === "resy") {
      const cityVenue = path.match(/^\/cities\/[^/]+\/venues\/[^/?#]+/i);
      if (cityVenue) return `https://resy.com${cityVenue[0]}`;
      const cityRestaurant = path.match(/^\/cities\/[^/]+\/[^/?#]+/i);
      if (cityRestaurant) return `https://resy.com${cityRestaurant[0]}`;
      return null;
    }

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

function buildResyBookingUrl(baseUrl: string, params: SearchParams): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("date", params.date);
    u.searchParams.set("seats", String(params.partySize));
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function buildOpenTableBookingUrl(baseUrl: string, params: SearchParams): string {
  try {
    const u = new URL(baseUrl);
    if (u.pathname.startsWith("/r/")) {
      u.searchParams.set("dateTime", `${params.date}T${params.time}`);
      u.searchParams.set("covers", String(params.partySize));
      return u.toString();
    }
    if (u.pathname.startsWith("/restref/client")) {
      u.searchParams.set("dateTime", `${params.date}T${params.time}`);
      u.searchParams.set("covers", String(params.partySize));
      u.searchParams.set("destination", "reservations");
      return u.toString();
    }
    return baseUrl;
  } catch {
    return baseUrl;
  }
}

// ─── AI enrichment ───

async function enrichWithAI(results: any[], apiKey: string, params: SearchParams): Promise<any[]> {
  if (results.length === 0) return [];

  const restaurantList = results.map((r, i) => `${i}. ${r.name} (${r.platform}, ${r.neighborhood})`).join("\n");
  const cityContext = `${params.city}, ${params.state}`;

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `You are a restaurant data expert. For EVERY restaurant below in ${cityContext}, you MUST provide ALL fields. Do not skip any restaurant.

For each, provide:
- index: the number from the list
- rating: Google Maps rating (out of 5, one decimal). If unsure, estimate based on the restaurant's reputation. NEVER leave null.
- cuisine: specific cuisine type (e.g. "Italian", "Southern American", "Japanese")
- neighborhood: the specific neighborhood in ${cityContext}
- priceRange: "$", "$$", "$$$", or "$$$$"
- lat: approximate latitude (must be a number, use the neighborhood's approximate location)
- lng: approximate longitude (must be a number)

Return JSON: { "restaurants": [{ "index": number, "rating": number, "cuisine": string, "neighborhood": string, "priceRange": string, "lat": number, "lng": number }] }

IMPORTANT: You MUST return an entry for EVERY restaurant in the list. Do not skip any.

${restaurantList}`,
        }],
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      await resp.text();
      console.error("AI enrich failed:", resp.status);
      return results;
    }

    const aiData = await resp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return results;

    const parsed = JSON.parse(content);
    const enrichments = parsed.restaurants || [];

    const enrichMap = new Map<number, any>();
    for (const e of enrichments) {
      if (typeof e.index === "number") enrichMap.set(e.index, e);
    }

    const userLat = params.lat || 0;
    const userLng = params.lng || 0;

    const enriched = results.map((r, i) => {
      const e = enrichMap.get(i);
      if (!e) return { ...r, distanceMiles: null };

      const rLat = e.lat || null;
      const rLng = e.lng || null;
      let distanceMiles: number | null = null;

      if (rLat && rLng && userLat && userLng) {
        distanceMiles = haversine(userLat, userLng, rLat, rLng);
      }

      return {
        ...r,
        rating: e.rating ?? r.rating,
        cuisine: e.cuisine || r.cuisine,
        neighborhood: e.neighborhood || r.neighborhood,
        priceRange: e.priceRange || r.priceRange,
        distanceMiles,
      };
    });

    // Sort by distance first, then rating
    return enriched.sort((a, b) => {
      const dA = a.distanceMiles ?? 9999;
      const dB = b.distanceMiles ?? 9999;
      if (Math.abs(dA - dB) > 0.1) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  } catch (err) {
    console.error("AI enrich error:", err);
    return results;
  }
}

// ─── Utilities ───

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function dedupeByUrl(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.platform}:${row.platformUrl.split("?")[0].toLowerCase()}`;
    if (!map.has(key)) map.set(key, row);
  }
  return Array.from(map.values()).slice(0, 80);
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

function hashKey(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) {
    h = (h << 5) - h + v.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
