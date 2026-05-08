// TableFinder Search Edge Function — v2 clean rebuild
// Platforms: Resy (Firecrawl), OpenTable (JSON API + Apify fallback), Yelp (Firecrawl)
// Deploy: paste into your Lovable project at supabase/functions/search/index.ts
//
// Required env vars (Lovable → Settings → Environment Variables):
//   FIRECRAWL_API_KEY   — you have this
//   LOVABLE_API_KEY     — already in your project
//
// Optional env vars (add these to unlock features):
//   APIFY_API_TOKEN     — get from apify.com → Settings → Integrations
//                         Enables OpenTable via Apify actor (most reliable OT path)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const AI_GATEWAY   = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FC_API       = "https://api.firecrawl.dev/v2";
const APIFY_API    = "https://api.apify.com/v2";
const NOMINATIM    = "https://nominatim.openstreetmap.org";

const GLOBAL_TIMEOUT   = 115_000;
const DISCOVERY_BUDGET =  12_000;
const VERIFY_BUDGET    =  10_000;

const PHOTON = "https://photon.komoot.io/api";  // OSM geocoder, no rate limits

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TimeSlot {
  time: string;
  url?: string;   // platform booking URL pre-filled with this slot's time
}

interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  description?: string;
  vibeTags?: string[];
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
  softVerified?: boolean;   // Yelp: reservation widget found but no extractable times
  // internal
  _lat?: number;
  _lng?: number;
  _slug?: string;
  _rid?: string;
  _preVerified?: boolean;
  _address?: string;        // street address extracted during verification, used as geocoding fallback
}

interface SearchParams {
  cuisine: string;
  cuisineType: string;
  dishKeyword: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM 24h
  partySize: number;
  city: string;
  state: string;
  country: string;    // "us" | "gb"
  lat?: number;
  lng?: number;
}

interface SearchMeta {
  date: string;       // formatted display e.g. "Tonight"
  dateRaw: string;    // YYYY-MM-DD
  time: string;
  partySize: number;
  city: string;
  state?: string;
  country?: string;
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const start = Date.now();
  const globalTimer = setTimeout(() => {/* will be cleared */}, GLOBAL_TIMEOUT);

  try {
    const body = await req.json();
    const FIRECRAWL = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
    const AI_KEY    = Deno.env.get("LOVABLE_API_KEY") ?? "";
    const APIFY     = Deno.env.get("APIFY_API_TOKEN") ?? "";

    // Extended search (second pass on remaining candidates)
    if (body.extended === true) {
      const extra = await runExtendedSearch(body, FIRECRAWL, AI_KEY, APIFY, start);
      return json({ results: extra });
    }

    const { query, lat, lng, location } = body;
    const params = await parseQuery(query, lat, lng, location, AI_KEY);
    console.log(`[params] ${JSON.stringify(params)}`);

    // Discovery: all 3 platforms in parallel, hard-capped
    const [resyCands, otCands, yelpCands] = await Promise.all([
      withTimeout(discoverResy(params, FIRECRAWL),                   DISCOVERY_BUDGET, []),
      withTimeout(discoverOpenTable(params, FIRECRAWL, APIFY),       DISCOVERY_BUDGET, []),
      withTimeout(discoverYelp(params, FIRECRAWL),                   DISCOVERY_BUDGET, []),
    ]);
    console.log(`[discovery] resy=${resyCands.length} ot=${otCands.length} yelp=${yelpCands.length} at ${Date.now()-start}ms`);

    // Allocate: Yelp capped at 12, others at 18
    const resySlice  = resyCands.slice(0, 18);
    const otSlice    = otCands.slice(0, 18);
    const yelpSlice  = yelpCands.slice(0, 12);

    // Verification: all 3 lanes in parallel, hard-capped
    const verifyStart = Date.now();
    const [resyVer, otVer, yelpVer] = await Promise.all([
      withTimeout(verifyBatch(resySlice,  params, FIRECRAWL, start), VERIFY_BUDGET, []),
      withTimeout(verifyBatch(otSlice,    params, FIRECRAWL, start), VERIFY_BUDGET, []),
      withTimeout(verifyBatch(yelpSlice,  params, FIRECRAWL, start), VERIFY_BUDGET, []),
    ]);
    console.log(`[verify] resy=${resyVer.length} ot=${otVer.length} yelp=${yelpVer.length} in ${Date.now()-verifyStart}ms`);

    let verified = dedup([...resyVer, ...otVer, ...yelpVer]);

    // Separate soft-verified (Yelp widget found but no extractable times) — cap at 3
    const softVerifiedResults = verified.filter(r => r.softVerified).slice(0, 3);
    const hardVerified = verified.filter(r => !r.softVerified);

    // Geocode + enrich in parallel — both are optional enrichments with hard caps
    const [ranked] = await Promise.all([
      geocodeAndRank(hardVerified, params, AI_KEY),
      withTimeout(enrich(hardVerified, params, AI_KEY), 10_000, hardVerified),
    ]);
    verified = [...ranked, ...softVerifiedResults];

    // Remaining candidates for optional second pass (deduped)
    const verifiedIds = new Set(verified.map(r => r.id));
    const attempted   = new Set([...resySlice, ...otSlice, ...yelpSlice].map(r => r.id));
    const remaining = dedup(
      [...resyCands, ...otCands, ...yelpCands]
        .filter(r => !attempted.has(r.id) && !verifiedIds.has(r.id))
    ).slice(0, 18);

    const meta: SearchMeta = {
      date: formatDisplayDate(params.date),
      dateRaw: params.date,
      time: formatDisplayTime(params.time),
      partySize: params.partySize,
      city: params.city,
      state: params.state,
      country: params.country,
    };

    console.log(`[done] ${verified.length} results in ${Date.now() - start}ms`);
    clearTimeout(globalTimer);
    return json({
      results: verified.slice(0, 24),
      params: meta,
      hasMore: remaining.length > 0,
      remainingCandidates: remaining,
      _v: "v7-ot-search-page",
    });

  } catch (err: any) {
    clearTimeout(globalTimer);
    console.error("[error]", err);
    return json({ error: err?.message ?? "Search failed. Please try again." }, 500);
  }
});

// ─── PIPELINE: DISCOVER + VERIFY PER PLATFORM ────────────────────────────────
// Pipelines discovery directly into verification so each platform doesn't wait
// for the others to finish discovery before its own verification starts.

async function discoverAndVerify(
  platform: "resy" | "opentable" | "yelp",
  params: SearchParams,
  fcKey: string,
  apifyToken: string,
  globalStart: number,
): Promise<[Restaurant[], Restaurant[]]> {
  // Discover
  let candidates: Restaurant[] = [];
  try {
    if (platform === "resy")      candidates = await withTimeout(discoverResy(params, fcKey),                   DISCOVERY_BUDGET, []);
    if (platform === "opentable") candidates = await withTimeout(discoverOpenTable(params, fcKey, apifyToken),  DISCOVERY_BUDGET, []);
    if (platform === "yelp")      candidates = await withTimeout(discoverYelp(params, fcKey),                   DISCOVERY_BUDGET, []);
  } catch { candidates = []; }

  console.log(`[discover:${platform}] ${candidates.length} candidates`);

  // Allocate — Yelp capped at 5, others at 7
  const cap = platform === "yelp" ? 5 : 7;
  const toVerify = candidates.slice(0, cap);

  // Verify immediately
  const verified = await withTimeout(
    verifyBatch(toVerify, params, fcKey, globalStart),
    VERIFY_BUDGET,
    [],
  );
  console.log(`[verify:${platform}] ${verified.length}/${toVerify.length} verified`);

  return [verified, candidates];
}

// ─── EXTENDED SEARCH ─────────────────────────────────────────────────────────

async function runExtendedSearch(
  body: any, FIRECRAWL: string, AI_KEY: string, APIFY: string, start: number
): Promise<Restaurant[]> {
  const { remainingCandidates, extendedParams } = body;
  if (!remainingCandidates?.length) return [];

  // extendedParams arrives from the frontend as SearchMeta (display strings).
  // Normalise back to proper SearchParams before using.
  const rawDate = extendedParams.dateRaw || extendedParams.date || new Date().toISOString().split("T")[0];
  const rawTime = /^\d{2}:\d{2}$/.test(extendedParams.time ?? "")
    ? extendedParams.time
    : displayTo24(extendedParams.time ?? "7:00 PM");

  const params: SearchParams = {
    cuisine:     extendedParams.cuisine     ?? "",
    cuisineType: extendedParams.cuisineType ?? "",
    dishKeyword: extendedParams.dishKeyword ?? "",
    date:        rawDate,
    time:        rawTime,
    partySize:   Number(extendedParams.partySize) || 2,
    city:        extendedParams.city   ?? "",
    state:       extendedParams.state  ?? "",
    country:     extendedParams.country ?? "us",
    lat:         body.lat ?? extendedParams.lat,
    lng:         body.lng ?? extendedParams.lng,
  };

  const batch = (remainingCandidates as Restaurant[]).slice(0, 18);

  const [resyVer, otVer, yelpVer] = await Promise.all([
    withTimeout(verifyBatch(batch.filter(r => r.platform === "resy"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
    withTimeout(verifyBatch(batch.filter(r => r.platform === "opentable"), params, FIRECRAWL, start), VERIFY_BUDGET, []),
    withTimeout(verifyBatch(batch.filter(r => r.platform === "yelp"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
  ]);

  let verified = dedup([...resyVer, ...otVer, ...yelpVer]);
  const [ranked] = await Promise.all([
    geocodeAndRank(verified, params, AI_KEY),
    withTimeout(enrich(verified, params, AI_KEY), 10_000, verified),
  ]);
  return ranked;
}

// ─── QUERY PARSING ────────────────────────────────────────────────────────────

async function parseQuery(
  query: string, lat?: number, lng?: number, location?: string, aiKey?: string
): Promise<SearchParams> {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  const prompt = `Extract restaurant search parameters from this query. Today is ${todayStr}.

Rules:
- date: YYYY-MM-DD. "tonight" / "today" = ${todayStr}. "tomorrow" = next day. Day names = nearest upcoming.
- time: HH:MM in 24h. Default 19:00. "lunch" ≈ 12:00, "brunch" ≈ 11:00, "dinner" ≈ 19:00.
- partySize: integer. Default 2.
- city: city name. Use the location context if the query omits a city. Do not guess — just use whatever city name is most appropriate for the coordinates provided.
- state: 2-letter US code or empty for UK.
- country: "us" or "gb". Default "us".
- cuisine: specific cuisine or dish type (e.g. "Italian", "sushi", "steakhouse").
- cuisineType: broad category (e.g. "italian", "japanese", "american").
- dishKeyword: specific dish if mentioned (e.g. "oysters", "ramen").

Location context: ${location ?? (lat && lng ? `${lat},${lng}` : "unknown")}
Query: "${query}"

Respond with ONLY valid JSON matching this shape (no markdown):
{"cuisine":"","cuisineType":"","dishKeyword":"","date":"","time":"","partySize":2,"city":"","state":"","country":"us"}`;

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) throw new Error(`AI gateway ${resp.status}`);
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

    return {
      cuisine:     parsed.cuisine     || "",
      cuisineType: parsed.cuisineType || "",
      dishKeyword: parsed.dishKeyword || "",
      date:        parsed.date        || todayStr,
      time:        parsed.time        || "19:00",
      partySize:   Number(parsed.partySize) || 2,
      city:        parsed.city        || extractCityFromLocation(location),
      state:       (parsed.state      || "").toUpperCase().slice(0, 2),
      country:     parsed.country     || "us",
      lat, lng,
    };
  } catch (err) {
    console.error("[parseQuery]", err);
    // Fallback: basic defaults
    return {
      cuisine: "", cuisineType: "", dishKeyword: "",
      date: todayStr, time: "19:00", partySize: 2,
      city: extractCityFromLocation(location) || "New York",
      state: "NY", country: "us", lat, lng,
    };
  }
}

function extractCityFromLocation(loc?: string): string {
  if (!loc) return "";
  const parts = loc.split(",");
  return parts[0]?.trim() || "";
}

// ─── RESY DISCOVERY ───────────────────────────────────────────────────────────

async function discoverResy(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const slug = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const metro = resyCityName(params.city, params.state, params.lat, params.lng);
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";

  const queries = [
    `site:resy.com/cities/${slug}/venues/ ${metro}${cuisine} restaurant reservation`,
    `site:resy.com/cities/${slug}/venues/ ${metro}${cuisine} dinner reservation`,
    `site:resy.com/cities/${slug}/venues/ ${metro} restaurant book table`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  return results
    .map(r => normToResy(r, params))
    .filter(Boolean) as Restaurant[];
}

function normToResy(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  const m = url.match(/resy\.com\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[2].toLowerCase();
  if (RESY_SKIP.has(slug)) return null;

  const canonUrl = `https://resy.com/cities/${m[1]}/venues/${m[2]}`;
  const bookingUrl = addResyParams(canonUrl, params);

  return {
    id: `resy-${slug}`,
    name: cleanTitle(fc.title, url, "resy"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "resy",
    platformUrl: bookingUrl,
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

const RESY_SKIP = new Set(["venues","search","explore","about","faq","gift-cards","events","blog","careers","press","terms","privacy"]);

// ─── OPENTABLE DISCOVERY ──────────────────────────────────────────────────────

async function discoverOpenTable(params: SearchParams, fcKey: string, apifyToken: string): Promise<Restaurant[]> {
  // If Apify is configured, use it for discovery + verification in one step
  if (apifyToken) {
    return discoverOTviaApify(params, apifyToken);
  }

  // Primary: scrape OT's own search-results page.
  // Google-index search for opentable.com returns homepages/search pages, not
  // individual /r/ pages — OT individual pages are not well-indexed. Scraping
  // the search results page directly gives us restaurant cards with /r/ links.
  if (params.lat != null && params.lng != null) {
    const fromPage = await discoverOTviaSearchPage(params, fcKey);
    if (fromPage.length > 0) return fromPage;
    console.log("[OT search page] returned 0, falling back to web search");
  }

  // Fallback: web search (last resort — usually returns 0 for OT)
  return discoverOTviaWebSearch(params, fcKey);
}

async function discoverOTviaSearchPage(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const cuisine = params.cuisine ? encodeURIComponent(params.cuisine) : "";
  const searchUrl = [
    `https://www.opentable.com/s`,
    `?covers=${params.partySize}`,
    `&dateTime=${params.date}T${params.time}`,
    `&latitude=${params.lat!.toFixed(4)}`,
    `&longitude=${params.lng!.toFixed(4)}`,
    `&radius=10`,
    cuisine ? `&term=${cuisine}` : "",
  ].join("");

  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: searchUrl,
        formats: ["markdown", "links"],
        onlyMainContent: false,   // need full page to capture restaurant card links
        waitFor: 4000,
        timeout: 14000,
      }),
    });
    if (!resp.ok) {
      console.log(`[OT search page] HTTP ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    const rawLinks: any[] = data.data?.links ?? [];
    const links: string[] = rawLinks.map(l => (typeof l === "string" ? l : l.url ?? "")).filter(Boolean);

    console.log(`[OT search page] ${md.length} chars, ${links.length} links, url=${searchUrl}`);

    if (md.length < 200) return [];
    if (/access denied|security check|enable javascript|are you a robot/i.test(md)) {
      console.log("[OT search page] Akamai block detected");
      return [];
    }

    // Collect /r/ URLs from the links array (most reliable)
    const otUrls = links.filter(l => /opentable\.com\/r\/[a-z0-9][a-z0-9-]{2,}/i.test(l));

    // Also regex-scan the markdown text for any /r/ slugs
    const mdMatches = [...md.matchAll(/opentable\.com\/r\/([a-z0-9][a-z0-9-]{2,})/gi)]
      .map(m => `https://www.opentable.com/r/${m[1]}`);

    const allUrls = [...new Set([...otUrls, ...mdMatches])];
    console.log(`[OT search page] ${allUrls.length} unique /r/ URLs found`);

    return allUrls
      .map(url => normToOT({ url, title: "", description: "" }, params))
      .filter(Boolean) as Restaurant[];
  } catch (err) {
    console.error("[OT search page]", err);
    return [];
  }
}

async function discoverOTviaWebSearch(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";

  const queries = [
    `site:${domain} ${city}${cuisine} restaurant reservations`,
    `site:${domain} ${city}${cuisine} dinner book table`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  const mapped = results.map(r => normToOT(r, params)).filter(Boolean) as Restaurant[];
  console.log(`[OT web search] ${results.length} raw → ${mapped.length} valid`);
  return mapped;
}

async function discoverOTviaApify(params: SearchParams, token: string): Promise<Restaurant[]> {
  // Apify canadesk/opentable actor — returns verified results with time slots
  // so we skip individual verification for these
  try {
    const input = {
      location: `${params.city}, ${params.state || params.country.toUpperCase()}`,
      date: params.date,
      time: params.time.replace(":", ""),
      covers: params.partySize,
      keyword: params.cuisine || undefined,
      maxItems: 15,
    };
    const resp = await fetch(
      `${APIFY_API}/acts/canadesk~opentable/run-sync-get-dataset-items?token=${token}&timeout=50&memory=256`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    if (!resp.ok) {
      console.warn(`[Apify OT] ${resp.status} — falling back to Firecrawl search`);
      return [];
    }
    const items: any[] = await resp.json();
    console.log(`[Apify OT] ${items.length} results`);

    return items.flatMap(item => {
      // Each item may have multiple available time slots, each with its own booking link
      const slots: TimeSlot[] = [];
      const bookingUrl = item.link ?? item.url ?? item.bookingUrl ?? "";

      if (Array.isArray(item.availableSlots)) {
        for (const s of item.availableSlots) {
          const t = s.time ?? parseTimeFromDT(s.dateTime ?? s.link ?? "");
          if (t) slots.push({ time: t });
        }
      } else if (item.availableTimes) {
        for (const t of (item.availableTimes as string[])) slots.push({ time: t });
      }

      // Filter slots to ±2hr window
      const filtered = filterWindow(slots, params.time);
      if (filtered.length === 0 && !item.name) return [];

      const rid = extractRid(bookingUrl);
      const baseOTUrl = (bookingUrl || `https://www.opentable.com/r/${slugify(item.name||"")}`).split("?")[0];
      const slotsWithUrls = filtered.map(s => ({
        ...s,
        url: buildSlotUrl("opentable", baseOTUrl, params, s.time),
      }));

      return [{
        id: `opentable-${rid || slugify(item.name || "")}`,
        name: item.name ?? item.restaurantName ?? "Restaurant",
        cuisine: item.cuisine ?? params.cuisine ?? "Restaurant",
        neighborhood: item.neighborhood ?? item.location ?? params.city,
        rating: item.stars ?? item.rating,
        reviewCount: item.reviewCount ?? item.reviews,
        priceRange: item.priceRange ?? item.price,
        platform: "opentable" as const,
        platformUrl: addOTParams(baseOTUrl, params),
        timeSlots: slotsWithUrls,
        distanceMiles: null,
        _lat: item.lat, _lng: item.lng,
        _preVerified: slotsWithUrls.length > 0,
        _rid: rid ?? undefined,
      }];
    }).filter(r => r.name);
  } catch (err) {
    console.error("[Apify OT]", err);
    return [];
  }
}

function normToOT(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";

  // Match /r/slug (canonical) or /restaurant/profile/NNN (legacy numeric)
  const mSlug = url.match(/opentable\.(?:com|co\.uk)\/r\/([^/?#]+)/i);
  const mNum  = url.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
  if (!mSlug && !mNum) return null;

  const slug = mSlug ? mSlug[1] : mNum![1];
  // Always canonicalise to /r/ path
  const baseUrl = mSlug
    ? `https://www.${domain}/r/${slug}`
    : `https://www.${domain}/r/${slug}`;  // numeric: OT redirects /r/NNN → correct page
  const rid = mNum ? mNum[1] : extractRid(url);

  return {
    id: `opentable-${slug}`,
    name: cleanTitle(fc.title, url, "opentable"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "opentable",
    platformUrl: addOTParams(baseUrl, params),
    timeSlots: [],
    distanceMiles: null,
    _rid: rid ?? undefined,
  };
}

// ─── YELP DISCOVERY ───────────────────────────────────────────────────────────

async function discoverYelp(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  // Use metro city name when coordinates available (avoids poor results for suburbs)
  const metroCity = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const city = metroCity;
  const state = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain = params.country === "gb" ? "yelp.co.uk" : "yelp.com";

  const queries = [
    `site:${domain}/reservations/ ${city}${state}${cuisine} restaurant`,
    `site:${domain}/reservations/ ${city}${state}${cuisine} dinner reservation`,
    `site:${domain}/reservations/ ${city}${state} restaurant book table`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  return results
    .map(r => normToYelp(r, params))
    .filter(Boolean) as Restaurant[];
}

function normToYelp(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  const mRes = url.match(/yelp\.com\/reservations\/([^/?#]+)/i);
  const mBiz = url.match(/yelp\.com\/biz\/([^/?#]+)/i);
  const slug = mRes?.[1] ?? mBiz?.[1];
  if (!slug) return null;

  const canonUrl = `https://www.yelp.com/reservations/${slug}`;

  return {
    id: `yelp-${slug}`,
    name: cleanTitle(fc.title, url, "yelp"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "yelp",
    platformUrl: addYelpParams(canonUrl, params),
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

async function verifyBatch(
  candidates: Restaurant[],
  params: SearchParams,
  fcKey: string,
  globalStart: number,
): Promise<Restaurant[]> {
  if (candidates.length === 0) return [];

  const results: Restaurant[] = [];
  const CONCURRENCY = 6;
  const LANE_TARGET = 8;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (results.length >= LANE_TARGET) break;
    if (Date.now() - globalStart > VERIFY_BUDGET + 40_000) break;

    const batch = candidates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(r => verifyOne(r, params, fcKey, globalStart)));
    results.push(...batchResults.filter(Boolean) as Restaurant[]);
  }

  return results;
}

async function verifyOne(
  r: Restaurant,
  params: SearchParams,
  fcKey: string,
  globalStart: number,
): Promise<Restaurant | null> {
  // Apify-sourced OT results are already verified
  if (r._preVerified && r.timeSlots.length > 0) return r;

  // Yelp: try scraping the reservation page
  if (r.platform === "yelp") return verifyYelp(r, params, fcKey);

  // Resy: scrape the venue page
  if (r.platform === "resy") return verifyResy(r, params, fcKey);

  // OpenTable: try JSON API first, then Firecrawl scrape fallback
  if (r.platform === "opentable") return verifyOT(r, params, fcKey);

  return null;
}

// ── Resy verification ──

async function verifyResy(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.platformUrl, formats: ["markdown"], onlyMainContent: true, waitFor: 500, timeout: 8000 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) return null;

    // Check for notify/waitlist (no real availability)
    if (/\bnotify\b/i.test(md) && !/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(md)) return null;

    // Find the meal section header and extract times from it
    const mealLabel = getMealLabel(params.time);
    const mealRegex = new RegExp(`## (?:${mealLabel}|all\\s*day)([\\s\\S]*?)(?=##|$)`, "i");
    const mealMatch = md.match(mealRegex);
    const section = mealMatch ? mealMatch[1] : md;

    if (mealMatch && /\bnotify\b/i.test(section)) return null;

    const slots = extractTimes(section);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) return null;

    const base = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({
      ...s,
      url: buildSlotUrl("resy", base, params, s.time),
    }));

    // Extract rating/reviews from the markdown if present
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);

    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                  : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, ""))  : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err) {
    console.error(`[verifyResy] ${r.name}:`, err);
    return null;
  }
}

// ── OpenTable verification ──

async function verifyOT(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  // OT's JSON API is permanently blocked by Akamai on Supabase datacenter IPs.
  // Use Firecrawl scrape — headless browser with residential proxies bypasses it.
  if (!fcKey) return null;
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.platformUrl, formats: ["markdown"], onlyMainContent: true, waitFor: 3000, timeout: 12000 }),
    });
    if (!resp.ok) {
      console.log(`[OT scrape] ${r.name}: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    console.log(`[OT scrape] ${r.name}: ${md.length} chars, first 200: ${md.slice(0, 200)}`);
    if (md.length < 100) return null;

    // Check if OT blocked the request (Akamai challenge page)
    if (/access denied|security check|enable javascript|are you a robot/i.test(md)) {
      console.log(`[OT scrape] ${r.name}: blocked by Akamai`);
      return null;
    }

    const slots = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT scrape] ${r.name}: no windowed slots (extracted ${slots.length} raw)`);
      return null;
    }

    const base = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1]) : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err: any) {
    console.log(`[OT scrape] ${r.name}: ${err?.message}`);
    return null;
  }
}

async function resolveOTRid(url: string): Promise<string | null> {
  // Try to extract rid from the URL first
  const fromUrl = extractRid(url);
  if (fromUrl) return fromUrl;
  // We skip the HTML fetch for rid — too slow and blocked by Akamai anyway
  return null;
}

function parseOTSlots(raw: any[]): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();
  for (const slot of raw) {
    let h: number | null = null, m: number | null = null;
    const dt = slot?.dateTime ?? slot?.startDateTime ?? slot?.time;
    if (typeof dt === "string") {
      const tm = dt.match(/T?(\d{1,2}):(\d{2})/);
      if (tm) { h = +tm[1]; m = +tm[2]; }
    }
    if (h === null && typeof slot?.hour === "number") { h = slot.hour; m = slot.minute; }
    if (h === null || m === null || !Number.isFinite(h) || !Number.isFinite(m)) continue;
    const displayH = h % 12 || 12;
    const ampm = h >= 12 ? "PM" : "AM";
    const t = `${displayH}:${m.toString().padStart(2, "0")} ${ampm}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }
  return slots;
}

// ── Yelp verification ──

async function verifyYelp(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.platformUrl, formats: ["markdown"], onlyMainContent: true, waitFor: 500, timeout: 8000 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) return null;

    const hasWidget = /\b(find\s+a\s+table|select\s+(a\s+)?time|request\s+a\s+reservation|book\s+a\s+table|takes?\s+reservations?|party\s+size)\b/i.test(md);
    if (!hasWidget) return null;

    const slots = extractTimes(md);
    const windowed = filterWindow(slots, params.time);

    // Extract metadata from markdown
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    const priceM   = md.match(/(\$+)\s*(?:·|•|,|\s)/);

    const meta = {
      rating:      ratingM ? parseFloat(ratingM[1])                    : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, ""))    : r.reviewCount,
      priceRange:  priceM  ? priceM[1]                                 : r.priceRange,
    };

    const addr = r._address || extractAddress(md) || undefined;

    if (windowed.length === 0) {
      // Reservation widget found but no extractable times — soft-verified fallback
      return { ...r, ...meta, timeSlots: [], softVerified: true, _address: addr };
    }

    const base = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({
      ...s,
      url: buildSlotUrl("yelp", base, params, s.time),
    }));

    return { ...r, ...meta, timeSlots: slotsWithUrls, _address: addr };
  } catch (err) {
    console.error(`[verifyYelp] ${r.name}:`, err);
    return null;
  }
}

// ─── GEOCODING & RANKING ──────────────────────────────────────────────────────

async function geocodeAndRank(
  restaurants: Restaurant[],
  params: SearchParams,
  _aiKey: string,
): Promise<Restaurant[]> {
  if (restaurants.length === 0) return [];

  const userLat = params.lat;
  const userLng = params.lng;

  // Geocode restaurants that don't yet have coordinates — all in parallel, 2.5s cap each.
  // Use the nearest metro city name (not the suburb) so Nominatim can find the venue.
  const geoCity = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const geoRegion = params.state || params.country;

  const needsGeo = restaurants.filter(r => r._lat == null && r._lng == null);
  if (needsGeo.length > 0) {
    // Build a bounding box ~1.5° around the user (≈100 miles) to constrain Photon results.
    // This prevents Photon from returning a same-named venue in a different city.
    const bboxParam = (userLat != null && userLng != null)
      ? `&bbox=${(userLng - 1.5).toFixed(4)},${(userLat - 1.5).toFixed(4)},${(userLng + 1.5).toFixed(4)},${(userLat + 1.5).toFixed(4)}`
      : "";

    await Promise.all(needsGeo.map(async r => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      try {
        // Try with city first; fall back to name-only + bbox if no result
        const q1 = encodeURIComponent(`${r.name} ${geoCity} ${geoRegion}`);
        const url1 = `${PHOTON}/?q=${q1}&limit=3${bboxParam}`;
        let resp = await fetch(url1, {
          headers: { "User-Agent": "TableFinder/2.0" },
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) return;
        let data = await resp.json();
        let feats: any[] = data?.features ?? [];

        // If no result with city name, retry with just the restaurant name + bbox
        if (feats.length === 0 && bboxParam) {
          const ctrl2 = new AbortController();
          const timer2 = setTimeout(() => ctrl2.abort(), 2500);
          try {
            const q2 = encodeURIComponent(`${r.name} restaurant`);
            const resp2 = await fetch(`${PHOTON}/?q=${q2}&limit=3${bboxParam}`, {
              headers: { "User-Agent": "TableFinder/2.0" },
              signal: ctrl2.signal,
            });
            clearTimeout(timer2);
            if (resp2.ok) {
              const d2 = await resp2.json();
              feats = d2?.features ?? [];
            }
          } catch { clearTimeout(timer2); }
        }

        // Pick the closest result within 30 miles (sanity cap)
        let bestFeat: any = null;
        let bestDist = Infinity;
        for (const feat of feats) {
          if (!feat?.geometry?.coordinates) continue;
          const [fLng, fLat] = feat.geometry.coordinates;
          if (userLat != null && userLng != null) {
            const d = haversine(userLat, userLng, fLat, fLng);
            if (d < bestDist && d <= 30) { bestDist = d; bestFeat = feat; }
          } else {
            bestFeat = feat;
            break;
          }
        }

        // Address-based fallback: if Photon couldn't find by name, try the street address
        if (!bestFeat && r._address) {
          const ctrl4 = new AbortController();
          const timer4 = setTimeout(() => ctrl4.abort(), 2500);
          try {
            const qa = encodeURIComponent(r._address);
            const resp4 = await fetch(`${PHOTON}/?q=${qa}&limit=1${bboxParam}`, {
              headers: { "User-Agent": "TableFinder/2.0" },
              signal: ctrl4.signal,
            });
            clearTimeout(timer4);
            if (resp4.ok) {
              const d4 = await resp4.json();
              const f4 = d4?.features?.[0];
              if (f4) {
                const [fLng, fLat] = f4.geometry.coordinates;
                if (userLat != null && userLng != null) {
                  const d = haversine(userLat, userLng, fLat, fLng);
                  if (d <= 30) bestFeat = f4;
                } else {
                  bestFeat = f4;
                }
              }
            }
          } catch { clearTimeout(timer4); }
        }

        if (bestFeat) {
          const [fLng, fLat] = bestFeat.geometry.coordinates;
          r._lat = fLat;
          r._lng  = fLng;
          // Populate neighborhood from Photon if not already set
          if (!r.neighborhood) {
            const p = bestFeat.properties as any;
            r.neighborhood = p.district ?? p.suburb ?? p.city ?? "";
          }
        }
      } catch { /* distance stays null */ }
    }));
  }

  // Compute distances
  for (const r of restaurants) {
    if (userLat != null && userLng != null && r._lat != null && r._lng != null) {
      r.distanceMiles = haversine(userLat, userLng, r._lat, r._lng);
    }
  }

  const isMetro = isMetroArea(params.city);
  const CAP_MI = isMetro ? 30 : 15;
  const SANITY = 200;

  return restaurants
    .filter(r => r.distanceMiles == null || r.distanceMiles <= SANITY)
    .filter(r => r.distanceMiles == null || r.distanceMiles <= CAP_MI)
    .sort((a, b) => {
      const dA = a.distanceMiles ?? 999;
      const dB = b.distanceMiles ?? 999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
}

// ─── AI ENRICHMENT ────────────────────────────────────────────────────────────

async function enrich(restaurants: Restaurant[], params: SearchParams, aiKey: string): Promise<Restaurant[]> {
  if (restaurants.length === 0 || !aiKey) return restaurants;

  const tops = restaurants.slice(0, 12);
  const prompt = `For each restaurant, provide a one-sentence evocative description and 1-3 vibe tags.
Vibe tags pick from: Romantic, Lively, Date Night, Outdoor Seating, Chef's Table, Wine Bar, Hidden Gem, Business Dinner, Rooftop, Casual, Fine Dining, Family Friendly.

Restaurants:
${tops.map((r, i) => `${i + 1}. ${r.name} — ${r.cuisine}${r.neighborhood ? ` in ${r.neighborhood}` : ""}`).join("\n")}

Respond with ONLY valid JSON (no markdown) in this exact shape:
{"items":[{"description":"...","vibeTags":["..."]}]}`;

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) return restaurants;
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const enriched: { description: string; vibeTags: string[] }[] = Array.isArray(parsed)
      ? parsed
      : (parsed.items ?? parsed.enrichments ?? parsed.restaurants ?? []);

    tops.forEach((r, i) => {
      if (enriched[i]) {
        r.description = enriched[i].description;
        r.vibeTags    = enriched[i].vibeTags;
      }
    });
  } catch { /* enrichment is optional */ }

  return restaurants;
}

// ─── FIRECRAWL SEARCH ─────────────────────────────────────────────────────────

async function firecrawlSearch(queries: string[], fcKey: string, limit = 5): Promise<any[]> {
  const results: any[] = [];
  const seen = new Set<string>();

  await Promise.all(queries.map(async (query) => {
    try {
      const resp = await fetch(`${FC_API}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit, scrapeOptions: { formats: ["markdown"] } }),
      });
      if (!resp.ok) {
        console.warn(`[firecrawlSearch] HTTP ${resp.status} for "${query}"`);
        return;
      }
      const data = await resp.json();
      // Log raw shape once so we can see what Firecrawl actually returns
      console.log(`[firecrawlSearch] raw keys: ${data && typeof data === "object" ? Object.keys(data).join(",") : typeof data}`);
      // Firecrawl v2 response shape can vary — handle all known variants
      let items: any[] = [];
      if (Array.isArray(data))                    items = data;
      else if (Array.isArray(data.data))          items = data.data;
      else if (Array.isArray(data.results))       items = data.results;
      else if (Array.isArray(data.data?.results)) items = data.data.results;
      else if (Array.isArray(data.data?.data))    items = data.data.data;
      else if (Array.isArray(data.data?.web))      items = data.data.web;
      else if (Array.isArray(data.web))             items = data.web;
      else {
        console.warn(`[firecrawlSearch] unrecognised shape: ${JSON.stringify(data).slice(0, 300)}`);
        return;
      }
      for (const item of items) {
        if (item.url && !seen.has(item.url)) {
          seen.add(item.url);
          results.push(item);
        }
      }
    } catch (err) {
      console.warn(`[firecrawlSearch] "${query}":`, err);
    }
  }));

  return results;
}

// ─── ALLOCATION & DEDUP ───────────────────────────────────────────────────────

function allocate(
  resy: Restaurant[], ot: Restaurant[], yelp: Restaurant[], total: number
): Restaurant[] {
  // Proportional: Resy gets most slots, Yelp capped at 6
  const yelpCap = Math.min(yelp.length, 6);
  const remainder = total - yelpCap;
  const resySlots = Math.ceil(remainder * 0.55);
  const otSlots   = Math.floor(remainder * 0.45);

  return [
    ...resy.slice(0, resySlots),
    ...ot.slice(0, otSlots),
    ...yelp.slice(0, yelpCap),
  ];
}

function dedup(restaurants: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of restaurants) {
    const key = normName(r.name);
    if (!seen.has(key)) {
      seen.set(key, r);
    } else {
      // Prefer native platforms over Yelp
      const existing = seen.get(key)!;
      if (existing.platform === "yelp" && r.platform !== "yelp") {
        seen.set(key, r);
      }
    }
  }
  return Array.from(seen.values());
}

function normName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(restaurant|bar|grill|bistro|cafe|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3_958.8; // Earth radius miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function displayTo24(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "19:00";
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${h.toString().padStart(2, "0")}:${min}`;
}

function buildSlotUrl(
  platform: "resy" | "opentable" | "yelp",
  base: string,
  p: SearchParams,
  slotTime: string,
): string {
  const t24 = displayTo24(slotTime);
  const tNoColon = t24.replace(":", "");
  switch (platform) {
    case "resy":
      return `${base}?date=${p.date}&seats=${p.partySize}&time=${tNoColon}`;
    case "opentable":
      return `${base}?dateTime=${p.date}T${t24}&covers=${p.partySize}`;
    case "yelp":
      return `${base}?covers=${p.partySize}&date=${p.date}&time=${tNoColon}`;
    default:
      return base;
  }
}

function filterWindow(slots: TimeSlot[], requestedTime: string): TimeSlot[] {
  const [rH, rM] = requestedTime.split(":").map(Number);
  const reqMins = rH * 60 + (rM || 0);

  return slots
    .map(s => {
      const m = s.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
      if (!m) return null;
      let h = +m[1];
      const mn = +m[2];
      const ampm = m[3].toLowerCase();
      if (ampm === "pm" && h !== 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      return { slot: s, mins: h * 60 + mn };
    })
    .filter(x => x && Math.abs(x.mins - reqMins) <= 120)
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 5)
    .sort((a, b) => a!.mins - b!.mins)
    .map(x => x!.slot);
}

function extractTimes(text: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();

  // 12h format: "7:30 PM" / "7:30pm"
  const re12 = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re12.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable/i.test(ctx)) continue;
    let h = +m[1];
    const mn = +m[2];
    const ampm = m[3].toLowerCase();
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const displayH = h % 12 || 12;
    const t = `${displayH}:${mn.toString().padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  // 24h format: "18:30" — used by OpenTable and some other platforms
  const re24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi;
  while ((m = re24.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable/i.test(ctx)) continue;
    const h = +m[1], mn = +m[2];
    if (h < 6) continue; // skip midnight/early-morning false positives
    const displayH = h % 12 || 12;
    const t = `${displayH}:${mn.toString().padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  return slots;
}

function getMealLabel(time: string): string {
  const [h] = time.split(":").map(Number);
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch|brunch";
  return "dinner";
}

function addResyParams(base: string, p: SearchParams): string {
  const u = new URL(base);
  u.searchParams.set("date", p.date);
  u.searchParams.set("seats", String(p.partySize));
  u.searchParams.set("time", p.time.replace(":", ""));
  return u.toString();
}

function addOTParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("dateTime", `${p.date}T${p.time}`);
    u.searchParams.set("covers", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

function addYelpParams(base: string, p: SearchParams): string {
  const u = new URL(base);
  u.searchParams.set("covers", String(p.partySize));
  u.searchParams.set("date", p.date);
  u.searchParams.set("time", p.time.replace(":", ""));
  return u.toString();
}

function extractRid(url: string): string | null {
  const m = url.match(/[?&]rid=(\d+)/i) ?? url.match(/\/(\d{5,})/);
  return m ? m[1] : null;
}

function parseTimeFromDT(dt: string): string | null {
  const m = dt.match(/T(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mn = +m[2];
  const displayH = h % 12 || 12;
  return `${displayH}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function cleanTitle(title: string | undefined, url: string, platform: string): string {
  if (title) {
    let t = title
      .replace(/\s*[|–-]\s*(Resy|OpenTable|Yelp).*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+(OpenTable|Resy|Yelp)$/i, "")
      .replace(/\s*[|•·]\s*[A-Za-z\s&]+$/i, "")
      .replace(/^book\s+(?:your\s+)?(?:reservation\s+(?:at\s+)?)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "")
      .trim();
    // Yelp-specific: strip trailing category list "- Bars, Seafood, ..."
    if (platform === "yelp") {
      t = t.replace(/\s*[-–]\s*[A-Za-z &']+(?:,\s*[A-Za-z &']+)+\s*$/, "").trim();
    }
    // Strip any bare trailing separator
    t = t.replace(/\s*[-–|]\s*$/, "").trim();
    if (t.length > 1) return t;
  }
  const parts = url.split("/");
  const slug = parts[parts.length - 1] || "restaurant";
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Pull a street address out of scraped markdown — used as geocoding fallback. */
function extractAddress(md: string): string {
  // "471 Boulevard NE, Atlanta, GA 30307" / "123 Main St NE, Atlanta, GA"
  const m = md.match(
    /\b(\d{2,5})\s+([\w][^,\n]{3,40}(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Pl|Ct|Pkwy|Hwy|Cir|Ter|NE|NW|SE|SW)\.?)(?:,?\s+(?:NE|NW|SE|SW))?[,\s]+([A-Za-z][A-Za-z\s]{2,25}),\s*([A-Z]{2})\b/i
  );
  if (m) return `${m[1]} ${m[2].trim()}, ${m[3].trim()}, ${m[4]}`;
  return "";
}

function extractNeighborhood(title?: string, desc?: string): string {
  const text = `${title || ""} ${desc || ""}`;
  const m = text.match(/[-–|]\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
  if (m) return m[1].trim();
  return ""; // neighborhood populated later from Photon geocode
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isMetroArea(city: string): boolean {
  const metros = new Set(["new york","los angeles","chicago","houston","phoenix","philadelphia","san antonio","san diego","dallas","san jose","austin","jacksonville","fort worth","columbus","charlotte","san francisco","indianapolis","seattle","denver","washington","nashville","oklahoma city","el paso","boston","portland","las vegas","memphis","louisville","baltimore","milwaukee","albuquerque","tucson","fresno","mesa","kansas city","atlanta","omaha","colorado springs","raleigh","long beach","virginia beach","minneapolis","tampa","new orleans","honolulu","anaheim","lexington","aurora","santa ana","corpus christi","riverside","st louis","pittsburgh","anchorage","stockton","cincinnati","st paul","toledo","greensboro","newark","plano","henderson","lincoln","buffalo","fort wayne","jersey city","chula vista","orlando","st petersburg","norfolk","chandler","laredo","madison","durham","lubbock","winston-salem","garland","glendale","hialeah","reno","baton rouge","irvine","chesapeake","scottsdale","north las vegas","fremont","gilbert","san bernardino","birmingham","boise","rochester","richmond","spokane","des moines","montgomery","modesto","fayetteville","tacoma","shreveport","akron","aurora","yonkers","huntington beach","little rock","glendale","columbus","grand rapids","amarillo","oxnard","tallahassee","huntsville","worcester","knoxville","brownsville","providence","moreno valley","jackson","oceanside","garden grove","chattanooga","fort lauderdale","rancho cucamonga","santa clarita","tempe","oceanside","cape coral","ontario","vancouver","sioux falls","peoria","elk grove","pembroke pines","corona","sunnyvale","springfield","lancaster","hayward","salinas","lakewood","palmdale","clarksville","pomona","hollywood","escondido","paterson","torrance","bridgeport","alexandria","mcallen","savannah","fullerton","roseville","kansas city","columbia","surprise","macon","sterling heights","murfreesboro","pasadena","cedar rapids","mesquite","killeen","bellevue","hartford","rockford","dayton","olathe","syracuse","tempe","eugene","salt lake city","manchester","port st lucie","worcester","fort collins","providence","barnstable","springfield","memphis","seattle","portland","denver","atlanta","miami","dallas","los angeles","chicago","new york","london","manchester","birmingham","leeds","glasgow","sheffield","bradford","edinburgh","liverpool","bristol","cardiff"]);
  return metros.has(city.toLowerCase());
}

function formatDisplayDate(date: string): string {
  try {
    const d = new Date(date + "T12:00:00");
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return "Tonight";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch { return date; }
}

function formatDisplayTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const displayH = h % 12 || 12;
  const ampm = h >= 12 ? "PM" : "AM";
  return `${displayH}:${m.toString().padStart(2, "0")} ${ampm}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── RESY METRO LOOKUP BY COORDINATES ────────────────────────────────────────
// Keyed by Resy slug. lat/lng is the metro centre point.
// When the user has coordinates we find the nearest metro by haversine distance.
// When they don't, we fall back to a name lookup on the known slugs only.

const RESY_METROS: { slug: string; name: string; lat: number; lng: number }[] = [
  { slug: "new-york-ny",      name: "New York",       lat: 40.7128,  lng: -74.0060 },
  { slug: "los-angeles-ca",   name: "Los Angeles",    lat: 34.0522,  lng: -118.2437 },
  { slug: "chicago-il",       name: "Chicago",        lat: 41.8781,  lng: -87.6298 },
  { slug: "san-francisco-ca", name: "San Francisco",  lat: 37.7749,  lng: -122.4194 },
  { slug: "washington-dc",    name: "Washington DC",  lat: 38.9072,  lng: -77.0369 },
  { slug: "miami-fl",         name: "Miami",          lat: 25.7617,  lng: -80.1918 },
  { slug: "boston-ma",        name: "Boston",         lat: 42.3601,  lng: -71.0589 },
  { slug: "seattle-wa",       name: "Seattle",        lat: 47.6062,  lng: -122.3321 },
  { slug: "portland-or",      name: "Portland",       lat: 45.5051,  lng: -122.6750 },
  { slug: "denver-co",        name: "Denver",         lat: 39.7392,  lng: -104.9903 },
  { slug: "austin-tx",        name: "Austin",         lat: 30.2672,  lng: -97.7431 },
  { slug: "dfw",              name: "Dallas",         lat: 32.7767,  lng: -96.7970 },
  { slug: "houston-tx",       name: "Houston",        lat: 29.7604,  lng: -95.3698 },
  { slug: "atlanta-ga",       name: "Atlanta",        lat: 33.7490,  lng: -84.3880 },
  { slug: "nashville-tn",     name: "Nashville",      lat: 36.1627,  lng: -86.7816 },
  { slug: "philadelphia-pa",  name: "Philadelphia",   lat: 39.9526,  lng: -75.1652 },
  { slug: "minneapolis-mn",   name: "Minneapolis",    lat: 44.9778,  lng: -93.2650 },
  { slug: "phoenix-az",       name: "Phoenix",        lat: 33.4484,  lng: -112.0740 },
  { slug: "new-orleans-la",   name: "New Orleans",    lat: 29.9511,  lng: -90.0715 },
  { slug: "las-vegas-nv",     name: "Las Vegas",      lat: 36.1699,  lng: -115.1398 },
  { slug: "san-diego-ca",     name: "San Diego",      lat: 32.7157,  lng: -117.1611 },
  { slug: "charlotte-nc",     name: "Charlotte",      lat: 35.2271,  lng: -80.8431 },
  { slug: "raleigh-nc",       name: "Raleigh",        lat: 35.7796,  lng: -78.6382 },
  { slug: "richmond-va",      name: "Richmond",       lat: 37.5407,  lng: -77.4360 },
  { slug: "baltimore-md",     name: "Baltimore",      lat: 39.2904,  lng: -76.6122 },
  { slug: "pittsburgh-pa",    name: "Pittsburgh",     lat: 40.4406,  lng: -79.9959 },
  { slug: "cleveland-oh",     name: "Cleveland",      lat: 41.4993,  lng: -81.6944 },
  { slug: "columbus-oh",      name: "Columbus",       lat: 39.9612,  lng: -82.9988 },
  { slug: "cincinnati-oh",    name: "Cincinnati",     lat: 39.1031,  lng: -84.5120 },
  { slug: "detroit-mi",       name: "Detroit",        lat: 42.3314,  lng: -83.0458 },
  { slug: "milwaukee-wi",     name: "Milwaukee",      lat: 43.0389,  lng: -87.9065 },
  { slug: "kansas-city-mo",   name: "Kansas City",    lat: 39.0997,  lng: -94.5786 },
  { slug: "st-louis-mo",      name: "St Louis",       lat: 38.6270,  lng: -90.1994 },
  { slug: "indianapolis-in",  name: "Indianapolis",   lat: 39.7684,  lng: -86.1581 },
  { slug: "louisville-ky",    name: "Louisville",     lat: 38.2527,  lng: -85.7585 },
  { slug: "memphis-tn-ar",    name: "Memphis",        lat: 35.1495,  lng: -90.0490 },
  { slug: "tampa-bay-fl",     name: "Tampa",          lat: 27.9506,  lng: -82.4572 },
  { slug: "orlando-fl",       name: "Orlando",        lat: 28.5383,  lng: -81.3792 },
  { slug: "salt-lake-city-ut",name: "Salt Lake City", lat: 40.7608,  lng: -111.8910 },
  { slug: "sacramento-ca",    name: "Sacramento",     lat: 38.5816,  lng: -121.4944 },
  { slug: "portland-me",      name: "Portland ME",    lat: 43.6591,  lng: -70.2568 },
  { slug: "san-antonio-tx",   name: "San Antonio",    lat: 29.4241,  lng: -98.4936 },
  { slug: "jacksonville-fl",  name: "Jacksonville",   lat: 30.3322,  lng: -81.6557 },
  { slug: "london-england",   name: "London",         lat: 51.5074,  lng: -0.1278 },
];

// Max distance to snap to a Resy metro (miles). Beyond this we use the city name as-is.
const RESY_SNAP_RADIUS = 60;

function nearestResyMetro(lat: number, lng: number): { slug: string; name: string } | null {
  let best: { slug: string; name: string } | null = null;
  let bestDist = Infinity;
  for (const m of RESY_METROS) {
    const d = haversine(lat, lng, m.lat, m.lng);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return bestDist <= RESY_SNAP_RADIUS ? best : null;
}

function resyCitySlug(city: string, state: string, _country: string, lat?: number, lng?: number): string {
  // Coordinate-based lookup (most reliable — works for any suburb)
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.slug;
  }
  // Name-based fallback for known cities
  const key = `${city.toLowerCase()}:${(state || "").toLowerCase()}`;
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.slug;
  }
  return slugify(city);
}

function resyCityName(city: string, state: string, lat?: number, lng?: number): string {
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.name;
  }
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.name;
  }
  return city;
}
