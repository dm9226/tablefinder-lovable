// TableFinder Search Edge Function — v101
// Platforms: Resy, OpenTable, Yelp
//
// Required env vars:
//   FIRECRAWL_API_KEY
//   LOVABLE_API_KEY
//
// Optional:
//   APIFY_API_TOKEN   — enables OpenTable via Apify
//   SCRAPER_LAMBDA_URL — AWS Lambda scraper URL (enables real-browser Resy + OT)
//   SCRAPER_SECRET     — shared secret for Lambda scraper auth
//
// v16 changes:
//   • lambdaLoad(): replaces bbLoad() CDP WebSocket — simple HTTP call to AWS Lambda
//   • AWS Lambda runs real headless Chrome (@sparticuz/chromium + playwright-core)
//   • discoverResyViaBB/discoverOTViaBB/verifyResyViaBB/verifyOTViaBB now use Lambda
//   • verifyYelp: detects /reservations/→/biz/ redirects (fixes false positives like
//     Poor Calvin's that appear in Yelp search but don't use Yelp reservations)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FC_API     = "https://api.firecrawl.dev/v2";
const APIFY_API  = "https://api.apify.com/v2";
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
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
  softVerified?: boolean;
  _lat?: number; _lng?: number;
  _slug?: string; _rid?: string;
  _preVerified?: boolean;
  _address?: string;   // extracted from scraped markdown; geocoding fallback
  _widgetUrl?: string; // OT widget canvas URL (lighter Akamai target than main page)
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

// ─── MODULE-LEVEL OT RID CACHE ────────────────────────────────────────────────
// Deno Deploy reuses isolates for warm requests within the same region.
// This map persists between requests, accumulating discovered RIDs over time.
// Cold starts begin empty; warm requests benefit from prior discoveries.
// Key: OT slug (e.g. "white-bull-restaurant-decatur"), value: numeric RID string.
// Seeded lazily from OT_SLUG_TO_RID after that table is defined.
// Additional RIDs accumulate at runtime via cacheOTRid().
const OT_RID_CACHE = new Map<string, string>();

function cacheOTRid(slug: string, rid: string): void {
  if (slug && rid && /^\d+$/.test(rid)) OT_RID_CACHE.set(slug, rid);
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const start = Date.now();
  try {
    const body = await req.json();
    const FIRECRAWL      = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
    const AI_KEY         = Deno.env.get("LOVABLE_API_KEY") ?? "";
    const APIFY          = Deno.env.get("APIFY_API_TOKEN") ?? "";
    const SCRAPER_URL    = Deno.env.get("SCRAPER_LAMBDA_URL") ?? "";
    const SCRAPER_SECRET = Deno.env.get("SCRAPER_SECRET") ?? "";
    const BB_KEY         = Deno.env.get("BROWSERBASE_API_KEY")    ?? "";
    const BB_PROJECT     = Deno.env.get("BROWSERBASE_PROJECT_ID") ?? "";

    if (body.extended === true) {
      const extra = await runExtendedSearch(body, FIRECRAWL, AI_KEY, APIFY, SCRAPER_URL, SCRAPER_SECRET);
      return json({ results: extra });
    }

    const { query, lat, lng, location } = body;
    const params = await withTimeout(
      parseQuery(query, lat, lng, location, AI_KEY),
      5_000,
      fallbackParams(lat, lng, location)
    );
    console.log(`[params] ${JSON.stringify(params)}`);

    // ── Discovery ─────────────────────────────────────────────────────────────
    // When Browserbase keys are present, all three platforms run in parallel via
    // real browser (CDP). Otherwise: Resy = 0 (SPA blocks bots), OT = Apify if
    // configured else 0 (Akamai blocks bots), Yelp = always via Firecrawl.
    const [resyCands, otCands, yelpCands] = await Promise.all([
      // Resy: Try the public JSON API first (api.resy.com/4/find) — returns pre-verified
      // venues with real time slots in one HTTP call, no SPA scraping needed.
      // Falls back to Firecrawl Google search if the API returns 0 results.
      abortableDiscover(async () => {
        const apiResults = await discoverResyViaAPI(params);
        if (apiResults.length > 0) {
          console.log(`[Resy] API returned ${apiResults.length} pre-verified venues`);
          return apiResults;
        }
        // Tier 2: Firecrawl Google search — works when the API key is rotated/blocked
        console.log("[Resy] API returned 0 — falling back to Firecrawl");
        const fcResults = await discoverResy(params, FIRECRAWL);
        if (fcResults.length > 0) {
          console.log(`[Resy] Firecrawl returned ${fcResults.length} venues`);
          return fcResults;
        }
        // Tier 3: Lambda real-browser — renders the Resy SPA and extracts venue links
        if (SCRAPER_URL && SCRAPER_SECRET) {
          console.log("[Resy] Firecrawl returned 0 — falling back to Lambda browser");
          return discoverResyViaBB(params, SCRAPER_URL, SCRAPER_SECRET);
        }
        return [];
      }, DISCOVER_MS),
      // OT: Two parallel approaches merged — Yahoo/FC search (for RIDs) + BB real browser
      // (for comprehensive restaurant list). BB loads OT's own search page through residential
      // proxy; Yahoo/FC search finds profile URLs with numeric RIDs. Results are merged.
      abortableDiscover(async () => {
        const [fcCands, bbCands, nextDataCands] = await Promise.all([
          discoverOTviaWidgetCanvas(params, FIRECRAWL),
          BB_KEY && BB_PROJECT
            ? discoverOTViaBB(params, BB_KEY, BB_PROJECT)
            : Promise.resolve([] as Restaurant[]),
          // OT search page __NEXT_DATA__ — if Akamai allows Firecrawl through
          // to /s/, we get RIDs from the server-rendered Next.js data blob.
          extractOTNextData(params, FIRECRAWL),
        ]);
        // Merge: BB first (may have real time slots), then FC/Yahoo (has RIDs), then NEXT_DATA
        const otSeen = new Set<string>();
        const rawMerged: Restaurant[] = [];
        for (const r of [...bbCands, ...fcCands, ...nextDataCands]) {
          if (!otSeen.has(r.id)) { otSeen.add(r.id); rawMerged.push(r); }
        }
        // Per-slug enrichment: for slug-only candidates, search for their profile URL
        const merged = await enrichOTSlugsWithRids(rawMerged, FIRECRAWL);
        console.log(`[OT merge] bb=${bbCands.length} fc=${fcCands.length} next=${nextDataCands.length} merged=${merged.length} rids=${merged.filter(r=>r._rid).length}`);
        return merged;
      }, DISCOVER_MS),
      abortableDiscover(() => discoverYelp(params, FIRECRAWL), DISCOVER_MS),
    ]);
    console.log(`[discovery] resy=${resyCands.length} ot=${otCands.length} yelp=${yelpCands.length} at ${Date.now()-start}ms`);

    // Resy/OT are pre-verified by discovery (API + Lambda DOM extracts slots directly).
    // Yelp: Firecrawl verification gives soft-verified results — better than Lambda cold starts
    // (which time out and return 0). Warm Lambda only helps if already hot from another call.
    const resySlice = resyCands.slice(0, 20);  // API pre-verifies — no scraping cost per restaurant
    const otSlice   = otCands.slice(0, 12);   // restref API is fast (~1s each)
    const yelpSlice = yelpCands.slice(0, 10); // increased from 6; server soft-verify feeds clientVerifyYelp

    // ── Verification ──────────────────────────────────────────────────────────
    const verifyStart = Date.now();
    const [resyVer, otVer, yelpVer] = await Promise.all([
      verifyBatch(resySlice,  params, FIRECRAWL, VERIFY_MS,        SCRAPER_URL, SCRAPER_SECRET, "", ""),
      verifyBatch(otSlice,    params, FIRECRAWL, VERIFY_MS,        SCRAPER_URL,  SCRAPER_SECRET, BB_KEY, BB_PROJECT),
      verifyBatch(yelpSlice,  params, FIRECRAWL, VERIFY_MS + 15_000, SCRAPER_URL, SCRAPER_SECRET, "", ""),   // BB blocked by DataDome
    ]);
    console.log(`[verify] resy=${resyVer.length} ot=${otVer.length} yelp=${yelpVer.length} in ${Date.now()-verifyStart}ms`);

    // Keep hard-verified results plus OT soft-verified (no server-side slot extraction
    // works for OT; BB discovers restaurants but can't scrape times — show as "Check on OT").
    let verified = dedup([...resyVer, ...otVer, ...yelpVer])
      .filter(r => !r.softVerified || r.platform === "opentable");

    // ── Geocode + Enrich ──────────────────────────────────────────────────────
    const [ranked] = await Promise.all([
      withTimeout(geocodeAndRank(verified, params), GEOCODE_MS, verified),
      withTimeout(enrich(verified, params, AI_KEY), ENRICH_MS,  verified),
    ]);
    verified = ranked;

    // Remaining candidates for optional second pass
    const verifiedIds = new Set(verified.map(r => r.id));
    const attempted   = new Set([...resySlice, ...otSlice, ...yelpSlice].map(r => r.id));
    const remaining   = dedup(
      [...resyCands, ...otCands, ...yelpCands]
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

    // ── Client-side verification candidates ──────────────────────────────────
    // The OT restref API and Yelp availability API are blocked from cloud IPs
    // (Akamai + DataDome) but work fine from a real browser. Return unverified
    // candidates so the frontend can call these APIs directly.
    const verifiedOTIds = new Set(otVer.map(r => r.id));
    // Only exclude HARD-verified Yelp restaurants from clientVerifyYelp.
    // Soft-verified = restaurant appears in Yelp search but server couldn't extract slots
    // (DataDome blocks Firecrawl on individual pages). The browser should still try these
    // via the real availability API — don't block them from clientVerifyYelp.
    const verifiedYelpIds = new Set(
      yelpVer.filter(r => !r.softVerified && (r.timeSlots?.length ?? 0) > 0).map(r => r.id)
    );

    // Always include ALL RID-bearing OT candidates in clientVerifyOT — even ones that were
    // "verified" server-side by BB. The BB widget canvas fix above means those results now
    // correctly return null, but even if BB returned fake times we want the browser to call
    // restref and replace them with real availability. The browser's mergeVerified will replace.
    // Include RIDs discovered server-side via __NEXT_DATA__ extraction in verifyOTViaBB.
    const ridMap: Map<string, string> = (globalThis as any).__tfRidMap ?? new Map();

    // Also include OT restaurants discovered via Yelp bridge that were soft-verified
    // (server-side restref blocked from datacenter IPs). The browser can call restref
    // successfully for these — don't let them languish as dead "Check on OT" links.
    const bridgeOTForClient = yelpVer
      .filter(r => r.platform === "opentable" && r.softVerified && r._rid)
      .map(r => ({
        id: r.id, name: r.name, cuisine: r.cuisine ?? "",
        neighborhood: r.neighborhood ?? "", rating: r.rating,
        reviewCount: r.reviewCount, platform: r.platform as "opentable",
        platformUrl: r.platformUrl, timeSlots: [],
        distanceMiles: r.distanceMiles,
        _rid: r._rid,
      }));
    console.log(`[clientVerifyOT] bridge candidates: ${bridgeOTForClient.length}`);

    const clientVerifyOT = otCands
      .filter(r => !!(r._rid ?? extractRid(r.platformUrl) ?? ridMap.get(r.id)))
      .slice(0, 10)
      .map(r => ({
        id: r.id, name: r.name, cuisine: r.cuisine ?? "",
        neighborhood: r.neighborhood ?? "", rating: r.rating,
        reviewCount: r.reviewCount, platform: r.platform,
        platformUrl: r.platformUrl, timeSlots: [],
        distanceMiles: (params.lat && r._lat) ? haversine(params.lat, params.lng!, r._lat!, r._lng!) : null,
        _rid: r._rid ?? extractRid(r.platformUrl) ?? ridMap.get(r.id),
        _lat: r._lat, _lng: r._lng,
      }));

    // Merge bridge-found OT restaurants (dedup by id, prefer discovery candidates).
    const clientVerifyOTMerged = (() => {
      const seen = new Set(clientVerifyOT.map(r => r.id));
      const bridgeExtra = bridgeOTForClient.filter(r => !seen.has(r.id));
      return [...clientVerifyOT, ...bridgeExtra].slice(0, 14);
    })();
    // Re-export with the merged list (clientVerifyOT reference now points to merged)
    // Use clientVerifyOTMerged below instead of clientVerifyOT.

    // Slug-only OT candidates (no numeric RID found yet).
    // The browser will try the restref endpoint with just the slug — OT may accept
    // a `slug` parameter in addition to `rid`. If not, the 400/404 response tells us
    // definitively and we fall back. This costs nothing if OT rejects the request.
    const clientVerifyOTSlugs = otCands
      .filter(r => {
        const rid = r._rid ?? extractRid(r.platformUrl) ?? ridMap.get(r.id);
        if (rid) return false; // already in clientVerifyOT
        const slugM = r.platformUrl.match(/opentable\.com\/r\/([^/?#]+)/i);
        return !!slugM;
      })
      .slice(0, 8)
      .map(r => {
        const slugM = r.platformUrl.match(/opentable\.com\/r\/([^/?#]+)/i);
        return {
          id: r.id, name: r.name, cuisine: r.cuisine ?? "",
          neighborhood: r.neighborhood ?? "", rating: r.rating,
          reviewCount: r.reviewCount, platform: r.platform as "opentable",
          platformUrl: r.platformUrl, timeSlots: [],
          distanceMiles: (params.lat && r._lat) ? haversine(params.lat, params.lng!, r._lat!, r._lng!) : null,
          _slug: slugM![1],
        };
      });

    // Non-restaurant keyword filter — Yelp's /reservations/ path covers all service
    // businesses (hair salons, towing, auto glass, etc.). Exclude obvious non-food results.
    const NON_FOOD_RE = /\b(towing|tow\b|rooter|proxpress|plumbing|salon|clips|barber|apartments?|realty|real\s+estate|auto\b|autos\b|autosports?|auto\s+sports?|auto\s*glass|safelite|windshield|repairs?|gutters?|tires?|electric|dental|clinic|spa\b|massage|nails?|wax|lash|brow|pediatric|veterinary|vet\b|law\s+firm|attorney|insurance|detailing|appearance|apparel|boutique|grooming|carpet|roofing|landscaping|hvac|heating|cooling|pest|exterminator|dry\s*clean|alterations|planned\s+parenthood|health\s+center|medical\s+center|healthcare|urgent\s+care|pharmacy|optometry|eyecare|eye\s+care|at\s+and\s+t|at&t|verizon|t-mobile|sprint|comcast|xfinity|wireless\s+store|phone\s+store|dispensary|liquor\s+store|self.?storage|storage\b|car\s+rental|auto\s+rental|car\s+wash|national\s+car|enterprise\s+rent|hertz|budget\s+car|bicycl|cyclery|bike\s+shop|cycling|yoga|pilates|fitness|gym\b|crossfit|imaging\b|transmission\b|cabinet\s+front|kitchen\s+front|countertop|flooring|window\s+treatment|interior\s+design\b|moving\s+compan|storage\s+unit|self\s+storage|flood\s+pros?|flood\s+restor|water\s+damage|fire\s+damage|mold\s+restor|restoration\s+company|nature\s+preserve|nature\s+park|state\s+park|national\s+park|county\s+park|mountain\s+preserve|greenway|recreation\s+area|hyundai\b|chevrolet\b|toyota\b|ford\b|honda\b|nissan\b|subaru\b|volkswagen\b|mazda\b|mercedes|bmw\b|audi\b|lexus\b|acura\b|infiniti\b|cadillac\b|buick\b|gmc\b|ram\s+truck|jeep\b|dodge\b|chrysler\b|dealership)\b/i;

    // Out-of-market filter: two strategies.
    // 1. Coordinate-based — most reliable but requires venue lat/lng.
    // 2. Slug city-suffix — catches distant suburbs when coordinates are missing.
    //    Yelp slugs end with the venue city name (e.g., "bistro-suwanee" or "bistro-marietta-2").
    //    If the search metro has a known set of distant suburbs, drop slugs ending with those cities.
    const DISTANT_SUBURB_SUFFIXES: Record<string, RegExp> = {
      "atlanta-ga":  /-(marietta|suwanee|cumming|alpharetta|kennesaw|woodstock|canton|acworth|smyrna|sandy\s*springs|dunwoody|norcross|duluth|lawrenceville|buford|gainesville|braselton|dacula|grayson|snellville|stockbridge|mcdonough|peachtree\s*city|fayetteville|newnan|douglasville|carrollton|rome|dalton|gainesville|tucker|lithonia|conyers|roswell)(-\d+)?$/i,
      "decatur-ga":  /-(marietta|suwanee|cumming|alpharetta|kennesaw|woodstock|canton|acworth|smyrna|sandy\s*springs|dunwoody|norcross|duluth|lawrenceville|buford|gainesville|braselton|dacula|grayson|snellville|stockbridge|mcdonough|peachtree\s*city|fayetteville|newnan|douglasville|carrollton|rome|dalton|tucker|lithonia|conyers|roswell)(-\d+)?$/i,
      "new-york-ny": /-(hoboken|jersey\s*city|newark|yonkers|white\s*plains|stamford|bridgeport|hartford)(-\d+)?$/i,
      "chicago-il":  /-(naperville|aurora|rockford|joliet|waukegan|evanston|schaumburg|elgin|arlington\s*heights|bolingbrook)(-\d+)?$/i,
    };
    const searchSlug = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
    const distantSuburbRe = DISTANT_SUBURB_SUFFIXES[searchSlug] ?? null;
    const isOutOfMarket = (r: Restaurant) => {
      // Coordinate-based check (most accurate)
      if (params.lat != null && params.lng != null && r._lat != null && r._lng != null) {
        return haversine(params.lat, params.lng, r._lat, r._lng) > 20;
      }
      // Fallback: slug suffix check when coordinates are unavailable
      if (distantSuburbRe) {
        const slugM = r.platformUrl.match(/yelp\.com\/(?:reservations\/|biz\/)([^/?#\s]+)/i);
        if (slugM && distantSuburbRe.test(slugM[1])) return true;
      }
      return false;
    };

    const clientVerifyYelp = yelpCands
      .filter(r =>
        !verifiedYelpIds.has(r.id) &&
        // Include both reservation-filtered AND top-rated candidates — the browser calls
        // Yelp's real /reservations/${slug}/availability endpoint so false positives are
        // naturally filtered (no slots returned). _topRated flag only gates server-side
        // soft-verify strictness, not browser-side API calls.
        !NON_FOOD_RE.test(r.name) &&      // drop obvious non-restaurant businesses
        !isOutOfMarket(r)                 // drop out-of-market suburb results
      )
      // Prioritize reservation-filtered candidates (not _topRated) — they came from
      // Yelp's own reservation search so are more likely to be native Yelp restaurants.
      .sort((a, b) => ((a as any)._topRated ? 1 : 0) - ((b as any)._topRated ? 1 : 0))
      .slice(0, 15)
      .map(r => ({
        id: r.id, name: r.name, cuisine: r.cuisine ?? "",
        neighborhood: r.neighborhood ?? "", rating: r.rating,
        reviewCount: r.reviewCount, platform: r.platform,
        platformUrl: r.platformUrl, timeSlots: [],
        distanceMiles: (params.lat && r._lat) ? haversine(params.lat, params.lng!, r._lat!, r._lng!) : null,
        _lat: r._lat, _lng: r._lng,
      }));

    const elapsed = Date.now() - start;
    console.log(`[done] ${verified.length} results in ${elapsed}ms clientOT=${clientVerifyOT.length} clientYelp=${clientVerifyYelp.length}`);
    return json({
      results:             verified.slice(0, 24),
      params:              meta,
      hasMore:             remaining.length > 0,
      remainingCandidates: remaining,
      clientVerifyOT:   clientVerifyOTMerged,
      clientVerifyOTSlugs,
      // Browser-side OT metro discovery — runs when server found fewer than 5 RIDs.
      // Even with some hardcoded RIDs, metro discovery can find additional restaurants.
      // Browser tries OT's widget search endpoints (CORS-enabled by design for aggregators).
      // If metroId is null (city not in OT_METRO_IDS), clientDiscoverOT is omitted.
      clientDiscoverOT: clientVerifyOTMerged.length < 5 ? (() => {
        const metroId = getOTMetroId(params);
        return metroId ? {
          date:      params.date,
          time:      params.time,      // HH:MM 24h
          partySize: params.partySize,
          metroId,
          cuisine:   params.cuisine ?? "",
        } : null;
      })() : null,
      clientVerifyYelp,
      _v:                  "v101",
      _debug: {
        elapsed_ms:      elapsed,
        discovery:       { resy: resyCands.length, ot: otCands.length, yelp: yelpCands.length },
        verified:        { resy: resyVer.length, ot: otVer.length, yelp: yelpVer.length },
        scraper_enabled: !!(SCRAPER_URL && SCRAPER_SECRET),
        bb_enabled:      !!(BB_KEY && BB_PROJECT),
        resy_api:        (globalThis as any).__resyApiDebug    ?? null,
        ot_lambda:       (globalThis as any).__otLambdaDebug   ?? null,
        ot_bing:         (globalThis as any).__otApiDebug      ?? null,
        ot_discovery:    (globalThis as any).__otDiscoveryDebug ?? null,
        ot_cand:         (globalThis as any).__otCandDebug       ?? null,
        ot_restref:      (globalThis as any).__otRestrefDebug    ?? null,
        ot_verify:         (globalThis as any).__otVerifyDebug      ?? null,
        ot_yelp_bridge:    (globalThis as any).__yelpOTBridgeDebug  ?? null,
        ot_bridge_count:   bridgeOTForClient.length,
        client_ot_merged:  clientVerifyOTMerged.length,
        client_ot_slugs:   clientVerifyOTSlugs.length,
        // Sample of what's being sent to the browser for OT verification.
        // Shows name + rid so we can confirm the right restaurants are flowing through.
        client_ot_sample:  clientVerifyOTMerged.slice(0, 5).map(r => ({
          name: r.name,
          rid:  (r as any)._rid ?? null,
          url:  r.platformUrl?.slice(0, 60),
        })),
        yelp_api:        (globalThis as any).__yelpApiDebug           ?? null,
        yelp_lambda:     (globalThis as any).__yelpLambdaDebug       ?? null,
        yelp_lambda_fetch: (globalThis as any).__yelpLambdaFetchDebug ?? null,
        yelp_fc_sample:  (globalThis as any).__yelpFcSample          ?? null,
        yelp_bb:         (globalThis as any).__yelpBBDebug            ?? null,
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
// Unlike plain withTimeout, this creates an AbortController and passes it to the
// discover function via a closure, so the underlying Firecrawl HTTP requests are
// actually cancelled when the budget expires.

async function abortableDiscover(
  fn: () => Promise<Restaurant[]>,
  budgetMs: number,
): Promise<Restaurant[]> {
  return withTimeout(fn(), budgetMs, []);
}

// ─── EXTENDED SEARCH ─────────────────────────────────────────────────────────

async function runExtendedSearch(
  body: any, FIRECRAWL: string, AI_KEY: string, APIFY: string, SCRAPER_URL: string, SCRAPER_SECRET: string,
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

  const BB_KEY2     = Deno.env.get("BROWSERBASE_API_KEY")    ?? "";
  const BB_PROJECT2 = Deno.env.get("BROWSERBASE_PROJECT_ID") ?? "";
  const batch = (remainingCandidates as Restaurant[]).slice(0, 18);
  const [resyVer, otVer, yelpVer] = await Promise.all([
    verifyBatch(batch.filter(r => r.platform === "resy"),      params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET, "",        ""),
    verifyBatch(batch.filter(r => r.platform === "opentable"), params, FIRECRAWL, VERIFY_MS, "",           "",             BB_KEY2, BB_PROJECT2),
    verifyBatch(batch.filter(r => r.platform === "yelp"),      params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET, "",       ""),   // BB blocked by DataDome
  ]);

  let verified = dedup([...resyVer, ...otVer, ...yelpVer]);
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
- city: infer from location context. Do not guess.
- state: 2-letter US or empty for UK.
- country: "us" or "gb". Default "us".
- cuisine: specific type (e.g. "Italian","sushi","steakhouse") or "" if none.
- cuisineType: broad category or "".
- dishKeyword: specific dish or "".
Location context: ${locCtx}
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

  return {
    cuisine:     parsed.cuisine     || "",
    cuisineType: parsed.cuisineType || "",
    dishKeyword: parsed.dishKeyword || "",
    date:        parsed.date        || todayStr,
    time:        parsed.time        || "19:00",
    partySize:   Number(parsed.partySize) || 2,
    city:        parsed.city  || extractCityFromLocation(location),
    state:       (parsed.state || "").toUpperCase().slice(0, 2),
    country:     parsed.country || "us",
    lat, lng,
  };
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
// evalExpr defaults to document.body.innerText; pass a JS expression for DOM data.

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
      // Read the error body so we know WHY Lambda failed (e.g. Chrome crash, nav timeout)
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

// ─── BROWSERBASE CDP CLIENT ───────────────────────────────────────────────────
// Raw CDP over WebSocket — no npm packages, Deno built-in WebSocket.
// Creates a real Chrome session on Browserbase (residential IP pool),
// navigates to the target URL, waits for React/SPA to render, then evaluates
// a JS expression and returns the result as a string.
// Used for OT which blocks all datacenter IPs via Akamai Bot Manager.

async function bbLoad(
  url: string,
  bbKey: string,
  bbProject: string,
  opts: { waitMs?: number; useProxy?: boolean; timeoutMs?: number; evalExpr?: string; initScript?: string } = {},
): Promise<string> {
  const { waitMs = 4000, useProxy = true, timeoutMs = 25_000, evalExpr, initScript } = opts;

  // Step 1: Create Browserbase session (residential proxy enabled by default for OT)
  const sessResp = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "x-bb-api-key": bbKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: bbProject,
      browserSettings: { solveCaptchas: true },
      ...(useProxy ? { proxies: [{ type: "browserbase" }] } : {}),
    }),
  });
  if (!sessResp.ok) {
    const errText = await sessResp.text();
    throw new Error(`BB create session: ${sessResp.status} — ${errText.substring(0, 200)}`);
  }
  const { id: sessionId } = await sessResp.json();

  // Step 2: CDP over WebSocket
  let msgId = 0;
  const pending = new Map<number, [(v: any) => void, (e: Error) => void]>();

  const ws = new WebSocket(
    `wss://connect.browserbase.com?apiKey=${bbKey}&sessionId=${sessionId}`
  );

  function cdpSend(method: string, params: any = {}, sid?: string): Promise<any> {
    return new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, [res, rej]);
      const msg: any = { id, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
    });
  }

  let outerResolve!: (v: string) => void;
  let outerReject!:  (e: any)    => void;
  const result = new Promise<string>((res, rej) => {
    outerResolve = res;
    outerReject  = rej;
  });

  const timer = setTimeout(() => {
    ws.close();
    outerReject(new Error(`bbLoad timeout ${timeoutMs}ms for ${url}`));
  }, timeoutMs);

  ws.onmessage = (evt: MessageEvent) => {
    try {
      const msg = JSON.parse(evt.data as string);
      if (msg.id && pending.has(msg.id)) {
        const [res, rej] = pending.get(msg.id)!;
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message ?? "CDP error")) : res(msg.result);
      }
    } catch { /* ignore parse errors */ }
  };

  ws.onerror = () => { clearTimeout(timer); outerReject(new Error("BB WebSocket error")); };

  ws.onopen = async () => {
    try {
      const { targetInfos } = await cdpSend("Target.getTargets");
      const page = (targetInfos as any[]).find(t => t.type === "page");
      if (!page) throw new Error("No page target");

      const { sessionId: pageSid } = await cdpSend("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });

      // Inject init script BEFORE navigation so it runs at document creation time.
      // Used to intercept fetch/XHR calls that fire during page JS execution.
      if (initScript) {
        await cdpSend("Page.addScriptToEvaluateOnNewDocument", { source: initScript }, pageSid);
      }

      await cdpSend("Page.navigate", { url }, pageSid);
      await new Promise(r => setTimeout(r, waitMs));

      const expr = evalExpr ?? "document.body.innerText";
      const { result: evalResult } = await cdpSend("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, pageSid);

      clearTimeout(timer);
      ws.close();
      outerResolve(String(evalResult?.value ?? ""));
    } catch (e: any) {
      clearTimeout(timer);
      ws.close();
      outerReject(e);
    }
  };

  try {
    return await result;
  } finally {
    fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
      method: "POST",
      headers: { "x-bb-api-key": bbKey, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    }).catch(() => {});
  }
}

// ─── RESY DISCOVERY ───────────────────────────────────────────────────────────
// PRIMARY: scrape Resy's own search page — pre-filtered for the exact date/time/party size.
// Only restaurants with confirmed availability appear. No Google index dependency.
// Resy does NOT use Akamai, so Firecrawl can access it freely.
// FALLBACK: Google-based site: search if the direct scrape yields < 3 venues.

// ─── RESY JSON API DISCOVERY ─────────────────────────────────────────────────
// Resy exposes a public venue-search API that powers their mobile app.
// It returns venues WITH availability for the requested date/party_size in one
// JSON response — no SPA scraping, no rate-limit exposure, pre-verified slots.
// Public API key is the same key embedded in Resy's own web bundle.
async function discoverResyViaAPI(params: SearchParams): Promise<Restaurant[]> {
  const slug  = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const metro = RESY_METROS.find(m => m.slug === slug);
  const lat   = params.lat  ?? metro?.lat;
  const lng   = params.lng  ?? metro?.lng;
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
    // seat_filter / start_time / end_time are undocumented and caused 400 errors in testing.
    // Rely on filterWindow() to narrow the returned slots to ±2h of the requested time.
    const url = `https://api.resy.com/4/find?lat=${lat}&long=${lng}&day=${params.date}&party_size=${params.partySize}&per_page=30&sort_by=available${cuiQ}`;
    // Two known Resy API keys — current and fallback in case of rotation.
    // These are embedded in Resy's web bundle and are not secrets.
    // Keys are used in headers only; the URL is the same for both.
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
      if (resp.ok) break; // first key that works, use it
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
    // Log sample venue to verify city slug construction via coordinates
    const sampleVenue = venues[0]?.venue ?? {};
    const sLat = sampleVenue.location?.geo?.lat;
    const sLng = sampleVenue.location?.geo?.lon;
    const sMetro = (sLat != null && sLng != null) ? nearestResyMetro(sLat, sLng)?.slug : "no_coords";
    (globalThis as any).__resyApiDebug = `status=200 venues=${venues.length} sample=${sampleVenue.name}|slug=${sampleVenue.url_slug}|lat=${sLat}|lng=${sLng}|metro=${sMetro}`;

    return venues.flatMap((v: any) => {
      const venue = v.venue ?? {};
      const name  = (venue.name ?? "").trim();
      if (!name) return [];

      // Extract venue coordinates first — needed for both distance filtering and city slug.
      // Resy API uses geo.lon (not geo.long). Cover all known field-name variants.
      const vLat: number | undefined =
        venue.location?.geo?.lat  ?? venue.location?.latitude  ?? venue.location?.lat;
      const vLng: number | undefined =
        venue.location?.geo?.lon  ??   // ← primary Resy API field
        venue.location?.geo?.long ??   // fallback variant
        venue.location?.longitude ??
        venue.location?.long      ??
        venue.location?.lng;

      // Determine Resy city slug from the venue's own coordinates via nearestResyMetro.
      // The API returns no city/state text fields usable for slug construction, but
      // venue lat/lng lets us pick the correct metro entry (e.g., Scout at 33.760,-84.302
      // snaps to decatur-ga, not atlanta-ga, because Decatur is 1.7 mi away vs 6.5 mi).
      let venueCitySlug = slug; // default: search city slug
      if (vLat != null && vLng != null) {
        const nearestM = nearestResyMetro(vLat, vLng);
        if (nearestM) venueCitySlug = nearestM.slug;
      }

      // contact.url is the restaurant's own website — not a resy.com URL. Keep the
      // check as a rare override for venues that happen to embed their Resy link.
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

      // Distance filter — skip venues outside 12 miles of the user.
      if (vLat != null && vLng != null) {
        if (haversine(lat, lng, vLat, vLng) > 12) {
          console.log(`[Resy API] skip ${name}: ${haversine(lat, lng, vLat, vLng).toFixed(1)}mi away`);
          return [];
        }
      }

      const bookingUrl = addResyParams(base, params);

      // Convert API slots → TimeSlot[]. Deduplicate by display time (API returns multiple
      // slot tokens for the same time when different seating areas are available).
      const seenTimes = new Set<string>();
      const allSlots: TimeSlot[] = (v.slots ?? []).flatMap((s: any) => {
        const startStr = (s.date?.start ?? "") as string;  // "2026-05-14 19:00:00"
        if (!startStr) return [];
        const timePart = startStr.split(" ")[1]?.substring(0, 5);  // "19:00"
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
          // Resy API field name varies by version — try all known shapes
          const raw = venue.rater?.score ?? venue.rating?.average ?? venue.rating
                   ?? venue.score        ?? venue.aggregate_score ?? venue.ratingAverage;
          const n = parseFloat(String(raw ?? ""));
          if (isNaN(n)) return undefined;
          return Math.round(n * 10) / 10;  // always 1 decimal place
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

  // Direct Resy search URL — only shows restaurants available on this date/time/size
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
        waitFor: 4000,   // Resy is a React SPA — needs time to render venue list
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

  // Google fallback — inurl: targets the exact URL path pattern that normToResy
  // requires (/cities/slug/venues/slug). site: with path-prefix is unreliable in
  // Firecrawl's search; site: without path returns homepage/category pages that
  // normToResy filters out. inurl: reliably returns individual venue pages.
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const queries = [
    `inurl:resy.com/cities/${slug}/venues ${metro}${cuisine} restaurant`,
    `inurl:resy.com/cities/${slug}/venues ${metro} restaurant reservation`,
  ];
  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToResy(r, params)).filter(Boolean) as Restaurant[];
}

// Extract all Resy venue URLs from a scraped markdown page.
// React SPAs typically render relative hrefs, which Firecrawl preserves in markdown
// as [text](/cities/slug/venues/slug). We match both absolute and relative forms.
function extractResyVenueUrls(md: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Absolute URLs: https://resy.com/cities/atlanta-ga/venues/atlas
  const reAbs = /https?:\/\/resy\.com\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/gi;
  // Relative paths in markdown link syntax: (/cities/atlanta-ga/venues/atlas)
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

// Real-browser Resy discovery via Browserbase CDP.
// Resy is a React SPA — datacenter scrapers only ever see an empty HTML shell.
// A real browser executes the JS bundle and renders the full venue list with
// actual anchor hrefs. DOM querySelectorAll reliably extracts them.
async function discoverResyViaBB(
  params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant[]> {
  const slug   = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  // Resy search page: /search?date=...&seats=... (not /venues? which 404s)
  const cuiQ   = params.cuisine ? `&cuisine=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://resy.com/cities/${slug}/search?date=${params.date}&seats=${params.partySize}${cuiQ}`;

  try {
    const linksJson = await lambdaLoad(searchUrl, scraperUrl, scraperSecret, {
      waitMs: 10000,  // Resy React SPA needs ~8-10s to fully hydrate venue list
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

// ─── OPENTABLE DISCOVERY ──────────────────────────────────────────────────────
// Akamai blocks datacenter IPs from the main OT restaurant pages.
// Two approaches:
//   1. Apify (residential proxies) — most reliable, requires paid token
//   2. Widget canvas bypass — scrapes opentable.com/widget/reservation/canvas?rid=NNN
//      which is embedded cross-origin on restaurant sites and has lighter Akamai rules.
//      We discover restaurants via Google (Firecrawl /search, no Akamai) then verify
//      via the widget endpoint rather than the main page.

async function discoverOpenTable(params: SearchParams, fcKey: string, apifyToken: string): Promise<Restaurant[]> {
  if (apifyToken) return discoverOTviaApify(params, apifyToken);
  // No Apify — fall back to widget canvas approach.
  // Discovery via Google search (no Akamai issue), verification via widget canvas.
  console.log("[OT] no Apify — trying widget canvas bypass");
  return discoverOTviaWidgetCanvas(params, fcKey);
}

// ─── OT LAMBDA DISCOVERY ─────────────────────────────────────────────────────
// Loads the OpenTable search results page with a real headless Chrome browser
// (AWS Lambda). Akamai blocks datacenter HTTP requests to OT, but a real browser
// with proper fingerprinting bypasses the JS challenge tier used on search pages.
// The evalExpr extracts restaurant cards including URL, name, and time slots in
// a single DOM pass — cards with slots are pre-verified, others soft-verified.
async function discoverOTviaLambda(
  params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant[]> {
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";
  const dt     = `${params.date}T${params.time}`;
  const cityQ  = encodeURIComponent(`${params.city}${params.state ? `, ${params.state}` : ""}`);
  const cuiQ   = params.cuisine ? `&term=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://www.${domain}/s/?covers=${params.partySize}&dateTime=${dt}&term=${cityQ}${cuiQ}`;

  try {
    const raw = await lambdaLoad(searchUrl, scraperUrl, scraperSecret, {
      waitMs:    7000,   // OT search page needs ~5-7s to fully render after Akamai challenge
      timeoutMs: 55_000,
      // Simple evalExpr — just extract /r/ links. Avoids complex DOM traversal that
      // can crash Playwright (e.g. closest() on detached nodes, class selector errors).
      evalExpr: `JSON.stringify((() => {
        try {
          const seen = new Set();
          return Array.from(document.querySelectorAll('a[href*="/r/"]'))
            .map(a => a.href.split('?')[0])
            .filter(h => /opentable\\.com\\/r\\/[^/?#]+$/.test(h))
            .filter(h => { if(seen.has(h)) return false; seen.add(h); return true; })
            .slice(0, 20)
            .map(url => ({url, name:'', times:[], rid:''}));
        } catch(e) { return []; }
      })())`,
    });

    let cards: { url: string; name: string; times: string[]; rid: string }[] = [];
    try { cards = JSON.parse(raw || "[]"); } catch { /* empty */ }

    if (!cards.length) {
      // Check if Akamai blocked or page returned challenge text
      const lc = raw.toLowerCase();
      const blocked = /access denied|security check|enable javascript|are you a robot|just a moment/i.test(lc);
      (globalThis as any).__otLambdaDebug = `cards=0 blocked=${blocked} raw_len=${raw.length} sample=${raw.substring(0,150)}`;
      if (blocked) {
        console.log("[OT Lambda discover] Akamai blocked search page — 0 results");
      } else {
        console.log(`[OT Lambda discover] 0 cards (page len=${raw.length})`);
      }
      return [];
    }

    (globalThis as any).__otLambdaDebug = `cards=${cards.length} with_slots=${cards.filter(c=>c.times.length>0).length}`;
    console.log(`[OT Lambda discover] ${cards.length} cards, ${cards.filter(c=>c.times.length>0).length} with slots`);
    return cards.map(card => {
      const r = normToOT({ url: card.url, title: card.name, description: "" }, params);
      if (!r) return null;
      // Override _rid if we extracted it from data attributes
      if (card.rid) r._rid = card.rid;
      if (card.times.length > 0) {
        const base = card.url.split("?")[0];
        r.timeSlots    = card.times.map(t => ({ time: t, url: buildSlotUrl("opentable", base, params, t) }));
        r._preVerified = true;
      } else {
        r.softVerified = true;
        r._preVerified = true;
      }
      return r;
    }).filter(Boolean) as Restaurant[];
  } catch (err: any) {
    (globalThis as any).__otLambdaDebug = `error=${err?.message}`;
    console.log(`[OT Lambda discover] error: ${err?.message}`);
    return [];
  }
}

async function discoverOTviaWidgetCanvas(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city    = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain  = params.country === "gb" ? "opentable.co.uk" : "opentable.com";

  // ── Approach 1: Search engine scrape + OT sitemap → OT restaurant rids ─────
  // Bing/DDG both serve CAPTCHA/challenge pages to Firecrawl (total_md ≈7k for 3 pages).
  // Yahoo and Ecosia have less aggressive bot detection.
  // OT sitemap (robots.txt-accessible) lists all restaurant URLs and must be publicly
  // crawlable for Google indexing — likely bypasses Akamai's page-level protection.
  const directP = (async () => {
    const cityEnc = encodeURIComponent(`${city}${state}`);
    const cuiEnc  = params.cuisine ? `+${encodeURIComponent(params.cuisine)}` : "";
    // Note: site:opentable.com returns 0 results on Yahoo because OT's robots.txt
    // disallows most paths so Yahoo/Bing have very little of OT indexed.
    // Instead search for the literal string "opentable.com/r" — this surfaces OT
    // restaurant pages and restaurant sites that link to OT with /r/ slugs.
    // DuckDuckGo HTML (html.duckduckgo.com) confirmed blocked with CAPTCHA — removed.
    const searchUrls = [
      // Yahoo — "opentable.com/r" as quoted phrase; appears in OT restaurant page snippets
      `https://search.yahoo.com/search?p=%22opentable.com%2Fr%22+${cityEnc}${cuiEnc}+restaurant&n=20`,
      // Second Yahoo query without cuisine filter — broader net
      `https://search.yahoo.com/search?p=%22opentable.com%2Fr%22+${cityEnc}+restaurant+dinner&n=20`,
      // Third Yahoo query: search for /restaurant/profile/ URLs which include numeric RIDs.
      // Third-party pages (restaurant sites, aggregators) often link to OT with the canonical
      // profile URL format, which includes the numeric RID we need for verifyOTviaRestref.
      `https://search.yahoo.com/search?p=%22opentable.com%2Frestaurant%2Fprofile%22+${cityEnc}+restaurant&n=20`,
      // Fourth Yahoo query: restaurant websites with embedded OT booking widgets.
      // The OT widget script tag src contains "opentable.com/widget" and appears in static HTML.
      // Yahoo sometimes surfaces these pages when the widget URL appears in page text/metadata.
      `https://search.yahoo.com/search?p=%22opentable.com%2Fwidget%22+${cityEnc}+restaurant&n=20`,
    ];
    const directSeen  = new Set<string>();
    const directItems: Restaurant[] = [];
    let   totalMdLen  = 0;
    let   bingSample  = "";

    await Promise.all(searchUrls.map(async (searchUrl) => {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 18_000);
        const isSitemap = searchUrl.includes("sitemap");
        const resp  = await fetch(`${FC_API}/scrape`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          signal:  ctrl.signal,
          body:    JSON.stringify({
            url: searchUrl, formats: ["markdown"],
            onlyMainContent: false, waitFor: isSitemap ? 0 : 2000, timeout: 15000,
          }),
        });
        clearTimeout(timer);
        if (!resp.ok) { console.log(`[OT search] HTTP ${resp.status} for ${searchUrl.slice(0, 60)}`); return; }
        const data = await resp.json();
        const md: string = data.data?.markdown ?? "";
        totalMdLen += md.length;
        console.log(`[OT search] "${searchUrl.slice(0, 70)}": md=${md.length}`);
        // Capture sample past nav bar (first 500 chars are usually just nav links)
        if (!bingSample && md.length > 50) bingSample = md.substring(400, 1000);

        // Profile URLs: /restaurant/profile/XXXXX → rid = XXXXX (appears in sitemaps + OT pages)
        const profRe = /opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/gi;
        let m: RegExpExecArray | null;
        while ((m = profRe.exec(md)) !== null) {
          const u = `https://www.opentable.com/restaurant/profile/${m[1]}`;
          if (!directSeen.has(u)) {
            directSeen.add(u);
            const r = normToOT({ url: u, title: "", description: "" }, params);
            if (r) directItems.push(r);
          }
        }
        // Sitemap <loc> tags also use /restaurant/profile/ — already matched above
        // Slug URLs: /r/restaurant-name (appears in Yahoo search snippets as hyperlinks)
        const slugRe = /opentable\.(?:com|co\.uk)\/r\/([^/\s"'&?#,()<>\]]+)/gi;
        while ((m = slugRe.exec(md)) !== null) {
          const slug = m[1].replace(/[.,;:)>\]]+$/, "");
          const u    = `https://www.opentable.com/r/${slug}`;
          if (!directSeen.has(u)) {
            directSeen.add(u);
            const r = normToOT({ url: u, title: "", description: "" }, params);
            if (r) directItems.push(r);
          }
        }
        // Yahoo breadcrumb format: "opentable.com › r › restaurant-name-city"
        // Yahoo renders OT result URLs as breadcrumbs using › (U+203A) instead of /
        const bcRe = /opentable\.(?:com|co\.uk)\s*[›>]\s*r\s*[›>]\s*([a-z0-9][a-z0-9-]+)/gi;
        while ((m = bcRe.exec(md)) !== null) {
          const slug = m[1].replace(/[.,;:)>\]›]+$/, "");
          if (slug.length < 3) continue;
          const u = `https://www.opentable.com/r/${slug}`;
          if (!directSeen.has(u)) {
            directSeen.add(u);
            const r = normToOT({ url: u, title: "", description: "" }, params);
            if (r) directItems.push(r);
          }
        }
      } catch (err: any) {
        console.log(`[OT search] ${err?.message}`);
      }
    }));

    console.log(`[OT search] ${directItems.length} candidates (totalMd=${totalMdLen})`);
    (globalThis as any).__otApiDebug = `search_candidates=${directItems.length} total_md=${totalMdLen} sample=${bingSample.substring(0, 300)}`;
    return directItems;
  })();

  // ── Approach 2: Scrape restaurant websites with rawHtml to find OT widget rids ──
  // OT widgets are injected as <iframe src="...?rid=XXXXX"> or <script src="...rid=XXXXX">.
  // These URLs are invisible in markdown but present in the raw HTML source.
  // "powered by OpenTable" is a phrase on restaurant websites that embed the OT widget.
  const scrapeP = (async () => {
    // These queries surface restaurant OWN websites that embed the OT booking widget.
    // The widget HTML contains ?rid=NNNNN which gives us the numeric RID we need.
    // "make a reservation" + opentable is more likely to appear on restaurant pages
    // than the generic "powered by OpenTable" branding which OT removed from newer widgets.
    const state2 = params.state ? ` "${params.state}"` : "";
    const cuiQ2  = params.cuisine ? ` ${params.cuisine}` : "";
    const scrapeQueries = [
      // "powered by OpenTable" appears in the static widget HTML on restaurant websites
      // that embed the OT booking widget. Google indexes this phrase from the page source.
      `"powered by OpenTable" "${city}"${state2}${cuiQ2} restaurant`,
      // "restaurant.opentable.com" is the OT widget script domain, present in static
      // <script src="..."> tags on restaurant websites — highly specific to OT embeds.
      `"restaurant.opentable.com" "${city}"${state2}${cuiQ2} restaurant reservation`,
    ];
    const scrapeOTSeen  = new Set<string>();
    const scrapeOTItems: Array<{ url: string; title?: string }> = [];

    await Promise.all(scrapeQueries.map(async (query) => {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 16_000);
      try {
        const resp = await fetch(`${FC_API}/search`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          signal:  ctrl.signal,
          body:    JSON.stringify({ query, limit: 8, scrapeOptions: { formats: ["rawHtml"] } }),
        });
        clearTimeout(timer);
        if (!resp.ok) { console.warn(`[OT scrape] HTTP ${resp.status}`); return; }
        const data  = await resp.json();
        const items: any[] = Array.isArray(data) ? data
          : (Array.isArray(data.data) ? data.data
          : (Array.isArray(data.results) ? data.results
          : (Array.isArray(data.data?.results) ? data.data.results : [])));
        const itemUrls = items.slice(0, 4).map((i: any) => i.url ?? "?").join("|");
        console.log(`[OT scrape] "${query.slice(0, 55)}": ${items.length} pages urls=${itemUrls}`);
        for (const item of items) {
          // rawHtml contains the full rendered DOM — iframe src and script src are present
          const html = item.rawHtml ?? item.html ?? item.markdown ?? item.content ?? "";
          // rid= appears in widget iframe src, script src, and booking button href
          const reRid  = /opentable\.(?:com|co\.uk)[^"'\s<>]*[?&\/]rid[=\/](\d+)/gi;
          const reProf = /opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/gi;
          const reSlug = /(?:href|src)=["'][^"']*opentable\.(?:com|co\.uk)\/r\/([^?#"'\s<>]+)/gi;
          let m;
          while ((m = reRid.exec(html)) !== null) {
            const rid = m[1];
            // also try to extract slug from same context
            const ctxStart = Math.max(0, m.index - 100);
            const ctx = html.slice(ctxStart, m.index + 100);
            const slugM = ctx.match(/opentable\.(?:com|co\.uk)\/r\/([^?#"'\s<>]+)/i);
            const slug = slugM ? slugM[1] : rid;
            const u = `https://www.opentable.com/r/${slug}?rid=${rid}`;
            if (!scrapeOTSeen.has(u)) { scrapeOTSeen.add(u); scrapeOTItems.push({ url: u, title: item.title }); }
          }
          while ((m = reProf.exec(html)) !== null) {
            const u = `https://www.opentable.com/restaurant/profile/${m[1]}`;
            if (!scrapeOTSeen.has(u)) { scrapeOTSeen.add(u); scrapeOTItems.push({ url: u, title: item.title }); }
          }
          while ((m = reSlug.exec(html)) !== null) {
            const u = `https://www.opentable.com/r/${m[1]}`;
            if (!scrapeOTSeen.has(u)) { scrapeOTSeen.add(u); scrapeOTItems.push({ url: u, title: item.title }); }
          }
        }
      } catch (err: any) {
        clearTimeout(timer);
        console.warn(`[OT scrape] ${err?.message}`);
      }
    }));

    console.log(`[OT scrape] ${scrapeOTItems.length} OT URLs from rawHtml scrape`);
    return scrapeOTItems.map(r => normToOT(r, params)).filter(Boolean) as Restaurant[];
  })();

  // ── Approach 3: Firecrawl search (Google) for OT restaurant profile URLs ─────
  // Firecrawl /search uses Google, which indexes OT canonical /restaurant/profile/NNN
  // URLs — giving us numeric RIDs at discovery time so verifyOTviaRestref can be
  // called directly without ever loading an Akamai-protected OT page.
  const fcProfileP = (async () => {
    const cuiQ  = params.cuisine ? ` ${params.cuisine}` : "";
    const state2 = params.state ? ` "${params.state}"` : "";
    // ── Key insight: `site:opentable.com/restaurant/profile` is a path-based site:
    // operator which Google ignores (treats path as search terms). Instead, search
    // for the literal string "opentable.com/restaurant/profile" as quoted text —
    // this surfaces third-party pages (restaurant sites, aggregators, review sites)
    // that link to OT with the canonical profile URL which includes the numeric RID.
    const queries = [
      `"opentable.com/restaurant/profile" "${city}"${state2}${cuiQ} restaurant`,
      `opentable.com "${city}"${state2}${cuiQ} restaurant reservation`,
      // Food editorial sites (Eater, Thrillist, Zagat) write full OT profile URLs in
      // their restaurant guides. These are indexed by Google and contain numeric RIDs.
      `site:eater.com "${city}" opentable restaurant reservation`,
      `site:thrillist.com "${city}" opentable restaurant reservation`,
    ];
    const fcItems: Restaurant[] = [];
    const fcSeen  = new Set<string>();
    await Promise.all(queries.map(async (query) => {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 14_000);
      try {
        const resp  = await fetch(`${FC_API}/search`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          signal:  ctrl.signal,
          body:    JSON.stringify({ query, limit: 10 }),
        });
        clearTimeout(timer);
        if (!resp.ok) { console.log(`[OT FC search] HTTP ${resp.status}`); return; }
        const data  = await resp.json();
        const items: any[] = Array.isArray(data) ? data
          : (Array.isArray(data.data)           ? data.data
          : (Array.isArray(data.results)         ? data.results
          : (Array.isArray(data.data?.results)   ? data.data.results : [])));
        console.log(`[OT FC search] "${query.slice(0, 65)}": ${items.length} results urls=${items.slice(0,3).map((i:any)=>i.url).join("|")}`);
        for (const item of items) {
          // Try URL-based extraction first
          let r = normToOT(item, params);
          if (!r) {
            // URL didn't match OT format — check snippet/description text for a profile URL
            const snippet = [item.description, item.markdown, item.content, item.snippet]
              .filter(Boolean).join(" ");
            const profM = snippet.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
            if (profM) r = normToOT({ ...item, url: `https://www.opentable.com/restaurant/profile/${profM[1]}` }, params);
          } else if (!r._rid) {
            // We have a slug URL but no RID — check snippet for a profile URL to get the RID
            const snippet = [item.description, item.markdown, item.content, item.snippet]
              .filter(Boolean).join(" ");
            const profM = snippet.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
            if (profM) r._rid = profM[1];
          }
          if (r && !fcSeen.has(r.id)) { fcSeen.add(r.id); fcItems.push(r); }
        }
      } catch (err: any) {
        clearTimeout(timer);
        console.log(`[OT FC search] ${err?.message}`);
      }
    }));
    console.log(`[OT FC search] ${fcItems.length} OT restaurants (rids=${fcItems.filter(r=>r._rid).length})`);
    return fcItems;
  })();

  // ── Approach 4: OT city/metro SEO landing pages ─────────────────────────────
  // OT publishes curated city pages they WANT Google to index — e.g.
  // /best-restaurants-in-atlanta-ga and /restaurants/atlanta-ga/ — which means they
  // may have lighter Akamai protection than the JS-rendered search page. These pages
  // list restaurants with /restaurant/profile/NNN links that contain numeric RIDs.
  const cityPageP = (async () => {
    const s = (params.state ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const citySlug = `${city}-${s}`.toLowerCase()
      .replace(/[,\s]+/g, "-").replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-").replace(/^-|-$/g, "");
    const cityPageUrls = [
      `https://www.opentable.com/best-restaurants-in-${citySlug}`,
      `https://www.opentable.com/restaurants/${citySlug}/`,
    ];
    const seen  = new Set<string>();
    const items: Restaurant[] = [];
    await Promise.all(cityPageUrls.map(async (pageUrl) => {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 14_000);
      try {
        const resp = await fetch(`${FC_API}/scrape`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
          signal:  ctrl.signal,
          body:    JSON.stringify({
            url: pageUrl, formats: ["rawHtml", "markdown"],
            onlyMainContent: false, waitFor: 0, timeout: 12000,
          }),
        });
        clearTimeout(timer);
        if (!resp.ok) { console.log(`[OT city] HTTP ${resp.status} for ${pageUrl}`); return; }
        const d    = await resp.json();
        const html: string = d.data?.rawHtml ?? "";
        const md:   string = d.data?.markdown ?? "";
        console.log(`[OT city] ${pageUrl.slice(-40)}: html=${html.length} md=${md.length}`);
        // Extract profile URLs — these have numeric RIDs baked in
        const profRe = /opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/gi;
        let m: RegExpExecArray | null;
        const combined = html + " " + md;
        while ((m = profRe.exec(combined)) !== null) {
          const u = `https://www.opentable.com/restaurant/profile/${m[1]}`;
          if (!seen.has(u)) { seen.add(u); const r = normToOT({ url: u, title: "", description: "" }, params); if (r) items.push(r); }
        }
        // Extract slug URLs from markdown as fallback
        const slugRe = /opentable\.(?:com|co\.uk)\/r\/([^/?#\s"'<>\]]+)/gi;
        while ((m = slugRe.exec(md)) !== null) {
          const slug = m[1].replace(/[.,;:)>\]›]+$/, "");
          const u    = `https://www.opentable.com/r/${slug}`;
          if (!seen.has(u)) { seen.add(u); const r = normToOT({ url: u, title: "", description: "" }, params); if (r) items.push(r); }
        }
      } catch (err: any) {
        clearTimeout(timer);
        console.log(`[OT city] ${err?.message}`);
      }
    }));
    console.log(`[OT city] ${items.length} candidates (rids=${items.filter(r => r._rid).length})`);
    return items;
  })();

  // Merge results from all four parallel approaches.
  // When the same restaurant appears in multiple results, prefer the version that has
  // a numeric RID (needed for verifyOTviaRestref).
  const [directItems, scrapeItems, fcProfileItems, cityPageItems] = await Promise.all([directP, scrapeP, fcProfileP, cityPageP]);
  const merged   = new Map<string, Restaurant>();
  for (const r of [...directItems, ...scrapeItems, ...fcProfileItems, ...cityPageItems]) {
    if (!r.id) continue;
    const existing = merged.get(r.id);
    // Prefer whichever version has a RID
    if (!existing || (!existing._rid && r._rid)) merged.set(r.id, r);
  }
  const candidates = [...merged.values()];
  const dt = `${params.date}T${params.time}`;
  for (const c of candidates) {
    if (c._rid) c._widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${c._rid}&covers=${params.partySize}&datetime=${dt}&styleid=5&disablegt=true`;
  }

  const dbg = `direct=${directItems.length} scrape=${scrapeItems.length} fc=${fcProfileItems.length} city=${cityPageItems.length} total=${candidates.length} rids=${candidates.filter(c=>c._rid).length}`;
  console.log(`[OT discovery] ${dbg}`);
  (globalThis as any).__otDiscoveryDebug = dbg;
  return candidates;
}

// ── OT slug→RID enrichment ────────────────────────────────────────────────────
// After Yahoo/FC discovery we have slug URLs but no numeric RIDs. For each slug-only
// candidate, do a targeted Firecrawl search for `"opentable.com/r/{slug}"` — this finds
// any page (restaurant website, aggregator, food blog) that links to or mentions this
// specific OT restaurant URL. Those pages sometimes also contain the /restaurant/profile/NNN
// URL which gives us the RID. Runs in parallel; budget-capped; non-blocking on failure.
async function enrichOTSlugsWithRids(
  candidates: Restaurant[], fcKey: string,
): Promise<Restaurant[]> {
  const slugOnly = candidates.filter(r => !r._rid);
  if (slugOnly.length === 0 || !fcKey) return candidates;

  const ridMap = new Map<string, string>(); // restaurant id → rid
  await Promise.all(slugOnly.slice(0, 6).map(async (r) => {
    const slugM = r.platformUrl.match(/opentable\.com\/r\/([^/?#]+)/i);
    if (!slugM) return;
    const slug = slugM[1];
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const resp = await fetch(`${FC_API}/search`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ query: `"opentable.com/r/${slug}" restaurant`, limit: 6 }),
      });
      clearTimeout(timer);
      if (!resp.ok) return;
      const data  = await resp.json();
      const items: any[] = Array.isArray(data) ? data
        : (Array.isArray(data.data)    ? data.data
        : (Array.isArray(data.results) ? data.results : []));
      for (const item of items) {
        const text = [item.description, item.markdown, item.content, item.snippet, item.url]
          .filter(Boolean).join(" ");
        const profM = text.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
        if (profM) {
          console.log(`[OT enrich] ${r.name} (${slug}) → rid=${profM[1]}`);
          ridMap.set(r.id, profM[1]);
          cacheOTRid(slug, profM[1]); // persist in module-level cache for warm reuse
          return;
        }
      }
      console.log(`[OT enrich] ${r.name} (${slug}): ${items.length} pages, no profile URL found`);
    } catch (err: any) {
      clearTimeout(timer);
      console.log(`[OT enrich] ${r.name}: ${err?.message}`);
    }
  }));

  if (ridMap.size === 0) return candidates;
  console.log(`[OT enrich] enriched ${ridMap.size}/${slugOnly.length} slugs with RIDs`);
  return candidates.map(r => {
    const rid = ridMap.get(r.id);
    if (!rid || r._rid) return r;
    const dt = `${r.platformUrl.match(/dateTime=([^&]+)/)?.[1] ?? ""}`;
    if (r._rid) return r;
    const enriched = { ...r, _rid: rid };
    if (enriched._widgetUrl === undefined && dt) {
      enriched._widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${rid}&covers=${dt}`;
    }
    return enriched;
  });
}

// ── OT search page __NEXT_DATA__ extraction ───────────────────────────────────
// OT's search page (/s/) is a Next.js app that server-side renders the initial
// results into a <script id="__NEXT_DATA__"> tag. If Firecrawl can access it
// (OT may be lighter on Akamai for /s/ than for individual restaurant pages),
// rawHtml will contain multiple restaurant RIDs in one call.
async function extractOTNextData(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const cityQ  = encodeURIComponent(`${params.city}${params.state ? `, ${params.state}` : ""}`);
  const dt     = `${params.date}T${params.time}`;
  const cuiQ   = params.cuisine ? `&term=${encodeURIComponent(params.cuisine)}` : "";
  const url    = `https://www.opentable.com/s/?covers=${params.partySize}&dateTime=${dt}&term=${cityQ}${cuiQ}`;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 14_000);
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body:    JSON.stringify({ url, formats: ["rawHtml"], onlyMainContent: false, timeout: 12000 }),
    });
    clearTimeout(timer);
    if (!resp.ok) { console.log(`[OT NEXT_DATA] HTTP ${resp.status}`); return []; }
    const d    = await resp.json();
    const html: string = d.data?.rawHtml ?? "";
    console.log(`[OT NEXT_DATA] html=${html.length}`);
    if (html.length < 500) return [];

    // Extract __NEXT_DATA__ JSON
    const ndM = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!ndM) { console.log(`[OT NEXT_DATA] no __NEXT_DATA__ found in ${html.length} bytes`); return []; }

    let nd: any;
    try { nd = JSON.parse(ndM[1]); } catch { console.log(`[OT NEXT_DATA] JSON parse failed`); return []; }

    const text = JSON.stringify(nd);
    console.log(`[OT NEXT_DATA] parsed JSON len=${text.length}`);

    // Extract all /restaurant/profile/NNN URLs from the JSON blob
    const seen  = new Set<string>();
    const items: Restaurant[] = [];
    const profRe = /\/restaurant\/profile\/(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = profRe.exec(text)) !== null) {
      const u = `https://www.opentable.com/restaurant/profile/${m[1]}`;
      if (!seen.has(u)) {
        seen.add(u);
        const r = normToOT({ url: u, title: "", description: "" }, params);
        if (r) items.push(r);
      }
    }
    console.log(`[OT NEXT_DATA] ${items.length} restaurants with RIDs from __NEXT_DATA__`);
    return items;
  } catch (err: any) {
    clearTimeout(timer);
    console.log(`[OT NEXT_DATA] ${err?.message}`);
    return [];
  }
}

async function discoverOTviaApify(params: SearchParams, token: string): Promise<Restaurant[]> {
  try {
    const input = {
      location: `${params.city}, ${params.state || params.country.toUpperCase()}`,
      date:     params.date,
      time:     params.time.replace(":", ""),
      covers:   params.partySize,
      keyword:  params.cuisine || undefined,
      maxItems: 15,
    };
    const resp = await fetch(
      `${APIFY_API}/acts/canadesk~opentable/run-sync-get-dataset-items?token=${token}&timeout=50&memory=256`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
    );
    if (!resp.ok) { console.warn(`[Apify OT] ${resp.status}`); return []; }
    const items: any[] = await resp.json();
    console.log(`[Apify OT] ${items.length} results`);

    return items.flatMap(item => {
      const slots: TimeSlot[] = [];
      const bookingUrl = item.link ?? item.url ?? item.bookingUrl ?? "";

      if (Array.isArray(item.availableSlots)) {
        for (const s of item.availableSlots) {
          const t = s.time ?? parseTimeFromDT(s.dateTime ?? "");
          if (t) slots.push({ time: t });
        }
      } else if (item.availableTimes) {
        for (const t of (item.availableTimes as string[])) slots.push({ time: t });
      }

      const filtered = filterWindow(slots, params.time);
      if (filtered.length === 0 && !item.name) return [];

      const rid        = extractRid(bookingUrl);
      const baseOTUrl  = (bookingUrl || `https://www.opentable.com/r/${slugify(item.name || "")}`).split("?")[0];
      const slotsWithUrls = filtered.map(s => ({ ...s, url: buildSlotUrl("opentable", baseOTUrl, params, s.time) }));

      return [{
        id:           `opentable-${rid || slugify(item.name || "")}`,
        name:         item.name ?? "Restaurant",
        cuisine:      item.cuisine ?? params.cuisine ?? "Restaurant",
        neighborhood: item.neighborhood ?? item.location ?? params.city,
        rating:       item.stars ?? item.rating,
        reviewCount:  item.reviewCount ?? item.reviews,
        priceRange:   item.priceRange ?? item.price,
        platform:     "opentable" as const,
        platformUrl:  addOTParams(baseOTUrl, params),
        timeSlots:    slotsWithUrls,
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

// Real-browser OT discovery via Browserbase CDP + residential proxy.
// OT uses Akamai bot-protection keyed on datacenter IP ranges.
// Browserbase's residential proxy IPs bypass Akamai's blacklist because they
// route through real ISPs indistinguishable from organic user traffic.
async function discoverOTViaBB(
  params: SearchParams, bbKey: string, bbProject: string,
): Promise<Restaurant[]> {
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";
  const dt     = `${params.date}T${params.time}`;
  const cityQ  = encodeURIComponent(params.city + (params.state ? `, ${params.state}` : ""));
  const cuiQ   = params.cuisine ? `&term=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://www.${domain}/s/?covers=${params.partySize}&dateTime=${dt}&term=${cityQ}${cuiQ}`;

  try {
    (globalThis as any).__otVerifyDebug = "bbLoad_starting";
    const raw = await bbLoad(searchUrl, bbKey, bbProject, {
      waitMs: 6000,
      useProxy: true,   // OT search page is Akamai-gated by datacenter IP — residential proxy required
      timeoutMs: 28_000,
      evalExpr: `JSON.stringify((() => {
        // 1. Try __NEXT_DATA__ first — most reliable, bypasses DOM selector fragility.
        try {
          const nd = document.getElementById('__NEXT_DATA__');
          if (nd && nd.textContent && nd.textContent.length > 100) {
            return {type:'nextdata', data: nd.textContent.substring(0, 300000)};
          }
        } catch(e) {}
        // 2. DOM fallback — deduplicate /r/ links.
        const seen = new Set();
        const links = Array.from(document.querySelectorAll('a[href*="/r/"]'))
          .map(a => ({el:a, url:a.href.split('?')[0].split('#')[0]}))
          .filter(({url}) => /opentable\\.(com|co\\.uk)\\/r\\/[^/]+$/.test(url))
          .filter(({url}) => { if(seen.has(url)) return false; seen.add(url); return true; })
          .slice(0,20);
        const cards = links.map(({el, url}) => {
          const card = el.closest('[data-test*="restaurant"]') ||
                       el.closest('[data-test*="result"]') ||
                       el.closest('article') || el.closest('li') ||
                       el.closest('[class*="result"]') || el.closest('[class*="Result"]') ||
                       el.closest('[class*="card"]')   || el.closest('[class*="Card"]') ||
                       (() => {
                         let c = el.parentElement;
                         for(let i=0; i<20 && c && c.tagName!=='BODY'; i++) {
                           if(c.clientHeight >= 120) return c;
                           c = c.parentElement;
                         }
                         return el.parentElement;
                       })();
          // Time slots: try button/pill elements first (OT renders times as clickable buttons).
          const btnTimes = [...new Set(
            Array.from(card?.querySelectorAll('button,[role="button"],[class*="time"],[class*="Time"],[class*="slot"],[class*="Slot"]') || [])
              .map(b => (b.textContent||'').trim())
              .filter(t => /^\\d{1,2}:\\d{2}\\s*(AM|PM|am|pm)$/i.test(t))
          )].slice(0,8);
          // Fallback: regex on full innerText
          const text = card ? (card.innerText || '') : '';
          const txtTimes = btnTimes.length ? [] : [...new Set(
            [...text.matchAll(/\\b(\\d{1,2}:\\d{2}\\s*(?:AM|PM))\\b/gi)].map(m=>m[1].trim())
          )].slice(0,8);
          const times = btnTimes.length ? btnTimes : txtTimes;
          const h = card?.querySelector('h1,h2,h3,[data-test*="name"],[class*="name"],[class*="Name"]');
          const name = (h?.textContent || el.textContent || '').trim().replace(/\\s+/g,' ').substring(0,80);
          return {url, name, times, _cc: card?.className?.substring(0,40)||''};
        });
        return {type:'dom', cards};
      })())`,
    });
    const parsed = JSON.parse(raw || "{}");
    // Always set debug so we can diagnose — even if type is missing
    (globalThis as any).__otVerifyDebug = `raw_len=${raw.length}|type=${parsed.type}|cards=${parsed.cards?.length??0}|first=${JSON.stringify(parsed.cards?.[0]??null)}`;

    let restaurants: Restaurant[] = [];

    if (parsed.type === "nextdata") {
      // Parse Next.js __NEXT_DATA__ for restaurants + slots.
      // OT's JSON structure varies between deployments; probe known paths.
      try {
        const nd = JSON.parse(parsed.data);
        const pageProps = nd?.props?.pageProps ?? {};
        (globalThis as any).__otVerifyDebug = `nextdata keys=${Object.keys(pageProps).join(',')}`;
        // Try multiple known paths to restaurant list
        const searchResults: any[] = pageProps.searchResults
          ?? pageProps.restaurants
          ?? pageProps.results
          ?? pageProps.restaurantList
          ?? pageProps.data?.restaurants
          ?? pageProps.initialData?.restaurants
          ?? [];
        console.log(`[OT BB] nextdata: ${searchResults.length} results, pageProps keys=${Object.keys(pageProps).join(',')}`);
        if (searchResults.length > 0) {
          restaurants = searchResults.slice(0, 20).flatMap((item: any) => {
            const name = item.name ?? item.restaurantName ?? "";
            if (!name) return [];
            const rid   = String(item.rid ?? item.restaurantId ?? item.id ?? "").match(/\d+/)?.[0];
            const slug  = item.urlSlug ?? item.slug ?? (rid ? rid : "");
            const baseUrl = `https://www.opentable.com/r/${slug || slugify(name)}`;
            const r = normToOT({ url: baseUrl, title: name, description: "" }, params);
            if (!r) return [];
            // Extract slots from availability data if present
            const avail: any[] = item.availability?.slots ?? item.timeslots ?? item.slots ?? [];
            const rawTimes: string[] = avail
              .map((s: any) => s.timeString ?? s.time ?? s.startTime ?? "")
              .filter(Boolean);
            const windowed = filterWindow(
              rawTimes.map((t: string) => ({ time: t })),
              params.time,
            );
            if (windowed.length > 0) {
              r.timeSlots    = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", baseUrl, params, s.time) }));
              r._preVerified = true;
            } else {
              r.softVerified = true;
              r._preVerified = true;
            }
            if (rid) r._rid = rid;
            return [r];
          });
        }
      } catch (e: any) {
        (globalThis as any).__otVerifyDebug = `nextdata parse error: ${e?.message}`;
      }
    }

    if (parsed.type === "dom" && parsed.cards?.length) {
      const cards = parsed.cards as {url:string; name:string; times:string[]}[];
      console.log(`[OT BB] dom: ${cards.length} cards, slots sample: ${JSON.stringify(cards[0])}`);
      (globalThis as any).__otVerifyDebug = `dom cards=${cards.length} first=${JSON.stringify({...cards[0], _cc: cards[0]?._cc})}`;
      restaurants = cards.map(card => {
        const r = normToOT({ url: card.url, title: card.name, description: "" }, params);
        if (!r) return null;
        if (card.times.length > 0) {
          const base = card.url.split("?")[0];
          r.timeSlots = card.times.map(t => ({ time: t, url: buildSlotUrl("opentable", base, params, t) }));
          r._preVerified = true;
        } else {
          // No times extracted from search page — individual pages are Akamai-blocked.
          // Soft-verify so the restaurant still shows with a "Check on OT" prompt.
          r.softVerified = true;
          r._preVerified = true; // skip verifyOTViaBB (which would just fail anyway)
        }
        return r;
      }).filter(Boolean) as Restaurant[];
    }

    if (!restaurants.length) {
      // last resort: just extract links, verification will handle slots
      const links = parsed.cards?.map((c:any)=>c.url) ?? [];
      restaurants = links.map((u:string) => normToOT({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
    }

    console.log(`[OT BB] ${restaurants.length} restaurants, ${restaurants.filter(r=>r._preVerified).length} pre-verified`);
    return restaurants;
  } catch (err: any) {
    console.log(`[OT BB] discovery error: ${err?.message}`);
    (globalThis as any).__otVerifyDebug = `error: ${err?.message}`;
    return [];
  }
}

// ─── STATIC OT SLUG→RID LOOKUP ────────────────────────────────────────────────
// Numeric restaurant IDs required by the restref availability API.
// The restref API is designed for cross-origin widget embedding — no Akamai
// protection — but requires a numeric RID, not the human-readable slug.
// Sources: OT legacy ?rid= URLs, restaurant websites with widget embeds,
//          Wayback Machine archive snapshots, and prior Yelp bridge detection.
// These are the most commonly searched-for and booked restaurants in each metro.
// Adding them here ensures browser restref works even when discovery returns 0 RIDs.
const OT_SLUG_TO_RID: Record<string, number> = {
  // Atlanta / Decatur
  "aria-atlanta":                      597,
  "the-sun-dial-restaurant-atlanta":   70636,
  "ag-modern-steakhouse-atlanta":      2392,
  "by-george-atlanta":                 1044556,
  "hartley-atlanta":                   1244200,
  "bacchanalia-atlanta":               1234,
  "little-italia-decatur":             269151,
  "leon-full-service-decatur":         1231,
  "the-iberian-pig-decatur":           136716,
  "white-bull-decatur":                1321960,   // Yahoo slug: /r/white-bull-decatur
  "avize-atlanta":                     1344521,
  "el-malo-atlanta":                   1326567,   // Yahoo slug: /r/el-malo-atlanta
  "watershed-on-peachtree-atlanta":    4808,
  "st-cecilia-atlanta":                145530,
  "the-little-alley-steak-atlanta":    119869,
  "ponce-city-market-food-hall":       1038752,
  "bones-restaurant-atlanta":          2388,
  // New York
  "le-bernardin-new-york":             3402,
  "eleven-madison-park-new-york":      30651,
  "gramercy-tavern-new-york":          3434,
  "the-modern-new-york":               94044,
  "nobu-fifty-seven-new-york":         3416,
  "balthazar-new-york":                7538,
  "per-se-new-york":                   6352,
  "daniel-new-york":                   3408,
  // Chicago
  "alinea-chicago":                    1178,
  "the-girl-and-the-goat-chicago":     64066,
  "boka-chicago":                      1172,
  "gt-prime-chicago":                  1182,
  // LA
  "providence-los-angeles":            5054,
  "nobu-los-angeles":                  5062,
  "the-ivy-los-angeles":               5049,
  // SF
  "gary-danko-san-francisco":          2424,
  "bix-san-francisco":                 2397,
  "the-slanted-door-san-francisco":    2427,
  // DC
  "minibar-by-jose-andres-washington-dc": 7518,
  "the-dabney-washington-dc":          233285,
  // Boston
  "no-9-park-boston":                  1079,
  "toro-boston":                       19461,
  // Houston
  "caracol-houston":                   73836,
  "uchi-houston":                      88484,
  // Nashville
  "the-catbird-seat-nashville":        63819,
  "rolf-and-daughters-nashville":      107618,
};

// Seed the persistent cache from the hardcoded table (runs once on cold start)
for (const [slug, rid] of Object.entries(OT_SLUG_TO_RID)) {
  OT_RID_CACHE.set(slug, String(rid));
}

// OT metro IDs — used for browser-side widget search endpoint calls.
// Source: OT's public /restref/ widget and partner documentation.
const OT_METRO_IDS: Record<string, number> = {
  "atlanta-ga":        4,  "new-york-ny":      13, "chicago-il":        2,
  "los-angeles-ca":    5,  "san-francisco-ca":  3, "boston-ma":         1,
  "washington-dc":     9,  "philadelphia-pa":   8, "seattle-wa":       12,
  "dfw":               7,  "miami-fl":         27, "houston-tx":       74,
  "austin-tx":        62,  "denver-co":        10, "minneapolis-mn":   15,
  "phoenix-az":       14,  "portland-or":      20, "nashville-tn":     58,
  "new-orleans-la":   45,  "las-vegas-nv":     44, "san-diego-ca":     41,
  "charlotte-nc":     53,  "raleigh-nc":       76, "baltimore-md":     21,
  "pittsburgh-pa":    18,  "cleveland-oh":     19, "detroit-mi":       16,
  "milwaukee-wi":     33,  "kansas-city-mo":   55, "st-louis-mo":      17,
  "indianapolis-in":  24,  "louisville-ky":    79, "memphis-tn-ar":    35,
  "tampa-bay-fl":     29,  "orlando-fl":       73, "salt-lake-city-ut":34,
  "sacramento-ca":    40,  "richmond-va":      69, "decatur-ga":        4,
  "san-antonio-tx":   93,  "london-england":  158,
};

function getOTMetroId(params: SearchParams): number | null {
  const slug = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  return OT_METRO_IDS[slug] ?? null;
}

function normToOT(fc: any, params: SearchParams): Restaurant | null {
  const url    = fc.url ?? "";
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";
  const mSlug  = url.match(/opentable\.(?:com|co\.uk)\/r\/([^/?#]+)/i);
  const mNum   = url.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
  if (!mSlug && !mNum) return null;
  const slug    = mSlug ? mSlug[1] : mNum![1];
  const baseUrl = `https://www.${domain}/r/${slug}`;
  const rid     = mNum ? mNum[1]
    : extractRid(url)
    ?? (OT_SLUG_TO_RID[slug] != null ? String(OT_SLUG_TO_RID[slug]) : null)
    ?? OT_RID_CACHE.get(slug)
    ?? null;
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
// TWO parallel searches:
//   1. Reservation-filtered (reservation_date/time/covers): returns ONLY native Yelp
//      restaurants. These have confirmed availability for the requested slot.
//   2. General top-rated (sortby=rating, no reservation filter): returns ALL restaurant
//      types regardless of booking platform. OT and Resy restaurants appear here but
//      not in search #1. This pool feeds the OT/Resy cross-platform bridges in verifyYelp.
// Both results are merged (reservation-filtered first) before verification.

async function discoverYelp(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city   = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const domain = params.country === "gb" ? "yelp.co.uk" : "yelp.com";
  const tNoCol = params.time.replace(":", "");
  const loc    = encodeURIComponent(`${city}${params.state ? `, ${params.state}` : ""}`);
  const term   = params.cuisine
    ? `&find_desc=${encodeURIComponent(params.cuisine + " restaurant")}`
    : "&find_desc=restaurants";

  const scrapeYelp = async (url: string, label: string): Promise<string[]> => {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 22_000);
      const resp  = await fetch(`${FC_API}/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, waitFor: 6000, timeout: 15000 }),
      });
      clearTimeout(timer);
      if (!resp.ok) { console.log(`[Yelp ${label}] HTTP ${resp.status}`); return []; }
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      const urls = extractYelpReservationUrls(md);
      console.log(`[Yelp ${label}] ${urls.length} venues (md=${md.length})`);
      return urls;
    } catch (err: any) {
      console.log(`[Yelp ${label}] ${err?.message}`); return [];
    }
  };

  // Two searches: reservation-filtered (native Yelp only) + top-rated (broader pool).
  // Top-rated results get flagged _topRated=true so verifyYelp can apply stricter
  // isYelpNative checks and drop non-native restaurants.
  const resvUrl = `https://www.${domain}/search?find_loc=${loc}${term.replace("find_desc=","term=")}&reservation_date=${params.date}&reservation_time=${tNoCol}&reservation_covers=${params.partySize}`;
  const topUrl  = `https://www.${domain}/search?find_loc=${loc}${term}&sortby=rating`;

  const [resvUrls, topUrls] = await Promise.all([
    scrapeYelp(resvUrl, "resv"),
    scrapeYelp(topUrl,  "top"),
  ]);

  const seen = new Set<string>();
  const combined: string[] = [];
  for (const u of [...resvUrls, ...topUrls]) {
    const slug = u.split("/").pop() ?? "";
    if (slug && !seen.has(slug)) { seen.add(slug); combined.push(u); }
  }

  if (combined.length >= 1) {
    console.log(`[Yelp] ${combined.length} venues (resv=${resvUrls.length} top=${topUrls.length})`);
    const resvSet = new Set(resvUrls.map(u => u.split("/").pop()));
    return combined.map(u => {
      const r = normToYelp({ url: u, title: "", description: "" }, params);
      if (!r) return null;
      // Flag top-rated-only results so verifyYelp treats them more strictly
      if (!resvSet.has(u.split("/").pop())) r._topRated = true;
      return r;
    }).filter(Boolean) as Restaurant[];
  }

  // Google fallback (rarely needed given two direct scrapes above)
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const queries = [
    `inurl:${domain}/reservations/ ${city}${state}${cuisine} restaurant`,
    `inurl:${domain}/reservations/ ${city}${state} restaurant dinner`,
  ];
  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToYelp(r, params)).filter(Boolean) as Restaurant[];
}

// Extract Yelp reservation/biz URLs from a scraped markdown page.
// Matches both absolute URLs and relative markdown hrefs (Yelp SPA renders /biz/ paths).
function extractYelpReservationUrls(md: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Absolute: https://www.yelp.com/biz/atlas-restaurant-atlanta
  const reAbs = /https?:\/\/(?:www\.)?yelp\.(?:com|co\.uk)\/(?:reservations|biz)\/([^/?#\s"')]+)/gi;
  // Relative in markdown link syntax: (/biz/slug) or (/reservations/slug)
  const reRel = /\(\/(?:reservations|biz)\/([^/?#\s"')]+)/gi;

  for (const re of [reAbs, reRel]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const slug = m[1].toLowerCase();
      if (!seen.has(slug) && !isGarbageYelpSlug(slug)) {
        seen.add(slug);
        urls.push(`https://www.yelp.com/reservations/${slug}`);
      }
    }
  }
  return urls;
}

function isGarbageYelpSlug(slug: string): boolean {
  if (slug.includes("_")) return true; // Yelp real slugs use hyphens only
  // Hash-like segments: 12+ chars mixing letters and digits (e.g. "aso24hnzbuvzniv1mq")
  return slug.split("-").some(seg => seg.length >= 10 && /\d/.test(seg) && /[a-z]/.test(seg));
}

function normToYelp(fc: any, params: SearchParams): Restaurant | null {
  const url  = fc.url ?? "";
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

// ─── TOCK DISCOVERY ───────────────────────────────────────────────────────────
// Tock (exploretock.com) is a reservation platform with no Akamai protection.
// It's popular for tasting-menu / ticketed dining and upscale restaurants.
// URL pattern: exploretock.com/[slug]
// Booking params: ?date=YYYY-MM-DD&time=HH:MM&size=N

async function discoverTock(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city    = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";

  const queries = [
    `site:exploretock.com ${city}${state}${cuisine} restaurant reservation`,
    `site:exploretock.com ${city}${state} restaurant dinner`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToTock(r, params)).filter(Boolean) as Restaurant[];
}

function normToTock(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  // Tock URL: exploretock.com/[slug] or exploretock.com/[slug]/experiences/...
  const m = url.match(/exploretock\.com\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (TOCK_SKIP.has(slug)) return null;
  const baseUrl    = `https://www.exploretock.com/${slug}`;
  const bookingUrl = addTockParams(baseUrl, params);
  return {
    id: `tock-${slug}`,
    name: cleanTitle(fc.title, url, "tock"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "tock" as const,
    platformUrl: bookingUrl,
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

const TOCK_SKIP = new Set([
  "about","press","legal","careers","help","contact","gift",
  "explore","blog","privacy","terms","faq","venues","search",
  "how-it-works","restaurant","restaurants","experiences","merch",
]);

async function verifyTock(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 2500,   // Tock is a React SPA; give it time to render
        timeout: 9000,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 80) return null;

    // Check for reservation / booking indicators
    const hasReservations = /\b(select\s+(a\s+)?time|find\s+a\s+table|choose\s+(a\s+)?time|available|book\s+(a\s+)?table|make\s+a\s+reservation|tickets?|experiences?|no\s+experiences|request\s+a\s+time)\b/i.test(md);
    if (!hasReservations) return null;

    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    const ratingM  = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    const priceM   = md.match(/(\$+)\s*(?:·|•|,|\s)/);
    const addr     = r._address || extractAddress(md) || undefined;

    const meta = {
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      priceRange:  priceM  ? priceM[1]                              : r.priceRange,
    };

    if (windowed.length === 0) {
      // Tock often requires date selection — soft-verify if the booking widget exists
      return { ...r, ...meta, timeSlots: [], softVerified: true, _address: addr };
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("tock", base, params, s.time) }));
    return { ...r, ...meta, timeSlots: slotsWithUrls, _address: addr };
  } catch (err) {
    console.error(`[verifyTock] ${r.name}:`, err);
    return null;
  }
}

function addTockParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("date", p.date);
    u.searchParams.set("time", p.time);
    u.searchParams.set("size", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

/**
 * KEY FIX: verifyBatch now accepts a budgetMs and tracks a local deadline.
 * It returns PARTIAL results — results accumulated before the deadline are
 * kept even if more candidates remain. This eliminates the previous bug where
 * withTimeout(verifyBatch, 10s) threw away all partially-accumulated results.
 */
async function verifyBatch(
  candidates: Restaurant[],
  params: SearchParams,
  fcKey: string,
  budgetMs: number,
  scraperUrl = "",
  scraperSecret = "",
  bbKey = "",
  bbProject = "",
): Promise<Restaurant[]> {
  if (candidates.length === 0) return [];

  const deadline = Date.now() + budgetMs;
  const results: Restaurant[] = [];

  for (let i = 0; i < candidates.length; i += VERIFY_CONCUR) {
    if (results.length >= VERIFY_MAX) break;
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break; // not enough time for a meaningful scrape batch

    const batch      = candidates.slice(i, i + VERIFY_CONCUR);
    const perScrapeMs = Math.min(remaining - 500, 24_000); // 24s allows warm Lambda Yelp (~15s) to complete
    const settled    = await Promise.allSettled(
      batch.map(r => withTimeout(verifyOne(r, params, fcKey, scraperUrl, scraperSecret, bbKey, bbProject), perScrapeMs, null))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== null) results.push(s.value);
    }
  }

  return results;
}

// ── Yelp: Real-browser verification via Browserbase ───────────────────────────
// DataDome (Yelp's bot protection) blocks Lambda IPs and rejects Firecrawl.
// A real Chrome browser with Browserbase's residential proxy bypasses DataDome.
// We intercept Yelp's own availability API call (same pattern as OT above).
async function verifyYelpViaBB(
  r: Restaurant, params: SearchParams, bbKey: string, bbProject: string,
): Promise<Restaurant | null> {
  const slugM = r.platformUrl.match(/yelp\.com\/(?:reservations\/|biz\/)([^/?#\s]+)/i);
  if (!slugM) return null;
  const slug = slugM[1];

  // Navigate to the reservations page with date/time/covers — Yelp's widget fires
  // availability requests automatically. Our init script intercepts them.
  const pageUrl = `https://www.yelp.com/reservations/${slug}?covers=${params.partySize}&date=${params.date}&time=${params.time}`;

  const initScript = [
    "(function(){",
    "var _f=window.fetch;window.__tf_yelp='';",
    "window.fetch=function(u,i){",
    "  var p=_f.apply(this,arguments);",
    "  if(typeof u==='string'&&(u.indexOf('/availability')!==-1||u.indexOf('seatme')!==-1)){",
    "    p.then(function(r){var c=r.clone();c.text().then(function(t){if(!window.__tf_yelp)window.__tf_yelp=t;}).catch(function(){});}).catch(function(){});",
    "  }",
    "  return p;",
    "};",
    "})();",
  ].join("");

  const evalExpr = "window.__tf_yelp || document.body.innerText";

  try {
    const text = await bbLoad(pageUrl, bbKey, bbProject, {
      waitMs:    8000,
      useProxy:  true,
      initScript,
      evalExpr,
      timeoutMs: 30_000,
    });

    (globalThis as any).__yelpBBDebug = ((globalThis as any).__yelpBBDebug
      ? (globalThis as any).__yelpBBDebug + " || " : "") + `${r.name}:len=${text.length}|s=${text.substring(0, 60)}`;

    if (text.length < 50 || /access denied|you don't have permission|are you a robot|just a moment|datadome/i.test(text)) {
      console.log(`[Yelp BB] ${r.name}: blocked (${text.length})`);
      return null;
    }

    const slots    = extractTimes(text);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[Yelp BB] ${r.name}: no slots in window (len=${text.length})`);
      return null;
    }

    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
    console.log(`[Yelp BB] ${r.name}: ${windowed.length} slots ✓`);
    return { ...r, timeSlots: slotsWithUrls, softVerified: false };
  } catch (err: any) {
    (globalThis as any).__yelpBBDebug = ((globalThis as any).__yelpBBDebug
      ? (globalThis as any).__yelpBBDebug + " || " : "") + `${r.name}:ERR:${err?.message?.substring(0, 50)}`;
    console.log(`[Yelp BB] ${r.name}: ${err?.message}`);
    return null;
  }
}

// Resolves with the first non-null result from an array of promises.
// Used to run BB, Lambda, and Firecrawl in parallel and take whichever wins first.
function raceNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let pending = promises.length;
    if (pending === 0) { resolve(null); return; }
    promises.forEach(p => {
      p.then(result => {
        if (result !== null) resolve(result);
        else if (--pending === 0) resolve(null);
      }).catch(() => { if (--pending === 0) resolve(null); });
    });
  });
}

async function verifyOne(
  r: Restaurant, params: SearchParams, fcKey: string,
  scraperUrl = "", scraperSecret = "", bbKey = "", bbProject = "",
): Promise<Restaurant | null> {
  if (r._preVerified && !r.softVerified) return r; // hard-verified during discovery — pass through
  // OT soft-verified = BB found the restaurant on the search page but couldn't extract times.
  // Show it with a "Check on OT" link rather than silently discarding it.
  if (r._preVerified &&  r.softVerified && r.platform === "opentable") return r;
  if (r._preVerified &&  r.softVerified) return null; // Resy: API returned but no slots in time window
  if (r.platform === "resy")      return scraperUrl && scraperSecret
    ? verifyResyViaBB(r, params, scraperUrl, scraperSecret)
    : verifyResy(r, params, fcKey);
  if (r.platform === "opentable") {
    // Log this candidate for diagnostics (append to global, all run in parallel)
    const _candInfo = `${r.name}|rid=${r._rid ?? "none"}|url=${r.platformUrl}`;
    (globalThis as any).__otCandDebug = ((globalThis as any).__otCandDebug
      ? (globalThis as any).__otCandDebug + " || " : "") + _candInfo;

    // v67: Run restref, BB, Lambda, and Firecrawl in parallel using raceNonNull.
    // Previous sequential approach (BB → Lambda → Firecrawl) was broken:
    // BB uses up to 18s of the 24s perScrapeMs budget, leaving Lambda only 0-6s
    // which causes timeouts on cold starts (8-15s).  Running in parallel means
    // OT verify strategy:
    // - RID restaurants: BB returns null (evalExpr="window.__tf_ot" stays empty since
    //   widget canvas shows calendar first). Goes to clientVerifyOT → browser restref.
    // - No-RID restaurants: BB loads full page with residential proxy (may succeed).
    // - Lambda removed: gets ERR_EMPTY_RESPONSE 100% of the time on opentable.com.
    // - Server-side restref: blocked from Supabase IPs.
    return raceNonNull([
      verifyOTviaRestref(r, params),
      bbKey && bbProject
        ? verifyOTViaBB(r, params, bbKey, bbProject)
        : Promise.resolve(null),
      verifyOT(r, params, fcKey),
    ]);
  }
  if (r.platform === "yelp") {
    // NOTE: Browserbase (BB) does NOT work for Yelp — DataDome blocks even real Chrome
    // with residential proxy, returning a blank page (len=0). We skip BB entirely for
    // Yelp and use Firecrawl + Lambda which work (DataDome is less aggressive on
    // non-reservation Yelp pages / Firecrawl's infrastructure has clean IPs for Yelp).
    // Firecrawl (soft-verify) + Lambda (JS render) in parallel
    const [lambdaResult, fcResult] = await Promise.all([
      scraperUrl && scraperSecret
        ? verifyYelpViaLambda(r, params, scraperUrl, scraperSecret)
        : Promise.resolve(null),
      verifyYelp(r, params, fcKey),
    ]);
    const lSlots = lambdaResult?.timeSlots.length ?? 0;
    const fSlots = fcResult?.timeSlots.length ?? 0;
    console.log(`[verifyOne Yelp] ${r.name}: lambda=${lSlots} slots fc=${fSlots} slots fc_platform=${fcResult?.platform ?? "null"}`);
    if (lambdaResult && lSlots > 0) return lambdaResult;
    if (fcResult    && fSlots > 0) return fcResult;
    return null;
  }
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
        waitFor: 1500,  // Resy is a React SPA — 500ms was too short
        timeout: 9000,
      }),
    });
    if (!resp.ok) { console.log(`[verifyResy] ${r.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) { console.log(`[verifyResy] ${r.name}: short markdown (${md.length})`); return null; }

    // Bail if page is purely notify/waitlist with zero time slots visible
    if (/\bnotify\b/i.test(md) && !/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(md)) return null;

    // Try to narrow to the relevant meal section; fall back to full page
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

// Real-browser Resy venue verification — renders the booking page JS and extracts
// actual time slot buttons from innerText.
async function verifyResyViaBB(
  r: Restaurant, params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant | null> {
  try {
    // Use full page text — we know this works reliably with the Lambda browser.
    // extractTimes already filters times near "notify/waitlist/other dates" context.
    const text = await lambdaLoad(r.platformUrl, scraperUrl, scraperSecret, { waitMs: 5000 });
    if (!text || text.trim().length < 50) {
      console.log(`[Resy Lambda] ${r.name}: empty page`);
      return null;
    }
    // If page clearly shows fully booked with NO time text at all, drop it.
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

// ── OpenTable ─────────────────────────────────────────────────────────────────
// Akamai blocks Firecrawl on main OT restaurant pages.
// Strategy: if _widgetUrl is set (widget canvas endpoint), try that first —
// it's cross-origin accessible by design and may have lighter Akamai protection.
// Apify-sourced candidates are already _preVerified so this function is skipped.

async function verifyOT(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  if (!fcKey) return null;

  // Try widget canvas first (lighter Akamai protection), then fall back to main page.
  const urlsToTry = r._widgetUrl
    ? [r._widgetUrl, r.platformUrl]
    : [r.platformUrl];

  for (const scrapeUrl of urlsToTry) {
    const isWidget = scrapeUrl === r._widgetUrl;
    try {
      const resp = await fetch(`${FC_API}/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: scrapeUrl, formats: ["markdown"],
          onlyMainContent: false,
          waitFor: isWidget ? 3500 : 3000,
          timeout: 10000,
        }),
      });
      if (!resp.ok) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: HTTP ${resp.status}`);
        continue; // try next URL
      }
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      if (md.length < 50) continue;
      if (/access denied|security check|enable javascript|are you a robot|just a moment/i.test(md)) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: Akamai blocked`);
        continue;
      }
      const slots    = extractTimes(md);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: no matching slots in markdown (len=${md.length})`);
        continue;
      }
      const base         = r.platformUrl.split("?")[0];
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
      const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
      const reviewM = md.match(/\(([\d,]+)\s*review/i);
      console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: ${windowed.length} slots ✓`);
      return {
        ...r,
        timeSlots:   slotsWithUrls,
        rating:      ratingM ? parseFloat(ratingM[1]) : r.rating,
        reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
        _address:    r._address || extractAddress(md) || undefined,
      };
    } catch (err: any) {
      console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: ${err?.message}`);
    }
  }

  // Path 3: Jina AI reader — different infrastructure/IPs from Firecrawl.
  // Akamai's IP blacklists target datacenter ranges used by Firecrawl/cloud scrapers.
  // Jina (r.jina.ai) runs its own headless browser fleet with separate IP space.
  // Free for basic use, no API key needed.
  return verifyOTviaJina(r, params);
}

async function verifyOTviaJina(r: Restaurant, params: SearchParams): Promise<Restaurant | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const resp = await fetch(`https://r.jina.ai/${r.platformUrl}`, {
      headers: {
        "Accept":          "text/plain",
        "User-Agent":      "Mozilla/5.0 (compatible; TableFinder/2.0)",
        "X-Return-Format": "markdown",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.log(`[OT Jina] ${r.name}: HTTP ${resp.status}`); return null; }
    const md = await resp.text();
    if (md.length < 100) return null;
    if (/access denied|security check|are you a robot|just a moment|enable javascript/i.test(md)) {
      console.log(`[OT Jina] ${r.name}: blocked`);
      return null;
    }
    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT Jina] ${r.name}: no slots (md=${md.length})`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[OT Jina] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1]) : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name !== "AbortError") console.log(`[OT Jina] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ── OT: Direct restref API ────────────────────────────────────────────────────
// opentable.com/restref/api/availability is designed for cross-origin embedding
// on restaurant websites worldwide — no Akamai bot protection, no CSRF required.
// Returns JSON availability data directly from Deno, no Lambda/scraping needed.
async function verifyOTviaRestref(r: Restaurant, params: SearchParams): Promise<Restaurant | null> {
  const rid = r._rid ?? extractRid(r.platformUrl);
  if (!rid) {
    console.log(`[OT restref] ${r.name}: no rid`);
    (globalThis as any).__otRestrefDebug = ((globalThis as any).__otRestrefDebug
      ? (globalThis as any).__otRestrefDebug + " | " : "") + `no_rid:${r.name}`;
    return null;
  }

  const url = `https://www.opentable.com/restref/api/availability?rid=${rid}&covers=${params.partySize}&day=${params.date}&lang=en-US&ref=5`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer":         "https://www.opentable.com/",
        "Accept":          "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Requested-With":"XMLHttpRequest",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.log(`[OT restref] ${r.name}: HTTP ${resp.status}`);
      (globalThis as any).__otRestrefDebug = ((globalThis as any).__otRestrefDebug
        ? (globalThis as any).__otRestrefDebug + " | " : "") + `http_${resp.status}:rid=${rid}:${r.name}`;
      return null;
    }
    const raw  = await resp.json();
    const text = JSON.stringify(raw);
    // Capture first successful response for schema inspection
    if (!(globalThis as any).__otRestrefDebug || !(globalThis as any).__otRestrefDebug.includes("success")) {
      (globalThis as any).__otRestrefDebug = ((globalThis as any).__otRestrefDebug
        ? (globalThis as any).__otRestrefDebug + " | " : "") + `success:rid=${rid}:${text.substring(0,200)}`;
    }
    // extractTimes handles both 12h ("7:30 PM") and 24h ("19:30") formats
    const slots    = extractTimes(text);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT restref] ${r.name}: no slots in window (raw len=${text.length})`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    console.log(`[OT restref] ${r.name}: ${windowed.length} slots ✓ (rid=${rid})`);
    return { ...r, timeSlots: slotsWithUrls, softVerified: false };
  } catch (err: any) {
    clearTimeout(timer);
    console.log(`[OT restref] ${r.name}: ${err?.message}`);
    (globalThis as any).__otRestrefDebug = ((globalThis as any).__otRestrefDebug
      ? (globalThis as any).__otRestrefDebug + " | " : "") + `err:${err?.message?.substring(0,40)}:rid=${rid}:${r.name}`;
    return null;
  }
}

// Real-browser OT verification via Browserbase residential proxy.
// v59: Instead of calling the restref API ourselves (which returns "Service Unavailable"
// because it requires auth tokens our browser session doesn't have), we let OT's own
// React widget make the call. The widget fires a fetch() to /restref/api/availability
// automatically when the restaurant page loads with ?dateTime=...&covers=... params.
// An init script injected before page load intercepts that fetch and captures the response.
// This bypasses all auth issues: OT's own code makes the authenticated call.
async function verifyOTViaBB(
  r: Restaurant, params: SearchParams, bbKey: string, bbProject: string,
): Promise<Restaurant | null> {
  const rid = r._rid ?? extractRid(r.platformUrl);

  // v75: Skip BB entirely for RID restaurants. The canvas widget URL requires a user
  // click to trigger /restref/api/availability — it never auto-fires, so window.__tf_ot
  // stays empty → returns null every time. This was burning BB session budget with 0 benefit.
  // RID restaurants are handled client-side via verifyOTRestref (browser → restref API).
  if (rid) {
    console.log(`[OT BB] ${r.name}: has RID — skipping BB (client-side restref handles this)`);
    return null;
  }

  (globalThis as any).__otVerifyDebug = ((globalThis as any).__otVerifyDebug
    ? (globalThis as any).__otVerifyDebug + " || " : "") + `CALL:${r.name}(rid=${rid ?? "none"})`;

  // No-RID restaurants require the full page (widget canvas requires a RID param).
  const dt      = `${params.date}T${params.time}`;
  const pageUrl = r.platformUrl;

  // Injected before page load. Wraps window.fetch + XMLHttpRequest to capture
  // any /restref/api/availability response that OT's widget fires during load.
  const initScript = [
    "(function(){",
    "var _f=window.fetch;window.__tf_ot='';",
    "window.fetch=function(u,i){",
    "  var p=_f.apply(this,arguments);",
    "  if(typeof u==='string'&&u.indexOf('/restref/api/availability')!==-1){",
    "    p.then(function(r){var c=r.clone();c.text().then(function(t){window.__tf_ot=t;}).catch(function(){});}).catch(function(){});",
    "  }",
    "  return p;",
    "};",
    "var _xo=XMLHttpRequest.prototype.open,_xs=XMLHttpRequest.prototype.send;",
    "XMLHttpRequest.prototype.open=function(m,u){",
    "  if(typeof u==='string'&&u.indexOf('/restref/api/availability')!==-1)this._tf=true;",
    "  return _xo.apply(this,arguments);",
    "};",
    "XMLHttpRequest.prototype.send=function(){",
    "  if(this._tf){var x=this;this.addEventListener('load',function(){window.__tf_ot=x.responseText;});}",
    "  return _xs.apply(this,arguments);",
    "};",
    "})();",
  ].join("");

  // v77: Don't fall back to innerText. The full OT page does NOT auto-fire
  // restref on load — it waits for user click. So window.__tf_ot stays empty and
  // innerText gives us the time-picker dropdown (6:00, 6:30 … 8:00 PM on every page).
  // Instead: try window.__tf_ot first; if empty, extract the real RID from OT's
  // embedded __NEXT_DATA__ JSON so clientVerifyOT can call restref from the browser.
  const evalExpr = [
    "(function(){",
    "  if(window.__tf_ot) return window.__tf_ot;",
    "  try{",
    "    var d=JSON.parse(document.getElementById('__NEXT_DATA__').textContent);",
    "    var pp=d&&d.props&&d.props.pageProps;",
    "    var rid=pp&&(",
    "      (pp.restaurantData&&pp.restaurantData.rid)||",
    "      (pp.restaurant&&pp.restaurant.rid)||",
    "      (pp.restaurantDetails&&pp.restaurantDetails.restaurantId)||",
    "      pp.rid",
    "    );",
    "    if(rid) return 'RID:'+String(rid);",
    "  }catch(e){}",
    "  return '';",
    "})()",
  ].join("");

  try {
    const text = await bbLoad(pageUrl, bbKey, bbProject, {
      waitMs:     4000,
      useProxy:   true,
      initScript,
      evalExpr,
      timeoutMs:  18_000,
    });

    (globalThis as any).__otVerifyDebug += `→len=${text.length}|sample=${text.substring(0, 120)}`;

    // Access Denied = Akamai blocked. Retry once with fresh proxy IP.
    let finalText = text;
    if (text.length < 500 && /access denied|you don't have permission/i.test(text)) {
      console.log(`[OT BB] ${r.name}: access denied, retrying with fresh proxy IP…`);
      (globalThis as any).__otVerifyDebug += `|RETRY`;
      try {
        finalText = await bbLoad(pageUrl, bbKey, bbProject, {
          waitMs: 4000, useProxy: true, initScript, evalExpr, timeoutMs: 18_000,
        });
        (globalThis as any).__otVerifyDebug += `→retry_len=${finalText.length}`;
      } catch (retryErr: any) {
        (globalThis as any).__otVerifyDebug += `→retry_ERR:${retryErr?.message?.substring(0, 50)}`;
        return null;
      }
    }

    if (/access denied|just a moment/i.test(finalText)) {
      console.log(`[OT BB] ${r.name}: blocked after retry`);
      return null;
    }

    // Case 1: Extracted a RID from __NEXT_DATA__ — page loaded but restref not intercepted.
    // Store it so clientVerifyOT can send this restaurant to the browser with the real RID.
    if (finalText.startsWith("RID:")) {
      const discoveredRid = finalText.slice(4).trim();
      console.log(`[OT BB] ${r.name}: discovered RID=${discoveredRid} via __NEXT_DATA__ → clientVerifyOT`);
      (globalThis as any).__otVerifyDebug += `|RID_FOUND:${discoveredRid}`;
      // Store in global request map + module-level persistent cache for warm reuse.
      const ridMap: Map<string, string> = ((globalThis as any).__tfRidMap ??= new Map());
      ridMap.set(r.id, discoveredRid);
      const slugM2 = r.platformUrl.match(/opentable\.com\/r\/([^/?#]+)/i);
      if (slugM2) cacheOTRid(slugM2[1], discoveredRid);
      return null; // client will verify with real RID
    }

    // Case 2: window.__tf_ot captured real restref JSON. Parse for actual availability.
    if (finalText.length > 10) {
      const slots    = extractTimes(finalText);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[OT BB] ${r.name}: restref captured but no slots in window`);
        return null;
      }
      const base          = r.platformUrl.split("?")[0];
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
      console.log(`[OT BB] ${r.name}: ${windowed.length} real slots ✓`);
      return { ...r, timeSlots: slotsWithUrls, softVerified: false };
    }

    // Case 3: Empty — page didn't load or restref not captured.
    console.log(`[OT BB] ${r.name}: empty response → null`);
    return null;
  } catch (err: any) {
    (globalThis as any).__otVerifyDebug += `→ERR:${err?.message?.substring(0, 80)}`;
    console.log(`[OT BB] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ── Yelp ──────────────────────────────────────────────────────────────────────

// Direct Yelp SeatMe availability API — called by the widget JS before rendering.
// Bypasses JS rendering entirely; returns JSON time slots from Deno directly.
// v100 fix: Yelp time param must be "HHMM" (no colon), e.g. "1900" not "19:00".
async function verifyYelpViaDirectAPI(r: Restaurant, params: SearchParams): Promise<Restaurant | null> {
  // Accept both /reservations/slug and /biz/slug URL shapes
  const slugM = r.platformUrl.match(/yelp\.com\/(?:reservations\/|biz\/)([^/?#\s]+)/i);
  if (!slugM) return null;
  const slug = slugM[1];

  // Yelp SeatMe widget uses HHMM format (no colon) for the time parameter.
  const timeNoColon = params.time.replace(":", "");

  const urls = [
    `https://www.yelp.com/reservations/${slug}/availability?covers=${params.partySize}&date=${params.date}&time=${timeNoColon}`,
    `https://www.yelp.com/reservations/${slug}/find_booking?covers=${params.partySize}&date=${params.date}&time=${timeNoColon}`,
  ];

  const headers = {
    "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer":           `https://www.yelp.com/reservations/${slug}`,
    "Accept":            "application/json",
    "Accept-Language":   "en-US,en;q=0.9",
    "X-Requested-With":  "XMLHttpRequest",
    "x-yelp-request-id": crypto.randomUUID(),
  };

  for (const url of urls) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const resp = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      const statusInfo = `HTTP ${resp.status} url=${url.split("?")[0].split("/").pop()}`;
      if (!resp.ok) {
        (globalThis as any).__yelpApiDebug = ((globalThis as any).__yelpApiDebug ?? "") + `${r.name}:${statusInfo} `;
        console.log(`[Yelp API] ${r.name}: ${statusInfo}`);
        continue;
      }
      const raw  = await resp.json();
      const text = JSON.stringify(raw);
      if (!(globalThis as any).__yelpApiDebug || !(globalThis as any).__yelpApiDebug.includes("200")) {
        (globalThis as any).__yelpApiDebug = `200ok:${r.name}:${text.substring(0, 300)}`;
      }
      const slots    = extractTimes(text);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[Yelp API] ${r.name}: no slots in window (raw=${text.substring(0, 120)})`);
        continue;
      }
      const base          = `https://www.yelp.com/reservations/${slug}`;
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
      console.log(`[Yelp API] ${r.name}: ${windowed.length} slots ✓`);
      return { ...r, timeSlots: slotsWithUrls, softVerified: false };
    } catch (err: any) {
      clearTimeout(timer);
      console.log(`[Yelp API] ${r.name}: ${err?.message}`);
    }
  }
  return null;
}

async function verifyYelp(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  // Try direct SeatMe API first — fastest path, no JS rendering needed.
  // Falls through to Firecrawl scraping if the API call fails or returns no slots.
  const apiResult = await verifyYelpViaDirectAPI(r, params);
  if (apiResult && apiResult.timeSlots.length > 0) return apiResult;

  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown", "rawHtml"],
        onlyMainContent: false,
        waitFor: 9000,  // Yelp reservation widget needs ~8-9s to fully hydrate
        timeout: 20000,
      }),
    });
    if (!resp.ok) { console.log(`[verifyYelp] ${r.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string   = data.data?.markdown ?? "";
    const html: string = data.data?.rawHtml ?? "";
    if (md.length < 50) { console.log(`[verifyYelp] ${r.name}: short markdown (${md.length})`); return null; }

    // Capture first FC markdown sample so _debug shows what Firecrawl returned
    if (!(globalThis as any).__yelpFcSample) {
      (globalThis as any).__yelpFcSample = `${r.name}|md_len=${md.length}|html_len=${html.length}|sample=${md.substring(0, 400)}`;
    }

    // Extract actual restaurant name from page og:title (slug-derived fallback names
    // include Yelp city-disambiguation suffixes like "Fox Bros Bar B Q Atlanta").
    const pageMetaTitle = (data.data?.metadata?.ogTitle ?? data.data?.metadata?.title ?? "") as string;
    const pageName = pageMetaTitle.length > 1
      ? pageMetaTitle
          .replace(/\s*[|–-]\s*(Yelp|Make a Reservation|Reservations?|Reviews?|Photos?|Menu|Order Online).*$/i, "")
          .replace(/\s*[-–]\s*[A-Za-z\s]+,\s*[A-Z]{2}.*$/i, "")
          .trim()
      : "";
    // Use the page-scraped name if it's cleaner than the URL-slug fallback
    const rr = pageName.length > 1 ? { ...r, name: pageName } : r;

    // Detect /reservations/ → /biz/ redirect: Yelp shows the restaurant in its
    // reservation search but the restaurant doesn't actually use Yelp reservations.
    // Firecrawl follows the redirect silently; ogUrl reveals the final landing URL.
    // We still run OT/Resy bridge checks below — bridges may fire from the biz page.
    // But we will NOT soft-verify as a native Yelp result if no bridge matches.
    const finalUrl: string = data.data?.metadata?.ogUrl ?? data.data?.metadata?.url ?? "";
    const isYelpNative = !(
      r.platformUrl.includes("/reservations/") &&
      /yelp\.com\/biz\//.test(finalUrl) &&
      !finalUrl.includes("/reservations/")
    );
    if (!isYelpNative) {
      console.log(`[verifyYelp] ${r.name}: /reservations/ redirected to /biz/ — not Yelp-native`);
    }

    // ── OT Bridge ─────────────────────────────────────────────────────────────
    // Yelp reservation pages often embed an OT booking link with the restaurant's
    // rid. Try the OT widget canvas first (hard result with slots). If Akamai
    // blocks it, return a soft-verified OT result rather than dropping entirely —
    // the rid is definitive proof this restaurant is on OpenTable.
    // Search both markdown (for visible links) and rawHtml (for widget script/iframe src
    // attributes like <script src="//www.opentable.com/widget/...?rid=12345"> which are
    // invisible in markdown format but present in the raw page source).
    const otRidRe1 = /opentable\.(?:com|co\.uk)[^\s"'<>]*[?&\/]rid[=\/](\d+)/i;
    const otRidRe2 = /opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i;
    const otRidM = md.match(otRidRe1) ?? md.match(otRidRe2)
                ?? html.match(otRidRe1) ?? html.match(otRidRe2);
    if (otRidM) {
      const rid        = otRidM[1];
      const profileUrl = `https://www.opentable.com/restaurant/profile/${rid}`;
      // Cache this RID — if the same restaurant appears in OT discovery on future warm
      // requests, normToOT will find the RID immediately without scraping.
      cacheOTRid(`yelp-bridge-${rid}`, rid);
      const mockR: Restaurant = {
        id: `opentable-${rid}`, name: rr.name, cuisine: rr.cuisine,
        neighborhood: rr.neighborhood, platform: "opentable",
        platformUrl: addOTParams(profileUrl, params),
        timeSlots: [], distanceMiles: null, _rid: rid,
      };
      // Try restref API first (no Akamai), then fall back to widget scrape
      const restrefResult = await verifyOTviaRestref(mockR, params);
      if (restrefResult) {
        console.log(`[verifyYelp OT bridge] ${rr.name}: restref ✓ (rid=${rid})`);
        (globalThis as any).__yelpOTBridgeDebug = ((globalThis as any).__yelpOTBridgeDebug ?? "") + `${rr.name}(rid=${rid}) `;
        return { ...restrefResult, name: rr.name };
      }
      const otResult = await tryOTWidgetScrape(rr.name, rid, params, fcKey);
      if (otResult) return { ...otResult, name: rr.name }; // Hard OT result with time slots ✓
      // Both blocked → emit soft-verified OT (shows "Check on OT" link)
      console.log(`[verifyYelp] ${rr.name}: OT rid=${rid} — all methods blocked → OT soft-verified`);
      return {
        ...rr,
        id:          `opentable-${rid}`,
        platform:    "opentable" as const,
        platformUrl: addOTParams(profileUrl, params),
        timeSlots:   [],
        softVerified: true,
        _rid: rid,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Resy Bridge ───────────────────────────────────────────────────────────
    // If the Yelp page links to a specific Resy venue URL, surface a soft-verified
    // Resy result. This fires even when Resy Google discovery returns 0 (bot block).
    const resyVenueM = md.match(/resy\.com\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/i);
    if (resyVenueM) {
      const resyBase = `https://resy.com/cities/${resyVenueM[1]}/venues/${resyVenueM[2]}`;
      const vSlug    = resyVenueM[2].toLowerCase();
      console.log(`[verifyYelp] ${rr.name}: Resy venue found → soft-verified Resy (${vSlug})`);
      return {
        ...rr,
        id:          `resy-${vSlug}`,
        platform:    "resy" as const,
        platformUrl: addResyParams(resyBase, params),
        timeSlots:   [],
        softVerified: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Non-native redirect (or Yelp og:url always resolves to /biz/) with no bridge found.
    if (!isYelpNative) {
      // _topRated-only candidates didn't come from Yelp's reservation-filtered search.
      // Without isYelpNative confirmation they're too likely to be false positives.
      if ((r as any)._topRated) {
        console.log(`[verifyYelp] ${rr.name}: non-native + top-rated + no bridge — skipping`);
        return null;
      }
      // Reservation-search candidates: Yelp included this in its own reservation index.
      // Note: Yelp's og:url may always resolve to /biz/ even for truly native Yelp pages,
      // causing false-negative native detection. Soft-verify so the user can click through.
      if (md.length >= 200) {
        console.log(`[verifyYelp] ${rr.name}: non-native (resv-search, og:url=/biz/) — soft-verified`);
        return { ...rr, timeSlots: [], softVerified: true };
      }
      console.log(`[verifyYelp] ${rr.name}: non-native + no bridge + thin content — skipping`);
      return null;
    }

    // Reject pages that mention Resy/OT by name but had no extractable URL above.
    // (Generic "Reserve on Resy" text without a venue link — not enough to act on.)
    const usesOtherPlatform = /\b(reserve\s+on\s+resy|book\s+on\s+resy|resy\.com|reserve\s+on\s+opentable|book\s+on\s+opentable)\b/i.test(md);
    if (usesOtherPlatform) {
      console.log(`[verifyYelp] ${rr.name}: redirects to Resy/OT (no extractable URL) — skipping`);
      return null;
    }

    // Top-rated-only results (not from reservation-filtered search) require isYelpNative.
    if ((r as any)._topRated && !isYelpNative) {
      console.log(`[verifyYelp] ${rr.name}: top-rated + non-native — skipping`);
      return null;
    }

    // Also scan rawHtml for times — Yelp may embed slot data in Next.js __NEXT_DATA__
    // JSON or other script tags that don't appear in the markdown.
    const htmlTimes = html.length > 500 ? extractTimes(html.substring(0, 120_000)) : [];
    const slots     = [...extractTimes(md), ...htmlTimes];
    const windowed  = filterWindow(slots, params.time);
    const ratingM   = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM   = md.match(/\(([\d,]+)\s*review/i);
    const priceM    = md.match(/(\$+)\s*(?:·|•|,|\s)/);
    const meta      = {
      rating:      ratingM ? parseFloat(ratingM[1])                 : rr.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : rr.reviewCount,
      priceRange:  priceM  ? priceM[1]                              : rr.priceRange,
    };
    const addr = rr._address || extractAddress(md) || undefined;

    if (windowed.length === 0) {
      // If the page redirected from /reservations/ to /biz/, this restaurant isn't
      // on Yelp natively — drop it (bridges above already had a chance to fire).
      if (!isYelpNative) {
        console.log(`[verifyYelp] ${rr.name}: non-native redirect + no slots — skipping`);
        return null;
      }
      // Soft-verify: the time-picker widget likely didn't render (JS-heavy), but the
      // restaurant was found via Yelp's own reservation search URL and doesn't redirect
      // to Resy/OT. Accept if there's any reservation-related language on the page.
      const hasAnyReservationHint = /\b(reservation|book\s+a\s+table|waitlist|party\s+of|guests?|dining|dine\s+in)\b/i.test(md);
      if (!hasAnyReservationHint) { console.log(`[verifyYelp] ${rr.name}: no reservation language — skipping`); return null; }
      console.log(`[verifyYelp] ${rr.name}: soft-verified (widget likely not rendered)`);
      return { ...rr, ...meta, timeSlots: [], softVerified: true, _address: addr };
    }
    const base          = rr.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
    console.log(`[verifyYelp] ${rr.name}: ${windowed.length} slots ✓`);
    return { ...rr, ...meta, timeSlots: slotsWithUrls, _address: addr };
  } catch (err) {
    console.error(`[verifyYelp] ${r.name}:`, err);
    return null;
  }
}

/**
 * Scrape the OT widget canvas endpoint — cross-origin accessible since it's
 * embedded on restaurant websites. May bypass Akamai's stricter datacenter IP
 * rules that block the main OpenTable restaurant pages.
 */
// ─── OT LAMBDA VERIFICATION ───────────────────────────────────────────────────
// The OT widget/reservation/canvas endpoint is designed for cross-origin embedding
// on any restaurant website — including cloud-hosted ones. Akamai's rules for it
// v55: Lambda uses Chrome + HTTP/1.1 to load the OT widget canvas URL.
// fetchOnly restref timed out (v54): Akamai drops Node.js TLS fingerprint connections silently.
// Chrome HTTP/1.1 (--disable-http2 always-on in handler.js) has a legitimate TLS JA3 fingerprint
// AND uses HTTP/1.1 which Akamai accepts (vs HTTP/2 which it RSTs from cloud IPs).
// Widget canvas URL is lighter than the full restaurant page and designed for cross-origin embedding.
async function verifyOTviaLambda(
  r: Restaurant, params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant | null> {
  const rid = r._rid ?? extractRid(r.platformUrl);
  if (!rid) {
    console.log(`[OT Lambda] ${r.name}: no RID — skip`);
    return null;
  }

  (globalThis as any).__otLambdaDebug = ((globalThis as any).__otLambdaDebug
    ? (globalThis as any).__otLambdaDebug + " || " : "") + `CALL:${r.name}(rid=${rid})`;

  const dt        = `${params.date}T${params.time}`;
  const widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${rid}&covers=${params.partySize}&datetime=${dt}&styleid=5&disablegt=true`;

  try {
    const raw = await lambdaLoad(widgetUrl, scraperUrl, scraperSecret, {
      useProxy:  true,   // Lambda uses PROXY_URL if configured; falls back to direct otherwise
      waitMs:    1500,   // v68: reduced from 3s — widget canvas is lightweight, saves time on cold starts
      evalExpr:  "document.body.innerText",
      timeoutMs: 22_000, // v68: slight raise — cold starts (8-15s) + 1.5s wait ≈ 10-17s, within 22s
    });

    (globalThis as any).__otLambdaDebug += `→len=${raw.length}|sample=${raw.substring(0, 120)}`;

    if (raw.length < 50 || /access denied|security check|are you a robot|just a moment/i.test(raw)) {
      console.log(`[OT Lambda] ${r.name}: blocked or empty (len=${raw.length})`);
      return null;
    }

    const slots    = extractTimes(raw);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT Lambda widget] ${r.name}: no slots in window (raw len=${raw.length})`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    console.log(`[OT Lambda widget] ${r.name}: ${windowed.length} slots ✓`);
    return { ...r, timeSlots: slotsWithUrls, softVerified: false };
  } catch (err: any) {
    (globalThis as any).__otLambdaDebug += `→ERR:${err?.message?.substring(0, 80)}`;
    console.log(`[OT Lambda] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ─── YELP LAMBDA VERIFICATION ─────────────────────────────────────────────────
// Real Chrome renders Yelp's JS reservation widget — Firecrawl cannot.
// We also get the actual page title for clean restaurant names.

async function verifyYelpViaLambda(
  r: Restaurant, params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant | null> {
  // Extract slug from URL
  const slugM = r.platformUrl.match(/yelp\.com\/(?:reservations\/|biz\/)([^/?#\s]+)/i);
  if (!slugM) { console.log(`[Yelp Lambda] ${r.name}: no slug`); return null; }
  const slug        = slugM[1];
  const timeNoColon = params.time.replace(":", "");

  // Strategy D (v65): fetchOnly fast path — plain HTTP to availability API from Lambda IP.
  // Lambda's IP range ≠ Supabase IP range; DataDome may not block Lambda for API calls.
  // Cost: ~200ms if blocked, saves 10s+ browser time if it works.
  const availUrl = `https://www.yelp.com/reservations/${slug}/availability?covers=${params.partySize}&date=${params.date}&time=${params.time}`;
  try {
    const fetchText = await lambdaLoad(availUrl, scraperUrl, scraperSecret, {
      fetchOnly: true,
      fetchHeaders: {
        "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":            "application/json, */*",
        "Referer":           `https://www.yelp.com/reservations/${slug}`,
        "Accept-Language":   "en-US,en;q=0.9",
        "x-yelp-request-id": crypto.randomUUID(),
      },
      timeoutMs: 9_000,
    });
    // Detect DataDome CAPTCHA interstitial — means this Lambda IP is flagged.
    // Browser mode will also be blocked; skip it to avoid wasting ~11s per candidate.
    const isDataDome = (fetchText ?? "").includes("captcha-delivery.com") ||
                       (fetchText ?? "").includes("datadome");
    (globalThis as any).__yelpLambdaFetchDebug = `len=${fetchText?.length ?? 0} dd=${isDataDome} sample=${(fetchText ?? "").substring(0, 180)}`;
    if (isDataDome) {
      console.log(`[Yelp Lambda] ${r.name}: DataDome CAPTCHA detected — skip browser mode`);
      (globalThis as any).__yelpLambdaDebug = `datadome_skip`;
      return null;
    }
    if (fetchText && fetchText.length > 10) {
      const slots    = extractTimes(fetchText);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length > 0) {
        const base          = `https://www.yelp.com/reservations/${slug}`;
        const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
        console.log(`[Yelp Lambda fetch] ${r.name}: ${windowed.length} slots ✓`);
        (globalThis as any).__yelpLambdaDebug = `fetch_api_success|slots=${windowed.length}`;
        return { ...r, timeSlots: slotsWithUrls, softVerified: false };
      }
    }
  } catch (e: any) {
    (globalThis as any).__yelpLambdaFetchDebug = `err=${e?.message?.substring(0, 80)}`;
  }

  // Strategy A (v37): load biz page, call SeatMe API via same-origin fetch
  //   → DataDome blocks the availability API even from within page context
  // Strategy B (v38): load biz page, inject iframe pointing to /reservations/ page.
  //   → iframe URL set correctly but textLen=0; SPA renders nothing because
  //     DataDome blocks the underlying SeatMe availability API calls.
  // Strategy C (v40): load /reservations/ URL directly in real Chrome.
  //   Better diagnostic: if DataDome blocks by IP, body text will contain challenge.
  //   If DataDome blocks by fingerprint, real Chrome might pass it.
  //   Either way we get richer diagnostics than textLen=0 from an iframe.
  const reservUrl = `https://www.yelp.com/reservations/${slug}?covers=${params.partySize}&date=${params.date}&time=${timeNoColon}`;
  const evalExpr  = `(async () => {
    // Wait for React + SeatMe widget to render (needs ~10s for API calls)
    await new Promise(r => setTimeout(r, 10000));
    const bodyText = document.body ? (document.body.innerText || '') : '';
    const finalUrl = window.location.href;
    // Look for time slot DOM elements first (fastest path)
    const timeEls = document.querySelectorAll('[data-testid*="time"], [class*="timeslot"], [class*="time-slot"], button[aria-label*="PM"], button[aria-label*="AM"], [class*="TimeSlot"], [class*="timeSlot"]');
    const fromEls = Array.from(timeEls).map(function(e){ return (e.textContent || e.getAttribute('aria-label') || '').trim(); }).filter(Boolean);
    if (fromEls.length) return 'dom:' + fromEls.join('\\n');
    // Fallback: scan innerText for time patterns
    const timeMatch = bodyText.match(/\\b(1[0-2]|[1-9]):[0-5][0-9]\\s*(am|pm|AM|PM)\\b/g);
    if (timeMatch && timeMatch.length > 0) return 'text:' + timeMatch.join('\\n');
    // Diagnostics: capture URL (redirect?) + body sample
    return 'diag:url=' + finalUrl.substring(0, 120) + ' textLen=' + bodyText.length + ' sample=' + bodyText.substring(0, 400);
  })()`;

  try {
    const text = await lambdaLoad(reservUrl, scraperUrl, scraperSecret, {
      waitMs:    500,    // minimal waitMs — evalExpr handles the actual 10s wait internally
      timeoutMs: 55_000, // 0.5s nav + 10s widget wait + overhead
      evalExpr,
    });
    // Capture for _debug regardless of outcome
    (globalThis as any).__yelpLambdaDebug = `direct_reserv|len=${text?.length ?? 0} sample=${(text ?? "").substring(0, 300)}`;
    if (!text || text.length < 5) {
      console.log(`[Yelp Lambda] ${r.name}: empty response`);
      return null;
    }

    // ── Path 1: API responded ────────────────────────────────────────────────
    const apiM = text.match(/^api_(\d+):([\s\S]*)$/);
    if (apiM) {
      const statusCode = apiM[1];
      const apiBody    = apiM[2];
      console.log(`[Yelp Lambda] ${r.name}: API ${statusCode} (len=${apiBody.length})`);
      if (statusCode !== "200") return null;

      const slots    = extractTimes(apiBody);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[Yelp Lambda] ${r.name}: API 200 but no slots in window — ${apiBody.substring(0, 200)}`);
        return null;
      }
      const base          = `https://www.yelp.com/reservations/${slug}`;
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
      console.log(`[Yelp Lambda] ${r.name}: ${windowed.length} slots via API ✓`);
      return { ...r, timeSlots: slotsWithUrls, softVerified: false };
    }

    // ── Path 2: DOM time elements found ─────────────────────────────────────
    const domM = text.match(/^dom:([\s\S]*)$/);
    if (domM) {
      const slots    = extractTimes(domM[1]);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[Yelp Lambda] ${r.name}: DOM elements found but no slots — ${domM[1].substring(0, 100)}`);
        return null;
      }
      const base          = `https://www.yelp.com/reservations/${slug}`;
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
      console.log(`[Yelp Lambda] ${r.name}: ${windowed.length} slots via DOM ✓`);
      return { ...r, timeSlots: slotsWithUrls, softVerified: false };
    }

    // ── Path 3: Neither prefix — unexpected (Cloudflare challenge on biz page?) ──
    console.log(`[Yelp Lambda] ${r.name}: unexpected response: ${text.substring(0, 200)}`);
    return null;
  } catch (err: any) {
    console.log(`[Yelp Lambda] ${r.name}: ${err?.message}`);
    return null;
  }
}

async function tryOTWidgetScrape(
  name: string, rid: string, params: SearchParams, fcKey: string
): Promise<Restaurant | null> {
  const dt        = `${params.date}T${params.time}`;
  const widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${rid}&covers=${params.partySize}&datetime=${dt}&styleid=5&disablegt=true`;
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: widgetUrl, formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 3500,
        timeout: 10000,
      }),
    });
    if (!resp.ok) { console.log(`[OT widget] ${name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 50) return null;
    if (/access denied|security check|enable javascript|are you a robot|just a moment/i.test(md)) {
      console.log(`[OT widget] ${name}: Akamai blocked`);
      return null;
    }
    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT widget] ${name}: no slots found (md len=${md.length})`);
      return null;
    }
    const baseOTUrl     = `https://www.opentable.com/r/${slugify(name)}`;
    const otBookingUrl  = addOTParams(baseOTUrl, params);
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", baseOTUrl, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[OT widget] ${name}: ${windowed.length} slots ✓ (rid=${rid})`);
    return {
      id:           `opentable-${rid}`,
      name,
      cuisine:      params.cuisine || "Restaurant",
      neighborhood: "",
      platform:     "opentable" as const,
      platformUrl:  otBookingUrl,
      timeSlots:    slotsWithUrls,
      distanceMiles: null,
      rating:       ratingM ? parseFloat(ratingM[1]) : undefined,
      reviewCount:  reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : undefined,
      _rid: rid,
    };
  } catch (err: any) {
    console.log(`[OT widget] ${name}: ${err?.message}`);
    return null;
  }
}

// ─── GEOCODING & RANKING ──────────────────────────────────────────────────────

async function geocodeAndRank(restaurants: Restaurant[], params: SearchParams): Promise<Restaurant[]> {
  if (restaurants.length === 0) return [];

  const userLat = params.lat;
  const userLng = params.lng;
  const geoCity = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const geoRegion = params.state || params.country;
  const bboxParam = (userLat != null && userLng != null)
    ? `&bbox=${(userLng-1.5).toFixed(4)},${(userLat-1.5).toFixed(4)},${(userLng+1.5).toFixed(4)},${(userLat+1.5).toFixed(4)}`
    : "";

  const needsGeo = restaurants.filter(r => r._lat == null && r._lng == null);
  if (needsGeo.length > 0) {
    await Promise.all(needsGeo.map(async r => {
      const feats = await photonSearch(`${r.name} ${geoCity} ${geoRegion}`, bboxParam, 3500);
      let best    = pickClosest(feats, userLat, userLng, 30);

      // Fallback: name-only + bbox
      if (!best && bboxParam) {
        const feats2 = await photonSearch(`${r.name} restaurant`, bboxParam, 2500);
        best = pickClosest(feats2, userLat, userLng, 30);
      }
      // Fallback: street address
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
      return feat; // no user coords — take first result
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
        // AI skipped this position — generate a minimal fallback so the card isn't blank
        if (!r.description) {
          const plat = r.platform === "resy" ? "Resy" : r.platform === "opentable" ? "OpenTable" : "Yelp";
          r.description = `${r.cuisine || "Contemporary"} restaurant accepting reservations via ${plat}.`;
        }
        if (!r.vibeTags || r.vibeTags.length === 0) r.vibeTags = [];
      }
    });
  } catch { /* optional */ }
  return restaurants;
}

// ─── FIRECRAWL SEARCH ─────────────────────────────────────────────────────────
// KEY FIX: removed scrapeOptions.formats — discovery only needs URL+title, not
// full markdown. Dropping markdown makes each search query 3-5x faster.

async function firecrawlSearch(queries: string[], fcKey: string, limit = 8): Promise<any[]> {
  const results: any[] = [];
  const seen            = new Set<string>();

  await Promise.all(queries.map(async (query) => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000); // per-query hard deadline
    try {
      const resp = await fetch(`${FC_API}/search`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal:  ctrl.signal,
        body:    JSON.stringify({ query, limit }), // no scrapeOptions — discovery needs URL/title only
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

function dedup(restaurants: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of restaurants) {
    const key = normName(r.name);
    if (!seen.has(key)) {
      seen.set(key, r);
    } else {
      const existing = seen.get(key)!;
      if (existing.platform === "yelp" && r.platform !== "yelp") seen.set(key, r);
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

function buildSlotUrl(platform: "resy"|"opentable"|"yelp", base: string, p: SearchParams, slotTime: string): string {
  const t24      = displayTo24(slotTime);
  const tNoColon = t24.replace(":", "");
  if (platform === "resy")      return `${base}?date=${p.date}&seats=${p.partySize}&time=${tNoColon}`;
  if (platform === "opentable") return `${base}?dateTime=${p.date}T${t24}&covers=${p.partySize}`;
  if (platform === "yelp")      return `${base}?covers=${p.partySize}&date=${p.date}&time=${tNoColon}`;
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
    .filter(x => x && Math.abs(x.mins - reqMins) <= 120)  // ±2h window; ±90min was cutting too many slots
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 6)    // show up to 6 slots (was 5)
    .sort((a, b) => a!.mins - b!.mins)
    .map(x => x!.slot);
}

function extractTimes(text: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen              = new Set<string>();

  // 12h format: "7:30 PM" / "7:30pm"
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

  // 24h format: "18:30"
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

function addOTParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("dateTime", `${p.date}T${p.time}`);
    u.searchParams.set("covers", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

function addYelpParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("covers", String(p.partySize));
    u.searchParams.set("date", p.date);
    u.searchParams.set("time", p.time.replace(":", ""));
    return u.toString();
  } catch { return base; }
}

function extractRid(url: string): string | null {
  const m = url.match(/[?&]rid=(\d+)/i) ?? url.match(/\/(\d{5,})/);
  return m ? m[1] : null;
}

function parseTimeFromDT(dt: string): string | null {
  const m = dt.match(/T(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mn = +m[2];
  return `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
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
    if (platform === "yelp") {
      t = t.replace(/\s*[-–]\s*[A-Za-z &']+(?:,\s*[A-Za-z &']+)+\s*$/, "").trim();
    }
    t = t.replace(/\s*[-–|]\s*$/, "").trim();
    if (t.length > 1) return t;
  }
  // Fallback: derive name from URL slug
  const parts = url.split("/");
  const rawSlug = (parts[parts.length - 1] || "restaurant").split("?")[0];
  // Decode %20 and other URL encoding before humanising
  const slug = decodeURIComponent(rawSlug);
  return slug
    .replace(/-\d+$/, "")   // strip trailing disambiguation numbers: "south-city-kitchen-2" → "south-city-kitchen"
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
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.slug;
  }
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.slug;
  }
  return slugify(city);
}

function resyCityName(city: string, _state: string, lat?: number, lng?: number): string {
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.name;
  }
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.name;
  }
  return city;
}
