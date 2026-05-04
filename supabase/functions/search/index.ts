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
const DISCOVERY_BUDGET =  40_000;
const VERIFY_BUDGET    =  28_000;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TimeSlot { time: string; }

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
  // internal
  _lat?: number;
  _lng?: number;
  _slug?: string;
  _rid?: string;
  _preVerified?: boolean;
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
  date: string;
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

    // Discovery: all 3 platforms in parallel
    const [resyCands, otCands, yelpCands] = await Promise.all([
      withTimeout(discoverResy(params, FIRECRAWL),      DISCOVERY_BUDGET, []),
      withTimeout(discoverOpenTable(params, FIRECRAWL, APIFY), DISCOVERY_BUDGET, []),
      withTimeout(discoverYelp(params, FIRECRAWL),      DISCOVERY_BUDGET, []),
    ]);
    console.log(`[discovery] resy=${resyCands.length} ot=${otCands.length} yelp=${yelpCands.length}`);

    // Proportional allocation: up to 24 for verification (Yelp capped at 6)
    const toVerify = allocate(resyCands, otCands, yelpCands, 24);

    // Verification: parallel lanes with time budget
    const verifyStart = Date.now();
    const [resyVer, otVer, yelpVer] = await Promise.all([
      withTimeout(verifyBatch(toVerify.filter(r => r.platform === "resy"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
      withTimeout(verifyBatch(toVerify.filter(r => r.platform === "opentable"), params, FIRECRAWL, start), VERIFY_BUDGET, []),
      withTimeout(verifyBatch(toVerify.filter(r => r.platform === "yelp"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
    ]);
    console.log(`[verify] resy=${resyVer.length} ot=${otVer.length} yelp=${yelpVer.length} in ${Date.now() - verifyStart}ms`);

    let verified = dedup([...resyVer, ...otVer, ...yelpVer]);

    // Geocode and rank by distance
    verified = await geocodeAndRank(verified, params, AI_KEY);

    // Enrich top results (descriptions + vibe tags) if time allows
    if (Date.now() - start < 95_000) {
      verified = await enrich(verified, params, AI_KEY);
    }

    // Remaining candidates for optional second pass
    const verifiedIds = new Set(verified.map(r => r.id));
    const remaining = [...resyCands, ...otCands, ...yelpCands]
      .filter(r => !toVerify.some(v => v.id === r.id) && !verifiedIds.has(r.id))
      .slice(0, 18);

    const meta: SearchMeta = {
      date: formatDisplayDate(params.date),
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
    });

  } catch (err: any) {
    clearTimeout(globalTimer);
    console.error("[error]", err);
    return json({ error: err?.message ?? "Search failed. Please try again." }, 500);
  }
});

// ─── EXTENDED SEARCH ─────────────────────────────────────────────────────────

async function runExtendedSearch(
  body: any, FIRECRAWL: string, AI_KEY: string, APIFY: string, start: number
): Promise<Restaurant[]> {
  const { remainingCandidates, extendedParams } = body;
  if (!remainingCandidates?.length) return [];

  const params = extendedParams as SearchParams;
  const batch = (remainingCandidates as Restaurant[]).slice(0, 18);

  const [resyVer, otVer, yelpVer] = await Promise.all([
    withTimeout(verifyBatch(batch.filter(r => r.platform === "resy"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
    withTimeout(verifyBatch(batch.filter(r => r.platform === "opentable"), params, FIRECRAWL, start), VERIFY_BUDGET, []),
    withTimeout(verifyBatch(batch.filter(r => r.platform === "yelp"),      params, FIRECRAWL, start), VERIFY_BUDGET, []),
  ]);

  let verified = dedup([...resyVer, ...otVer, ...yelpVer]);
  verified = await geocodeAndRank(verified, params, AI_KEY);
  return verified;
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
- city: city name only, no state. Use location context if query omits city.
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
  const slug = resyCitySlug(params.city, params.state, params.country);
  const metro = resyCityName(params.city, params.state);
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";

  const queries = [
    `site:resy.com/cities/${slug}/venues/ ${metro}${cuisine} restaurant reservation`,
    `site:resy.com/cities/${slug}/venues/ ${metro}${cuisine} dinner reservation`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 8);
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
    neighborhood: extractNeighborhood(fc.title, fc.description, params.city),
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

  // Otherwise fall back to Firecrawl search (Google index of OT pages)
  const city = params.city;
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";

  const queries = [
    `site:${domain}/r/ ${city}${cuisine} restaurant reservation`,
    `site:${domain}/r/ ${city}${cuisine} dinner reservation`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 8);
  return results
    .map(r => normToOT(r, params))
    .filter(Boolean) as Restaurant[];
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

      return [{
        id: `opentable-${rid || slugify(item.name || "")}`,
        name: item.name ?? item.restaurantName ?? "Restaurant",
        cuisine: item.cuisine ?? params.cuisine ?? "Restaurant",
        neighborhood: item.neighborhood ?? item.location ?? params.city,
        rating: item.stars ?? item.rating,
        reviewCount: item.reviewCount ?? item.reviews,
        priceRange: item.priceRange ?? item.price,
        platform: "opentable" as const,
        platformUrl: addOTParams(bookingUrl || `https://www.opentable.com/r/${slugify(item.name||"")}`, params),
        timeSlots: filtered,
        distanceMiles: null,
        _lat: item.lat, _lng: item.lng,
        _preVerified: filtered.length > 0,
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
  const m = url.match(/opentable\.com\/r\/([^/?#]+)/i) ?? url.match(/opentable\.co\.uk\/r\/([^/?#]+)/i);
  if (!m) return null;

  const slug = m[1];
  const baseUrl = `https://www.${domain}/r/${slug}`;
  const rid = extractRid(url);

  return {
    id: `opentable-${slug}`,
    name: cleanTitle(fc.title, url, "opentable"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description, params.city),
    platform: "opentable",
    platformUrl: addOTParams(baseUrl, params),
    timeSlots: [],
    distanceMiles: null,
    _rid: rid ?? undefined,
  };
}

// ─── YELP DISCOVERY ───────────────────────────────────────────────────────────

async function discoverYelp(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city = params.city;
  const state = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain = params.country === "gb" ? "yelp.co.uk" : "yelp.com";

  const queries = [
    `site:${domain}/reservations/ ${city}${state}${cuisine} restaurant`,
    `site:${domain}/reservations/ ${city}${state}${cuisine} dinner reservation`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 8);
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
    neighborhood: extractNeighborhood(fc.title, fc.description, params.city),
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
  const CONCURRENCY = 4;
  const LANE_TARGET = 6;

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

  // OpenTable: try JSON API first, then skip (Firecrawl fails on OT)
  if (r.platform === "opentable") return verifyOT(r, params);

  return null;
}

// ── Resy verification ──

async function verifyResy(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: r.platformUrl, formats: ["markdown"], onlyMainContent: true, waitFor: 1500, timeout: 12000 }),
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

    // Extract rating/reviews from the markdown if present
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);

    return {
      ...r,
      timeSlots: windowed,
      rating:      ratingM  ? parseFloat(ratingM[1])                       : r.rating,
      reviewCount: reviewM  ? parseInt(reviewM[1].replace(/,/g, ""))        : r.reviewCount,
    };
  } catch (err) {
    console.error(`[verifyResy] ${r.name}:`, err);
    return null;
  }
}

// ── OpenTable verification ──

async function verifyOT(r: Restaurant, params: SearchParams): Promise<Restaurant | null> {
  // Primary path: OT's own JSON availability endpoint
  // This works when called from non-datacenter IPs; may be blocked by Akamai on Supabase.
  // If it fails, we skip this restaurant (Firecrawl OT scrape is also blocked by Akamai).
  // Solution: add APIFY_API_TOKEN env var to use Apify actor for OT discovery+verification.
  const rid = r._rid ?? (await resolveOTRid(r.platformUrl));
  if (!rid) return null;

  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 6_000);

    const resp = await fetch("https://www.opentable.com/dapi/booking/restaurant/availability", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: r.platformUrl,
        Origin: "https://www.opentable.com",
      },
      body: JSON.stringify({
        rids: [Number(rid)],
        dateTime: `${params.date}T${params.time}`,
        partySize: params.partySize,
        includeOffers: false,
        requestPremium: "true",
        forceNextAvailable: "false",
      }),
      signal: abort.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      console.log(`[OT JSON] ${r.name}: HTTP ${resp.status} — blocked (add APIFY_API_TOKEN for OT)`);
      return null;
    }

    const json: any = await resp.json().catch(() => null);
    if (!json) return null;

    // Parse slots from various response shapes OT has used
    const raw: any[] = [];
    const push = (arr: any) => Array.isArray(arr) && raw.push(...arr);
    push(json?.availability?.[rid]?.times);
    push(json?.availability?.[rid]?.timeslots);
    push(json?.availability?.times);
    if (Array.isArray(json?.restaurants)) json.restaurants.forEach((rs: any) => { push(rs.slots); push(rs.times); });
    push(json?.timeslots);
    push(json?.slots);

    const slots = parseOTSlots(raw);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) return null;

    return { ...r, timeSlots: windowed };
  } catch (err: any) {
    if (err?.name !== "AbortError") console.log(`[OT JSON] ${r.name}: ${err?.message}`);
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
      body: JSON.stringify({ url: r.platformUrl, formats: ["markdown"], onlyMainContent: true, waitFor: 1500, timeout: 12000 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) return null;

    const hasWidget = /\b(find\s+a\s+table|select\s+(a\s+)?time|request\s+a\s+reservation|book\s+a\s+table|takes?\s+reservations?|party\s+size)\b/i.test(md);
    if (!hasWidget) return null;

    const slots = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0 && !hasWidget) return null;

    // Extract metadata from markdown
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    const priceM   = md.match(/(\$+)\s*(?:·|•|,|\s)/);

    return {
      ...r,
      timeSlots: windowed.length > 0 ? windowed : [],
      rating:      ratingM ? parseFloat(ratingM[1])                    : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, ""))    : r.reviewCount,
      priceRange:  priceM  ? priceM[1]                                 : r.priceRange,
    };
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

  // Batch geocode restaurants that need it (up to 6 at a time, Nominatim throttle)
  const needsGeo = restaurants.filter(r => r._lat == null && r._lng == null);
  const BATCH = 4;
  for (let i = 0; i < needsGeo.length; i += BATCH) {
    await Promise.all(needsGeo.slice(i, i + BATCH).map(async r => {
      try {
        const query = encodeURIComponent(`${r.name}, ${params.city}, ${params.state || params.country}`);
        const resp = await fetch(`${NOMINATIM}/search?q=${query}&format=json&limit=1`, {
          headers: { "User-Agent": "TableFinder/2.0" },
        });
        const data = await resp.json();
        if (data?.[0]) { r._lat = parseFloat(data[0].lat); r._lng = parseFloat(data[0].lon); }
      } catch { /* skip */ }
    }));
    if (i + BATCH < needsGeo.length) await sleep(300); // Nominatim rate limit
  }

  // Compute distances and sort
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

Respond with ONLY a JSON array (no markdown):
[{"description":"...","vibeTags":["..."]}]`;

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
    const raw = data.choices?.[0]?.message?.content ?? "[]";
    const enriched: { description: string; vibeTags: string[] }[] = JSON.parse(
      raw.replace(/```json|```/g, "").trim()
    );

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
      if (!resp.ok) return;
      const data = await resp.json();
      for (const item of (data.data ?? [])) {
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
  const re = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
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
    const t = title
      .replace(/\s*[|–-]\s*(Resy|OpenTable|Yelp).*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+(OpenTable|Resy|Yelp)$/i, "")
      .replace(/\s*[|•·]\s*[A-Za-z\s&]+$/i, "")
      .replace(/^book\s+(your\s+)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "")
      .trim();
    if (t.length > 1) return t;
  }
  const parts = url.split("/");
  const slug = parts[parts.length - 1] || "restaurant";
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function extractNeighborhood(title?: string, desc?: string, fallback?: string): string {
  const text = `${title || ""} ${desc || ""}`;
  const m = text.match(/[-–|]\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
  if (m) return m[1].trim();
  return fallback || "";
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

// ─── RESY CITY SLUG MAP ────────────────────────────────────────────────────────
// Maps city+state → Resy metro slug

const RESY_MAP: Record<string, [string, string]> = { // [slug, displayName]
  "new york:ny": ["new-york-city", "New York"],
  "brooklyn:ny": ["new-york-city", "New York"],
  "manhattan:ny": ["new-york-city", "New York"],
  "queens:ny": ["new-york-city", "New York"],
  "los angeles:ca": ["los-angeles", "Los Angeles"],
  "la:ca": ["los-angeles", "Los Angeles"],
  "santa monica:ca": ["los-angeles", "Los Angeles"],
  "west hollywood:ca": ["los-angeles", "Los Angeles"],
  "beverly hills:ca": ["los-angeles", "Los Angeles"],
  "chicago:il": ["chicago", "Chicago"],
  "san francisco:ca": ["san-francisco", "San Francisco"],
  "sf:ca": ["san-francisco", "San Francisco"],
  "washington:dc": ["washington-dc", "Washington DC"],
  "dc:dc": ["washington-dc", "Washington DC"],
  "miami:fl": ["miami", "Miami"],
  "miami beach:fl": ["miami", "Miami"],
  "coral gables:fl": ["miami", "Miami"],
  "boston:ma": ["boston", "Boston"],
  "cambridge:ma": ["boston", "Boston"],
  "seattle:wa": ["seattle", "Seattle"],
  "portland:or": ["portland", "Portland"],
  "denver:co": ["denver", "Denver"],
  "austin:tx": ["austin", "Austin"],
  "dallas:tx": ["dallas", "Dallas"],
  "houston:tx": ["houston", "Houston"],
  "atlanta:ga": ["atlanta", "Atlanta"],
  "buckhead:ga": ["atlanta", "Atlanta"],
  "midtown:ga": ["atlanta", "Atlanta"],
  "nashville:tn": ["nashville", "Nashville"],
  "philadelphia:pa": ["philadelphia", "Philadelphia"],
  "minneapolis:mn": ["minneapolis", "Minneapolis"],
  "phoenix:az": ["phoenix", "Phoenix"],
  "scottsdale:az": ["phoenix", "Phoenix"],
  "new orleans:la": ["new-orleans", "New Orleans"],
  "las vegas:nv": ["las-vegas", "Las Vegas"],
  "san diego:ca": ["san-diego", "San Diego"],
  "portland:me": ["portland-me", "Portland ME"],
  "charlotte:nc": ["charlotte", "Charlotte"],
  "raleigh:nc": ["raleigh", "Raleigh"],
  "durham:nc": ["raleigh", "Raleigh"],
  "richmond:va": ["richmond", "Richmond"],
  "baltimore:md": ["baltimore", "Baltimore"],
  "pittsburgh:pa": ["pittsburgh", "Pittsburgh"],
  "cleveland:oh": ["cleveland", "Cleveland"],
  "columbus:oh": ["columbus", "Columbus"],
  "cincinnati:oh": ["cincinnati", "Cincinnati"],
  "detroit:mi": ["detroit", "Detroit"],
  "milwaukee:wi": ["milwaukee", "Milwaukee"],
  "kansas city:mo": ["kansas-city", "Kansas City"],
  "st louis:mo": ["st-louis", "St Louis"],
  "indianapolis:in": ["indianapolis", "Indianapolis"],
  "louisville:ky": ["louisville", "Louisville"],
  "memphis:tn": ["memphis", "Memphis"],
  "tampa:fl": ["tampa", "Tampa"],
  "orlando:fl": ["orlando", "Orlando"],
  "fort lauderdale:fl": ["miami", "Miami"],
  "boca raton:fl": ["miami", "Miami"],
  "salt lake city:ut": ["salt-lake-city", "Salt Lake City"],
  "sacramento:ca": ["sacramento", "Sacramento"],
  "san jose:ca": ["san-francisco", "San Francisco"],
  "palo alto:ca": ["san-francisco", "San Francisco"],
  "oakland:ca": ["san-francisco", "San Francisco"],
  "london:": ["london", "London"],
  "london:england": ["london", "London"],
};

function resyCitySlug(city: string, state: string, country: string): string {
  const key = `${city.toLowerCase()}:${(state || "").toLowerCase()}`;
  return RESY_MAP[key]?.[0] ?? slugify(city);
}

function resyCityName(city: string, state: string): string {
  const key = `${city.toLowerCase()}:${(state || "").toLowerCase()}`;
  return RESY_MAP[key]?.[1] ?? city;
}
