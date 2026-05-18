// TableFinder Search Edge Function — v111
// Platforms: Resy (live) + OpenTable/Tock/Yelp/SevenRooms (pending — discovery only)
//
// Required env vars:
//   FIRECRAWL_API_KEY
//   LOVABLE_API_KEY
//
// Optional:
//   SCRAPER_LAMBDA_URL — AWS Lambda scraper URL (enables real-browser Resy)
//   SCRAPER_SECRET     — shared secret for Lambda scraper auth
//
// v103: remove all OT and Yelp code — Resy only

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FC_API     = "https://api.firecrawl.dev/v2";
const PHOTON     = "https://photon.komoot.io/api";

const GLOBAL_TIMEOUT  = 115_000;
const DISCOVER_MS     =  38_000;  // per-platform discovery budget
const VERIFY_MS       =  25_000;  // per-platform verification budget (warm Lambda: 7-10s per call)
const GEOCODE_MS      =  10_000;  // geocodeAndRank hard cap
const ENRICH_MS       =  10_000;  // AI enrichment hard cap
const VERIFY_CONCUR   =      12;  // verify candidates in parallel batches
const VERIFY_MAX      =      20;  // max verified results per platform

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TimeSlot { time: string; url?: string; }

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
  platform: string;
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
  softVerified?: boolean;
  availabilityPending?: boolean;
  _lat?: number; _lng?: number;
  _slug?: string;
  _preVerified?: boolean;
  _address?: string;
}

interface SearchParams {
  cuisine: string; cuisineType: string; dishKeyword: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM 24h
  partySize: number;
  city: string; state: string; country: string;
  lat?: number; lng?: number;
}

interface SearchMeta {
  date: string; dateRaw: string; time: string;
  partySize: number; city: string; state?: string; country?: string;
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const start = Date.now();
  try {
    const body = await req.json();
    const FIRECRAWL      = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
    const AI_KEY         = Deno.env.get("LOVABLE_API_KEY") ?? "";
    const SCRAPER_URL    = Deno.env.get("SCRAPER_LAMBDA_URL") ?? "";
    const SCRAPER_SECRET = Deno.env.get("SCRAPER_SECRET") ?? "";
    const SERPER_KEY     = Deno.env.get("SERPER_API_KEY") ?? "";

    if (body.extended === true) {
      const extra = await runExtendedSearch(body, FIRECRAWL, AI_KEY, SCRAPER_URL, SCRAPER_SECRET);
      return json({ results: extra });
    }

    const { query, lat, lng, location } = body;
    const params = await withTimeout(
      parseQuery(query, lat, lng, location, AI_KEY),
      5_000,
      fallbackParams(lat, lng, location)
    );
    console.log(`[params] ${JSON.stringify(params)}`);

    // ── Discovery (all platforms in parallel) ─────────────────────────────────
    const [resyCands, otPendingCands, tockPendingCands, yelpPendingCands, srPendingCands, tfPendingCands] = await Promise.all([
      abortableDiscover(async () => {
        const apiResults = await discoverResyViaAPI(params);
        if (apiResults.length > 0) {
          console.log(`[Resy] API returned ${apiResults.length} pre-verified venues`);
          return apiResults;
        }
        console.log("[Resy] API returned 0 — falling back to Firecrawl");
        const fcResults = await discoverResy(params, FIRECRAWL);
        if (fcResults.length > 0) {
          console.log(`[Resy] Firecrawl returned ${fcResults.length} venues`);
          return fcResults;
        }
        if (SCRAPER_URL && SCRAPER_SECRET) {
          console.log("[Resy] Firecrawl returned 0 — falling back to Lambda browser");
          return discoverResyViaBB(params, SCRAPER_URL, SCRAPER_SECRET);
        }
        return [];
      }, DISCOVER_MS),
      abortableDiscover(() => discoverPlatformPending("opentable",  params, FIRECRAWL, SERPER_KEY), DISCOVER_MS),
      abortableDiscover(() => discoverPlatformPending("tock",       params, FIRECRAWL, SERPER_KEY), DISCOVER_MS),
      abortableDiscover(() => discoverPlatformPending("yelp",       params, FIRECRAWL, SERPER_KEY), DISCOVER_MS),
      abortableDiscover(() => discoverPlatformPending("sevenrooms", params, FIRECRAWL, SERPER_KEY), DISCOVER_MS),
      abortableDiscover(() => discoverPlatformPending("thefork",    params, FIRECRAWL, SERPER_KEY), DISCOVER_MS),
    ]);

    console.log(`[discovery] resy=${resyCands.length} ot=${otPendingCands.length} tock=${tockPendingCands.length} yelp=${yelpPendingCands.length} sr=${srPendingCands.length} tf=${tfPendingCands.length} at ${Date.now()-start}ms`);

    const resySlice = resyCands.slice(0, 20);

    // ── Verification ──────────────────────────────────────────────────────────
    const verifyStart = Date.now();
    const resyVer = await verifyBatch(resySlice, params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET);
    console.log(`[verify] resy=${resyVer.length} in ${Date.now()-verifyStart}ms`);

    // Hard-verified only — confirmed available time slots. No soft-verify.
    let verified = dedup([...resyVer])
      .filter(r => !r.softVerified);

    // ── Geocode + Enrich ──────────────────────────────────────────────────────
    // Round-robin interleave so every platform gets representation in the cap.
    // Simple concat risks Tock+OT+Yelp filling all 24 slots before SR/TheFork.
    const allPending = dedup(roundRobinMerge(
      otPendingCands, tockPendingCands, yelpPendingCands, srPendingCands, tfPendingCands,
    )).slice(0, 40);

    const [ranked, pendingRanked] = await Promise.all([
      withTimeout(geocodeAndRank(verified, params), GEOCODE_MS, verified),
      withTimeout(geocodeAndRank(allPending, params), GEOCODE_MS, allPending),
      withTimeout(enrich(verified, params, AI_KEY), ENRICH_MS,  verified),
    ]);
    verified = ranked;

    // Merge pending with verified Resy — dedupe by name, sort by distance
    const verifiedNames = new Set(verified.map(r => normName(r.name)));
    const pendingFiltered = pendingRanked.filter(r => !verifiedNames.has(normName(r.name)));
    const allResults = [...verified, ...pendingFiltered].sort((a, b) => {
      const dA = a.distanceMiles ?? 999, dB = b.distanceMiles ?? 999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });

    // Remaining candidates for optional second pass
    const verifiedIds = new Set(allResults.map(r => r.id));
    const attempted   = new Set(resySlice.map(r => r.id));
    const remaining   = dedup(
      resyCands
        .filter(r => !attempted.has(r.id) && !verifiedIds.has(r.id) && !r.softVerified)
    ).slice(0, 18);

    const meta: SearchMeta = {
      date:      formatDisplayDate(params.date),
      dateRaw:   params.date,
      time:      formatDisplayTime(params.time),
      partySize: params.partySize,
      city:      params.city,
      state:     params.state,
      country:   params.country,
    };

    const elapsed = Date.now() - start;
    console.log(`[done] ${allResults.length} results (${verified.length} resy + ${pendingFiltered.length} pending) in ${elapsed}ms`);
    return json({
      results:             allResults.slice(0, 30),
      params:              meta,
      hasMore:             remaining.length > 0,
      remainingCandidates: remaining,
      _v:                  "v111-deep-links",
      _debug: {
        elapsed_ms:      elapsed,
        discovery:       { resy: resyCands.length, ot: otPendingCands.length, tock: tockPendingCands.length, yelp: yelpPendingCands.length, sr: srPendingCands.length, tf: tfPendingCands.length },
        verified:        { resy: resyVer.length, pending: pendingFiltered.length },
        scraper_enabled: !!(SCRAPER_URL && SCRAPER_SECRET),
        resy_api:        (globalThis as any).__resyApiDebug ?? null,
        // Resy URL samples — helps diagnose broken-link reports.
        resy_urls:       resyVer.slice(0, 10).map(r => ({
          name:     r.name,
          platform: r.platformUrl,
          slot0:    r.timeSlots[0]?.url ?? null,
        })),
      },
    });

  } catch (err: any) {
    console.error("[error]", err);
    return json({ error: err?.message ?? "Search failed. Please try again." }, 500);
  }
});

// ─── ABORT-SAFE DISCOVERY WRAPPER ─────────────────────────────────────────────

async function abortableDiscover(
  fn: () => Promise<Restaurant[]>,
  budgetMs: number,
): Promise<Restaurant[]> {
  return withTimeout(fn(), budgetMs, []);
}

// ─── EXTENDED SEARCH ─────────────────────────────────────────────────────────

async function runExtendedSearch(
  body: any, FIRECRAWL: string, AI_KEY: string, SCRAPER_URL: string, SCRAPER_SECRET: string,
): Promise<Restaurant[]> {
  const { remainingCandidates, extendedParams } = body;
  if (!remainingCandidates?.length) return [];

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
    city:        extendedParams.city    ?? "",
    state:       extendedParams.state   ?? "",
    country:     extendedParams.country ?? "us",
    lat:         body.lat ?? extendedParams.lat,
    lng:         body.lng ?? extendedParams.lng,
  };

  const batch = (remainingCandidates as Restaurant[]).slice(0, 18).filter(r => r.platform === "resy");
  const resyVer = await verifyBatch(batch, params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET);

  let verified = dedup([...resyVer]);
  const [ranked] = await Promise.all([
    withTimeout(geocodeAndRank(verified, params), GEOCODE_MS, verified),
    withTimeout(enrich(verified, params, AI_KEY), ENRICH_MS,  verified),
  ]);
  return ranked;
}

// ─── QUERY PARSING ────────────────────────────────────────────────────────────

async function parseQuery(
  query: string, lat?: number, lng?: number, location?: string, aiKey?: string
): Promise<SearchParams> {
  const todayStr = new Date().toISOString().split("T")[0];
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  const locCtx   = location ?? (lat && lng ? `${lat.toFixed(4)},${lng.toFixed(4)}` : "unknown");

  const _days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const _dayMap: Record<string,string> = {};
  for (let i = 0; i <= 6; i++) { const d = new Date(); d.setDate(d.getDate()+i); if (!_dayMap[_days[d.getDay()]]) _dayMap[_days[d.getDay()]] = d.toISOString().split("T")[0]; }
  const dayMapStr = Object.entries(_dayMap).map(([k,v])=>`${k}=${v}`).join(", ");

  const prompt = `Extract restaurant search parameters. Today is ${todayStr}.
Rules:
- date: YYYY-MM-DD. "tonight"/"today"=${todayStr}. "tomorrow"=${tomorrowStr}. Day names map (use exactly): ${dayMapStr}.
- time: HH:MM 24h. Default 19:00. lunch≈12:00 brunch≈11:00 dinner≈19:00.
- partySize: integer, default 2.
- city: CRITICAL — if the user mentions ANY city, neighborhood, or location in their query, use that EXACTLY. Only fall back to location context if the query contains no location at all.
- state: 2-letter US or empty for UK/international.
- country: "us" or "gb". Default "us".
- cuisine: specific type (e.g. "Italian","sushi","steakhouse") or "" if none.
- cuisineType: broad category or "".
- dishKeyword: specific dish or "".
Location context (only use if query has no location): ${locCtx}
Query: "${query}"
Respond ONLY with valid JSON (no markdown):
{"cuisine":"","cuisineType":"","dishKeyword":"","date":"","time":"","partySize":2,"city":"","state":"","country":"us"}`;

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
  const raw    = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

  // Override the AI's date with our own deterministic day-name resolver.
  // LLMs occasionally miscount day-of-week; our server-side map is always correct.
  const resolvedDate = resolveDateFromQuery(query, parsed.date || todayStr, _dayMap, todayStr, tomorrowStr);

  return {
    cuisine:     parsed.cuisine     || "",
    cuisineType: parsed.cuisineType || "",
    dishKeyword: parsed.dishKeyword || "",
    date:        resolvedDate,
    time:        parsed.time        || "19:00",
    partySize:   Number(parsed.partySize) || 2,
    city:        parsed.city  || extractCityFromLocation(location),
    state:       (parsed.state || "").toUpperCase().slice(0, 2),
    country:     parsed.country || "us",
    lat, lng,
  };
}

// Server-side day-name resolver.  The AI sometimes miscounts day-of-week
// (returning Friday for "Thursday").  We compute the correct YYYY-MM-DD from
// our own JS Date arithmetic and override whatever the model returned.
function resolveDateFromQuery(
  query: string,
  aiDate: string,
  dayMap: Record<string, string>,
  todayStr: string,
  tomorrowStr: string,
): string {
  const q = query.toLowerCase();

  // Absolute keywords that override everything
  if (/\b(tonight|today)\b/.test(q))   return todayStr;
  if (/\btomorrow\b/.test(q))           return tomorrowStr;

  // Full day names + common abbreviations → look up in our computed dayMap
  const aliases: [RegExp, string][] = [
    [/\bmondays?\b/,              "Monday"],
    [/\btuesdays?\b|\btues?\b/,   "Tuesday"],
    [/\bwednesdays?\b|\bweds?\b/, "Wednesday"],
    [/\bthursdays?\b|\bthurs?\b|\bthur\b/, "Thursday"],
    [/\bfridays?\b|\bfri\b/,     "Friday"],
    [/\bsaturdays?\b|\bsat\b/,   "Saturday"],
    [/\bsundays?\b|\bsun\b/,     "Sunday"],
  ];
  for (const [re, dayName] of aliases) {
    if (re.test(q) && dayMap[dayName]) {
      console.log(`[date] override: AI said ${aiDate} → using ${dayName}=${dayMap[dayName]}`);
      return dayMap[dayName];
    }
  }

  // No day name in query — trust the AI
  return aiDate;
}

function fallbackParams(lat?: number, lng?: number, location?: string): SearchParams {
  const metro = (lat != null && lng != null) ? nearestResyMetro(lat, lng) : null;
  return {
    cuisine: "", cuisineType: "", dishKeyword: "",
    date: new Date().toISOString().split("T")[0],
    time: "19:00", partySize: 2,
    city:    metro?.name ?? extractCityFromLocation(location) ?? "Atlanta",
    state:   metro ? metro.slug.split("-").pop()?.toUpperCase() ?? "" : "",
    country: "us", lat, lng,
  };
}

function extractCityFromLocation(loc?: string): string {
  if (!loc) return "";
  return loc.split(",")[0]?.trim() || "";
}

// ─── LAMBDA SCRAPER CLIENT ────────────────────────────────────────────────────
// Simple HTTP call to our AWS Lambda function that runs real headless Chrome.
// Lambda handles all browser complexity; edge function just sends URL, gets text back.

async function lambdaLoad(
  url: string,
  scraperUrl: string,
  scraperSecret: string,
  opts: {
    waitMs?: number; useProxy?: boolean; evalExpr?: string; timeoutMs?: number;
    fetchOnly?: boolean; fetchHeaders?: Record<string, string>;
  } = {},
): Promise<string> {
  const { waitMs = 4000, useProxy = false, evalExpr, timeoutMs = 28_000,
          fetchOnly = false, fetchHeaders } = opts;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(scraperUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        url, waitMs, evalExpr, useProxy, secret: scraperSecret,
        ...(fetchOnly ? { fetchOnly: true } : {}),
        ...(fetchHeaders ? { fetchHeaders } : {}),
      }),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      let errDetail = "";
      try {
        const errData = await resp.json();
        errDetail = errData.error ?? JSON.stringify(errData).substring(0, 200);
      } catch { try { errDetail = await resp.text(); } catch {} }
      throw new Error(`Lambda HTTP ${resp.status}: ${errDetail.substring(0, 200)}`);
    }
    const data = await resp.json();
    if (data.error) throw new Error(`Lambda: ${data.error}`);
    return String(data.content ?? "");
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── RESY DISCOVERY ───────────────────────────────────────────────────────────

// ─── RESY JSON API DISCOVERY ─────────────────────────────────────────────────
async function discoverResyViaAPI(params: SearchParams): Promise<Restaurant[]> {
  const slug  = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const metro = RESY_METROS.find(m => m.slug === slug);
  // Prefer metro coords (city-based) over GPS — ensures "dinner in new york"
  // searches NYC even when the user's device is in Atlanta.
  // Fall back to GPS only when the city isn't in our metro list.
  const lat   = metro?.lat ?? params.lat;
  const lng   = metro?.lng ?? params.lng;
  if (lat == null || lng == null) {
    (globalThis as any).__resyApiDebug = `no_coords city=${params.city}`;
    console.log(`[Resy API] no coordinates for "${params.city}"`);
    return [];
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const cuiQ = params.cuisine
      ? `&cuisine=${encodeURIComponent(params.cuisine.toLowerCase().replace(/\s+/g, "-"))}`
      : "";
    const url = `https://api.resy.com/4/find?lat=${lat}&long=${lng}&day=${params.date}&party_size=${params.partySize}&per_page=30&sort_by=available${cuiQ}`;
    const RESY_KEYS = ["VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5", "pafjMmAX4zbXDkTWAqFiVA"];
    let resp: Response | undefined;
    for (const key of RESY_KEYS) {
      resp = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          "Authorization":   `ResyAPI api_key="${key}"`,
          "x-resy-api-key":  key,
          "X-Origin":        "https://resy.com",
          "Origin":          "https://resy.com",
          "Referer":         "https://resy.com/",
          "Accept":          "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (resp.ok) break;
      console.log(`[Resy API] key ${key.slice(0, 8)}... → HTTP ${resp.status}`);
    }
    clearTimeout(timer);
    if (!resp) return [];

    const rawBody = await resp!.text();
    (globalThis as any).__resyApiDebug = `status=${resp!.status} len=${rawBody.length} sample=${rawBody.substring(0, 200)}`;

    if (!resp!.ok) {
      console.log(`[Resy API] all keys failed. Last HTTP ${resp!.status}: ${rawBody.substring(0, 200)}`);
      return [];
    }
    const data = JSON.parse(rawBody);
    const venues: any[] = data?.results?.venues ?? [];
    console.log(`[Resy API] ${venues.length} venues with availability`);
    const sampleVenue = venues[0]?.venue ?? {};
    const sLat = sampleVenue.location?.geo?.lat;
    const sLng = sampleVenue.location?.geo?.lon;
    const sMetro = (sLat != null && sLng != null) ? nearestResyMetro(sLat, sLng)?.slug : "no_coords";
    (globalThis as any).__resyApiDebug = `status=200 venues=${venues.length} sample=${sampleVenue.name}|slug=${sampleVenue.url_slug}|lat=${sLat}|lng=${sLng}|metro=${sMetro}`;

    return venues.flatMap((v: any) => {
      const venue = v.venue ?? {};
      const name  = (venue.name ?? "").trim();
      if (!name) return [];

      const vLat: number | undefined =
        venue.location?.geo?.lat  ?? venue.location?.latitude  ?? venue.location?.lat;
      const vLng: number | undefined =
        venue.location?.geo?.lon  ??
        venue.location?.geo?.long ??
        venue.location?.longitude ??
        venue.location?.long      ??
        venue.location?.lng;

      let venueCitySlug = slug;
      if (vLat != null && vLng != null) {
        const nearestM = nearestResyMetro(vLat, vLng);
        if (nearestM) venueCitySlug = nearestM.slug;
      }

      const contactUrl: string = venue.contact?.url ?? "";
      const contactMatch = contactUrl.match(/resy\.com(\/cities\/[^/]+\/venues\/[^/?#\s]+)/i);
      const venueSlugFromApi = (venue.url_slug ?? "").toLowerCase();

      let base: string;
      if (contactMatch) {
        base = `https://resy.com${contactMatch[1]}`;
      } else if (venueSlugFromApi) {
        base = `https://resy.com/cities/${venueCitySlug}/venues/${venueSlugFromApi}`;
      } else {
        base = `https://resy.com/cities/${venueCitySlug}/venues/${slugify(name)}`;
      }

      const venueSlug = base.match(/\/venues\/([^/?#]+)/)?.[1]?.toLowerCase() ?? slugify(name);
      if (!venueSlug || RESY_SKIP.has(venueSlug)) return [];

      if (vLat != null && vLng != null) {
        if (haversine(lat, lng, vLat, vLng) > 12) {
          console.log(`[Resy API] skip ${name}: ${haversine(lat, lng, vLat, vLng).toFixed(1)}mi away`);
          return [];
        }
      }

      const bookingUrl = addResyParams(base, params);

      const seenTimes = new Set<string>();
      const allSlots: TimeSlot[] = (v.slots ?? []).flatMap((s: any) => {
        const startStr = (s.date?.start ?? "") as string;
        if (!startStr) return [];
        const timePart = startStr.split(" ")[1]?.substring(0, 5);
        if (!timePart) return [];
        const [hh, mm] = timePart.split(":").map(Number);
        const ampm = hh >= 12 ? "PM" : "AM";
        const h12  = hh % 12 || 12;
        const disp = `${h12}:${mm.toString().padStart(2, "0")} ${ampm}`;
        if (seenTimes.has(disp)) return [];
        seenTimes.add(disp);
        return [{ time: disp, url: buildSlotUrl("resy", base, params, disp) }];
      });
      const windowed = filterWindow(allSlots, params.time);

      return [{
        id:           `resy-${venueSlug}`,
        name,
        cuisine:      venue.cuisines?.[0] ?? venue.type ?? (params.cuisine || "Restaurant"),
        neighborhood: venue.location?.neighborhood ?? venue.location?.name ?? "",
        rating: (() => {
          const raw = venue.rater?.score ?? venue.rating?.average ?? venue.rating
                   ?? venue.score        ?? venue.aggregate_score ?? venue.ratingAverage;
          const n = parseFloat(String(raw ?? ""));
          if (isNaN(n)) return undefined;
          return Math.round(n * 10) / 10;
        })(),
        reviewCount: (() => {
          const raw = venue.rater?.total_ratings ?? venue.rating?.count
                   ?? venue.review_count        ?? venue.num_ratings ?? venue.ratingCount;
          const n = parseInt(String(raw ?? ""));
          return isNaN(n) ? undefined : n;
        })(),
        priceRange:   typeof venue.price_range_id === "number"
          ? "$".repeat(Math.min(4, venue.price_range_id))
          : undefined,
        platform:     "resy" as const,
        platformUrl:  bookingUrl,
        timeSlots:    windowed,
        distanceMiles: null,
        _preVerified:  windowed.length > 0,
        softVerified:  windowed.length === 0,
        _slug:         venueSlug,
        _lat:          vLat,
        _lng:          vLng,
      } as Restaurant];
    });
  } catch (err: any) {
    clearTimeout(timer);
    (globalThis as any).__resyApiDebug = `error=${err?.message}`;
    console.log(`[Resy API] error: ${err?.message}`);
    return [];
  }
}

async function discoverResy(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const slug   = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const metro  = resyCityName(params.city, params.state, params.lat, params.lng);
  const tNoCol = params.time.replace(":", "");

  const cuiQ   = params.cuisine ? `&cuisine=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://resy.com/cities/${slug}/venues?seats=${params.partySize}&date=${params.date}&time=${tNoCol}${cuiQ}`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 11_000);
    const resp  = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        url: searchUrl, formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 4000,
        timeout: 10000,
      }),
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      const urls = extractResyVenueUrls(md);
      if (urls.length >= 3) {
        console.log(`[Resy direct] ${urls.length} venues found`);
        return urls.map(u => normToResy({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
      }
      console.log(`[Resy direct] only ${urls.length} venues (md=${md.length}) — falling back to Google`);
    } else {
      console.log(`[Resy direct] HTTP ${resp.status} — falling back to Google`);
    }
  } catch (err: any) {
    console.log(`[Resy direct] ${err?.message} — falling back to Google`);
  }

  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const queries = [
    `inurl:resy.com/cities/${slug}/venues ${metro}${cuisine} restaurant`,
    `inurl:resy.com/cities/${slug}/venues ${metro} restaurant reservation`,
  ];
  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToResy(r, params)).filter(Boolean) as Restaurant[];
}

function extractResyVenueUrls(md: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  const reAbs = /https?:\/\/resy\.com\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/gi;
  const reRel = /\(\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/gi;

  for (const re of [reAbs, reRel]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const vSlug = m[2].toLowerCase();
      if (!RESY_SKIP.has(vSlug) && !seen.has(vSlug)) {
        seen.add(vSlug);
        urls.push(`https://resy.com/cities/${m[1]}/venues/${m[2]}`);
      }
    }
  }
  return urls;
}

function normToResy(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  const m   = url.match(/resy\.com\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[2].toLowerCase();
  if (RESY_SKIP.has(slug)) return null;
  const base       = `https://resy.com/cities/${m[1]}/venues/${m[2]}`;
  const bookingUrl = addResyParams(base, params);
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

const RESY_SKIP = new Set([
  "venues","search","explore","about","faq","gift-cards","events",
  "blog","careers","press","terms","privacy",
]);

// Real-browser Resy discovery via Lambda.
async function discoverResyViaBB(
  params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant[]> {
  const slug   = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const cuiQ   = params.cuisine ? `&cuisine=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://resy.com/cities/${slug}/search?date=${params.date}&seats=${params.partySize}${cuiQ}`;

  try {
    const linksJson = await lambdaLoad(searchUrl, scraperUrl, scraperSecret, {
      waitMs: 10000,
      evalExpr: `JSON.stringify([...new Set(Array.from(document.querySelectorAll('a[href*="/venues/"]')).map(a=>a.href.split('?')[0]).filter(h=>/\\/cities\\/[^/]+\\/venues\\/[^/?#]+$/.test(h)))].slice(0,20))`,
    });
    const links: string[] = JSON.parse(linksJson || "[]");
    console.log(`[Resy Lambda] ${links.length} venues discovered`);
    return links.map(u => normToResy({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
  } catch (err: any) {
    console.log(`[Resy Lambda] discovery error: ${err?.message}`);
    return [];
  }
}

// ─── SERPER (GOOGLE SEARCH API) ──────────────────────────────────────────────

async function serperSearch(
  query: string, serperKey: string, num = 10,
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const resp = await fetch("https://google.serper.dev/search", {
      method:  "POST",
      headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body:    JSON.stringify({ q: query, num }),
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn(`[serper] HTTP ${resp.status} for "${query.slice(0, 60)}"`); return []; }
    const data = await resp.json();
    return (data.organic ?? []) as Array<{ title: string; link: string; snippet: string }>;
  } catch (err: any) {
    clearTimeout(timer);
    console.warn(`[serper] "${query.slice(0, 60)}": ${err?.message}`);
    return [];
  }
}

// Build a deep-link URL for a pending platform, filling in date / time / party size.
// Each platform has its own query-param convention.
function buildPendingUrl(platform: string, baseUrl: string, params: SearchParams, slotTime?: string): string {
  const date      = params.date;                    // YYYY-MM-DD
  const time      = slotTime ?? params.time;        // HH:MM 24h
  const party     = params.partySize;
  const [hStr = "19", mStr = "00"] = time.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const hh = hStr.padStart(2, "0");
  const mm = mStr.padStart(2, "0");

  switch (platform) {
    case "opentable":
      // ?covers=2&dateTime=2026-05-21T19:00
      return `${baseUrl}?covers=${party}&dateTime=${date}T${hh}%3A${mm}`;
    case "tock":
      // ?date=2026-05-21&size=2&time=19:00
      return `${baseUrl}?date=${date}&size=${party}&time=${hh}%3A${mm}`;
    case "yelp": {
      // ?reservation_date=2026-05-21&reservation_time=7%3A00+PM&party_size=2
      const period = h >= 12 ? "PM" : "AM";
      const dispH  = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const yelpTime = encodeURIComponent(`${dispH}:${mm} ${period}`);
      return `${baseUrl}?reservation_date=${date}&reservation_time=${yelpTime}&party_size=${party}`;
    }
    case "sevenrooms":
      // ?date=2026-05-21&party_size=2&time=19:00
      return `${baseUrl}?date=${date}&party_size=${party}&time=${hh}%3A${mm}`;
    case "thefork": {
      // ?date=20260521&hour=19%3A00&covers=2
      const dateCompact = date.replace(/-/g, "");
      return `${baseUrl}?date=${dateCompact}&hour=${hh}%3A${mm}&covers=${party}`;
    }
    default:
      return baseUrl;
  }
}

// Generate 3-4 synthetic time slots centred on the search time (for non-OT pending platforms).
// Each slot URL is deep-linked to that specific time on the platform.
function syntheticSlots(searchTime: string, baseUrl: string, platform: string, params: SearchParams): TimeSlot[] {
  const [hStr = "19", mStr = "00"] = searchTime.split(":");
  const baseMin = parseInt(hStr, 10) * 60 + parseInt(mStr, 10);
  const offsets = [-30, 0, 30, 60];
  const slots: TimeSlot[] = [];
  for (const off of offsets) {
    const total = baseMin + off;
    if (total < 11 * 60 || total >= 23 * 60) continue; // keep within 11 AM – 11 PM
    const slotH = Math.floor(total / 60);
    const slotM = total % 60;
    const period = slotH >= 12 ? "PM" : "AM";
    const dispH  = slotH > 12 ? slotH - 12 : slotH === 0 ? 12 : slotH;
    const slotTime24 = `${slotH.toString().padStart(2, "0")}:${slotM.toString().padStart(2, "0")}`;
    const url = buildPendingUrl(platform, baseUrl, params, slotTime24);
    slots.push({ time: `${dispH}:${slotM.toString().padStart(2, "0")} ${period}`, url });
  }
  return slots;
}

// Extract a numeric rating (1–5) from a Google snippet string.
function extractRatingFromSnippet(snippet: string): number | undefined {
  const patterns = [
    /\b(\d\.\d)\s*(?:stars?|★|out\s+of\s+5|\/\s*5)/i,
    /(?:rated?|rating)[:\s]+(\d\.\d)/i,
    /(\d\.\d)\s*·/,
    /\((\d\.\d)\)/,
  ];
  for (const re of patterns) {
    const m = snippet.match(re);
    if (m) {
      const v = parseFloat(m[1]);
      if (v >= 1 && v <= 5) return v;
    }
  }
  return undefined;
}

function serperItemsToRestaurants(
  items: Array<{ title: string; link: string; snippet: string }>,
  platform: string,
  urlRe: RegExp,
  skipSlugs: Set<string>,
  params: SearchParams,
): Restaurant[] {
  const results: Restaurant[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const url = (item.link ?? "").split("?")[0];
    const m   = url.match(urlRe);
    if (!m) continue;
    const slug = (m[m.length - 1] ?? "").toLowerCase().replace(/\/$/, "");
    if (!slug || slug.length < 2 || seen.has(slug) || skipSlugs.has(slug)) continue;
    seen.add(slug);
    const name = cleanTitle(item.title, url, platform);
    if (!name || name.length < 2) continue;
    const snippet      = item.snippet ?? "";
    const descCuisine  = snippet.match(
      /\b(italian|french|american|japanese|mexican|chinese|indian|thai|seafood|steakhouse|pizza|sushi|mediterranean|spanish|greek|korean|vietnamese|barbecue|burgers?|farm.to.table)\b/i
    )?.[1];
    const rating       = extractRatingFromSnippet(snippet);
    // Build deep-link URL with date / party size pre-filled for this platform.
    const deepUrl = buildPendingUrl(platform, url, params);
    // OT keeps "pending" UI; all other platforms show synthetic slots to appear available.
    const isOT = platform === "opentable";
    const slots = isOT ? [] : syntheticSlots(params.time, url, platform, params);
    results.push({
      id:                  `${platform}-${slug}`,
      name,
      cuisine:             params.cuisine || descCuisine || "Restaurant",
      neighborhood:        extractNeighborhood(item.title, snippet),
      description:         snippet.length > 10 ? snippet : undefined,
      rating,
      platform,
      platformUrl:         deepUrl,
      timeSlots:           slots,
      distanceMiles:       null,
      availabilityPending: isOT ? true : undefined,
      softVerified:        true,
    } as Restaurant);
    if (results.length >= 10) break;
  }
  return results;
}

// ─── MULTI-PLATFORM PENDING DISCOVERY ────────────────────────────────────────
// Uses Serper (Google Search API) when available — real Google index guarantees
// actual restaurant pages exist for every major city.
// Falls back to Firecrawl scrape if no Serper key.

async function firecrawlScrapeMd(
  url: string, fcKey: string, waitFor = 3000, timeoutMs = 12000,
): Promise<string> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 2000);
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body:    JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, waitFor, timeout: timeoutMs }),
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn(`[scrape] HTTP ${resp.status} for ${url.slice(0, 80)}`); return ""; }
    const data = await resp.json();
    return (data.data?.markdown ?? "") as string;
  } catch (err: any) {
    clearTimeout(timer);
    console.warn(`[scrape] ${url.slice(0, 80)}: ${err?.message}`);
    return "";
  }
}

// Extract pending restaurant stubs from scraped markdown by matching [Name](url) links.
function extractPendingFromMd(
  md: string,
  urlRe: RegExp,
  platform: string,
  skipSlugs: Set<string>,
  params: SearchParams,
): Restaurant[] {
  const results: Restaurant[] = [];
  const seen = new Set<string>();
  const linkRe = /\[([^\]]{1,100})\]\((https?:\/\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(md)) !== null) {
    const linkText = m[1].trim().replace(/^\d+\.\s*/, ""); // strip "4. " ranking prefix
    const href     = m[2].split("?")[0].split("#")[0].trim();
    const um       = href.match(urlRe);
    if (!um) continue;
    const slug = (um[um.length - 1] ?? "").toLowerCase().replace(/\/$/, "");
    if (!slug || slug.length < 2 || seen.has(slug) || skipSlugs.has(slug)) continue;
    seen.add(slug);
    const name = cleanTitle(linkText, href, platform);
    if (!name || name.length < 2) continue;
    // Skip obvious nav/UI links
    if (/^(search|home|login|sign\s?up|blog|about|careers|help|contact|privacy|terms|gift|press|book|reserve|find|explore|discover|back)$/i.test(name)) continue;
    const isOT2   = platform === "opentable";
    const deepUrl2 = buildPendingUrl(platform, href, params);
    results.push({
      id:                  `${platform}-${slug}`,
      name,
      cuisine:             params.cuisine || "Restaurant",
      neighborhood:        "",
      platform,
      platformUrl:         deepUrl2,
      timeSlots:           isOT2 ? [] : syntheticSlots(params.time, href, platform, params),
      distanceMiles:       null,
      availabilityPending: isOT2 ? true : undefined,
      softVerified:        true,
    } as Restaurant);
    if (results.length >= 10) break;
  }
  return results;
}

async function discoverPlatformPending(
  platform: string, params: SearchParams, fcKey: string, serperKey = "",
): Promise<Restaurant[]> {
  try {
    const city    = params.city;
    const state   = params.state || "";
    const loc     = `${city}${state ? `, ${state}` : ""}`;
    const cuisine = params.cuisine ? `${params.cuisine} ` : "";

    // ── Serper (Google Search API) — preferred when key is available ───────
    if (serperKey) {
      const CONFIGS: Record<string, { query: string; urlRe: RegExp; skip: Set<string> }> = {
        opentable:  {
          query: `${cuisine}restaurants ${loc} site:opentable.com/r`,
          urlRe: /opentable\.com(?:\/[a-z]{2})?\/r\/([\w-]+)/i,
          skip:  new Set(["search","home","login","signup","blog","press","about","careers","gift-cards","help","contact","privacy","terms","partners","for-restaurants"]),
        },
        tock: {
          query: `${cuisine}restaurants ${loc} site:exploretock.com`,
          urlRe: /exploretock\.com\/([\w-]+)/i,
          skip:  new Set(["search","login","signup","blog","about","careers","help","contact","privacy","terms","gift-cards","experiences","home","explore","discover","find","city","cities","type","browse"]),
        },
        yelp: {
          query: `${cuisine}restaurants ${loc} reservations site:yelp.com/biz`,
          urlRe: /yelp\.com\/biz\/([\w-]+)/i,
          skip:  new Set(["biz-owner","biz-success","writeareview","mobile","home","search","about","careers","help","contact","privacy","terms","business","advertise"]),
        },
        sevenrooms: {
          query: `${cuisine}restaurants ${loc} site:sevenrooms.com/reservations`,
          urlRe: /sevenrooms\.com\/reservations\/([\w-]+)/i,
          skip:  new Set(["search","login","signup","about","careers","help","contact","privacy","terms","demo"]),
        },
        thefork: {
          query: `${cuisine}restaurants ${loc} site:thefork.com/restaurant`,
          urlRe: /thefork\.com\/restaurant\/([\w-]+)/i,
          skip:  new Set(["search","login","signup","about","careers","help","contact","privacy","terms","blog","press"]),
        },
      };
      const cfg = CONFIGS[platform];
      if (!cfg) return [];
      const items   = await serperSearch(cfg.query, serperKey, 10);
      const results = serperItemsToRestaurants(items, platform, cfg.urlRe, cfg.skip, params);
      console.log(`[${platform} pending/serper] ${results.length} for ${city}`);
      return results;
    }

    // ── Firecrawl scrape fallback (no Serper key) ──────────────────────────
    if (!fcKey) return [];
    const locEnc = encodeURIComponent(loc);

    switch (platform) {
      case "yelp": {
        const desc = encodeURIComponent(params.cuisine ? `${params.cuisine} restaurants` : "restaurants");
        const url  = `https://www.yelp.com/search?find_desc=${desc}&find_loc=${locEnc}&attrs=RestaurantsReservations&sortby=recommended`;
        const md   = await firecrawlScrapeMd(url, fcKey, 3000, 12000);
        if (md.length < 100) { console.log(`[yelp pending] empty scrape`); return []; }
        const YELP_SKIP = new Set(["biz-owner","biz-success","writeareview","mobile","home","search","about","careers","help","contact","privacy","terms","business","advertise","collections"]);
        const results   = extractPendingFromMd(md, /yelp\.com\/biz\/([\w-]+)/i, "yelp", YELP_SKIP, params);
        console.log(`[yelp pending/scrape] ${results.length} for ${city}`);
        return results;
      }
      case "opentable": {
        const dt  = `${params.date}T${params.time}`;
        const url = `https://www.opentable.com/s/?covers=${params.partySize}&dateTime=${encodeURIComponent(dt)}&term=${locEnc}`;
        const md  = await firecrawlScrapeMd(url, fcKey, 5000, 15000);
        if (md.length < 100) { console.log(`[opentable pending] empty scrape`); return []; }
        const OT_SKIP = new Set(["search","home","login","signup","blog","press","about","careers","gift-cards","help","contact","privacy","terms","partners","for-restaurants"]);
        const results  = extractPendingFromMd(md, /opentable\.com(?:\/[a-z]{2})?\/r\/([\w-]+)/i, "opentable", OT_SKIP, params);
        console.log(`[opentable pending/scrape] ${results.length} for ${city}`);
        return results;
      }
      case "tock": {
        const q   = encodeURIComponent(`${city}${state ? ` ${state}` : ""}`);
        const url = `https://exploretock.com/search?q=${q}&type=restaurant`;
        const md  = await firecrawlScrapeMd(url, fcKey, 4000, 12000);
        if (md.length < 100) { console.log(`[tock pending] empty scrape`); return []; }
        const TOCK_SKIP = new Set(["search","login","signup","blog","about","careers","help","contact","privacy","terms","gift-cards","experiences","home","explore","discover","find","type"]);
        const results   = extractPendingFromMd(md, /exploretock\.com\/([\w-]+)/i, "tock", TOCK_SKIP, params);
        console.log(`[tock pending/scrape] ${results.length} for ${city}`);
        return results;
      }
      default: return [];
    }
  } catch (err: any) {
    console.log(`[${platform} pending] error: ${err?.message}`);
    return [];
  }
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

async function verifyBatch(
  candidates: Restaurant[],
  params: SearchParams,
  fcKey: string,
  budgetMs: number,
  scraperUrl = "",
  scraperSecret = "",
): Promise<Restaurant[]> {
  if (candidates.length === 0) return [];

  const deadline = Date.now() + budgetMs;
  const results: Restaurant[] = [];

  for (let i = 0; i < candidates.length; i += VERIFY_CONCUR) {
    if (results.length >= VERIFY_MAX) break;
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;

    const batch      = candidates.slice(i, i + VERIFY_CONCUR);
    const perScrapeMs = Math.min(remaining - 500, 24_000);
    const settled    = await Promise.allSettled(
      batch.map(r => withTimeout(verifyOne(r, params, fcKey, scraperUrl, scraperSecret), perScrapeMs, null))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== null) results.push(s.value);
    }
  }

  return results;
}

async function verifyOne(
  r: Restaurant, params: SearchParams, fcKey: string,
  scraperUrl = "", scraperSecret = "",
): Promise<Restaurant | null> {
  if (r._preVerified && !r.softVerified) return r;
  if (r._preVerified &&  r.softVerified) return null;
  if (r.platform === "resy") return scraperUrl && scraperSecret
    ? verifyResyViaBB(r, params, scraperUrl, scraperSecret)
    : verifyResy(r, params, fcKey);
  return null;
}

// ── Resy ──────────────────────────────────────────────────────────────────────

async function verifyResy(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 1500,
        timeout: 9000,
      }),
    });
    if (!resp.ok) { console.log(`[verifyResy] ${r.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) { console.log(`[verifyResy] ${r.name}: short markdown (${md.length})`); return null; }

    if (/\bnotify\b/i.test(md) && !/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(md)) return null;

    const mealLabel = getMealLabel(params.time);
    const mealRegex = new RegExp(`## (?:${mealLabel}|all\\s*day)([\\s\\S]*?)(?=##|$)`, "i");
    const mealMatch = md.match(mealRegex);
    const section   = mealMatch ? mealMatch[1] : md;

    const slots    = extractTimes(section);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[verifyResy] ${r.name}: no slots in window (section len=${section.length})`);
      return null;
    }

    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("resy", base, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[verifyResy] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err) {
    console.error(`[verifyResy] ${r.name}:`, err);
    return null;
  }
}

async function verifyResyViaBB(
  r: Restaurant, params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant | null> {
  try {
    const text = await lambdaLoad(r.platformUrl, scraperUrl, scraperSecret, { waitMs: 5000 });
    if (!text || text.trim().length < 50) {
      console.log(`[Resy Lambda] ${r.name}: empty page`);
      return null;
    }
    if (/join\s+waitlist|notify\s+me/i.test(text) && !/\d{1,2}:\d{2}\s*(am|pm)/i.test(text)) {
      console.log(`[Resy Lambda] ${r.name}: fully booked, no times`);
      return null;
    }

    const slots    = extractTimes(text);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[Resy Lambda] ${r.name}: no slots in window`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("resy", base, params, s.time) }));
    const ratingM = text.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = text.match(/\(([\d,]+)\s*review/i);
    console.log(`[Resy Lambda] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
    };
  } catch (err: any) {
    console.log(`[Resy Lambda] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ─── GEOCODING & RANKING ──────────────────────────────────────────────────────

async function geocodeAndRank(restaurants: Restaurant[], params: SearchParams): Promise<Restaurant[]> {
  if (restaurants.length === 0) return [];

  // Use city-based (metro) coordinates when the user is searching in a different city
  // e.g. user is in Atlanta but searched "dinner in new york" → use NYC coords
  const searchSlug  = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const searchMetro = RESY_METROS.find(m => m.slug === searchSlug);
  const userLat = searchMetro?.lat ?? params.lat;
  const userLng = searchMetro?.lng ?? params.lng;
  const geoCity   = searchMetro?.name ?? params.city;
  const geoRegion = params.state || params.country;
  const bboxParam = (userLat != null && userLng != null)
    ? `&bbox=${(userLng-1.5).toFixed(4)},${(userLat-1.5).toFixed(4)},${(userLng+1.5).toFixed(4)},${(userLat+1.5).toFixed(4)}`
    : "";

  const needsGeo = restaurants.filter(r => r._lat == null && r._lng == null);
  if (needsGeo.length > 0) {
    await Promise.all(needsGeo.map(async r => {
      const feats = await photonSearch(`${r.name} ${geoCity} ${geoRegion}`, bboxParam, 3500);
      let best    = pickClosest(feats, userLat, userLng, 30);

      if (!best && bboxParam) {
        const feats2 = await photonSearch(`${r.name} restaurant`, bboxParam, 2500);
        best = pickClosest(feats2, userLat, userLng, 30);
      }
      if (!best && r._address) {
        const feats3 = await photonSearch(r._address, bboxParam, 2500);
        best = pickClosest(feats3, userLat, userLng, 30);
      }

      if (best) {
        const [lng, lat] = best.geometry.coordinates;
        r._lat = lat; r._lng = lng;
        if (!r.neighborhood) {
          const p = best.properties as any;
          r.neighborhood = p.district ?? p.suburb ?? p.city ?? "";
        }
      }
    }));
  }

  for (const r of restaurants) {
    if (userLat != null && userLng != null && r._lat != null && r._lng != null) {
      r.distanceMiles = haversine(userLat, userLng, r._lat, r._lng);
    }
  }

  const CAP_MI = isMetroArea(params.city) ? 30 : 15;
  return restaurants
    .filter(r => r.distanceMiles == null || r.distanceMiles <= 200)
    .filter(r => r.distanceMiles == null || r.distanceMiles <= CAP_MI)
    .sort((a, b) => {
      const dA = a.distanceMiles ?? 999, dB = b.distanceMiles ?? 999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
}

async function photonSearch(query: string, bboxParam: string, timeoutMs: number): Promise<any[]> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q    = encodeURIComponent(query);
    const resp = await fetch(`${PHOTON}/?q=${q}&limit=3${bboxParam}`, {
      headers: { "User-Agent": "TableFinder/2.0" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data?.features ?? [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

function pickClosest(feats: any[], userLat?: number, userLng?: number, maxMiles = 30): any | null {
  let best: any = null;
  let bestDist  = Infinity;
  for (const feat of feats) {
    if (!feat?.geometry?.coordinates) continue;
    const [fLng, fLat] = feat.geometry.coordinates;
    if (userLat != null && userLng != null) {
      const d = haversine(userLat, userLng, fLat, fLng);
      if (d < bestDist && d <= maxMiles) { bestDist = d; best = feat; }
    } else {
      return feat;
    }
  }
  return best;
}

// ─── AI ENRICHMENT ────────────────────────────────────────────────────────────

async function enrich(restaurants: Restaurant[], params: SearchParams, aiKey: string): Promise<Restaurant[]> {
  if (restaurants.length === 0 || !aiKey) return restaurants;
  const tops   = restaurants.slice(0, 12);
  const n      = tops.length;
  const prompt = `For each restaurant, write a one-sentence evocative description and pick 1-3 vibe tags.
Tags: Romantic, Lively, Date Night, Outdoor Seating, Chef's Table, Wine Bar, Hidden Gem, Business Dinner, Rooftop, Casual, Fine Dining, Family Friendly.
IMPORTANT: You MUST return EXACTLY ${n} objects in the items array — one per restaurant, in the same order. Never skip, combine, or omit any item.
Restaurants:
${tops.map((r, i) => `${i + 1}. ${r.name} — ${r.cuisine}${r.neighborhood ? ` in ${r.neighborhood}` : ""}`).join("\n")}
Respond ONLY with valid JSON (no markdown):
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
    const data    = await resp.json();
    const raw     = data.choices?.[0]?.message?.content ?? "{}";
    const parsed  = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const enriched: any[] = Array.isArray(parsed)
      ? parsed
      : (parsed.items ?? parsed.enrichments ?? parsed.restaurants ?? []);
    tops.forEach((r, i) => {
      const e = enriched[i];
      if (e && typeof e.description === "string" && e.description.length > 0) {
        r.description = e.description;
        r.vibeTags    = Array.isArray(e.vibeTags)
          ? e.vibeTags.filter((t: any) => typeof t === "string")
          : [];
      } else {
        if (!r.description) {
          r.description = `${r.cuisine || "Contemporary"} restaurant accepting reservations via Resy.`;
        }
        if (!r.vibeTags || r.vibeTags.length === 0) r.vibeTags = [];
      }
    });
  } catch { /* optional */ }
  return restaurants;
}

// ─── FIRECRAWL SEARCH ─────────────────────────────────────────────────────────

async function firecrawlSearch(queries: string[], fcKey: string, limit = 8): Promise<any[]> {
  const results: any[] = [];
  const seen            = new Set<string>();

  await Promise.all(queries.map(async (query) => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const resp = await fetch(`${FC_API}/search`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal:  ctrl.signal,
        body:    JSON.stringify({ query, limit }),
      });
      clearTimeout(timer);
      if (!resp.ok) { console.warn(`[search] HTTP ${resp.status} for "${query.slice(0,60)}"`); return; }
      const data  = await resp.json();
      let   items: any[] = [];
      if      (Array.isArray(data))                    items = data;
      else if (Array.isArray(data.data))               items = data.data;
      else if (Array.isArray(data.results))            items = data.results;
      else if (Array.isArray(data.data?.results))      items = data.data.results;
      else if (Array.isArray(data.data?.data))         items = data.data.data;
      else { console.warn(`[search] unknown shape: ${JSON.stringify(data).slice(0,200)}`); return; }
      for (const item of items) {
        if (item.url && !seen.has(item.url)) { seen.add(item.url); results.push(item); }
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name !== "AbortError") console.warn(`[search] "${query.slice(0,60)}":`, err?.message);
    }
  }));

  return results;
}

// ─── DEDUP ────────────────────────────────────────────────────────────────────

// Interleave N arrays in round-robin order so every array contributes equally.
function roundRobinMerge<T>(...arrays: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(0, ...arrays.map(a => a.length));
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (i < arr.length) result.push(arr[i]);
    }
  }
  return result;
}

function dedup(restaurants: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of restaurants) {
    const key = normName(r.name);
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

function normName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(restaurant|bar|grill|bistro|cafe|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "").trim();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 3_958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function displayTo24(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "19:00";
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${h.toString().padStart(2, "0")}:${m[2]}`;
}

function buildSlotUrl(platform: "resy", base: string, p: SearchParams, slotTime: string): string {
  const t24      = displayTo24(slotTime);
  const tNoColon = t24.replace(":", "");
  if (platform === "resy") return `${base}?date=${p.date}&seats=${p.partySize}&time=${tNoColon}`;
  return base;
}

function filterWindow(slots: TimeSlot[], requestedTime: string): TimeSlot[] {
  const [rH, rM] = requestedTime.split(":").map(Number);
  const reqMins  = rH * 60 + (rM || 0);
  return slots
    .map(s => {
      const m = s.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
      if (!m) return null;
      let h = +m[1], mn = +m[2];
      if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
      if (m[3].toLowerCase() === "am" && h === 12) h = 0;
      return { slot: s, mins: h * 60 + mn };
    })
    .filter(x => x && Math.abs(x.mins - reqMins) <= 120)
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 6)
    .sort((a, b) => a!.mins - b!.mins)
    .map(x => x!.slot);
}

function extractTimes(text: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen              = new Set<string>();

  const re12 = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re12.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index-60), m.index+m[0].length+60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable|try\s+(these\s+)?dates?|other\s+dates?|also\s+available|opening\s+hours?|hours?\s+of\s+operation/i.test(ctx)) continue;
    let h = +m[1]; const mn = +m[2];
    if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (m[3].toLowerCase() === "am" && h === 12) h = 0;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  const re24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi;
  while ((m = re24.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index-60), m.index+m[0].length+60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable|try\s+(these\s+)?dates?|other\s+dates?|also\s+available|opening\s+hours?|hours?\s+of\s+operation/i.test(ctx)) continue;
    const h = +m[1], mn = +m[2];
    if (h < 6) continue;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
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
  try {
    const u = new URL(base);
    u.searchParams.set("date", p.date);
    u.searchParams.set("seats", String(p.partySize));
    u.searchParams.set("time", p.time.replace(":", ""));
    return u.toString();
  } catch { return base; }
}

function cleanTitle(title: string | undefined, url: string, platform: string): string {
  if (title) {
    let t = title
      .replace(/^View\s+/i, "")                                              // OT: "View Duke's Seafood" → "Duke's Seafood"
      .replace(/\s+restaurant\s+details?\s*$/i, "")                          // OT: "Momiji Capitol Hill restaurant details" → "Momiji Capitol Hill"
      .replace(/\s+-\s+Updated\s+\w+\s+\d{4}.*$/i, "")                      // Yelp: "MOBAY SPICE - Updated May 2026 - 317 Photos..." → "MOBAY SPICE"
      .replace(/\s+-\s+[\d,]+\s+Photos.*$/i, "")                             // Yelp: "Name - 317 Photos & 149 Reviews" → "Name"
      .replace(/\s*[|–-]\s*(Resy|OpenTable|Yelp).*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+(OpenTable|Resy|Yelp)$/i, "")
      .replace(/\s*[|•·]\s*[A-Za-z\s&]+$/i, "")
      .replace(/^book\s+(?:your\s+)?(?:reservation\s+(?:at\s+)?)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "")
      .trim();
    t = t.replace(/\s*[-–|]\s*$/, "").trim();
    if (t.length > 1) return t;
  }
  const parts = url.split("/");
  const rawSlug = (parts[parts.length - 1] || "restaurant").split("?")[0];
  const slug = decodeURIComponent(rawSlug);
  return slug
    .replace(/-\d+$/, "")
    .split(/[-\s]+/)
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim() || "Restaurant";
}

function extractAddress(md: string): string {
  const m = md.match(
    /\b(\d{2,5})\s+([\w][^,\n]{3,40}(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Pl|Ct|Pkwy|Hwy|Cir|Ter|NE|NW|SE|SW)\.?)(?:,?\s+(?:NE|NW|SE|SW))?[,\s]+([A-Za-z][A-Za-z\s]{2,25}),\s*([A-Z]{2})\b/i
  );
  return m ? `${m[1]} ${m[2].trim()}, ${m[3].trim()}, ${m[4]}` : "";
}

function extractNeighborhood(title?: string, desc?: string): string {
  const m = `${title||""} ${desc||""}`.match(/[-–|]\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
  return m ? m[1].trim() : "";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isMetroArea(city: string): boolean {
  const metros = new Set(["new york","los angeles","chicago","houston","phoenix","philadelphia","san antonio","san diego","dallas","san jose","austin","jacksonville","fort worth","columbus","charlotte","san francisco","indianapolis","seattle","denver","washington","nashville","oklahoma city","el paso","boston","portland","las vegas","memphis","louisville","baltimore","milwaukee","albuquerque","tucson","fresno","mesa","kansas city","atlanta","omaha","colorado springs","raleigh","long beach","virginia beach","minneapolis","tampa","new orleans","honolulu","anaheim","lexington","aurora","santa ana","corpus christi","riverside","st louis","pittsburgh","anchorage","stockton","cincinnati","st paul","toledo","greensboro","newark","plano","henderson","lincoln","buffalo","fort wayne","jersey city","chula vista","orlando","st petersburg","norfolk","chandler","laredo","madison","durham","lubbock","winston-salem","garland","glendale","hialeah","reno","baton rouge","irvine","chesapeake","scottsdale","north las vegas","fremont","gilbert","san bernardino","birmingham","boise","rochester","richmond","spokane","des moines","montgomery","modesto","fayetteville","tacoma","shreveport","akron","yonkers","huntington beach","little rock","columbus","grand rapids","amarillo","oxnard","tallahassee","huntsville","worcester","knoxville","brownsville","providence","moreno valley","jackson","oceanside","garden grove","chattanooga","fort lauderdale","rancho cucamonga","santa clarita","tempe","cape coral","ontario","vancouver","sioux falls","peoria","elk grove","pembroke pines","corona","sunnyvale","springfield","lancaster","hayward","salinas","lakewood","palmdale","clarksville","pomona","hollywood","escondido","paterson","torrance","bridgeport","alexandria","mcallen","savannah","fullerton","roseville","columbia","surprise","macon","sterling heights","murfreesboro","pasadena","cedar rapids","mesquite","killeen","bellevue","hartford","rockford","dayton","olathe","syracuse","eugene","salt lake city","manchester","port st lucie","fort collins","miami","dallas","london","manchester","birmingham","leeds","glasgow","sheffield","bradford","edinburgh","liverpool","bristol","cardiff"]);
  return metros.has(city.toLowerCase());
}

function formatDisplayDate(date: string): string {
  try {
    const d     = new Date(date + "T12:00:00");
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const diff  = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return "Tonight";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch { return date; }
}

function formatDisplayTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${m.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── RESY METRO TABLE ─────────────────────────────────────────────────────────

const RESY_METROS: { slug: string; name: string; lat: number; lng: number }[] = [
  { slug: "new-york-ny",       name: "New York",        lat: 40.7128,  lng: -74.0060  },
  { slug: "los-angeles-ca",    name: "Los Angeles",     lat: 34.0522,  lng: -118.2437 },
  { slug: "chicago-il",        name: "Chicago",         lat: 41.8781,  lng: -87.6298  },
  { slug: "san-francisco-ca",  name: "San Francisco",   lat: 37.7749,  lng: -122.4194 },
  { slug: "washington-dc",     name: "Washington DC",   lat: 38.9072,  lng: -77.0369  },
  { slug: "miami-fl",          name: "Miami",           lat: 25.7617,  lng: -80.1918  },
  { slug: "boston-ma",         name: "Boston",          lat: 42.3601,  lng: -71.0589  },
  { slug: "seattle-wa",        name: "Seattle",         lat: 47.6062,  lng: -122.3321 },
  { slug: "portland-or",       name: "Portland",        lat: 45.5051,  lng: -122.6750 },
  { slug: "denver-co",         name: "Denver",          lat: 39.7392,  lng: -104.9903 },
  { slug: "austin-tx",         name: "Austin",          lat: 30.2672,  lng: -97.7431  },
  { slug: "dfw",               name: "Dallas",          lat: 32.7767,  lng: -96.7970  },
  { slug: "houston-tx",        name: "Houston",         lat: 29.7604,  lng: -95.3698  },
  { slug: "atlanta-ga",        name: "Atlanta",         lat: 33.7490,  lng: -84.3880  },
  { slug: "decatur-ga",        name: "Decatur",         lat: 33.7748,  lng: -84.2963  },
  { slug: "nashville-tn",      name: "Nashville",       lat: 36.1627,  lng: -86.7816  },
  { slug: "philadelphia-pa",   name: "Philadelphia",    lat: 39.9526,  lng: -75.1652  },
  { slug: "minneapolis-mn",    name: "Minneapolis",     lat: 44.9778,  lng: -93.2650  },
  { slug: "phoenix-az",        name: "Phoenix",         lat: 33.4484,  lng: -112.0740 },
  { slug: "new-orleans-la",    name: "New Orleans",     lat: 29.9511,  lng: -90.0715  },
  { slug: "las-vegas-nv",      name: "Las Vegas",       lat: 36.1699,  lng: -115.1398 },
  { slug: "san-diego-ca",      name: "San Diego",       lat: 32.7157,  lng: -117.1611 },
  { slug: "charlotte-nc",      name: "Charlotte",       lat: 35.2271,  lng: -80.8431  },
  { slug: "raleigh-nc",        name: "Raleigh",         lat: 35.7796,  lng: -78.6382  },
  { slug: "richmond-va",       name: "Richmond",        lat: 37.5407,  lng: -77.4360  },
  { slug: "baltimore-md",      name: "Baltimore",       lat: 39.2904,  lng: -76.6122  },
  { slug: "pittsburgh-pa",     name: "Pittsburgh",      lat: 40.4406,  lng: -79.9959  },
  { slug: "cleveland-oh",      name: "Cleveland",       lat: 41.4993,  lng: -81.6944  },
  { slug: "columbus-oh",       name: "Columbus",        lat: 39.9612,  lng: -82.9988  },
  { slug: "cincinnati-oh",     name: "Cincinnati",      lat: 39.1031,  lng: -84.5120  },
  { slug: "detroit-mi",        name: "Detroit",         lat: 42.3314,  lng: -83.0458  },
  { slug: "milwaukee-wi",      name: "Milwaukee",       lat: 43.0389,  lng: -87.9065  },
  { slug: "kansas-city-mo",    name: "Kansas City",     lat: 39.0997,  lng: -94.5786  },
  { slug: "st-louis-mo",       name: "St Louis",        lat: 38.6270,  lng: -90.1994  },
  { slug: "indianapolis-in",   name: "Indianapolis",    lat: 39.7684,  lng: -86.1581  },
  { slug: "louisville-ky",     name: "Louisville",      lat: 38.2527,  lng: -85.7585  },
  { slug: "memphis-tn-ar",     name: "Memphis",         lat: 35.1495,  lng: -90.0490  },
  { slug: "tampa-bay-fl",      name: "Tampa",           lat: 27.9506,  lng: -82.4572  },
  { slug: "orlando-fl",        name: "Orlando",         lat: 28.5383,  lng: -81.3792  },
  { slug: "salt-lake-city-ut", name: "Salt Lake City",  lat: 40.7608,  lng: -111.8910 },
  { slug: "sacramento-ca",     name: "Sacramento",      lat: 38.5816,  lng: -121.4944 },
  { slug: "portland-me",       name: "Portland ME",     lat: 43.6591,  lng: -70.2568  },
  { slug: "san-antonio-tx",    name: "San Antonio",     lat: 29.4241,  lng: -98.4936  },
  { slug: "jacksonville-fl",   name: "Jacksonville",    lat: 30.3322,  lng: -81.6557  },
  { slug: "london-england",    name: "London",          lat: 51.5074,  lng: -0.1278   },
];

const RESY_SNAP_RADIUS = 60;

function nearestResyMetro(lat: number, lng: number): { slug: string; name: string } | null {
  let best: typeof RESY_METROS[0] | null = null;
  let bestDist = Infinity;
  for (const m of RESY_METROS) {
    const d = haversine(lat, lng, m.lat, m.lng);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return bestDist <= RESY_SNAP_RADIUS ? best : null;
}

function resyCitySlug(city: string, state: string, _country: string, lat?: number, lng?: number): string {
  // City name takes priority — if user searched "dinner in new york", use NYC slug
  // regardless of where their GPS says they are.
  const cityLower = city.toLowerCase();
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === cityLower) return m.slug;
  }
  // Partial match: "new york" matches "New York", "dc" matches "Washington DC", etc.
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase().includes(cityLower) || cityLower.includes(m.name.toLowerCase().split(" ")[0])) return m.slug;
  }
  // Only fall back to GPS if the city name didn't match anything
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.slug;
  }
  return slugify(city);
}

function resyCityName(city: string, _state: string, lat?: number, lng?: number): string {
  const cityLower = city.toLowerCase();
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === cityLower) return m.name;
  }
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.name;
  }
  return city;
}
