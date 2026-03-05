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

    // Step 2: Fetch from all platforms in parallel
    if (!YELP_API_KEY) {
      console.warn("YELP_API_KEY missing — skipping Yelp to avoid low-confidence reservation results");
    }

    const [resyCandidates, otCandidates, yelpResults] = await Promise.all([
      searchFirecrawl(params, FIRECRAWL_API_KEY, "resy"),
      searchFirecrawl(params, FIRECRAWL_API_KEY, "opentable"),
      YELP_API_KEY
        ? fetchYelpWithReservations(params, YELP_API_KEY, FIRECRAWL_API_KEY)
        : Promise.resolve([] as Restaurant[]),
    ]);

    // Normalize Firecrawl results into Restaurant objects
    const resyRaw = normalizeCandidates("resy", resyCandidates, params);
    const otRaw = normalizeCandidates("opentable", otCandidates, params);

    // Step 2b: Verify Resy/OT pages actually exist (HEAD check)
    const [resyResults, otResults] = await Promise.all([
      verifyPlatformUrls(resyRaw),
      verifyPlatformUrls(otRaw),
    ]);
    console.log(`Verified — Resy: ${resyResults.length}/${resyRaw.length}, OT: ${otResults.length}/${otRaw.length}`);

    const allResults = dedupeByName([...resyResults, ...otResults, ...yelpResults]);
    console.log(`Results — Resy: ${resyResults.length}, OT: ${otResults.length}, Yelp: ${yelpResults.length}, deduped: ${allResults.length}`);

    // Step 3: Enrich with AI (ratings, cuisine, neighborhood, coords)
    const enriched = await enrichWithAI(allResults, LOVABLE_API_KEY, params);

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
- Convert suburbs to major metro city (e.g. "North Druid Hills" => "Atlanta")
- dinner/tonight defaults to time "19:00", lunch = "12:00"

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
              cuisine: { type: "string" }, date: { type: "string" },
              time: { type: "string" }, partySize: { type: "number" },
              city: { type: "string" }, state: { type: "string" },
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
  const INVALID_CITY = new Set(["unknown", "n/a", "none", "unspecified", ""]);
  parsed.city = INVALID_CITY.has((parsed.city || "").trim().toLowerCase()) ? "" : parsed.city?.trim() || "";
  parsed.state = INVALID_CITY.has((parsed.state || "").trim().toLowerCase()) ? "" : parsed.state?.trim() || "";
  // If city is still empty, try reverse-geocoding from coords or default to Atlanta
  if (!parsed.city) {
    if (lat && lng) {
      try {
        const revResp = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
          { headers: { "User-Agent": "TableFinder/1.0" } }
        );
        const revData = await revResp.json();
        parsed.city = revData.address?.city || revData.address?.town || "Atlanta";
        parsed.state = revData.address?.state_code || revData.address?.state || "GA";
      } catch {
        parsed.city = "Atlanta";
        parsed.state = "GA";
      }
    } else {
      parsed.city = "Atlanta";
      parsed.state = "GA";
    }
  }
  if (!parsed.state) parsed.state = "GA";
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

// ─── Firecrawl web search for Resy / OpenTable ───

interface FirecrawlResult {
  url: string;
  title?: string;
  description?: string;
}

async function searchFirecrawl(
  params: SearchParams, firecrawlKey: string, platform: "resy" | "opentable" | "yelp"
): Promise<FirecrawlResult[]> {
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const city = params.city;
  const resyCitySlug = getResyCitySlug(params);

  const queries = platform === "resy"
    ? [
        `site:resy.com/cities/${resyCitySlug}/venues/ ${city}${cuisine} reservation`,
        `site:resy.com/cities/${resyCitySlug}/venues/ ${city}${cuisine} book table`,
      ]
    : platform === "opentable"
    ? [
        `site:opentable.com/r ${city}${cuisine} restaurant reserve`,
        `site:opentable.com ${city}${cuisine} opentable reservation`,
      ]
    : [
        `site:yelp.com/reservations ${city}${cuisine}`,
        `site:yelp.com/biz ${city}${cuisine} reservation`,
      ];

  console.log(`Firecrawl ${platform} queries:`, JSON.stringify(queries));

  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        const resp = await fetch(`${FIRECRAWL_API}/search`, {
          method: "POST",
          headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: 20 }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          console.error(`${platform} search failed:`, resp.status);
          return [] as FirecrawlResult[];
        }
        return (data?.data || []) as FirecrawlResult[];
      } catch {
        return [] as FirecrawlResult[];
      }
    })
  );

  // Dedupe by base URL + platform-specific validity gate
  const map = new Map<string, FirecrawlResult>();
  for (const r of results.flat()) {
    if (!r?.url) continue;
    if (!isPlatformCandidateUrlValid(platform, r.url, params)) continue;
    const key = r.url.split("?")[0].toLowerCase();
    if (!map.has(key)) map.set(key, r);
  }
  const deduped = Array.from(map.values());
  console.log(`${platform} candidates: ${deduped.length}`);
  return deduped;
}

function slugify(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getResyCitySlug(params: SearchParams): string {
  const city = slugify(params.city || "");
  const state = slugify(params.state || "");
  return state ? `${city}-${state}` : city;
}

function isPlatformCandidateUrlValid(
  platform: "resy" | "opentable" | "yelp",
  rawUrl: string,
  params: SearchParams
): boolean {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();

    if (platform === "resy") {
      const m = p.match(/^\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
      if (!m) return false;
      const citySlug = m[1];
      return citySlug === getResyCitySlug(params).toLowerCase();
    }

    if (platform === "opentable") {
      return /^\/r\/[^/?#]+/i.test(p);
    }

    // Yelp candidates from web search are low-confidence by default, keep only reservation pages.
    return /^\/reservations\/[^/?#]+/i.test(p);
  } catch {
    return false;
  }
}

// ─── Normalize Firecrawl results → Restaurant objects ───

function normalizeCandidates(
  platform: "resy" | "opentable" | "yelp", candidates: FirecrawlResult[], params: SearchParams
): Restaurant[] {
  return candidates
    .map((c) => {
      const canonUrl = extractCanonicalUrl(platform, c.url);
      if (!canonUrl) return null;

      const name = cleanName(c.title, canonUrl, platform);
      const bookingUrl = platform === "resy"
        ? addResyParams(canonUrl, params)
        : platform === "opentable"
        ? addOTParams(canonUrl, params)
        : canonUrl;

      return {
        id: `${platform}-${hashKey(canonUrl)}`,
        name,
        cuisine: params.cuisine || "Restaurant",
        neighborhood: params.city,
        rating: undefined,
        priceRange: undefined,
        imageUrl: null,
        platform,
        platformUrl: bookingUrl,
        timeSlots: [],
        distanceMiles: null,
      } as Restaurant;
    })
    .filter(Boolean) as Restaurant[];
}

// Generic Resy pages that are NOT individual restaurants
const RESY_EXCLUDED_SLUGS = new Set([
  "venues", "search", "explore", "about", "faq", "gift-cards",
  "events", "blog", "careers", "press", "terms", "privacy",
]);

function extractCanonicalUrl(platform: "resy" | "opentable" | "yelp", raw: string): string | null {
  try {
    const u = new URL(raw);
    const p = u.pathname;
    if (platform === "resy") {
      // Strictly require restaurant pages: /cities/{city}/venues/{venue-slug}
      const venueMatch = p.match(/^\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
      if (!venueMatch) return null;
      const citySlug = venueMatch[1];
      const venueSlug = venueMatch[2].toLowerCase();
      if (!venueSlug || RESY_EXCLUDED_SLUGS.has(venueSlug)) return null;
      return `https://resy.com/cities/${citySlug}/venues/${venueMatch[2]}`;
    }
    if (platform === "opentable") {
      const m = p.match(/^\/r\/[^/?#]+/i);
      return m ? `https://www.opentable.com${m[0]}` : null;
    }
    // Yelp: only reservation pages count as valid booking URLs
    const resMatch = p.match(/^\/reservations\/[^/?#]+/i);
    return resMatch ? `https://www.yelp.com${resMatch[0]}` : null;
  } catch { return null; }
}

function addResyParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("date", p.date);
    u.searchParams.set("seats", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

function addOTParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("dateTime", `${p.date}T${p.time}`);
    u.searchParams.set("covers", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

function cleanName(title: string | undefined, url: string, platform: string): string {
  if (title) {
    const cleaned = title
      .replace(/\s*\|.*$/i, "")
      .replace(/\s*-\s*(resy|opentable|yelp).*$/i, "")
      .replace(/^book\s+(your\s+)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*\w+,?\s*\w{2}$/i, "") // trailing "- Atlanta, GA"
      .trim();
    if (cleaned.length > 1) return cleaned;
  }
  const parts = url.split("/");
  const slug = parts[parts.length - 1] || "restaurant";
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ─── Yelp Fusion API: search for restaurants that accept reservations ───

async function fetchYelpWithReservations(
  params: SearchParams, yelpKey: string, firecrawlKey: string
): Promise<Restaurant[]> {
  try {
    // First try with reservation attribute
    const sp = new URLSearchParams({
      term: `${params.cuisine || ""} restaurants`.trim(),
      location: `${params.city}, ${params.state}`,
      limit: "20",
      sort_by: "best_match",
      attributes: "reservation",
    });
    if (params.lat && params.lng) {
      sp.set("latitude", String(params.lat));
      sp.set("longitude", String(params.lng));
    }

    console.log("Yelp search (reservation):", sp.toString());
    let resp = await fetch(`${YELP_API}/businesses/search?${sp}`, {
      headers: { Authorization: `Bearer ${yelpKey}` },
    });

    let data: any;
    if (resp.ok) {
      data = await resp.json();
    }

    let businesses = data?.businesses || [];

    // If reservation filter returned few results, broaden and keep reservation-capable transactions only.
    if (businesses.length < 5) {
      console.log(`Yelp reservation filter returned only ${businesses.length}, trying broader search`);
      sp.delete("attributes");
      const resp2 = await fetch(`${YELP_API}/businesses/search?${sp}`, {
        headers: { Authorization: `Bearer ${yelpKey}` },
      });
      if (resp2.ok) {
        const data2 = await resp2.json();
        const broader = (data2.businesses || []).filter((b: any) =>
          b.transactions?.includes("restaurant_reservation")
        );
        const seen = new Set(businesses.map((b: any) => b.id));
        for (const b of broader) {
          if (!seen.has(b.id)) {
            businesses.push(b);
            seen.add(b.id);
          }
        }
      }
    }

    console.log(`Yelp pre-verify: ${businesses.length} reservation-capable businesses`);

    const mapped = businesses
      .filter((b: any) => !!b.alias)
      .map((b: any): Restaurant => ({
        id: `yelp-${b.id}`,
        name: b.name,
        cuisine: b.categories?.[0]?.title || params.cuisine || "Restaurant",
        neighborhood: b.location?.neighborhood || b.location?.city || params.city,
        rating: b.rating,
        priceRange: b.price || undefined,
        imageUrl: b.image_url || null,
        platform: "yelp",
        platformUrl: buildYelpAvailabilityUrl(`https://www.yelp.com/reservations/${b.alias}`, params),
        timeSlots: [],
        distanceMiles: b.distance ? +(b.distance / 1609.34).toFixed(1) : null,
      }));

    const verified = await verifyYelpAvailabilityWithFirecrawl(mapped, params, firecrawlKey);
    console.log(`Yelp verified available: ${verified.length}/${mapped.length}`);
    return verified;
  } catch (err) {
    console.error("Yelp error:", err);
    return [];
  }
}

async function verifyYelpAvailabilityWithFirecrawl(
  candidates: Restaurant[],
  params: SearchParams,
  firecrawlKey: string
): Promise<Restaurant[]> {
  const limited = candidates.slice(0, 10);
  const keep: Restaurant[] = [];

  for (let i = 0; i < limited.length; i += 10) {
    const batch = limited.slice(i, i + 10);
    const checked = await Promise.all(batch.map(async (r) => {
      const verifyUrl = buildYelpAvailabilityUrl(r.platformUrl, params);

      try {
        const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${firecrawlKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: verifyUrl,
            formats: ["markdown"],
            onlyMainContent: true,
          }),
        });

        if (!resp.ok) return null;
        const data = await resp.json();
        const markdown = extractFirecrawlMarkdown(data).toLowerCase();
        if (!markdown) return null;

        const blocked = [
          "not currently accepting reservations",
          "this business is not currently accepting reservations",
          "no availability",
          "temporarily unavailable",
        ];
        if (blocked.some((phrase) => markdown.includes(phrase))) return null;

        const requestedTime = toTwelveHourLabel(params.time).toLowerCase();
        const hasAnyTimes = /\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(markdown);
        const hasRequestedTime = requestedTime ? markdown.includes(requestedTime) : false;

        return hasRequestedTime || hasAnyTimes ? r : null;
      } catch {
        return null;
      }
    }));

    for (const item of checked) {
      if (item) keep.push(item);
    }
  }

  return keep;
}

function buildYelpAvailabilityUrl(baseUrl: string, params: SearchParams): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("covers", String(params.partySize));
    u.searchParams.set("date", params.date);
    u.searchParams.set("time", params.time.replace(":", ""));
    return u.toString();
  } catch {
    return baseUrl;
  }
}

function extractFirecrawlMarkdown(data: any): string {
  return data?.data?.markdown || data?.markdown || "";
}

function toTwelveHourLabel(time24: string): string {
  const m = time24.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = Number(m[1]);
  const minutes = m[2];
  const ampm = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 || 12;
  return `${hour12}:${minutes} ${ampm}`;
}

// ─── AI enrichment ───

async function enrichWithAI(results: Restaurant[], apiKey: string, params: SearchParams): Promise<Restaurant[]> {
  if (results.length === 0) return [];

  const list = results.map((r, i) => `${i}. ${r.name} (${r.platform})`).join("\n");

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `For each restaurant in ${params.city}, ${params.state}, provide:
- index, rating (Google Maps /5), cuisine type, neighborhood, priceRange ($-$$$$), lat, lng

Return JSON: { "restaurants": [{ "index": number, "rating": number, "cuisine": string, "neighborhood": string, "priceRange": string, "lat": number, "lng": number }] }

Return an entry for EVERY restaurant:

${list}`,
        }],
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) { await resp.text(); return results; }

    const aiData = await resp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return results;

    const parsed = JSON.parse(content);
    const enrichments = parsed.restaurants || [];
    const eMap = new Map<number, any>();
    for (const e of enrichments) {
      if (typeof e.index === "number") eMap.set(e.index, e);
    }

    const userLat = params.lat || 0;
    const userLng = params.lng || 0;

    const enriched = results.map((r, i) => {
      const e = eMap.get(i);
      if (!e) return r;

      let dist = r.distanceMiles;
      if (!dist && e.lat && e.lng && userLat && userLng) {
        dist = haversine(userLat, userLng, e.lat, e.lng);
      }

      return {
        ...r,
        rating: e.rating ?? r.rating,
        cuisine: e.cuisine || r.cuisine,
        neighborhood: e.neighborhood || r.neighborhood,
        priceRange: e.priceRange || r.priceRange,
        distanceMiles: dist,
      };
    });

    return enriched.sort((a, b) => {
      const dA = a.distanceMiles ?? 9999;
      const dB = b.distanceMiles ?? 9999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
  } catch (err) {
    console.error("AI enrich error:", err);
    return results;
  }
}

// ─── Verify platform URLs actually exist (HEAD check) ───

async function verifyPlatformUrls(restaurants: Restaurant[]): Promise<Restaurant[]> {
  // Process in batches of 10 to avoid overwhelming the target
  const keep: Restaurant[] = [];
  for (let i = 0; i < restaurants.length; i += 10) {
    const batch = restaurants.slice(i, i + 10);
    const checked = await Promise.all(
      batch.map(async (r) => {
        try {
          const checkUrl = r.platformUrl.split("?")[0];
          const resp = await fetch(checkUrl, {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": "Mozilla/5.0 (compatible; TableFinder/1.0)" },
          });
          const body = await resp.text();
          const lower = body.toLowerCase();

          // Hard reject on non-200
          if (!resp.ok) {
            console.log(`Dropping ${r.platform} (${resp.status}): ${checkUrl}`);
            return null;
          }

          // OT-specific: check for "we can't find that restaurant" or redirect to search
          if (r.platform === "opentable") {
            const otBadSignals = [
              "we couldn't find",
              "we can't find",
              "page not found",
              "this restaurant is no longer",
              "restaurant not found",
              "no longer available on opentable",
              "looking for something else",
            ];
            if (otBadSignals.some((s) => lower.includes(s))) {
              console.log(`Dropping OT (content signals not-found): ${checkUrl}`);
              return null;
            }
            // Check for redirect to homepage or search
            const finalUrl = resp.url || checkUrl;
            if (finalUrl.includes("/s?") || finalUrl === "https://www.opentable.com/" || finalUrl === "https://www.opentable.com") {
              console.log(`Dropping OT (redirected to search/home): ${checkUrl}`);
              return null;
            }
          }

          // Resy-specific
          if (r.platform === "resy") {
            const resyBadSignals = ["page not found", "404", "venue not found"];
            if (resyBadSignals.some((s) => lower.includes(s))) {
              console.log(`Dropping Resy (not-found): ${checkUrl}`);
              return null;
            }
          }

          return r;
        } catch {
          return r; // network error — keep (benefit of the doubt)
        }
      })
    );
    for (const item of checked) {
      if (item) keep.push(item);
    }
  }
  return keep;
}

// ─── Utilities ───

function dedupeByName(results: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of results) {
    const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seen.has(key)) seen.set(key, r);
  }
  return Array.from(seen.values()).slice(0, 60);
}

function hashKey(v: string): string {
  let h = 0;
  for (let i = 0; i < v.length; i++) { h = (h << 5) - h + v.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
