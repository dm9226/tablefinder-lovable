import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
const YELP_API = "https://api.yelp.com/v3";

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

interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  priceRange?: string;
  imageUrl?: string;
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: { time: string; type?: string }[];
  distanceMiles?: number | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, lat, lng, location } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    const YELP_API_KEY = Deno.env.get("YELP_API_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");

    // Step 1: Parse user query
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Step 2: Fetch from all platforms in parallel (scraping search pages = only available restaurants)
    const [resyResults, otResults, yelpResults] = await Promise.all([
      fetchResyAvailable(params, FIRECRAWL_API_KEY, LOVABLE_API_KEY),
      fetchOpenTableAvailable(params, FIRECRAWL_API_KEY, LOVABLE_API_KEY),
      YELP_API_KEY ? fetchYelpAvailable(params, YELP_API_KEY) : Promise.resolve([]),
    ]);

    console.log(`Platform results — Resy: ${resyResults.length}, OT: ${otResults.length}, Yelp: ${yelpResults.length}`);

    // Step 3: Dedupe and merge
    const allResults = dedupeByName([...resyResults, ...otResults, ...yelpResults]);
    console.log(`After dedup: ${allResults.length} results`);

    // Step 4: Enrich with distance
    const enriched = enrichWithDistance(allResults, params);

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

// ─── Query parsing ───

async function parseQuery(
  query: string, lat: number | undefined, lng: number | undefined,
  location: string | undefined, apiKey: string
): Promise<SearchParams> {
  const now = new Date();
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dateRef: string[] = [];
  for (let d = 0; d <= 13; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + d);
    const label = d === 0 ? "today" : d === 1 ? "tomorrow" : "";
    dateRef.push(`${dayNames[dt.getDay()]} ${dt.toISOString().split("T")[0]}${label ? ` (${label})` : ""}`);
  }

  const parsePrompt = `You parse restaurant reservation search queries.

Current date: ${now.toISOString().split("T")[0]} (${dayNames[now.getDay()]})
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
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: parsePrompt }],
      tools: [{
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
      }],
      tool_choice: { type: "function", function: { name: "extract_search_params" } },
    }),
  });

  if (!aiResp.ok) throw new Error("Failed to parse search query");

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

  if (!parsed.lat && parsed.city) {
    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.city + ", " + parsed.state)}&format=json&limit=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const geoData = await geoResp.json();
      if (geoData?.[0]) {
        parsed.lat = parseFloat(geoData[0].lat);
        parsed.lng = parseFloat(geoData[0].lon);
      }
    } catch { /* ignore */ }
  }

  return parsed;
}

// ─── Resy: Scrape search page (only shows available restaurants) ───

async function fetchResyAvailable(
  params: SearchParams, firecrawlKey: string, aiKey: string
): Promise<Restaurant[]> {
  try {
    // Build Resy search URL — the page only shows restaurants with availability
    const citySlug = params.city.toLowerCase().replace(/\s+/g, "-");
    const resyUrl = `https://resy.com/cities/${citySlug}?date=${params.date}&seats=${params.partySize}`;
    console.log("Scraping Resy:", resyUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: resyUrl, formats: ["markdown"], waitFor: 5000 }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.success) {
      console.error("Resy scrape failed:", JSON.stringify(data).slice(0, 300));
      return [];
    }

    const markdown = data.data?.markdown || data.markdown || "";
    if (!markdown || markdown.length < 100) {
      console.log("Resy scrape returned empty content");
      return [];
    }

    // Use AI to parse the scraped markdown into structured restaurant data
    return await parseScrapedResults(markdown, "resy", params, aiKey);
  } catch (err) {
    console.error("Resy fetch error:", err);
    return [];
  }
}

// ─── OpenTable: Scrape search page (shows restaurants with time slots) ───

async function fetchOpenTableAvailable(
  params: SearchParams, firecrawlKey: string, aiKey: string
): Promise<Restaurant[]> {
  try {
    const cuisineTerm = params.cuisine || "restaurant";
    const otUrl = `https://www.opentable.com/s?dateTime=${params.date}T${params.time}&covers=${params.partySize}&term=${encodeURIComponent(cuisineTerm)}&queryUnderstandingType=cuisine&nearMe=false&sortBy=availability`;
    console.log("Scraping OpenTable:", otUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: otUrl, formats: ["markdown"], waitFor: 5000 }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.success) {
      console.error("OT scrape failed:", JSON.stringify(data).slice(0, 300));
      return [];
    }

    const markdown = data.data?.markdown || data.markdown || "";
    if (!markdown || markdown.length < 100) {
      console.log("OT scrape returned empty content");
      return [];
    }

    return await parseScrapedResults(markdown, "opentable", params, aiKey);
  } catch (err) {
    console.error("OT fetch error:", err);
    return [];
  }
}

// ─── Yelp: Use Fusion API (searches businesses supporting reservations) ───

async function fetchYelpAvailable(
  params: SearchParams, yelpKey: string
): Promise<Restaurant[]> {
  try {
    const searchParams = new URLSearchParams({
      term: `${params.cuisine || ""} restaurants`.trim(),
      location: `${params.city}, ${params.state}`,
      limit: "20",
      sort_by: "best_match",
    });

    // Add coordinates if available for better results
    if (params.lat && params.lng) {
      searchParams.set("latitude", String(params.lat));
      searchParams.set("longitude", String(params.lng));
    }

    console.log("Yelp API search:", searchParams.toString());

    const resp = await fetch(`${YELP_API}/businesses/search?${searchParams}`, {
      headers: { Authorization: `Bearer ${yelpKey}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Yelp API error:", resp.status, errText.slice(0, 300));
      return [];
    }

    const data = await resp.json();
    const businesses = data.businesses || [];

    // Filter to only businesses that support reservations
    const withReservations = businesses.filter((b: any) =>
      b.transactions?.includes("restaurant_reservation")
    );

    console.log(`Yelp: ${businesses.length} total, ${withReservations.length} with reservations`);

    return withReservations.map((b: any): Restaurant => {
      const priceMap: Record<string, string> = { "$": "$", "$$": "$$", "$$$": "$$$", "$$$$": "$$$$" };
      return {
        id: `yelp-${b.id}`,
        name: b.name,
        cuisine: b.categories?.[0]?.title || params.cuisine || "Restaurant",
        neighborhood: b.location?.city || params.city,
        rating: b.rating,
        priceRange: priceMap[b.price] || undefined,
        imageUrl: b.image_url || null,
        platform: "yelp",
        platformUrl: b.url?.replace(/\?.*$/, "") || `https://www.yelp.com/biz/${b.alias}`,
        timeSlots: [],
        distanceMiles: b.distance ? b.distance / 1609.34 : null,
      };
    });
  } catch (err) {
    console.error("Yelp fetch error:", err);
    return [];
  }
}

// ─── AI parsing of scraped platform pages ───

async function parseScrapedResults(
  markdown: string, platform: "resy" | "opentable", params: SearchParams, aiKey: string
): Promise<Restaurant[]> {
  const truncated = markdown.slice(0, 15000); // Limit context size

  const prompt = platform === "resy"
    ? `Extract restaurants from this Resy search results page. Each restaurant listed here has availability for ${params.date} with ${params.partySize} guests.

For each restaurant found, extract:
- name: restaurant name
- cuisine: cuisine type
- neighborhood: neighborhood or area
- rating: rating if shown (number)
- priceRange: "$", "$$", "$$$", or "$$$$" if shown
- slug: the URL slug (e.g. "restaurant-name" from the listing)

Return JSON: { "restaurants": [{ "name": string, "cuisine": string, "neighborhood": string, "rating": number|null, "priceRange": string|null, "slug": string }] }

If no restaurants are found, return { "restaurants": [] }.

Page content:
${truncated}`
    : `Extract restaurants from this OpenTable search results page. Each restaurant listed here has availability for ${params.date} at ${params.time} with ${params.partySize} guests.

For each restaurant found, extract:
- name: restaurant name
- cuisine: cuisine type
- neighborhood: neighborhood or area
- rating: rating if shown (number)
- priceRange: "$", "$$", "$$$", or "$$$$" if shown
- slug: the URL slug from the listing link (e.g. "restaurant-name-city" from /r/restaurant-name-city)
- timeSlots: array of available time strings shown (e.g. ["6:30 PM", "7:00 PM", "7:30 PM"])

Return JSON: { "restaurants": [{ "name": string, "cuisine": string, "neighborhood": string, "rating": number|null, "priceRange": string|null, "slug": string, "timeSlots": string[] }] }

If no restaurants are found, return { "restaurants": [] }.

Page content:
${truncated}`;

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      console.error(`AI parse ${platform} failed:`, resp.status);
      return [];
    }

    const aiData = await resp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const restaurants = parsed.restaurants || [];

    return restaurants.map((r: any): Restaurant => {
      const citySlug = params.city.toLowerCase().replace(/\s+/g, "-");
      const baseUrl = platform === "resy"
        ? `https://resy.com/cities/${citySlug}/${r.slug || slugify(r.name)}?date=${params.date}&seats=${params.partySize}`
        : `https://www.opentable.com/r/${r.slug || slugify(r.name)}?dateTime=${params.date}T${params.time}&covers=${params.partySize}`;

      return {
        id: `${platform}-${hashKey(r.name)}`,
        name: r.name,
        cuisine: r.cuisine || params.cuisine || "Restaurant",
        neighborhood: r.neighborhood || params.city,
        rating: r.rating || undefined,
        priceRange: r.priceRange || undefined,
        imageUrl: null,
        platform,
        platformUrl: baseUrl,
        timeSlots: (r.timeSlots || []).map((t: string) => ({ time: t })),
        distanceMiles: null,
      };
    });
  } catch (err) {
    console.error(`AI parse ${platform} error:`, err);
    return [];
  }
}

// ─── Enrichment & utilities ───

function enrichWithDistance(results: Restaurant[], params: SearchParams): Restaurant[] {
  if (!params.lat || !params.lng) return results;

  // Sort by distance if available, then rating
  return results.sort((a, b) => {
    const dA = a.distanceMiles ?? 9999;
    const dB = b.distanceMiles ?? 9999;
    if (Math.abs(dA - dB) > 0.5) return dA - dB;
    return (b.rating ?? 0) - (a.rating ?? 0);
  });
}

function dedupeByName(results: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of results) {
    const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values()).slice(0, 50);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hashKey(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) {
    h = (h << 5) - h + v.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

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
