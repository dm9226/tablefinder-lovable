import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";
// Yelp discovery now uses Firecrawl scraping instead of the Fusion API

interface SearchParams {
  cuisine: string;
  cuisineType: string;   // broad category: "seafood", "italian", "japanese", ""
  dishKeyword: string;   // specific dish/ingredient: "oysters", "lobster roll", ""
  date: string;
  time: string;
  partySize: number;
  city: string;
  state: string;
  country: string;       // "us" or "gb" — defaults to "us"
  lat?: number;
  lng?: number;
  userZip?: string;      // ZIP / postcode at the user's actual coords (for hyperlocal discovery)
  userLat?: number;      // The user's actual browser coords — used for distance ranking.
  userLng?: number;      // (params.lat/lng get overwritten to the city centroid by parseQuery.)
}

// ─── Dish-to-cuisine synonym map ───
// Maps specific dishes/ingredients to their parent cuisine categories.
// Used for discovery (adding parallel cuisine queries) and verification (two-tier relevance).
const DISH_TO_CUISINE_MAP: Record<string, string[]> = {
  // Seafood dishes
  oysters: ["seafood", "raw bar", "cajun", "southern", "french"],
  oyster: ["seafood", "raw bar", "cajun", "southern", "french"],
  shrimp: ["seafood", "cajun", "southern", "asian"],
  crab: ["seafood", "cajun", "southern", "maryland"],
  lobster: ["seafood", "new england", "american"],
  "lobster roll": ["seafood", "new england", "american"],
  clams: ["seafood", "new england", "italian"],
  mussels: ["seafood", "french", "belgian", "italian"],
  scallops: ["seafood", "french", "american"],
  calamari: ["seafood", "italian", "mediterranean"],
  "fish tacos": ["seafood", "mexican", "tex-mex"],
  poke: ["seafood", "hawaiian", "japanese"],
  ceviche: ["seafood", "peruvian", "latin", "mexican"],
  crawfish: ["seafood", "cajun", "southern"],
  // Japanese dishes
  sushi: ["japanese", "sushi bar", "asian"],
  sashimi: ["japanese", "sushi bar", "asian"],
  ramen: ["japanese", "asian", "noodle"],
  udon: ["japanese", "asian", "noodle"],
  tempura: ["japanese", "asian"],
  omakase: ["japanese", "sushi bar"],
  // Mexican/Latin dishes
  tacos: ["mexican", "tex-mex", "latin"],
  taco: ["mexican", "tex-mex", "latin"],
  "birria tacos": ["mexican", "tex-mex"],
  birria: ["mexican"],
  burrito: ["mexican", "tex-mex"],
  enchiladas: ["mexican", "tex-mex"],
  guacamole: ["mexican", "tex-mex", "latin"],
  quesadilla: ["mexican", "tex-mex"],
  // Italian dishes
  pasta: ["italian", "mediterranean"],
  pizza: ["italian", "pizzeria"],
  risotto: ["italian", "mediterranean"],
  lasagna: ["italian"],
  gnocchi: ["italian"],
  carbonara: ["italian"],
  tiramisu: ["italian"],
  // American/Steakhouse
  steak: ["steakhouse", "american", "chophouse"],
  "prime rib": ["steakhouse", "american"],
  burger: ["american", "burgers", "gastropub"],
  burgers: ["american", "burgers", "gastropub"],
  ribs: ["bbq", "barbecue", "american", "southern"],
  brisket: ["bbq", "barbecue", "texas", "southern"],
  wings: ["american", "bar food", "sports bar"],
  // Asian dishes
  "pad thai": ["thai", "asian"],
  curry: ["indian", "thai", "asian"],
  "dim sum": ["chinese", "cantonese", "asian"],
  dumplings: ["chinese", "asian", "japanese"],
  "pho": ["vietnamese", "asian"],
  "banh mi": ["vietnamese", "asian"],
  "bibimbap": ["korean", "asian"],
  "korean bbq": ["korean", "asian", "barbecue"],
  // Mediterranean/Middle Eastern
  falafel: ["mediterranean", "middle eastern", "israeli"],
  hummus: ["mediterranean", "middle eastern"],
  shawarma: ["mediterranean", "middle eastern"],
  kebab: ["mediterranean", "middle eastern", "turkish"],
  // Southern/Soul
  "fried chicken": ["southern", "soul food", "american"],
  "chicken and waffles": ["southern", "soul food", "brunch"],
  grits: ["southern", "soul food", "american"],
  gumbo: ["cajun", "creole", "southern"],
  jambalaya: ["cajun", "creole", "southern"],
  // French
  "foie gras": ["french", "fine dining"],
  "crème brûlée": ["french", "fine dining"],
  escargot: ["french", "fine dining"],
  crepes: ["french", "brunch"],
  // Other
  tapas: ["spanish", "mediterranean"],
  paella: ["spanish", "mediterranean"],
  "poke bowl": ["hawaiian", "japanese", "asian"],
};

// ─── State name → 2-letter code normalization ───
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",
  colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",
  hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",
  kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",
  massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",
  montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",
  ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI",
  "south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",
  vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",
  wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
};

function normalizeStateCode(state: string, country?: string): string {
  if (!state) return state;
  const trimmed = state.trim();
  // For UK, pass through region names as-is (e.g. "England", "Scotland", "London")
  if (country === "gb") return trimmed;
  // Already a 2-letter code
  if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  // Look up full name
  const code = STATE_NAME_TO_CODE[trimmed.toLowerCase()];
  return code || trimmed;
}

interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  imageUrl?: string;
  description?: string;
  vibeTags?: string[];
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: { time: string; type?: string }[];
  distanceMiles?: number | null;
  _address?: string; // transient: extracted from scraped page for geocoding
  _addressCity?: string; // transient: city from extracted address
  _yelpCategories?: string; // transient: Yelp API category text for cuisine relevance bypass
  _yelpCrossplatformGuess?: boolean; // transient: true if URL was guessed from name (not from link)
  _yelpSearchVerified?: boolean; // transient: true if time slots came from Yelp search results page (skip individual verification)
}

// ─── Provider Adapter Interface ───
interface ApiKeys {
  firecrawlKey: string;
  aiKey: string;
  _startTime?: number;
}

interface ProviderAdapter {
  platform: "resy" | "opentable" | "yelp";
  discover(params: SearchParams, keys: ApiKeys, amenityTerms: string[]): Promise<Restaurant[]>;
  verify(candidates: Restaurant[], params: SearchParams, keys: ApiKeys, amenityTerms: string[]): Promise<Restaurant[]>;
}

// Caching removed — all searches are fresh

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Global timeout: return partial results before the hard 150s edge function limit
  const GLOBAL_TIMEOUT_MS = 120_000;
  const globalAbort = new AbortController();
  const globalTimer = setTimeout(() => globalAbort.abort(), GLOBAL_TIMEOUT_MS);
  const startTime = Date.now();

  try {
    const body = await req.json();
    const { query, lat, lng, location, extended, remainingCandidates: incomingCandidates, extendedParams } = body;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");

    const keys: ApiKeys = { firecrawlKey: FIRECRAWL_API_KEY, aiKey: LOVABLE_API_KEY, _startTime: startTime };
    const adapters: ProviderAdapter[] = [resyAdapter, opentableAdapter, yelpAdapter];

    // ─── Extended Search Mode ───
    // Skips discovery and parsing; verifies remaining candidates from a previous search
    if (extended && incomingCandidates && extendedParams) {
      console.log(`[EXTENDED] Starting extended search with ${incomingCandidates.length} remaining candidates`);
      const params = extendedParams as SearchParams;
      // Re-stamp the user's true browser coords for distance ranking. Prefer fresh body coords;
      // fall back to whatever extendedParams already carries from the initial search.
      if (typeof lat === "number" && typeof lng === "number") {
        params.userLat = lat;
        params.userLng = lng;
      }
      console.log(`[EXTENDED] Coords received: lat=${lat}, lng=${lng} | userLat=${params.userLat}, userLng=${params.userLng}`);
      const amenityTerms = extractAmenityTerms(params.cuisine || "", query || "");

      // Verify a smaller balanced slice for extended searches so blocked OT candidates
      // cannot dominate the follow-up request budget.
      const toVerify = selectCandidatesForVerification((incomingCandidates as Restaurant[]), 12);
      const selectedIds = new Set(toVerify.map(r => r.name + r.platform));
      const leftover = (incomingCandidates as Restaurant[]).filter(c => !selectedIds.has(c.name + c.platform));

      let verified = (await Promise.all(
        adapters.map(a => a.verify(
          toVerify.filter((c: Restaurant) => c.platform === a.platform),
          params, keys, amenityTerms
        ))
      )).flat();
      console.log(`[EXTENDED] Verified: ${verified.length}/${toVerify.length}`);

      // Geocoding + enrichment (same as main flow)
      const elapsed = Date.now() - startTime;
      const skipEnrichment = elapsed > 110_000;
      const enrichmentPromise = skipEnrichment
        ? Promise.resolve(new Map<number, any>())
        : enrichWithAI(verified, LOVABLE_API_KEY, params, amenityTerms);

      const [, enrichmentMap] = await Promise.all([
        geocodeVerifiedResults(verified, params),
        enrichmentPromise,
      ]);

      // Distance is measured from the USER's coords when available, falling back to city centroid.
      const refLat = params.userLat ?? params.lat ?? 0;
      const refLng = params.userLng ?? params.lng ?? 0;
      console.log(
        params.userLat != null
          ? `[EXTENDED] Distance ref: user coords (${refLat}, ${refLng})`
          : `[EXTENDED] Distance ref: city centroid (${refLat}, ${refLng})`
      );
      for (let i = 0; i < verified.length; i++) {
        const e = enrichmentMap.get(i);
        if (!e) continue;
        const r = verified[i];
        r.rating = e.rating ?? r.rating;
        r.reviewCount = e.reviewCount ?? r.reviewCount;
        r.cuisine = e.cuisine || r.cuisine;
        r.description = e.description || r.description;
        r.vibeTags = e.vibeTags || r.vibeTags;
        r.priceRange = e.priceRange || r.priceRange;
        if (e.neighborhood && r.neighborhood === params.city) {
          r.neighborhood = e.neighborhood;
        }
        if (r.distanceMiles == null && typeof e.lat === "number" && typeof e.lng === "number" && refLat !== 0 && refLng !== 0) {
          const aiDist = +haversine(refLat, refLng, e.lat, e.lng).toFixed(1);
          if (aiDist <= 200) {
            r.distanceMiles = aiDist;
            if (e.neighborhood) r.neighborhood = e.neighborhood;
          }
        }
      }

      // Distance filter + sort
      const metroCity = getMetroCityName(params.city || "", params.state || "");
      const wasMetroNormalized = metroCity !== (params.city || "");
      // When we have the user's true coords, expand the cap — candidates were discovered from
      // the metro center, so a "close to me in suburbs" venue can read 20+ mi from city center.
      const hasUserCoords = params.userLat != null && params.userLng != null;
      const MAX_DISTANCE_MILES = hasUserCoords ? 25 : (wasMetroNormalized ? 30 : 15);
      const nearby = verified.filter((r) => {
        const d = r.distanceMiles;
        if (d === null || d === undefined) return true;
        return d <= MAX_DISTANCE_MILES;
      });
      const sorted = nearby.sort((a, b) => {
        const dA = a.distanceMiles ?? 9999;
        const dB = b.distanceMiles ?? 9999;
        if (Math.abs(dA - dB) > 0.5) return dA - dB;
        return (b.rating ?? 0) - (a.rating ?? 0);
      });

      const finalResults = cleanTransientFields(sorted);
      clearTimeout(globalTimer);
      return new Response(
        JSON.stringify({
          results: finalResults,
          params,
          hasMore: leftover.length > 0,
          remainingCandidates: leftover.length > 0 ? leftover : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Normal Search Flow ───

    // Step 1: Parse user query (always fresh)
    const t0 = Date.now();
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log(`[TIMING] parseQuery: ${Date.now() - t0}ms`);
    // Preserve the user's actual browser coords separately — parseQuery overwrites
    // params.lat/lng with the geocoded *city centroid*, which is wrong for distance ranking.
    if (typeof lat === "number" && typeof lng === "number") {
      params.userLat = lat;
      params.userLng = lng;
    }
    console.log(`Coords received: lat=${lat}, lng=${lng} | city centroid: ${params.lat},${params.lng}`);
    // Resolve user's ZIP from precise browser coords for hyperlocal discovery (Yelp find_loc, OT supplemental query).
    if (lat && lng && !params.userZip) {
      console.log(`Attempting reverse-geocode to ZIP for ${lat},${lng}...`);
      try {
        const zip = await reverseGeocodeToZip(lat, lng);
        if (zip) {
          params.userZip = zip;
          console.log(`User ZIP from coords: ${zip}`);
        } else {
          console.log(`Reverse-geocode returned empty ZIP for ${lat},${lng}`);
        }
      } catch (e) {
        console.log(`Reverse-geocode to ZIP failed: ${(e as Error).message}`);
      }
    } else if (!lat || !lng) {
      console.log(`Skipping ZIP resolution: no browser coords (lat=${lat}, lng=${lng})`);
    }
    console.log("Parsed params:", JSON.stringify(params));

    // Step 2: Discover candidates from all platforms via adapters
    const t1 = Date.now();

    // Detect amenity/experience keywords BEFORE discovery so we can add them to search queries
    const amenityTerms = extractAmenityTerms(params.cuisine || "", query);
    if (amenityTerms.length > 0) {
      console.log(`Amenity relevance filter active for: ${amenityTerms.join(", ")}`);
    }

    // Discovery with early termination: if it takes >40s, use whatever we have
    const DISCOVERY_TIMEOUT_MS = 45_000;
    const discoveryPromises = adapters.map(a => a.discover(params, keys, amenityTerms));
    const discoveryTimer = new Promise<null>(resolve => setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS));
    
    let discovered: Restaurant[][] = [];
    const raceResult = await Promise.race([
      Promise.all(discoveryPromises).then(r => ({ type: "complete" as const, results: r })),
      discoveryTimer.then(() => ({ type: "timeout" as const, results: null })),
    ]);

    if (raceResult.type === "complete") {
      discovered = raceResult.results;
    } else {
      console.warn(`Discovery timeout after ${DISCOVERY_TIMEOUT_MS}ms — using partial results`);
      // Collect whatever has resolved so far
      discovered = await Promise.all(
        discoveryPromises.map(p => Promise.race([p, Promise.resolve([] as Restaurant[])]))
      );
    }

    const allCandidates = dedupeByName(discovered.flat());
    console.log(`[TIMING] discovery: ${Date.now() - t1}ms`);

    // Log counts per platform
    const platformCounts = adapters.map((a, i) => `${a.platform}: ${discovered[i].length}`);
    console.log(`Candidates — ${platformCounts.join(", ")}, deduped: ${allCandidates.length}`);

    // Log ALL discovered candidate URLs per platform for diagnostics
    for (const platform of ["resy", "opentable", "yelp"] as const) {
      const urls = allCandidates.filter(c => c.platform === platform).map(c => (c as any).bookingUrl || c.name);
      console.log(`[DISCOVERY] ${platform} (${urls.length}): ${urls.join(" | ")}`);
    }

    // Step 3: Select candidates with round-robin balance, then verify per-adapter
    // Use fewer candidates for vague queries to avoid timeouts
    const isVagueQuery = !params.cuisineType && !params.dishKeyword;
    const maxCandidates = isVagueQuery ? 24 : 30;
    console.log(`Candidate cap: ${maxCandidates} (vague=${isVagueQuery})`);
    const selected = selectCandidatesForVerification(allCandidates, maxCandidates);
    const selectedCounts = selected.reduce((acc, r) => { acc[r.platform] = (acc[r.platform] || 0) + 1; return acc; }, {} as Record<string, number>);
    console.log(`Verifying (capped): total=${selected.length}, ${Object.entries(selectedCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);

    // Track remaining candidates for extended search
    const selectedIds = new Set(selected.map(r => r.name + r.platform));
    const remainingAfterSelection = allCandidates.filter(c => !selectedIds.has(c.name + c.platform));

    const t2 = Date.now();
    let verified = (await Promise.all(
      adapters.map(a => a.verify(
        selected.filter(c => c.platform === a.platform),
        params, keys, amenityTerms
      ))
    )).flat();
    // Dedupe cross-platform conversions (Yelp→OT/Resy may duplicate direct OT/Resy results)
    verified = dedupeByName(verified);
    console.log(`Verified available: ${verified.length}/${selected.length}`);
    console.log(`[TIMING] verification: ${Date.now() - t2}ms`);

    // Yelp fallback no longer needed — Yelp candidates are pre-verified from search page

    // Diagnostic: address extraction summary per platform
    for (const platform of ["resy", "opentable", "yelp"] as const) {
      const platResults = verified.filter(r => r.platform === platform);
      const withAddr = platResults.filter(r => r._address).length;
      const withoutAddr = platResults.filter(r => !r._address && r.platform !== "yelp").length;
      if (platResults.length > 0) {
        console.log(`[ADDR_SUMMARY] ${platform}: ${withAddr}/${platResults.length} have addresses${withoutAddr > 0 ? ` (${withoutAddr} missing)` : ""}`);
      }
    }

    // Step 3.5 + 4: Run geocoding and AI enrichment in parallel (no dependency)
    // Time-budget: skip enrichment if already past 30s to keep first response fast
    const elapsed = Date.now() - startTime;
    const skipEnrichment = elapsed > 30_000;
    if (skipEnrichment) {
      console.warn(`Skipping AI enrichment — already ${elapsed}ms elapsed`);
    }

    const t3 = Date.now();
    // Cap geocoding to 6s max
    const geocodePromise = Promise.race([
      geocodeVerifiedResults(verified, params),
      new Promise<void>(resolve => setTimeout(resolve, 6_000)),
    ]);
    // Cap enrichment to 6s max as well
    const rawEnrichmentPromise = skipEnrichment
      ? Promise.resolve(new Map<number, any>())
      : enrichWithAI(verified, LOVABLE_API_KEY, params, amenityTerms);
    const enrichmentPromise = Promise.race([
      rawEnrichmentPromise,
      new Promise<Map<number, any>>(resolve => setTimeout(() => resolve(new Map()), 6_000)),
    ]);

    const [, enrichmentMap] = await Promise.all([
      geocodePromise,
      enrichmentPromise,
    ]);
    console.log(`[TIMING] geocode+enrich: ${Date.now() - t3}ms`);

    // Merge AI enrichment onto the geocoded originals (preserves distanceMiles)
    // Distance is measured from the USER's coords when available, falling back to city centroid.
    const refLat = params.userLat ?? params.lat ?? 0;
    const refLng = params.userLng ?? params.lng ?? 0;
    console.log(
      params.userLat != null
        ? `Distance ref: user coords (${refLat}, ${refLng})`
        : `Distance ref: city centroid (${refLat}, ${refLng})`
    );
    for (let i = 0; i < verified.length; i++) {
      const e = enrichmentMap.get(i);
      if (!e) continue;
      const r = verified[i];
      r.rating = e.rating ?? r.rating;
      r.reviewCount = e.reviewCount ?? r.reviewCount;
      r.cuisine = e.cuisine || r.cuisine;
      r.description = e.description || r.description;
      r.vibeTags = e.vibeTags || r.vibeTags;
      r.priceRange = e.priceRange || r.priceRange;
      if (e.neighborhood && r.neighborhood === params.city) {
        r.neighborhood = e.neighborhood;
      }

      // AI coordinate fallback: fill distance for restaurants Nominatim missed
      if (r.distanceMiles == null && typeof e.lat === "number" && typeof e.lng === "number" && refLat !== 0 && refLng !== 0) {
        const aiDist = +haversine(refLat, refLng, e.lat, e.lng).toFixed(1);
        if (aiDist <= 200) {
          r.distanceMiles = aiDist;
          if (e.neighborhood) r.neighborhood = e.neighborhood;
          console.log(`  Geocoded (AI) ${r.name}: ${aiDist} mi (${r.neighborhood})`);
        } else {
          console.log(`  AI geocode sanity fail for ${r.name}: ${aiDist} mi — discarding`);
        }
      }
    }
    const geocodedCount = verified.filter(r => r.distanceMiles != null).length;
    console.log(`Final geocoding: ${geocodedCount}/${verified.length} restaurants have distances`);
    console.log(`[TIMING] total: ${Date.now() - startTime}ms`);

    // Apply distance filtering
    const metroCity = getMetroCityName(params.city || "", params.state || "");
    const wasMetroNormalized = metroCity !== (params.city || "");
    const hasUserCoords = params.userLat != null && params.userLng != null;
    const MAX_DISTANCE_MILES = hasUserCoords ? 25 : (wasMetroNormalized ? 30 : 15);
    const nearby = verified.filter((r) => {
      const d = r.distanceMiles;
      if (d === null || d === undefined) return true;
      return d <= MAX_DISTANCE_MILES;
    });
    const sorted = nearby.sort((a, b) => {
      const dA = a.distanceMiles ?? 9999;
      const dB = b.distanceMiles ?? 9999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });

    // Clean transient fields before returning
    const finalResults = cleanTransientFields(sorted);

    clearTimeout(globalTimer);
    const hasMore = remainingAfterSelection.length > 0;
    console.log(`[RESPONSE] ${finalResults.length} results, hasMore=${hasMore} (${remainingAfterSelection.length} remaining candidates)`);
    try {
      const responseBody = JSON.stringify({
        results: finalResults,
        params,
        cached: false,
        hasMore,
        remainingCandidates: hasMore ? remainingAfterSelection : undefined,
      });
      return new Response(responseBody, {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (jsonErr) {
      console.error("JSON.stringify failed:", jsonErr);
      return new Response(
        JSON.stringify({ results: [], params, cached: false, hasMore: false, error: "Response serialization failed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (e) {
    clearTimeout(globalTimer);

    // If global timeout fired, return empty results gracefully
    if (globalAbort.signal.aborted) {
      console.error("Global timeout reached (120s) — returning empty results");
      return new Response(
        JSON.stringify({ results: [], params: {}, cached: false, error: "Search timed out. Please try a more specific query." }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const message = e instanceof Error ? e.message : "Search failed";
    const isInputError =
      message.includes("Please include") ||
      message.includes("Multiple locations found");

    console.error("Search error:", e);

    // Input/clarification errors should not surface as 500 runtime failures.
    if (isInputError) {
      return new Response(
        JSON.stringify({ error: message, needsClarification: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: message }),
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
User browser location (FALLBACK ONLY): ${location || "unknown"}
Browser coordinates (FALLBACK ONLY): lat=${lat || "unknown"}, lng=${lng || "unknown"}

CALENDAR for next 14 days:
${dateRef.join("\n")}

DEFAULTS (apply when the user does NOT specify):
- Date: today (${now.toISOString().split("T")[0]})
- Time: "19:00" (dinner tonight)
- Party size: 2
- Location: use browser coordinates / reverse-geocoded city (see below)
The user can override ANY default by mentioning it. Examples:
- "mexican" → date: today, time: 19:00, partySize: 2, city: from browser
- "mexican for 4" → date: today, time: 19:00, partySize: 4, city: from browser
- "mexican Saturday" → date: this Saturday, time: 19:00, partySize: 2, city: from browser
- "mexican in Decatur" → date: today, time: 19:00, partySize: 2, city: "Decatur"

Rules:
- "today" or "tonight" = ${now.toISOString().split("T")[0]}
- "tomorrow" = the day AFTER today
- If no date is mentioned at all, default to today (${now.toISOString().split("T")[0]})
- **CRITICAL**: If the user explicitly names a city or location in their query (e.g. "Athens, GA", "near Savannah", "in Chicago"), ALWAYS use that city. NEVER override it with the browser location. The browser location is ONLY a fallback when the user does NOT mention any location at all.
- Only convert small neighborhoods/suburbs to their parent metro city (e.g. "North Druid Hills" => "Atlanta", "Brooklyn" => "New York"). Do NOT convert independent cities to other cities — Athens GA is NOT a suburb of Atlanta, Savannah is NOT Atlanta, etc.
- dinner/tonight defaults to time "19:00", lunch = "12:00", breakfast = "08:00", brunch = "10:30"
- If the user mentions a meal type (breakfast, brunch, lunch, dinner), use the corresponding default time above
- If no meal or time is mentioned, default to "19:00"
- IMPORTANT: "brunch" is BOTH a meal time AND a cuisine/experience. When the user says "brunch", set time to "10:30" AND set cuisine to "brunch" (so results include brunch-specific restaurants and menus). Same for "breakfast" — set cuisine to "breakfast" in addition to the time.
- If the user says something like "brunch Italian", set cuisine to "brunch italian" to capture both the meal style and food preference.
- If the user provides a US zip code (5-digit number) or UK postcode (e.g. "SW1A 1AA", "EC2R 8AH", "M1 1AA"), put it in the "zipCode" field and leave city/state empty. We will geocode it separately.
- COUNTRY DETECTION: Detect whether the user is searching in the US or UK.
  - Return country: "gb" for UK cities (London, Manchester, Edinburgh, Birmingham, Liverpool, Glasgow, Bristol, Leeds, Sheffield, Oxford, Cambridge, Brighton, Cardiff, Belfast, Newcastle, Nottingham, Bath, York, etc.) or UK postcodes.
  - Return country: "us" for US cities, US state codes, or US zip codes.
  - Default to "us" if ambiguous.
  - For UK searches, use "state" for the country/region (e.g. "England", "Scotland", "Wales", "Northern Ireland").

IMPORTANT — Cuisine type vs. dish keyword classification:
You MUST distinguish between a CUISINE TYPE (broad restaurant category) and a DISH KEYWORD (specific menu item or ingredient).
- cuisineType: The broad restaurant category that would serve this food. Examples: "seafood", "italian", "japanese", "steakhouse", "mexican", "thai", "indian", "southern", "french". Leave empty if no cuisine is implied.
- dishKeyword: A specific dish, preparation, or ingredient the user is searching for. Examples: "oysters", "lobster roll", "birria tacos", "sushi", "ramen", "steak", "fried chicken". Leave empty if the user is searching by cuisine category, not a specific dish.

Classification examples:
- "seafood near Decatur" → cuisineType: "seafood", dishKeyword: ""
- "oysters tonight Atlanta" → cuisineType: "seafood", dishKeyword: "oysters"
- "Italian for 2" → cuisineType: "italian", dishKeyword: ""
- "birria tacos Friday" → cuisineType: "mexican", dishKeyword: "birria tacos"
- "steakhouse near Decatur" → cuisineType: "steakhouse", dishKeyword: ""
- "steak dinner" → cuisineType: "steakhouse", dishKeyword: "steak"
- "sushi tonight" → cuisineType: "japanese", dishKeyword: "sushi"
- "ramen near me" → cuisineType: "japanese", dishKeyword: "ramen"
- "Thai food Saturday" → cuisineType: "thai", dishKeyword: ""
- "fried chicken Atlanta" → cuisineType: "southern", dishKeyword: "fried chicken"
- "dinner for 4" → cuisineType: "", dishKeyword: ""

Return JSON:
- cuisine: string ("" if unspecified — but include meal type like "brunch" or "breakfast" when mentioned. Also include specific dish/ingredient names like "oysters", "sushi", "steak", "tacos", etc.)
- cuisineType: string (broad restaurant category, "" if none)
- dishKeyword: string (specific dish/ingredient, "" if none)
- date: YYYY-MM-DD
- time: HH:MM (24h)
- partySize: number (default 2)
- city: major city string (empty if zip code provided instead)
- state: 2-letter US state code OR UK region (e.g. "England", "Scotland") (empty if zip code provided instead)
- country: "us" or "gb" (default "us")
- zipCode: string (5-digit US zip code or UK postcode if provided, "" otherwise)

User query: "${query}"`;

  const requestBody = {
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
            cuisineType: { type: "string", description: "Broad restaurant category (e.g. seafood, italian, japanese). Empty if none." },
            dishKeyword: { type: "string", description: "Specific dish or ingredient (e.g. oysters, sushi, steak). Empty if none." },
            date: { type: "string" },
            time: { type: "string" }, partySize: { type: "number" },
            city: { type: "string" }, state: { type: "string" },
            country: { type: "string", description: "Country code: 'us' or 'gb'. Default 'us'." },
            zipCode: { type: "string" },
          },
          required: ["cuisine", "cuisineType", "dishKeyword", "date", "time", "partySize", "city", "state"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "extract_search_params" } },
  };
  const aiHeaders = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  let aiResp = await fetch(AI_GATEWAY, {
    method: "POST",
    headers: aiHeaders,
    body: JSON.stringify(requestBody),
  });

  if (!aiResp.ok) throw new Error("Failed to parse search query");
  let respText = await aiResp.text();

  // Retry once if AI gateway returned empty/truncated response
  if (!respText || respText.length < 10) {
    console.warn("AI gateway returned empty response, retrying once...");
    const retryResp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: aiHeaders,
      body: JSON.stringify(requestBody),
    });
    if (!retryResp.ok) throw new Error("Search temporarily unavailable. Please try again.");
    respText = await retryResp.text();
    if (!respText || respText.length < 10) {
      throw new Error("Search temporarily unavailable. Please try again.");
    }
  }

  let aiData;
  try { aiData = JSON.parse(respText); }
  catch { throw new Error("Search temporarily unavailable. Please try again."); }
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Failed to parse search query");

  const parsed = JSON.parse(toolCall.function.arguments) as SearchParams;
  parsed.country = ((parsed as any).country || "us").toLowerCase().trim();
  if (parsed.country !== "gb") parsed.country = "us"; // Only us and gb supported

  // ─── Deterministic UK city safety net ───
  // The AI parser occasionally misclassifies well-known UK cities as country="us".
  // If the parsed city matches a major UK city AND no US state was provided,
  // force country="gb". This prevents the disambiguation error against US homonyms
  // (e.g. London, KY / London, OH).
  const UK_MAJOR_CITIES = new Set([
    "london", "manchester", "edinburgh", "birmingham", "liverpool", "glasgow",
    "bristol", "leeds", "sheffield", "oxford", "cambridge", "brighton",
    "cardiff", "belfast", "newcastle", "nottingham", "bath", "york",
    "southampton", "portsmouth", "leicester", "coventry", "reading", "aberdeen",
    "dundee", "swansea", "norwich", "exeter", "bournemouth", "plymouth",
  ]);
  const cityLowerForUK = ((parsed as any).city || "").trim().toLowerCase();
  const stateRawForUK = ((parsed as any).state || "").trim();
  const looksLikeUSState = /^[A-Z]{2}$/.test(stateRawForUK) && stateRawForUK !== "UK";
  if (parsed.country === "us" && UK_MAJOR_CITIES.has(cityLowerForUK) && !looksLikeUSState) {
    console.log(`UK city safety net: reclassifying "${parsed.city}" as country="gb" (was "us")`);
    parsed.country = "gb";
  }
  
  // Normalize cuisineType and dishKeyword
  parsed.cuisineType = (parsed.cuisineType || "").trim().toLowerCase();
  parsed.dishKeyword = (parsed.dishKeyword || "").trim().toLowerCase();
  
  // ─── Post-parse amenity correction ───
  // Fix misparsing like "rooftop bar" → cuisine="bar", dish="rooftop"
  // or "rooftop restaurant" → dish="rooftop"
  const AMENITY_TERMS_SET = new Set(["rooftop", "patio", "outdoor", "waterfront", "live music", "private dining", "happy hour"]);
  const VENUE_TYPE_CUISINE = new Set(["bar", "lounge", "pub", "club", "restaurant", "dining"]);
  
  // If dishKeyword is an amenity term, it was misparsed — clear it
  if (AMENITY_TERMS_SET.has(parsed.dishKeyword)) {
    console.log(`Amenity correction: clearing dishKeyword "${parsed.dishKeyword}" (amenity, not a dish)`);
    parsed.dishKeyword = "";
  }
  
  // If cuisineType is a generic venue type (bar, lounge) and query mentions an amenity,
  // clear cuisineType so discovery searches broadly with the amenity term
  if (VENUE_TYPE_CUISINE.has(parsed.cuisineType)) {
    const qLower = query.toLowerCase();
    for (const amenity of AMENITY_TERMS_SET) {
      if (qLower.includes(amenity)) {
        console.log(`Amenity correction: clearing cuisineType "${parsed.cuisineType}" — amenity "${amenity}" drives discovery`);
        parsed.cuisineType = "";
        // Put the venue type into cuisine so it still appears in search terms
        if (!parsed.cuisine.toLowerCase().includes(amenity)) {
          parsed.cuisine = `${amenity} ${parsed.cuisine}`.trim();
        }
        break;
      }
    }
  }
  
  // Post-parse cleanup: if user explicitly used a category term (e.g. "steakhouse"),
  // clear dishKeyword so we use strict category matching, not loose dish matching
  const CATEGORY_ROOTS: Record<string, string> = {
    steakhouse: "steak", chophouse: "steak", pizzeria: "pizza",
    "sushi bar": "sushi", "sushi restaurant": "sushi",
  };
  if (parsed.cuisineType && parsed.dishKeyword) {
    const root = CATEGORY_ROOTS[parsed.cuisineType];
    if (root && parsed.dishKeyword === root && query.toLowerCase().includes(parsed.cuisineType)) {
      console.log(`Clearing dishKeyword "${parsed.dishKeyword}" — user said "${parsed.cuisineType}" (category search)`);
      parsed.dishKeyword = "";
    }
  }

  // If AI didn't classify but we can infer from DISH_TO_CUISINE_MAP
  if (!parsed.cuisineType && parsed.dishKeyword) {
    const mapped = DISH_TO_CUISINE_MAP[parsed.dishKeyword];
    if (mapped && mapped.length > 0) {
      parsed.cuisineType = mapped[0]; // Use first (most likely) parent cuisine
      console.log(`Inferred cuisineType "${parsed.cuisineType}" from dishKeyword "${parsed.dishKeyword}"`);
    }
  }
  
  console.log(`Intent classification — cuisineType: "${parsed.cuisineType}", dishKeyword: "${parsed.dishKeyword}"`);

  console.log(`Intent classification — cuisineType: "${parsed.cuisineType}", dishKeyword: "${parsed.dishKeyword}"`);
  const INVALID_CITY = new Set(["unknown", "n/a", "none", "unspecified", ""]);
  parsed.city = INVALID_CITY.has((parsed.city || "").trim().toLowerCase()) ? "" : parsed.city?.trim() || "";
  parsed.state = INVALID_CITY.has((parsed.state || "").trim().toLowerCase()) ? "" : parsed.state?.trim() || "";

  // Strip embedded state suffix from city (AI sometimes returns "North Druid Hills, GA")
  const citySuffix = parsed.city.match(/^(.+),\s*([A-Z]{2})$/);
  if (citySuffix) {
    parsed.city = citySuffix[1].trim();
    if (!parsed.state) parsed.state = citySuffix[2];
  }
  parsed.state = normalizeStateCode(parsed.state, parsed.country);

  // Parse browser location string for reliable city/state
  let browserCity = "";
  let browserState = "";
  let cityFromBrowser = false;
  if (location) {
    // US format: "City, ST"  UK format: "City, England" or "London, UK"
    const locMatch = location.match(/^(.+),\s*([A-Z]{2})$/);
    const locMatchUK = location.match(/^(.+),\s*(England|Scotland|Wales|Northern Ireland|UK)$/i);
    if (locMatch) {
      browserCity = locMatch[1].trim();
      browserState = locMatch[2].trim();
    } else if (locMatchUK) {
      browserCity = locMatchUK[1].trim();
      browserState = locMatchUK[2].trim();
      if (parsed.country === "us") parsed.country = "gb"; // auto-detect UK from browser
    }
  }

  // If AI returned the same city the browser detected but no state, trust the browser state/coords.
  if (
    browserCity &&
    browserState &&
    parsed.city &&
    !parsed.state &&
    normalizePlaceToken(parsed.city) === normalizePlaceToken(browserCity)
  ) {
    parsed.state = browserState;
    if (lat && lng) {
      parsed.lat = lat;
      parsed.lng = lng;
    }
    cityFromBrowser = true;
    console.log(`Adopted browser state for ambiguous city: ${parsed.city}, ${parsed.state}`);
  }

  // Handle zip code: geocode to city/state/coords
  const zipCode = (parsed as any).zipCode?.trim() || "";
  const isUKPostcode = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(zipCode);
  const isUSZip = /^\d{5}$/.test(zipCode);
  if (zipCode && (isUSZip || isUKPostcode) && !parsed.city) {
    const zipCountry = isUKPostcode ? "gb" : "us";
    if (isUKPostcode) parsed.country = "gb";
    try {
      const zipResp = await fetch(
        `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zipCode)}&country=${zipCountry}&format=json&limit=1&addressdetails=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const zipData = await zipResp.json();
      if (zipData && zipData.length > 0) {
        const addr = zipData[0].address;
        // Prefer city/town/village over county — county names like "DeKalb County"
        // don't work well with platform searches (Resy, OpenTable, Yelp)
        let resolvedCity = addr?.city || addr?.town || addr?.village || "";
        parsed.state = normalizeStateCode(extractStateCode(addr) || addr?.state || parsed.state, parsed.country);
        parsed.lat = parseFloat(zipData[0].lat);
        parsed.lng = parseFloat(zipData[0].lon);

        // If only county was found, reverse-geocode the coordinates to get the nearest city
        if (!resolvedCity && (addr?.county || "")) {
          try {
            const revResp = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${parsed.lat}&lon=${parsed.lng}&format=json&zoom=16&addressdetails=1`,
              { headers: { "User-Agent": "TableFinder/1.0" } }
            );
            const revData = await revResp.json();
            resolvedCity = revData.address?.city || revData.address?.town || revData.address?.village || revData.address?.suburb || "";
            console.log(`Zip ${zipCode} county "${addr.county}" reverse-geocoded to city: ${resolvedCity}`);
          } catch {
            // Fall back to county name if reverse geocode fails
            resolvedCity = addr.county || "";
          }
        }

        parsed.city = resolvedCity || addr?.county || "";
        console.log(`Zip ${zipCode} resolved to: ${parsed.city}, ${parsed.state}`);
      }
    } catch (e) {
      console.error("Zip geocoding failed:", e);
    }
  }

  // If city is still empty, use browser-provided location directly (no redundant Nominatim call)
  if (!parsed.city) {
    if (browserCity && browserState) {
      parsed.city = browserCity;
      parsed.state = browserState;
      parsed.lat = lat;
      parsed.lng = lng;
      cityFromBrowser = true;
      console.log(`City from browser location string: ${parsed.city}, ${parsed.state} (using precise coords ${lat},${lng})`);
    } else if (lat && lng) {
      // Last resort: reverse-geocode from coords (only if no parsed location string)
      try {
        const revResp = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
          { headers: { "User-Agent": "TableFinder/1.0" } }
        );
        const revData = await revResp.json();
        parsed.city = revData.address?.city || revData.address?.town || revData.address?.village || revData.address?.suburb || "";
        parsed.state = normalizeStateCode(revData.address?.state_code || revData.address?.state || "", parsed.country);
        if (parsed.city) {
          cityFromBrowser = true;
          parsed.lat = lat;
          parsed.lng = lng;
          console.log(`City from reverse-geocode: ${parsed.city}, ${parsed.state} (coords ${lat},${lng})`);
        }
      } catch { /* leave empty */ }
    }
    if (!parsed.city) {
      throw new Error("Please include a city or postcode in your search (e.g. 'rooftop dining Friday Decatur GA', 'sushi tonight 30030', or 'Italian London') so we can find the right location.");
    }
  }

  // Skip city geocoding if zip code already resolved coordinates
  const resolvedViaZip = zipCode && (isUSZip || isUKPostcode) && parsed.lat && parsed.lng;

  const hasExplicitState = hasExplicitStateInQuery(query);

  // Geocode city name (without trusting AI-guessed state) for disambiguation and coordinates.
  let cityGeoResults: any[] = [];
  if (!resolvedViaZip) {
    try {
      const countryCode = parsed.country === "gb" ? "gb" : "us";
      const geoCheck = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.city)}&format=json&limit=12&addressdetails=1&countrycodes=${countryCode}`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      cityGeoResults = await geoCheck.json();
    } catch {
      cityGeoResults = [];
    }
  }

  const cityNorm = normalizePlaceToken(parsed.city);
  const candidates = (cityGeoResults || [])
    .map((r: any) => {
      const stateCode = extractStateCode(r.address);
      const locality = extractLocalityName(r.address);
      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        stateCode,
        locality,
        localityNorm: normalizePlaceToken(locality),
        type: `${r.class || ""}/${r.type || ""}`.toLowerCase(),
      };
    })
    .filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && (!!c.stateCode || parsed.country === "gb"))
    .filter((c: any) => {
      // Prefer true locality matches; avoid county-only matches when possible.
      if (!c.localityNorm) return false;
      return c.localityNorm === cityNorm;
    });

  const usableCandidates = candidates.length > 0
    ? candidates
    : (cityGeoResults || [])
        .map((r: any) => ({
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lon),
          stateCode: extractStateCode(r.address),
          locality: extractLocalityName(r.address),
          localityNorm: normalizePlaceToken(extractLocalityName(r.address)),
          type: `${r.class || ""}/${r.type || ""}`.toLowerCase(),
        }))
        .filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && (!!c.stateCode || parsed.country === "gb"));

  const distinctStates = [...new Set(usableCandidates.map((c: any) => c.stateCode))];

  // If user did NOT explicitly include a state, do NOT guess for ambiguous cities.
  // UK cities are generally unambiguous within GB, so skip disambiguation for UK.
  if (parsed.country === "gb") {
    // For UK, just take the first result's state code
    if (distinctStates.length >= 1 && !parsed.state) {
      parsed.state = distinctStates[0];
    }
  } else if (!hasExplicitState && !cityFromBrowser) {
    if (distinctStates.length > 1) {
      // If browser told us the state and it's among the candidate states, trust it.
      if (browserState && distinctStates.includes(browserState.toUpperCase())) {
        parsed.state = browserState.toUpperCase();
      } else {
      const options = [...new Set(usableCandidates.map((c: any) => `${parsed.city}, ${c.stateCode}`))].slice(0, 4);
      throw new Error(`Multiple locations found for "${parsed.city}". Please include the state or zip code — e.g. ${options.join(" or ")}.`);
      }
    } else if (distinctStates.length === 1) {
      parsed.state = distinctStates[0];
    }
  } else if (!parsed.state && distinctStates.length === 1) {
    parsed.state = distinctStates[0];
  }

  parsed.cuisine = parsed.cuisine?.trim() || "";
  parsed.time = /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : "19:00";
  parsed.partySize = Number(parsed.partySize) > 0 ? Number(parsed.partySize) : 2;

  // Coordinates should represent the searched city (for distance filtering), not browser position.
  const stateFiltered = parsed.state
    ? usableCandidates.filter((c: any) => c.stateCode === parsed.state.toUpperCase())
    : usableCandidates;

  const cityTypeRank = (type: string): number => {
    if (type.includes("place/city")) return 1;
    if (type.includes("place/town")) return 2;
    if (type.includes("place/village")) return 3;
    if (type.includes("boundary/administrative")) return 4;
    return 5;
  };

  const candidatePool = stateFiltered.length > 0 ? stateFiltered : usableCandidates;
  let selectedCandidate = (candidatePool.sort((a: any, b: any) => cityTypeRank(a.type) - cityTypeRank(b.type))[0]) || null;

  // Distance origin selection:
  //   1. If user has precise browser coords AND parsed city matches detected city → use the user's actual coords.
  //      (Handles unincorporated areas / suburbs where city centroid is far from the user.)
  //   2. Else if a candidate centroid is available → use it (user typed a different city than detected).
  //   3. Else fall back to whatever browser coords we have.
  const parsedMatchesBrowser =
    !!browserCity &&
    !!parsed.city &&
    normalizePlaceToken(parsed.city) === normalizePlaceToken(browserCity);

  if (lat && lng && (cityFromBrowser || parsedMatchesBrowser)) {
    parsed.lat = lat;
    parsed.lng = lng;
    console.log(`Distance origin: user coords (${lat.toFixed(4)}, ${lng.toFixed(4)}) for ${parsed.city}, ${parsed.state}`);
  } else if (selectedCandidate) {
    parsed.lat = selectedCandidate.lat;
    parsed.lng = selectedCandidate.lng;
    console.log(`Distance origin: city centroid (${selectedCandidate.lat.toFixed(4)}, ${selectedCandidate.lng.toFixed(4)}) for ${parsed.city}, ${parsed.state}`);
  }

  // Last fallback to browser coordinates.
  if (!parsed.lat && lat) parsed.lat = lat;
  if (!parsed.lng && lng) parsed.lng = lng;

  return parsed;
}

const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia"
];

const STATE_CODE_AFTER_COMMA = /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;
const STATE_CODE_STANDALONE_SAFE = /\b(al|ak|az|ar|ca|co|ct|de|fl|ga|id|il|ia|ks|ky|la|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;
function normalizePlaceToken(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

async function reverseGeocodeToZip(lat: number, lng: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "TableFinder/1.0" }, signal: ctrl.signal }
    );
    const data = await resp.json();
    const postcode: string = data?.address?.postcode || "";
    // For US, return only the 5-digit base ZIP (Yelp/OT prefer this).
    const usZip = postcode.match(/^(\d{5})/);
    if (usZip) return usZip[1];
    // For UK, return the full postcode.
    if (/^[A-Z]{1,2}\d/i.test(postcode)) return postcode.toUpperCase();
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function extractStateCode(address: any): string {
  const fromStateCode = address?.state_code;
  if (fromStateCode && typeof fromStateCode === "string") return fromStateCode.toUpperCase();

  const iso = address?.["ISO3166-2-lvl4"];
  if (iso && typeof iso === "string" && iso.includes("-")) {
    return iso.split("-")[1]?.toUpperCase() || "";
  }

  return "";
}

function extractLocalityName(address: any): string {
  return address?.city
    || address?.town
    || address?.village
    || address?.hamlet
    || address?.municipality
    || address?.county
    || "";
}

function hasExplicitStateInQuery(query: string): boolean {
  const q = (query || "").toLowerCase();

  if (STATE_CODE_AFTER_COMMA.test(q)) {
    return true;
  }

  // Detect safe standalone two-letter state codes (e.g. "decatur ga").
  if (STATE_CODE_STANDALONE_SAFE.test(` ${q.replace(/[^a-z\s]/g, " ")} `)) {
    return true;
  }

  const padded = ` ${q.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ")} `;
  return US_STATE_NAMES.some((state) => padded.includes(` ${state} `));
}

// ─── Firecrawl web search for Resy / OpenTable ───

interface FirecrawlResult {
  url: string;
  title?: string;
  description?: string;
}

async function searchFirecrawl(
  params: SearchParams, firecrawlKey: string, platform: "resy" | "opentable" | "yelp",
  amenityTerms: string[] = []
): Promise<FirecrawlResult[]> {
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const city = params.city;
  const state = params.state || "";
  // Use metro city name for OT/Yelp Firecrawl queries — tiny CDPs return no results
  const metroCityName = getMetroCityName(city, state);
  // For UK, use "City UK" instead of "City STATE_CODE"
  const cityState = params.country === "gb" 
    ? `${metroCityName} UK` 
    : (state ? `${metroCityName} ${state}` : metroCityName);
  const resyCitySlug = getResyCitySlug(params);

  // Build amenity search suffix for dedicated discovery queries
  const amenitySuffix = amenityTerms.length > 0 ? ` ${amenityTerms.join(" ")}` : "";

  // For Resy, use the metro city name in the search text (not suburb/county)
  const resyMetroName = getResyMetroCityName(params);

  // DISH-AWARE DISCOVERY: When the user searched for a specific dish (e.g. "oysters"),
  // add parallel queries using the parent cuisine type (e.g. "seafood") to improve recall.
  // This is critical for platforms like Resy where venue pages may not mention specific dishes
  // but DO mention their cuisine category.
  const hasDishKeyword = !!params.dishKeyword;
  const parentCuisineType = params.cuisineType || "";
  const cuisineTypeSuffix = parentCuisineType ? ` ${parentCuisineType}` : "";
  // Only add cuisine-type queries if it differs from what's already in the cuisine field
  const needsCuisineTypeQuery = hasDishKeyword && parentCuisineType && 
    !cuisine.toLowerCase().includes(parentCuisineType);

  const queries = platform === "resy"
    ? [
        `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName} best rated${cuisine} restaurant`,
        `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName} top${cuisine} reservation`,
        // Dish-aware: add parent cuisine type query for better Resy recall
        ...(needsCuisineTypeQuery ? [
          `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${cuisineTypeSuffix} restaurant reservation`,
        ] : []),
        ...(amenitySuffix ? [`site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${amenitySuffix} restaurant`] : []),
      ]
    : platform === "opentable"
    ? (() => {
        const isUK = params.country === "gb";
        const otSite = isUK ? "site:opentable.co.uk/r" : "site:opentable.com/r";
        return [
          `${otSite} ${cityState} best rated${cuisine} restaurant`,
          `${otSite} ${cityState} top${cuisine} restaurant reservation`,
          // Hyperlocal supplemental query using user's ZIP — surfaces ZIP-local OT venues that metro queries miss.
          ...(params.userZip && !isUK ? [
            `${otSite} ${params.userZip}${cuisine} restaurant reservation`,
          ] : []),
          ...(needsCuisineTypeQuery ? [
            `${otSite} ${cityState}${cuisineTypeSuffix} restaurant reservation`,
          ] : []),
          ...(amenitySuffix ? [`${otSite} ${cityState}${amenitySuffix} restaurant reservation`] : []),
        ];
      })()
    : [
        `site:yelp.com/reservations ${cityState}${cuisine} restaurant`,
        `site:yelp.com/reservations ${cityState} best rated${cuisine} restaurant`,
        `site:yelp.com/reservations ${cityState} find open tables${cuisine}`,
        ...(needsCuisineTypeQuery ? [
          `site:yelp.com/reservations ${cityState}${cuisineTypeSuffix} restaurant`,
        ] : []),
        ...(amenitySuffix ? [`site:yelp.com/reservations ${cityState}${amenitySuffix} restaurant`] : []),
      ];

  if (hasDishKeyword) {
    console.log(`Firecrawl ${platform} queries (dish-aware, dish="${params.dishKeyword}", cuisineType="${parentCuisineType}"):`, JSON.stringify(queries));
  } else {
    console.log(`Firecrawl ${platform} queries:`, JSON.stringify(queries));
  }

  const results = await Promise.all(
    queries.map(async (query) => {
      try {
        const resp = await fetch(`${FIRECRAWL_API}/search`, {
          method: "POST",
          headers: { Authorization: `Bearer ${firecrawlKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, limit: 12 }),
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

// Map suburbs, counties, and neighborhoods to their Resy metro city slug.
// Resy organizes restaurants by major metro, not by suburb/county.
const RESY_METRO_MAP: Record<string, string> = {
  // Atlanta metro
  "dekalb county|ga": "atlanta",
  "decatur|ga": "atlanta",
  "scottdale|ga": "atlanta",
  "avondale estates|ga": "atlanta",
  "clarkston|ga": "atlanta",
  "north druid hills|ga": "atlanta",
  "druid hills|ga": "atlanta",
  "dunwoody|ga": "atlanta",
  "sandy springs|ga": "atlanta",
  "roswell|ga": "atlanta",
  "alpharetta|ga": "atlanta",
  "marietta|ga": "atlanta",
  "smyrna|ga": "atlanta",
  "brookhaven|ga": "atlanta",
  "buckhead|ga": "atlanta",
  "midtown|ga": "atlanta",
  "east point|ga": "atlanta",
  "college park|ga": "atlanta",
  "stone mountain|ga": "atlanta",
  "tucker|ga": "atlanta",
  "chamblee|ga": "atlanta",
  "doraville|ga": "atlanta",
  "kennesaw|ga": "atlanta",
  "lawrenceville|ga": "atlanta",
  "duluth|ga": "atlanta",
  "johns creek|ga": "atlanta",
  "peachtree city|ga": "atlanta",
  "fulton county|ga": "atlanta",
  "cobb county|ga": "atlanta",
  "gwinnett county|ga": "atlanta",
  "lithonia|ga": "atlanta",
  "conyers|ga": "atlanta",
  "covington|ga": "atlanta",
  "norcross|ga": "atlanta",
  "lilburn|ga": "atlanta",
  "snellville|ga": "atlanta",
  "woodstock|ga": "atlanta",
  "canton|ga": "atlanta",
  "acworth|ga": "atlanta",
  "powder springs|ga": "atlanta",
  "mableton|ga": "atlanta",
  "vinings|ga": "atlanta",
  "cumberland|ga": "atlanta",
  // NYC metro
  "brooklyn|ny": "new-york",
  "queens|ny": "new-york",
  "bronx|ny": "new-york",
  "staten island|ny": "new-york",
  "manhattan|ny": "new-york",
  "hoboken|nj": "new-york",
  "jersey city|nj": "new-york",
  // LA metro
  "santa monica|ca": "los-angeles",
  "beverly hills|ca": "los-angeles",
  "west hollywood|ca": "los-angeles",
  "pasadena|ca": "los-angeles",
  "burbank|ca": "los-angeles",
  "culver city|ca": "los-angeles",
  "malibu|ca": "los-angeles",
  // Chicago metro
  "evanston|il": "chicago",
  "oak park|il": "chicago",
  // SF metro
  "oakland|ca": "san-francisco",
  "berkeley|ca": "san-francisco",
  // DC metro
  "arlington|va": "washington-d-c",
  "alexandria|va": "washington-d-c",
  "bethesda|md": "washington-d-c",
  // Miami metro
  "miami beach|fl": "miami",
  "coral gables|fl": "miami",
  "wynwood|fl": "miami",
  // Dallas metro
  "plano|tx": "dallas",
  "frisco|tx": "dallas",
  "fort worth|tx": "dallas-fort-worth",
  // Houston metro
  "sugar land|tx": "houston",
  "the woodlands|tx": "houston",
  // Denver metro
  "boulder|co": "denver",
  "aurora|co": "denver",
  // Seattle metro
  "bellevue|wa": "seattle",
  "kirkland|wa": "seattle",
  // Boston metro
  "cambridge|ma": "boston",
  "somerville|ma": "boston",
  // Nashville metro
  "franklin|tn": "nashville",
  // Austin metro
  "round rock|tx": "austin",
  // ─── UK metro areas ───
  // London neighborhoods/boroughs → london
  "shoreditch|england": "london",
  "soho|england": "london",
  "mayfair|england": "london",
  "covent garden|england": "london",
  "chelsea|england": "london",
  "kensington|england": "london",
  "notting hill|england": "london",
  "brixton|england": "london",
  "hackney|england": "london",
  "islington|england": "london",
  "camden|england": "london",
  "fitzrovia|england": "london",
  "marylebone|england": "london",
  "clerkenwell|england": "london",
  "bermondsey|england": "london",
  "peckham|england": "london",
  "dalston|england": "london",
  "whitechapel|england": "london",
  "city of london|england": "london",
  "westminster|england": "london",
  "fulham|england": "london",
  "battersea|england": "london",
  "richmond|england": "london",
};

function getResyCitySlug(params: SearchParams): string {
  const city = (params.city || "").trim().toLowerCase();
  const state = (params.state || "").trim().toLowerCase();
  const key = state ? `${city}|${state}` : city;
  const isUK = params.country === "gb";

  // Check metro mapping first
  const metroSlug = RESY_METRO_MAP[key];
  if (metroSlug) {
    // UK cities don't use state suffix (Resy uses "london" not "london-england")
    if (isUK) return metroSlug;
    return state ? `${metroSlug}-${state}` : metroSlug;
  }

  // Fallback: slugify city (+ state for US only)
  const slugCity = slugify(params.city || "");
  if (isUK) return slugCity;
  const slugState = slugify(params.state || "");
  return slugState ? `${slugCity}-${slugState}` : slugCity;
}

// Returns the human-readable metro city name for use in search text
// e.g. "DeKalb County" + "GA" → "Atlanta"
function getResyMetroCityName(params: SearchParams): string {
  const city = (params.city || "").trim().toLowerCase();
  const state = (params.state || "").trim().toLowerCase();
  const key = state ? `${city}|${state}` : city;

  const metroSlug = RESY_METRO_MAP[key];
  if (metroSlug) {
    // Convert slug back to display name (e.g. "new-york" → "New York")
    return metroSlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return params.city || "";
}

// Generic helper: returns the metro city name for ANY platform search.
// Used by Yelp and Firecrawl to search the broader metro area instead of tiny CDPs.
function getMetroCityName(city: string, state: string): string {
  const c = (city || "").trim().toLowerCase();
  const s = (state || "").trim().toLowerCase();
  const key = s ? `${c}|${s}` : c;
  const metroSlug = RESY_METRO_MAP[key];
  if (metroSlug) {
    return metroSlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return city;
}


function isPlatformCandidateUrlValid(
  platform: "resy" | "opentable" | "yelp",
  rawUrl: string,
  params: SearchParams
): boolean {
  try {
    const u = new URL(rawUrl);
    const p = u.pathname.toLowerCase();
    const host = u.hostname.toLowerCase();

    if (platform === "resy") {
      const m = p.match(/^\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
      if (!m) return false;
      const citySlug = m[1].toLowerCase();
      const expectedSlug = getResyCitySlug(params).toLowerCase();
      return citySlug === expectedSlug;
    }

    if (platform === "opentable") {
      // Accept both opentable.com and opentable.co.uk
      if (host.includes("opentable.co.uk") || host.includes("opentable.com")) {
        return /^\/r\/[^/?#]+/i.test(p);
      }
      return false;
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
        : buildYelpAvailabilityUrl(canonUrl, params);

      return {
        id: `${platform}-${hashKey(canonUrl)}`,
        name,
        cuisine: params.cuisine || "Restaurant",
        neighborhood: extractNeighborhoodFromTitle(c.title, c.description, params.city),
        rating: undefined,
        priceRange: undefined,
        imageUrl: undefined,
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
      const host = u.hostname.toLowerCase();
      const m = p.match(/^\/r\/[^/?#]+/i);
      if (!m) return null;
      // Normalize to the correct domain
      if (host.includes("opentable.co.uk")) {
        return `https://www.opentable.co.uk${m[0]}`;
      }
      return `https://www.opentable.com${m[0]}`;
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
    // Resy uses HHMM format (no colon) for time filtering, e.g. "1900" for 7:00 PM
    const resyTime = p.time.replace(":", "");
    u.searchParams.set("time", resyTime);
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
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "") // "- Atlanta, GA on OpenTable"
      .replace(/\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+Resy$/i, "")
      .replace(/[•·|]\s*[A-Za-z\s&]+$/i, "") // trailing bullet sections like "• Sushi • Bar"
      .replace(/^book\s+(your\s+)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "") // trailing "- Atlanta, GA" or "- Buckhead"
      .replace(/\s*-\s*(Updated|Restaurant)\s.*$/i, "") // "- Updated 2026" or "- Restaurant Name"
      .trim();
    if (cleaned.length > 1) return cleaned;
  }
  const parts = url.split("/");
  const slug = parts[parts.length - 1] || "restaurant";
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Extract neighborhood/location from platform title/description
function extractNeighborhoodFromTitle(title: string | undefined, description: string | undefined, fallback: string): string {
  // OpenTable titles often have "Restaurant Name - City, ST" or description has location
  // Resy titles often have "Restaurant Name | City"
  const text = `${title || ""} ${description || ""}`;
  // Look for "City, ST" or "Neighborhood - City" patterns
  const cityStateMatch = text.match(/[-–|]\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
  if (cityStateMatch) return cityStateMatch[1].trim();
  return fallback;
}


async function fetchYelpCandidates(
  params: SearchParams, firecrawlKey: string, aiKey: string, amenityTerms: string[] = []
): Promise<Restaurant[]> {
  try {
    console.log(">>> YELP DISCOVERY FUNCTION ENTERED <<<");
    const amenitySuffix = amenityTerms.length > 0 ? ` ${amenityTerms.join(" ")}` : "";
    const MEAL_AS_CUISINE_YELP = new Set(["brunch", "breakfast"]);
    const YELP_MEAL_STRIP = /\b(dinner|lunch|breakfast|supper|brunch|meal|dining)\b/gi;
    const yelpCuisine = (params.cuisine || "").replace(YELP_MEAL_STRIP, (match) => {
      return MEAL_AS_CUISINE_YELP.has(match.toLowerCase()) ? match : "";
    }).replace(/\s+/g, " ").trim();

    const yelpCity = getMetroCityName(params.city, params.state);
    // Prefer the user's actual ZIP for hyperlocal Yelp results (ranked outward from ZIP centroid).
    const yelpLocation = params.userZip
      ? params.userZip
      : params.country === "gb"
        ? `${yelpCity}, UK`
        : `${yelpCity}, ${params.state}`;

    // Build Yelp search URL with reservation filter AND reservation params
    const searchTerm = `${yelpCuisine}${amenitySuffix} restaurants`.trim();
    const yelpSearchUrl = new URL("https://www.yelp.com/search");
    yelpSearchUrl.searchParams.set("find_desc", searchTerm);
    yelpSearchUrl.searchParams.set("find_loc", yelpLocation);
    if (params.country !== "gb") {
      yelpSearchUrl.searchParams.set("attrs", "reservation");
    }
    // Add reservation date/time/party so Yelp filters to restaurants with actual availability
    yelpSearchUrl.searchParams.set("reservation_date", params.date);
    yelpSearchUrl.searchParams.set("reservation_time", params.time.replace(":", ""));
    yelpSearchUrl.searchParams.set("reservation_covers", String(params.partySize));

    console.log(`Yelp discovery: ${searchTerm} in ${yelpLocation}`);

    // Strategy: Use Yelp's internal /search/snippet JSON API (same endpoint their frontend XHR uses)
    // This returns structured JSON without needing a browser or bypassing DataDome's JS challenge
    let snippetResults: Array<Record<string, any>> = [];
    let markdown = "";
    let links: string[] = [];
    let domCards: Array<Record<string, string>> = [];

    const snippetUrl = new URL("https://www.yelp.com/search/snippet");
    snippetUrl.searchParams.set("find_desc", searchTerm);
    snippetUrl.searchParams.set("find_loc", yelpLocation);
    snippetUrl.searchParams.set("request_origin", "user");
    if (params.country !== "gb") {
      snippetUrl.searchParams.set("attrs", "reservation");
    }
    snippetUrl.searchParams.set("reservation_date", params.date);
    snippetUrl.searchParams.set("reservation_time", params.time.replace(":", ""));
    snippetUrl.searchParams.set("reservation_covers", String(params.partySize));

    console.log(`[YELP_SNIPPET] Fetching: ${snippetUrl.toString()}`);

    try {
      const snippetResp = await fetch(snippetUrl.toString(), {
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Referer": "https://www.yelp.com/search?" + snippetUrl.searchParams.toString(),
          "X-Requested-With": "XMLHttpRequest",
        },
      });

      console.log(`[YELP_SNIPPET] Response status: ${snippetResp.status}`);

      if (snippetResp.ok) {
        const snippetData = await snippetResp.json();
        const components = snippetData?.searchPageProps?.mainContentComponentsListProps || [];
        console.log(`[YELP_SNIPPET] Got ${components.length} components`);

        for (const comp of components) {
          const biz = comp?.searchResultBusiness;
          if (!biz) continue;
          snippetResults.push(biz);
        }
        console.log(`[YELP_SNIPPET] Extracted ${snippetResults.length} businesses`);
      } else {
        const errBody = await snippetResp.text().catch(() => "");
        console.log(`[YELP_SNIPPET] Failed: ${snippetResp.status}, body=${errBody.slice(0, 500)}`);
      }
    } catch (snippetErr: any) {
      console.log(`[YELP_SNIPPET] Error: ${snippetErr.message || snippetErr}`);
    }

    // If snippet API returned results, parse them into our standard format
    let extracted: Array<{
      name: string;
      neighborhood?: string;
      rating?: number;
      reviewCount?: number;
      priceRange?: string;
      cuisineCategories: string[];
      availableTimes: string[];
      reservationUrl?: string;
      businessUrl?: string;
      alias?: string;
    }> = [];

    if (snippetResults.length > 0) {
      extracted = snippetResults.map(biz => {
        const alias = biz.alias || biz.businessUrl?.match(/\/biz\/([^?#]+)/)?.[1] || "";
        const categories = (biz.categories || []).map((c: any) => c?.title || "").filter(Boolean);
        const neighborhoods = biz.neighborhoods || [];
        const reservationUrl = biz.reservationUrl
          ? (biz.reservationUrl.startsWith("http") ? biz.reservationUrl : `https://www.yelp.com${biz.reservationUrl}`)
          : null;
        const businessUrl = biz.businessUrl
          ? (biz.businessUrl.startsWith("http") ? biz.businessUrl : `https://www.yelp.com${biz.businessUrl}`)
          : (alias ? `https://www.yelp.com/biz/${alias}` : null);

        return {
          name: biz.name || "",
          neighborhood: neighborhoods[0] || "",
          rating: typeof biz.rating === "number" ? biz.rating : undefined,
          reviewCount: typeof biz.reviewCount === "number" ? biz.reviewCount : undefined,
          priceRange: biz.priceRange || "",
          cuisineCategories: categories,
          availableTimes: [] as string[],
          reservationUrl: reservationUrl || undefined,
          businessUrl: businessUrl || undefined,
          alias,
        };
      }).filter(r => r.name);
      console.log(`[YELP_SNIPPET] Parsed ${extracted.length} restaurants from snippet API`);
    }

    // Fallback: if snippet API failed/blocked, try Steel.dev stealth browser
    if (extracted.length === 0) {
      console.log("[YELP_FALLBACK] Snippet API returned 0 results, trying Steel.dev fallback...");
      const steelApiKey = Deno.env.get("STEEL_API_KEY");
      if (steelApiKey) {
        let steelSessionId: string | null = null;
        try {
          const sessionResp = await fetch("https://api.steel.dev/v1/sessions", {
            method: "POST",
            headers: { "steel-api-key": steelApiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ useProxy: false, solveCaptcha: false }),
          });
          if (sessionResp.ok) {
            const sessionData = await sessionResp.json();
            steelSessionId = sessionData.id;
            if (steelSessionId) {
              console.log(`[YELP_STEEL] Session created: ${steelSessionId}`);
              const connectUrl = `wss://connect.steel.dev?apiKey=${steelApiKey}&sessionId=${steelSessionId}`;
              const ws = new WebSocket(connectUrl);
              let cdpId = 1;
              const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
              let cdpSessionId: string | null = null;

              const cdpSend = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
                return new Promise((resolve, reject) => {
                  const id = cdpId++;
                  pending.set(id, { resolve, reject });
                  const msg: Record<string, unknown> = { id, method, params };
                  if (cdpSessionId) msg.sessionId = cdpSessionId;
                  ws.send(JSON.stringify(msg));
                  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
                });
              };

              await new Promise<void>((resolve, reject) => {
                ws.onopen = () => resolve();
                ws.onerror = (e) => reject(e);
                setTimeout(() => reject(new Error("WS connect timeout")), 15000);
              });

              ws.onmessage = (event) => {
                try {
                  const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
                  if (msg.id && pending.has(msg.id)) {
                    const p = pending.get(msg.id)!;
                    pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
                    else p.resolve(msg.result);
                  }
                } catch (_) {}
              };

              const targetResult = await cdpSend("Target.createTarget", { url: "about:blank" });
              const targetId = targetResult?.targetId;
              if (targetId) {
                const attachResult = await cdpSend("Target.attachToTarget", { targetId, flatten: true });
                cdpSessionId = attachResult?.sessionId;
                if (cdpSessionId) {
                  await cdpSend("Page.enable");
                  await cdpSend("Runtime.enable");
                  await cdpSend("Page.navigate", { url: yelpSearchUrl.toString() });
                  await new Promise(resolve => setTimeout(resolve, 8000));
                  for (let i = 0; i < 3; i++) {
                    await cdpSend("Runtime.evaluate", { expression: `window.scrollBy(0, 1500); 'scrolled-${i}'`, returnByValue: true });
                    await new Promise(resolve => setTimeout(resolve, 1500));
                  }
                  const extractResult = await cdpSend("Runtime.evaluate", {
                    expression: `(function() {
                      const anchors = Array.from(document.querySelectorAll('a[href]'));
                      const hrefs = anchors.map(a => a.href).filter(h => h.includes('yelp.com'));
                      const skipName = /^(skip|filters?|sort|more filters|sponsored|ad|map|delivery|takeout|open now|yelp)$/i;
                      const cardsByAlias = new Map();
                      for (const anchor of anchors) {
                        const href = anchor.href || '';
                        if (!/\\/(?:biz|reservations)\\//i.test(href)) continue;
                        const rawName = (anchor.textContent || '').replace(/\\s+/g, ' ').trim();
                        if (!rawName || rawName.length < 2 || rawName.length > 120 || skipName.test(rawName)) continue;
                        const aliasMatch = href.match(/\\/(?:biz|reservations)\\/([^/?#]+)/i);
                        const alias = (aliasMatch?.[1] || rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).toLowerCase();
                        const container = anchor.closest('li, article, [role="article"]') || anchor.parentElement || anchor;
                        const snippet = (container?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 700);
                        const existing = cardsByAlias.get(alias) || { alias, name: rawName, businessUrl: '', reservationUrl: '', snippet: '' };
                        if (/\\/reservations\\//i.test(href)) existing.reservationUrl = href;
                        if (/\\/biz\\//i.test(href)) existing.businessUrl = href;
                        if (!existing.name || rawName.length > existing.name.length) existing.name = rawName;
                        if (snippet.length > (existing.snippet || '').length) existing.snippet = snippet;
                        cardsByAlias.set(alias, existing);
                      }
                      const text = document.body.innerText || document.body.textContent || '';
                      return JSON.stringify({ text, links: hrefs, cards: Array.from(cardsByAlias.values()) });
                    })()`,
                    returnByValue: true,
                  });
                  const ext = JSON.parse(extractResult?.result?.value || '{"text":"","links":[],"cards":[]}');
                  markdown = typeof ext.text === "string" ? ext.text : "";
                  links = Array.isArray(ext.links) ? ext.links : [];
                  domCards = Array.isArray(ext.cards) ? ext.cards : [];
                }
              }
              try { ws.close(); } catch (_) {}
              console.log(`[YELP_STEEL] links=${links.length}, cards=${domCards.length}, text=${markdown.length} chars`);
            }
          }
        } catch (steelErr: any) {
          console.log(`[YELP_STEEL] Error: ${steelErr.message || steelErr}`);
        } finally {
          if (steelSessionId) {
            try {
              await fetch(`https://api.steel.dev/v1/sessions/${steelSessionId}/release`, {
                method: "POST", headers: { "steel-api-key": Deno.env.get("STEEL_API_KEY")! },
              });
            } catch (_) {}
          }
        }
        const extractedFromCards = parseYelpDomCards(domCards);
        const extractedFromMarkdown = parseYelpMarkdownResults(markdown);
        extracted = extractedFromCards.length > 0 ? extractedFromCards : extractedFromMarkdown;
        console.log(`[YELP_STEEL] Parsed cards=${extractedFromCards.length}, markdown=${extractedFromMarkdown.length}`);
      } else {
        console.log("[YELP_FALLBACK] No STEEL_API_KEY configured, skipping Steel fallback");
      }
    }
    console.log(`Yelp discovery: extracted=${extracted.length} restaurants`);

    const markdownTimesMap = new Map<string, string[]>();

    // Build alias map from links for URL construction
    // Build alias map from links for URL construction
    const reservationLinkMap = new Map<string, string>();
    const bizLinkMap = new Map<string, string>();
    for (const link of links) {
      const alias = extractYelpAliasFromUrl(link);
      if (!alias) continue;
      if (/\/reservations\//i.test(link)) {
        if (!reservationLinkMap.has(alias)) reservationLinkMap.set(alias, link);
      } else if (/\/biz\//i.test(link)) {
        if (!bizLinkMap.has(alias)) bizLinkMap.set(alias, link);
      }
    }

    // Match extracted restaurants to URLs
    const results: Restaurant[] = [];
    for (const rest of extracted) {
      let alias: string | null = null;
      let reservationUrl: string | null = null;
      let bizUrl: string | null = null;

      if (rest.reservationUrl) {
        alias = extractYelpAliasFromUrl(rest.reservationUrl);
        reservationUrl = rest.reservationUrl;
      }
      if (rest.businessUrl) {
        alias = alias || extractYelpAliasFromUrl(rest.businessUrl);
        bizUrl = rest.businessUrl;
      }

      if (!alias) {
        const normalizedName = rest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        for (const [a] of reservationLinkMap) {
          if (a.includes(normalizedName) || normalizedName.includes(a.split("-").slice(0, -1).join("-"))) {
            alias = a;
            break;
          }
        }
        if (!alias) {
          for (const [a] of bizLinkMap) {
            if (a.includes(normalizedName) || normalizedName.includes(a.split("-").slice(0, -1).join("-"))) {
              alias = a;
              break;
            }
          }
        }
      }

      if (!alias) {
        alias = typeof (rest as any).alias === "string"
          ? (rest as any).alias.toLowerCase()
          : rest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      }

      reservationUrl = reservationUrl || reservationLinkMap.get(alias) || null;
      bizUrl = bizUrl || bizLinkMap.get(alias) || null;
      const bestUrl = reservationUrl || (bizUrl ? bizUrl.replace("/biz/", "/reservations/") : `https://www.yelp.com/reservations/${alias}`);

      const markdownTimes = markdownTimesMap.get(normalizeRestaurantNameForMatch(rest.name)) || [];
      const allTimes = rest.availableTimes.length > 0 ? rest.availableTimes : markdownTimes;

      results.push({
        id: `yelp-${alias}`,
        name: rest.name,
        cuisine: rest.cuisineCategories.length > 0 ? rest.cuisineCategories.join(", ") : (params.cuisine || "Restaurant"),
        neighborhood: rest.neighborhood || params.city,
        rating: rest.rating,
        reviewCount: typeof (rest as any).review_count === "number" ? (rest as any).review_count : undefined,
        priceRange: rest.priceRange,
        imageUrl: undefined,
        platform: "yelp" as const,
        platformUrl: buildYelpAvailabilityUrl(bestUrl, params),
        timeSlots: allTimes.map(time => ({ time })),
        distanceMiles: null,
        _yelpCategories: rest.cuisineCategories.join(" ").toLowerCase() || alias.replace(/-/g, " "),
      });
    }

    console.log(`Yelp extract candidates: ${results.length}, with slots: ${results.filter(r => r.timeSlots.length > 0).length}`);
    return results;
  } catch (err) {
    console.error("Yelp scrape error:", err);
    return [];
  }
}
// Parse Yelp search results from markdown text (no LLM needed — pure regex)
// Yelp markdown format: "1. [Restaurant Name](https://www.yelp.com/biz/alias-city)\n...details..."
function parseYelpMarkdownResults(markdown: string): Array<{
  name: string;
  neighborhood?: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  cuisineCategories: string[];
  availableTimes: string[];
  reservationUrl?: string;
  businessUrl?: string;
}> {
  if (!markdown || markdown.length < 50) return [];

  const results: Array<{
    name: string;
    neighborhood?: string;
    rating?: number;
    reviewCount?: number;
    priceRange?: string;
    cuisineCategories: string[];
    availableTimes: string[];
    reservationUrl?: string;
    businessUrl?: string;
  }> = [];

  // Non-restaurant headings to skip
  const SKIP_NAMES = /^(skip|top \d|can't find|trending|seasonal|more nearby|browse|popular brands|nearby cities|neighborhoods|streets|campuses|related)/i;

  // Match numbered list items: "1. [Name](yelp-url)" — each is a restaurant entry
  // Split into blocks at each numbered item that links to yelp.com
  const entryRegex = /\d+\.\s+\[([^\]]+)\]\((https?:\/\/www\.yelp\.com\/biz\/[^\s)]+)\)/g;
  const entries: Array<{ name: string; url: string; startIdx: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(markdown)) !== null) {
    entries.push({ name: m[1].trim(), url: m[2], startIdx: m.index });
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (SKIP_NAMES.test(entry.name)) continue;

    // Get the block of text for this entry (until the next entry or end)
    const blockEnd = i + 1 < entries.length ? entries[i + 1].startIdx : Math.min(entry.startIdx + 2000, markdown.length);
    const block = markdown.slice(entry.startIdx, blockEnd);

    // Skip sponsored
    if (/sponsored|^\s*ad\b/i.test(block.slice(0, 300))) continue;

    // Extract alias from URL
    const aliasMatch = entry.url.match(/\/biz\/([^?#]+)/);
    const alias = aliasMatch?.[1] || "";

    // Extract rating: look for "X.X" pattern near star indicators
    const ratingMatch = block.match(/(\d\.\d)\s*(?:\(|star|★)/i) || block.match(/★\s*(\d\.\d)/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;

    // Extract review count: "123 reviews" or "(1.2k reviews)"
    const reviewMatch = block.match(/([\d,]+(?:\.\d+)?k?)\s*review/i);
    let reviewCount: number | undefined;
    if (reviewMatch) {
      const raw = reviewMatch[1].replace(/,/g, "");
      reviewCount = raw.endsWith("k") ? Math.round(parseFloat(raw) * 1000) : parseInt(raw);
    }

    // Extract price range: "$" to "$$$$"
    const priceMatch = block.match(/(\${1,4})(?:\s|·|,|\n)/);
    const priceRange = priceMatch ? priceMatch[1] : undefined;

    // Extract neighborhood — often after price or categories, like "· Midtown" or "in Buckhead"
    const hoodMatch = block.match(/·\s*([A-Z][a-zA-Z\s]{2,25})(?:\s*·|\s*\n|$)/m);
    const neighborhood = hoodMatch ? hoodMatch[1].trim() : undefined;

    // Extract cuisine categories — comma/· separated items like "American, Seafood"
    // Often appears as "American · $$$ · Midtown" or similar
    const catLine = block.match(/(?:^|\n)([A-Z][a-zA-Z, ·&]+?)(?:\s*·\s*\${1,4}|\s*·\s*[A-Z]|\s*\n)/m);
    const cuisineCategories: string[] = [];
    if (catLine) {
      const cats = catLine[1].split(/[·,]/).map(c => c.trim()).filter(c => c.length > 1 && c.length < 30 && !/^\$/.test(c));
      cuisineCategories.push(...cats);
    }

    // Extract time slots — look for time patterns like "6:30 PM"
    const timePattern = /\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/gi;
    const rawTimes = block.match(timePattern) || [];
    const availableTimes = [...new Set(
      rawTimes.map(t => normalizeExtractedTimeLabel(t)).filter(Boolean) as string[]
    )];

    results.push({
      name: entry.name,
      neighborhood,
      rating,
      reviewCount,
      priceRange,
      cuisineCategories,
      availableTimes,
      reservationUrl: undefined, // Will be constructed from alias in the caller
      businessUrl: entry.url,
    });
  }

  return results;
}

function parseYelpDomCards(cards: Array<Record<string, string>>): Array<{
  alias?: string;
  name: string;
  neighborhood?: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  cuisineCategories: string[];
  availableTimes: string[];
  reservationUrl?: string;
  businessUrl?: string;
}> {
  if (!Array.isArray(cards) || cards.length === 0) return [];

  const results: Array<{
    alias?: string;
    name: string;
    neighborhood?: string;
    rating?: number;
    reviewCount?: number;
    priceRange?: string;
    cuisineCategories: string[];
    availableTimes: string[];
    reservationUrl?: string;
    businessUrl?: string;
  }> = [];

  const seen = new Set<string>();
  const SKIP_NAMES = /^(skip|top \d|can't find|trending|seasonal|more nearby|browse|popular brands|nearby cities|neighborhoods|streets|campuses|related|more filters|filters|sort|sponsored|ad)$/i;

  for (const card of cards) {
    const name = typeof card?.name === "string" ? card.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length < 2 || name.length > 120 || SKIP_NAMES.test(name)) continue;

    const businessUrl = typeof card?.businessUrl === "string" && card.businessUrl ? card.businessUrl : undefined;
    const reservationUrl = typeof card?.reservationUrl === "string" && card.reservationUrl ? card.reservationUrl : undefined;
    const alias = typeof card?.alias === "string" && card.alias
      ? card.alias.toLowerCase()
      : extractYelpAliasFromUrl(reservationUrl || businessUrl || "") || normalizeRestaurantNameForMatch(name);

    if (!alias || seen.has(alias)) continue;
    seen.add(alias);

    const snippet = typeof card?.snippet === "string" ? card.snippet : "";
    const ratingMatch = snippet.match(/(?:^|\s)([1-5]\.\d)(?=\s*(?:star|stars|rating|\(|\d+(?:\.\d+)?k?\s*reviews?))/i) || snippet.match(/★\s*([1-5]\.\d)/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : undefined;

    const reviewMatch = snippet.match(/([\d,]+(?:\.\d+)?k?)\s*reviews?/i);
    let reviewCount: number | undefined;
    if (reviewMatch) {
      const raw = reviewMatch[1].replace(/,/g, "");
      reviewCount = raw.endsWith("k") ? Math.round(parseFloat(raw) * 1000) : parseInt(raw);
    }

    const priceRange = snippet.match(/(\${1,4})/)?.[1];
    const neighborhood = snippet.match(/·\s*([A-Z][a-zA-Z\s]{2,25})(?:\s*·|\s*$)/m)?.[1]?.trim();
    const rawTimes = snippet.match(/\d{1,2}:\d{2}\s*(?:AM|PM)/gi) || [];
    const availableTimes = [...new Set(
      rawTimes.map((value) => normalizeExtractedTimeLabel(value)).filter(Boolean) as string[]
    )];

    results.push({
      alias,
      name,
      neighborhood,
      rating,
      reviewCount,
      priceRange,
      cuisineCategories: [],
      availableTimes,
      reservationUrl,
      businessUrl,
    });
  }

  return results;
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

function extractYelpAliasFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const match = u.pathname.match(/^\/(?:biz|reservations)\/([^/?#]+)/i);
    return match?.[1]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

function normalizeRestaurantNameForMatch(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’'`]/g, "")
    .replace(/(the|restaurant|bar|grill|kitchen|cafe|café|bistro|tavern|steakhouse|house|atlanta|ga)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");
}

function normalizeExtractedTimeLabel(raw: string): string | null {
  const match = raw.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;

  const hour12 = Number(match[1]);
  const minutes = Number(match[2] || "0");
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12 || minutes < 0 || minutes > 59) return null;

  let hour24 = hour12 % 12;
  if (match[3].toLowerCase() === "pm") hour24 += 12;

  const displayHour = hour24 % 12 || 12;
  const displayAmpm = hour24 >= 12 ? "PM" : "AM";
  return `${displayHour}:${minutes.toString().padStart(2, "0")} ${displayAmpm}`;
}

function extractStructuredTimeLabels(value: unknown): string[] {
  const rawValues: string[] = [];

  const collect = (input: unknown) => {
    if (!input) return;
    if (Array.isArray(input)) {
      input.forEach(collect);
      return;
    }
    if (typeof input === "string") {
      rawValues.push(input);
      return;
    }
    if (typeof input === "object") {
      const obj = input as Record<string, unknown>;
      for (const key of ["available_times", "available_reservation_times", "times", "time_slots", "slots", "reservation_times"]) {
        collect(obj[key]);
      }
    }
  };

  collect(value);

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    const matches = raw.match(/\d{1,2}(?::\d{2})?\s*(?:AM|PM)/gi) || [raw];
    for (const candidate of matches) {
      const label = normalizeExtractedTimeLabel(candidate);
      if (label && !seen.has(label)) {
        seen.add(label);
        normalized.push(label);
      }
    }
  }
  return normalized;
}

function coerceYelpExtractedRestaurants(extractData: any): Array<{
  name: string;
  neighborhood?: string;
  rating?: number;
  priceRange?: string;
  cuisineCategories: string[];
  availableTimes: string[];
  reservationUrl?: string;
  businessUrl?: string;
}> {
  const rows = Array.isArray(extractData?.restaurants)
    ? extractData.restaurants
    : Array.isArray(extractData?.data?.restaurants)
      ? extractData.data.restaurants
      : Array.isArray(extractData)
        ? extractData
        : [];

  return rows
    .map((row: any) => {
      const categoryValue = row?.cuisine_categories ?? row?.categories ?? row?.cuisine ?? [];
      const cuisineCategories = Array.isArray(categoryValue)
        ? categoryValue.map((value) => String(value).trim()).filter(Boolean)
        : typeof categoryValue === "string"
          ? categoryValue.split(/[|,]/).map((value) => value.trim()).filter(Boolean)
          : [];

      const ratingValue = typeof row?.rating === "number" ? row.rating : Number(row?.rating);

      return {
        name: typeof row?.name === "string" ? row.name.trim() : "",
        neighborhood: typeof row?.neighborhood === "string" ? row.neighborhood.trim() : undefined,
        rating: Number.isFinite(ratingValue) ? ratingValue : undefined,
        priceRange: typeof row?.price_range === "string"
          ? row.price_range.trim()
          : typeof row?.priceRange === "string"
            ? row.priceRange.trim()
            : undefined,
        cuisineCategories,
        availableTimes: extractStructuredTimeLabels(row),
        reservationUrl: typeof row?.reservation_url === "string" ? row.reservation_url : undefined,
        businessUrl: typeof row?.business_url === "string" ? row.business_url : undefined,
      };
    })
    .filter((row: { name: string }) => row.name);
}

function extractFirecrawlMarkdown(data: any): string {
  return data?.data?.markdown || data?.markdown || "";
}

function extractFirecrawlHtml(data: any): string {
  return data?.data?.html || data?.html || "";
}

function extractFirecrawlLinks(data: any): string[] {
  const rawLinks = data?.data?.links || data?.links || [];
  return Array.isArray(rawLinks)
    ? rawLinks.filter((value): value is string => typeof value === "string")
    : [];
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

// Address extraction now handled by Firecrawl JSON extraction format during verification scrape

// ─── Batch geocode verified results ───

async function geocodeVerifiedResults(results: Restaurant[], params: SearchParams): Promise<void> {
  // Prefer the user's true browser coords; fall back to city centroid.
  const refLat = params.userLat || params.lat || 0;
  const refLng = params.userLng || params.lng || 0;
  if (!refLat || !refLng) {
    console.log("No search coordinates for distance calculation, skipping geocode");
    return;
  }

  const metroCity = getMetroCityName(params.city || "", params.state || "");
  const state = params.state || "";

  // Single geocoding helper: tries up to 4 strategies, returns on first success
  async function geocodeOne(r: Restaurant): Promise<void> {
    if (r.distanceMiles != null) return; // Already geocoded

    const cleanedName = r.name
      .replace(/\s+restaurant$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+Resy$/i, "")
      .replace(/[•·]\s*[A-Za-z\s&]+$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "")
      .replace(/\s*-\s*(Atlanta|Buckhead|Decatur|Perimeter|Brookhaven).*$/i, "")
      .trim();

    // Helper to attempt a Nominatim query and apply result
    async function tryGeocode(queryUrl: string, label: string): Promise<boolean> {
      try {
        const resp = await fetch(queryUrl, { headers: { "User-Agent": "TableFinder/1.0" } });
        if (!resp.ok) return false;
        const data = await resp.json();
        if (!data?.[0]) return false;
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
        const dist = +haversine(refLat, refLng, lat, lng).toFixed(1);
        if (dist > 200) {
          console.log(`  Geocode sanity fail (${label}) ${r.name}: ${dist} mi — discarding`);
          return false;
        }
        r.distanceMiles = dist;
        const geoAddr = data[0].address;
        const neighborhood = geoAddr?.suburb || geoAddr?.neighbourhood || geoAddr?.city_district || "";
        if (neighborhood) r.neighborhood = neighborhood;
        else if (r._addressCity) r.neighborhood = r._addressCity;
        console.log(`  Geocoded (${label}) ${r.name}: ${dist} mi (${r.neighborhood})`);
        return true;
      } catch {
        return false;
      }
    }

    // Strategy 1: Direct address lookup
    if (r._address) {
      const addr = r._address;
      const url1 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(addr)}&format=json&limit=1&addressdetails=1`;
      if (await tryGeocode(url1, "direct")) return;

      // Strategy 2: Simplified address (strip suite/unit + zip)
      const simplified = addr
        .replace(/\b(suite|ste|unit|apt|#)\s*\S+,?\s*/gi, "")
        .replace(/\s+\d{5}(-\d{4})?$/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (simplified !== addr) {
        // No delay — Nominatim handles sequential queries fine
        const url2 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(simplified)}&format=json&limit=1&addressdetails=1`;
        if (await tryGeocode(url2, "simplified")) return;
      }

      // Strategy 3: Structured query (street + city + state params)
      const streetPart = addr.split(",")[0].trim();
      if (streetPart.length > 3) {
        // No delay — same endpoint, different query params
        const url3 = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(streetPart)}&city=${encodeURIComponent(metroCity)}&state=${encodeURIComponent(state)}&format=json&limit=1&addressdetails=1`;
        if (await tryGeocode(url3, "structured")) return;
      }
    }

    // Strategies 4-5 removed: Nominatim name-based lookups fail >95% of the time.
    // AI coordinate enrichment now handles restaurants without addresses.
    if (r._addressCity) r.neighborhood = r._addressCity;
    console.log(`  Nominatim miss for ${r.name} — will use AI coordinates`);
  }

  const toGeocode = results.filter(r => r.distanceMiles == null);
  if (toGeocode.length === 0) return;

  console.log(`Geocoding ${toGeocode.length} restaurants via Nominatim...`);

  // Fire in batches of 8 with 25ms stagger between batches
  const BATCH_SIZE = 8;
  const geocodePromises: Promise<void>[] = [];
  for (let i = 0; i < toGeocode.length; i++) {
    const batchIndex = Math.floor(i / BATCH_SIZE);
    geocodePromises.push(
      new Promise<void>(async (resolve) => {
        await new Promise(w => setTimeout(w, batchIndex * 25));
        await geocodeOne(toGeocode[i]);
        resolve();
      })
    );
  }

  await Promise.all(geocodePromises);
  const geocoded = toGeocode.filter(r => r.distanceMiles != null).length;
  console.log(`Geocoded ${geocoded}/${toGeocode.length} restaurants`);
}

// ─── AI enrichment ───
// AI provides: rating, reviewCount, cuisine, priceRange, description, vibeTags
// Coordinates and neighborhoods come from geocoding extracted addresses (not AI)

async function enrichWithAI(results: Restaurant[], apiKey: string, params: SearchParams, amenityTerms: string[] = []): Promise<Map<number, any>> {
  const emptyMap = new Map<number, any>();
  if (results.length === 0) return emptyMap;

  const metroCity = getMetroCityName(params.city || "", params.state || "");
  const list = results.map((r, i) => `${i}. ${r.name} (${r.platform})`).join("\n");

  // Build amenity instruction if relevant
  const amenityInstruction = amenityTerms.length > 0
    ? `\n- amenities: list any known venue features/amenities this restaurant has (e.g. "rooftop", "patio", "outdoor seating", "waterfront", "live music", "private dining", "happy hour", "bottomless brunch"). Be thorough — include ALL applicable amenities you know about for each restaurant.`
    : "";
  const amenityJsonField = amenityTerms.length > 0 ? `, "amenities": string[]` : "";

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `For each restaurant in the ${metroCity || params.city}, ${params.country === "gb" ? "UK" : params.state} metro area, provide:
- index, rating (Google Maps /5), reviewCount (approximate total Google reviews), cuisine type, priceRange (${params.country === "gb" ? "£-££££" : "$-$$$$"})
- neighborhood: the ACTUAL neighborhood or suburb where the restaurant is physically located (e.g. ${params.country === "gb" ? '"Soho", "Shoreditch", "Mayfair", "Covent Garden"' : '"Buckhead", "Midtown", "Vinings", "Sandy Springs"'}) — NOT the search city "${params.city}"
- description: ONE sentence (max 15 words) describing the restaurant's signature appeal or what it's known for
- vibeTags: 1-3 short tags describing the vibe/ambiance (e.g. "Date Night", "Casual", "Upscale", "Family-Friendly", "Trendy", "Cozy", "Lively", "Intimate", "Hip", "Classic")${amenityInstruction}

- lat: the restaurant's latitude (Google Maps coordinate, decimal degrees)
- lng: the restaurant's longitude (Google Maps coordinate, decimal degrees)

Return JSON: { "restaurants": [{ "index": number, "rating": number, "reviewCount": number, "cuisine": string, "neighborhood": string, "priceRange": string, "description": string, "vibeTags": string[], "lat": number, "lng": number${amenityJsonField} }] }

Return an entry for EVERY restaurant:

${list}`,
        }],
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) { await resp.text(); return emptyMap; }

    const aiData = await resp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return emptyMap;

    const parsed = JSON.parse(content);
    const enrichments = parsed.restaurants || [];
    const eMap = new Map<number, any>();
    for (const e of enrichments) {
      if (typeof e.index === "number") {
        // Merge amenities into vibeTags so they're visible in results
        if (Array.isArray(e.amenities) && e.amenities.length > 0) {
          const existing = new Set((e.vibeTags || []).map((t: string) => t.toLowerCase()));
          for (const amenity of e.amenities) {
            const lower = amenity.toLowerCase();
            if (!existing.has(lower)) {
              e.vibeTags = [...(e.vibeTags || []), amenity];
              existing.add(lower);
            }
          }
        }
        eMap.set(e.index, e);
      }
    }

    return eMap;
  } catch (err) {
    console.error("AI enrich error:", err);
    return emptyMap;
  }
}

// Clean transient fields before returning results
function cleanTransientFields(results: Restaurant[]): Restaurant[] {
  return results.map(r => {
    const { _address, _addressCity, _yelpCrossplatformGuess, _yelpCategories, _yelpSearchPageVerified, _yelpSearchVerified, _xplatMarkdown, _xplatHtml, _xplatMeta, ...clean } = r as any;
    return clean;
  });
}

// ─── UNIFIED VERIFICATION GATE ───
// Every candidate must pass this check before being returned.
// Scrapes the booking URL via Firecrawl and confirms time slots exist.

const NO_AVAILABILITY_SIGNALS = [
  // Generic
  "no availability", "no online availability", "no tables available",
  "not available", "fully booked", "sold out",
  // Resy
  "there's no online availability", "no online reservations", "at the moment, there's no",
  // OpenTable
  "we didn't find", "no results", "we couldn't find", "we can't find",
  "this restaurant is no longer", "restaurant not found", "no longer available on opentable",
  "page not found", "looking for something else",
  // Yelp
  "not currently accepting reservations", "this business is not currently accepting reservations",
  "temporarily unavailable",
];

function selectCandidatesForVerification(
  candidates: Restaurant[],
  maxCandidates: number
): Restaurant[] {
  const platformOrder: Array<Restaurant["platform"]> = ["resy", "opentable", "yelp"];
  const buckets = {
    resy: candidates.filter((c) => c.platform === "resy"),
    opentable: candidates.filter((c) => c.platform === "opentable"),
    yelp: candidates.filter((c) => c.platform === "yelp"),
  };

  // Proportional allocation: distribute slots based on candidate volume per platform.
  // OpenTable is currently frequently blocked/408ing, so keep a hard cap on it.
  const total = candidates.length || 1;
  const hardCaps: Record<Restaurant["platform"], number> = { resy: maxCandidates, opentable: 6, yelp: 10 };
  const quotas: Record<string, number> = {};
  let assigned = 0;
  for (const platform of platformOrder) {
    const raw = Math.round((buckets[platform].length / total) * maxCandidates);
    quotas[platform] = Math.min(raw, hardCaps[platform], buckets[platform].length);
    assigned += quotas[platform];
  }
  // Distribute any remaining slots (due to rounding or capped buckets) round-robin
  let remaining = maxCandidates - assigned;
  for (const platform of platformOrder) {
    if (remaining <= 0) break;
    const canAdd = Math.min(buckets[platform].length, hardCaps[platform]) - quotas[platform];
    if (canAdd > 0) {
      const add = Math.min(canAdd, remaining);
      quotas[platform] += add;
      remaining -= add;
    }
  }

  console.log(`[SELECTION] Proportional quotas: ${platformOrder.map(p => `${p}=${quotas[p]}/${buckets[p].length}`).join(", ")}`);

  const selected: Restaurant[] = [];
  for (const platform of platformOrder) {
    selected.push(...buckets[platform].slice(0, quotas[platform]));
  }

  return selected;
}

async function verifyAvailability(
  candidates: Restaurant[],
  params: SearchParams,
  firecrawlKey: string,
  amenityTerms: string[] = [],
  globalStartTime?: number
): Promise<Restaurant[]> {
   if (candidates.length === 0) return [];

  // Steel.dev concurrency limiter (hobby tier: be conservative)
  let steelActiveCount = 0;
  const steelQueue: (() => void)[] = [];
  const STEEL_MAX_CONCURRENT = 2;
  const acquireSteelSlot = (): Promise<void> => {
    if (steelActiveCount < STEEL_MAX_CONCURRENT) {
      steelActiveCount++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => steelQueue.push(resolve));
  };
  const releaseSteelSlot = () => {
    steelActiveCount--;
    const next = steelQueue.shift();
    if (next) { steelActiveCount++; next(); }
  };

  // Firecrawl concurrency limiter for non-Yelp (Resy/OpenTable) scrapes.
  // Firing 18 simultaneous scrapes during extended search caused a cluster of
  // 25s timeouts (Firecrawl contention). Cap to 4 concurrent + 35s ceiling +
  // one-time retry on timeout = no more lost nearby venues.
  let fcActiveCount = 0;
  const fcQueue: (() => void)[] = [];
  const FC_MAX_CONCURRENT = 6;
  const acquireFcSlot = (): Promise<void> => {
    if (fcActiveCount < FC_MAX_CONCURRENT) { fcActiveCount++; return Promise.resolve(); }
    return new Promise<void>(resolve => fcQueue.push(resolve));
  };
  const releaseFcSlot = () => {
    fcActiveCount--;
    const next = fcQueue.shift();
    if (next) { fcActiveCount++; next(); }
  };
  // Per-provider timeout counters for diagnostics
  const timeoutCounts: Record<string, number> = { resy: 0, opentable: 0, yelp: 0 };

  // Run ALL scrapes in parallel (Firecrawl handles concurrency, Steel is rate-limited)
  const checked = await Promise.all(candidates.map(async (r) => {
     try {
       const isYelp = r.platform === "yelp";

      const isResy = r.platform === "resy";
      const isOT = r.platform === "opentable";

      // ── YELP: Firecrawl reservation-page scrape ──
      let yelpSteelHtml = "";
      let yelpHasConcreteSlotEvidence = false;
      let markdown = "";
      let html = "";
      let links: string[] = [];
      let jsonData: any = null;
      let data: any = null;

      if (isYelp) {
        const scrapeAbort = new AbortController();
        const scrapeTimer = setTimeout(() => scrapeAbort.abort(), 15_000);
        let yelpResp: Response;
        try {
          yelpResp = await fetch(`${FIRECRAWL_API}/scrape`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${firecrawlKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url: r.platformUrl,
              formats: ["markdown", "html"],
              onlyMainContent: false,
              waitFor: 5000,
            }),
            signal: scrapeAbort.signal,
          });
        } catch (fetchErr: any) {
          clearTimeout(scrapeTimer);
          console.log(`✗ ${r.name} [yelp] — Firecrawl fetch error: ${fetchErr.name === "AbortError" ? "timeout" : fetchErr}`);
          return null;
        }
        clearTimeout(scrapeTimer);

        if (!yelpResp.ok) {
          const errBody = await yelpResp.text().catch(() => "");
          console.log(`✗ ${r.name} [yelp] — Firecrawl scrape failed (${yelpResp.status}): ${errBody.slice(0, 300)}`);
          return null;
        }

        const yelpData = await yelpResp.json();
        const yelpMarkdown = extractFirecrawlMarkdown(yelpData);
        const yelpHtml = extractFirecrawlHtml(yelpData);
        markdown = yelpMarkdown;
        html = yelpHtml;
        yelpSteelHtml = yelpHtml;

        const lowerYelp = `${yelpMarkdown}\n${yelpHtml}`.toLowerCase();
        const reservationKeywords = /(select\s+(a\s+)?time|available\s+times?|find\s+a\s+table|book\s+a\s+table|make\s+a\s+reservation|request\s+a\s+reservation)/i;
        const buttonOrInlineTimes = [...new Set((`${yelpMarkdown}\n${yelpHtml}`.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi) || []).map(v => v.trim()))];
        yelpHasConcreteSlotEvidence = reservationKeywords.test(lowerYelp) || buttonOrInlineTimes.length >= 2;
        console.log(`  ${r.name} [yelp] Firecrawl evidence: times=${buttonOrInlineTimes.length}, reservationSection=${reservationKeywords.test(lowerYelp)}, evidence=${yelpHasConcreteSlotEvidence}`);
      }

      // ── Non-Yelp: Firecrawl scrape (Resy / OpenTable) ──
      // OT gets both markdown + HTML so the HTML slot parser can run as fallback
      const scrapePayload: Record<string, unknown> = isOT ? {
          url: r.platformUrl,
          formats: ["markdown", "html"],
          onlyMainContent: false,
        } : {
          url: r.platformUrl,
          formats: ["markdown"],
          onlyMainContent: false,
        };

      if (!isYelp) {
        {
          // ── Resy & OT: Use Firecrawl ──
          // OT: use actions-based scraping with enhanced proxy for anti-bot bypass
          const otPayload = isOT ? {
            url: r.platformUrl,
            formats: ["markdown", "html"],
            onlyMainContent: false,
            waitFor: 5000,
            timeout: 15000,
            proxy: "auto",
          } : scrapePayload;
          const primaryTimeout = isOT ? 20_000 : 15_000;
          const retryTimeout = isOT ? 15_000 : 12_000;
          await acquireFcSlot();
          let resp: Response;
          const doScrape = async (timeoutMs: number, payload: Record<string, unknown>): Promise<Response | { aborted: true }> => {
            const scrapeAbort = new AbortController();
            const scrapeTimer = setTimeout(() => scrapeAbort.abort(), timeoutMs);
            try {
              const fcResp = await fetch(`${FIRECRAWL_API}/scrape`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${firecrawlKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
                signal: scrapeAbort.signal,
              });
              clearTimeout(scrapeTimer);
              return fcResp;
            } catch (err: any) {
              clearTimeout(scrapeTimer);
              if (err.name === "AbortError") return { aborted: true };
              throw err;
            }
          };
          try {
            let attempt = await doScrape(primaryTimeout, otPayload);
            if ("aborted" in attempt) {
              timeoutCounts[r.platform] = (timeoutCounts[r.platform] || 0) + 1;
              console.log(`Scrape timeout (${primaryTimeout/1000}s) for ${r.name} [${r.platform}] — retrying once`);
              await new Promise(res => setTimeout(res, 300));
              attempt = await doScrape(retryTimeout, { ...otPayload, timeout: retryTimeout - 2000 });
              if ("aborted" in attempt) {
                console.log(`Scrape timeout (${retryTimeout/1000}s retry) for ${r.name} [${r.platform}] — giving up`);
                releaseFcSlot();
                return null;
              }
            }
            resp = attempt;
          } catch (fetchErr: any) {
            releaseFcSlot();
            console.log(`Scrape fetch error for ${r.name} [${r.platform}]: ${fetchErr}`);
            return null;
          }
          releaseFcSlot();

          if (resp.status === 408) {
            console.log(`Scrape 408 for ${r.name} [${r.platform}] — skipping`);
            return null;
          }

          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "(no body)");
            console.log(`Scrape failed (${resp.status}) for ${r.name} [${r.platform}]: ${errBody.slice(0, 300)}`);
            return null;
          }

          data = await resp.json();
          markdown = extractFirecrawlMarkdown(data);
          html = extractFirecrawlHtml(data);
          links = extractFirecrawlLinks(data);
          jsonData = data?.data?.extract || data?.extract;
        }
      }

      if (!markdown && !html && !jsonData) {
        console.log(`No content for ${r.name} [${r.platform}]`);
        return null;
      }

      // Extract structured data from Firecrawl JSON extraction (if present)
      
      // Extract address from markdown/metadata (all platforms)
      if (!r._address) {
        // Try OG metadata first (OpenTable populates these)
        const meta2 = data?.data?.metadata || data?.metadata;
        const ogStreet = meta2?.["og:street-address"] || meta2?.["street-address"];
        const ogCity = meta2?.["og:locality"] || meta2?.locality;
        const ogState = meta2?.["og:region"] || meta2?.region;
        const ogZip = meta2?.["og:postal-code"] || meta2?.["postal-code"];
        if (ogStreet && ogCity && ogState) {
          r._address = `${ogStreet}, ${ogCity}, ${ogState}${ogZip ? " " + ogZip : ""}`;
          r._addressCity = ogCity;
          console.log(`  Address extracted (metadata) for ${r.name}: ${r._address}`);
        }
        // Try structured extraction next (if available)
        const extractedAddr = !r._address ? (jsonData?.address) : null;
        if (extractedAddr && typeof extractedAddr === "string" && extractedAddr.length > 5) {
          r._address = extractedAddr;
          const cityMatch = extractedAddr.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
          r._addressCity = cityMatch ? cityMatch[1].trim() : undefined;
          console.log(`  Address extracted (JSON) for ${r.name}: ${extractedAddr}`);
        } else {
          // Pre-normalize markdown for address extraction:
          // - Collapse line breaks between street and city/state lines
          // - Replace bullets/middots with spaces
          // - Remove duplicate whitespace
          const normalizedMd = markdown
            .replace(/·/g, " ")           // middots
            .replace(/•/g, " ")           // bullets
            .replace(/\|/g, " ")          // pipes
            .replace(/\n\s*\n/g, "\n")    // collapse double newlines
            .replace(/\n(?=[A-Z][a-z])/g, ", ")  // join lines where next starts with capital (city after street)
            .replace(/\s{2,}/g, " ");     // collapse whitespace

          // OT-specific: look for address near "location" or "address" sections
          let otAddressFound = false;
          if (isOT) {
            // Pattern 1: structured block near location/address header
            const locationSectionRegex = /(?:location|address|find us|where)[:\s]*\n?\s*(\d{1,5}\s+[A-Za-z\s.#']+(?:,\s*[A-Za-z\s]+)?(?:,\s*[A-Z]{2}(?:\s+\d{5})?))/im;
            const locMatch = normalizedMd.match(locationSectionRegex);
            if (locMatch) {
              r._address = locMatch[1].trim();
              const cityM = r._address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
              r._addressCity = cityM ? cityM[1].trim() : undefined;
              otAddressFound = true;
              console.log(`  Address extracted (OT location section) for ${r.name}: ${r._address}`);
            }
            
            // Pattern 2: any street address in normalized text
            if (!otAddressFound) {
              const otAddrRegex = /(\d{1,5}\s+[A-Za-z\s.#']+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Parkway|Hwy|Highway|Cir(?:cle)?|Ter(?:race)?)[.,]?\s*,?\s*[A-Za-z\s]+,\s*[A-Z]{2}(?:\s+\d{5})?)/m;
              const otMatch = normalizedMd.match(otAddrRegex);
              if (otMatch) {
                r._address = otMatch[1].trim().replace(/,\s*,/g, ",");
                const cityM = r._address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
                r._addressCity = cityM ? cityM[1].trim() : undefined;
                otAddressFound = true;
                console.log(`  Address extracted (OT normalized regex) for ${r.name}: ${r._address}`);
              }
            }
          }

          if (!otAddressFound) {
            // Regex fallback on normalized markdown (all platforms)
            const addrRegex = /(\d{1,5}\s+[A-Z][A-Za-z\s.]+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Hwy|Cir(?:cle)?|Ter(?:race)?)[.,]?\s+[A-Z][A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/m;
            const addrMatch = normalizedMd.match(addrRegex);
            if (addrMatch) {
              r._address = addrMatch[1].trim();
              const cityMatch2 = r._address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
              r._addressCity = cityMatch2 ? cityMatch2[1].trim() : undefined;
              console.log(`  Address extracted (normalized regex+zip) for ${r.name}: ${r._address}`);
            } else {
              const addrRegexNoZip = /(\d{1,5}\s+[A-Z][A-Za-z\s.]+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Parkway|Hwy|Highway|Cir(?:cle)?|Ter(?:race)?)[.,]?\s+[A-Za-z\s]+,\s*[A-Z]{2})\b/m;
              const addrMatch2 = normalizedMd.match(addrRegexNoZip);
              if (addrMatch2) {
                r._address = addrMatch2[1].trim();
                const cityMatch3 = r._address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
                r._addressCity = cityMatch3 ? cityMatch3[1].trim() : undefined;
                console.log(`  Address extracted (normalized no-zip regex) for ${r.name}: ${r._address}`);
              } else {
                const addrRegexBroad = /(\d{1,5}\s+[A-Za-z\s.#']+,\s*[A-Za-z\s]+,\s*[A-Z]{2}(?:\s+\d{5})?)/m;
                const addrMatch3 = normalizedMd.match(addrRegexBroad);
                if (addrMatch3) {
                  // Validate broad match: require at least 3 words before first comma
                  // AND a street-type word to avoid false positives like "101 Steak, Atlanta, GA"
                  const broadCandidate = addrMatch3[1].trim();
                  const preComma = broadCandidate.split(",")[0].trim();
                  const wordCount = preComma.split(/\s+/).length;
                  const hasStreetWord = /\b(St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Parkway|Hwy|Highway|Cir(?:cle)?|Ter(?:race)?|NE|NW|SE|SW)\b/i.test(preComma);
                  if (wordCount >= 3 && hasStreetWord) {
                    r._address = broadCandidate;
                    const cityMatch4 = r._address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*,\s*[A-Z]{2}/);
                    r._addressCity = cityMatch4 ? cityMatch4[1].trim() : undefined;
                    console.log(`  Address extracted (broad regex) for ${r.name}: ${r._address}`);
                  } else {
                    console.log(`  [ADDR_MISS] Broad regex match rejected (words=${wordCount}, streetWord=${hasStreetWord}: "${preComma}") for ${r.name} [${r.platform}]`);
                  }
                } else {
                  console.log(`  [ADDR_MISS] No address pattern found for ${r.name} [${r.platform}]`);
                }
              }
            }
          }
        }
      }

      // Extract image from scrape metadata if not already set
      if (!r.imageUrl) {
        const meta = data?.data?.metadata || data?.metadata;
        const ogImg = meta?.ogImage || meta?.image || meta?.["og:image"] || null;
        if (ogImg && typeof ogImg === "string" && ogImg.startsWith("http")) {
          r.imageUrl = ogImg;
        }
      }

      const lower = markdown.toLowerCase();

      // Check for "no availability" signals
      if (NO_AVAILABILITY_SIGNALS.some((signal) => lower.includes(signal))) {
        console.log(`No availability for ${r.name} [${r.platform}]`);
        return null;
      }

      // TWO-TIER CUISINE/DISH RELEVANCE CHECK (applies to ALL platforms).
      // For DISH searches (e.g. "oysters"): accept if page mentions the dish keyword
      // OR the parent cuisine type (e.g. "seafood"). A seafood restaurant likely serves
      // oysters even if "oysters" isn't on the booking page.
      // For CUISINE searches (e.g. "seafood"): standard check — page must mention the cuisine.
      const cuisineFilter = (params.cuisine || "").toLowerCase().replace(/\b(restaurant|restaurants|food)\b/g, "").trim();
      const MEAL_AS_CUISINE_VERIFY = new Set(["brunch", "breakfast"]);
      const MEAL_TERMS_SET = new Set(["dinner", "lunch", "supper", "meal", "eat", "eating", "dining"]);
      const cuisineTokens = cuisineFilter.split(/\s+/).filter(Boolean).filter(t => !MEAL_TERMS_SET.has(t) || MEAL_AS_CUISINE_VERIFY.has(t));
      
      // Build expanded check tokens: include parent cuisine types for dish searches
      const GENERIC_VERIFY_TOKENS = new Set(["american", "asian", "european", "mediterranean"]);
      // Filter out amenity terms (patio, rooftop, outdoor, etc.) from cuisine verification —
      // these are handled by the dedicated amenity check downstream (line ~2172).
      const AMENITY_TERM_SET = new Set(Object.keys(AMENITY_KEYWORDS));
      let verifyTokens = cuisineTokens.filter(t => !AMENITY_TERM_SET.has(t));
      if (params.dishKeyword) {
        const parentCuisines = DISH_TO_CUISINE_MAP[params.dishKeyword] || [];
        for (const pc of parentCuisines) {
          if (!verifyTokens.includes(pc)) verifyTokens.push(pc);
        }
        if (params.cuisineType && !verifyTokens.includes(params.cuisineType)) {
          verifyTokens.push(params.cuisineType);
        }
        // Remove overly generic tokens for dish searches
        verifyTokens = verifyTokens.filter(t => !GENERIC_VERIFY_TOKENS.has(t));
      }
      
      if (verifyTokens.length > 0) {
        const isDishSearch = !!params.dishKeyword;
        // DEFER cuisine check for OpenTable — OT page scrapes are often too thin
        // to contain cuisine keywords. Check AFTER slot parsing instead.
        if (isOT) {
          // Store tokens for post-slot cuisine check
          (r as any)._deferredCuisineTokens = verifyTokens;
          (r as any)._deferredIsDishSearch = isDishSearch;
        } else {
        const restaurantName = (r.name || "").toLowerCase();
        const pageText = `${lower} ${restaurantName}`;

        const tokenMatches = (text: string, token: string): boolean => {
          if (text.includes(token)) return true;
          const singular = token.endsWith("s") ? token.slice(0, -1) : null;
          const plural = !token.endsWith("s") ? token + "s" : null;
          if (singular && text.includes(singular)) return true;
          if (plural && text.includes(plural)) return true;
          return false;
        };

        const countOccurrences = (text: string, token: string): number => {
          let count = 0;
          const variants = [token];
          if (token.endsWith("s")) variants.push(token.slice(0, -1));
          else variants.push(token + "s");
          for (const v of variants) {
            let idx = 0;
            while ((idx = text.indexOf(v, idx)) !== -1) { count++; idx += v.length; }
          }
          return count;
        };

        let hasMatch: boolean;

        // Yelp candidates: since discovery is now via scraping (no category metadata),
        // use page-text matching like other platforms. Yelp reservation pages often
        // have cuisine info in the page header/description area.
        if (r.platform === "yelp") {
          // Check restaurant name, page header (first 500 chars), and frequency in full text
          if (verifyTokens.some((token) => tokenMatches(restaurantName, token))) {
            hasMatch = true;
          } else {
            const headerText = lower.slice(0, 500);
            hasMatch = verifyTokens.some((token) => {
              if (tokenMatches(headerText, token)) return true;
              if (countOccurrences(lower, token) >= 2) return true; // slightly looser than non-yelp (2 vs 3)
              return false;
            });
          }
          // For meal-as-cuisine terms (brunch, breakfast), also check scraped text
          if (!hasMatch) {
            const mealTokens = verifyTokens.filter(t => MEAL_AS_CUISINE_VERIFY.has(t));
            if (mealTokens.length > 0) {
              hasMatch = mealTokens.some((token) => tokenMatches(pageText, token));
            }
          }
        } else if (isDishSearch) {
          // Dish search: keep current loose matching — any mention passes
          hasMatch = verifyTokens.some((token) => tokenMatches(pageText, token));
        } else {
          // Check if any tokens are meal-as-cuisine terms — use loose matching for those
          const mealTokens = verifyTokens.filter(t => MEAL_AS_CUISINE_VERIFY.has(t));
          const nonMealTokens = verifyTokens.filter(t => !MEAL_AS_CUISINE_VERIFY.has(t));
          
          // Meal-as-cuisine tokens (brunch, breakfast): loose match — any mention in page/reviews passes
          const mealMatch = mealTokens.length > 0 && mealTokens.some((token) => tokenMatches(pageText, token));
          
          // Non-meal tokens: standard strict matching (name, header, or 3+ frequency)
          const nonMealMatch = nonMealTokens.length > 0 && nonMealTokens.some((token) => {
            if (tokenMatches(restaurantName, token)) return true;
            const headerText = lower.slice(0, 500);
            if (tokenMatches(headerText, token)) return true;
            if (countOccurrences(lower, token) >= 3) return true;
            return false;
          });
          
          hasMatch = mealMatch || nonMealMatch;
          // If ONLY meal tokens exist and none matched, hasMatch stays false (correct)
          // If ONLY non-meal tokens exist, nonMealMatch decides (original behavior)
        }

        if (!hasMatch) {
          const label = isDishSearch
            ? `dish="${params.dishKeyword}" OR cuisineType="${params.cuisineType}"`
            : cuisineTokens.join(", ");
          console.log(`✗ ${r.name} [${r.platform}] — failed cuisine relevance (${isDishSearch ? "dish" : "category"}) for: ${label} (checked: ${verifyTokens.join(", ")})`);
          return null;
        }
        } // end non-OT cuisine check
      }

      // RELEVANCE CHECK: If user searched for an amenity (rooftop, patio, etc.),
      // verify the restaurant page actually mentions it. Zero extra latency — uses already-scraped markdown.
      if (amenityTerms.length > 0 && !checkRelevanceInMarkdown(markdown, amenityTerms)) {
        console.log(`✗ ${r.name} [${r.platform}] — failed relevance check for: ${amenityTerms.join(", ")}`);
        return null;
      }

      // (structuredTimes removed — jsonData/extract format no longer used)

      // ── Strip non-booking sections from markdown for regex fallback ──
      // Remove "Need to Know", "Hours of Operation", "About", etc. sections
      let bookingMarkdown = markdown;
      const sectionCutMarkers = [
        "need to know", "hours of operation", "about the restaurant",
        "about this restaurant", "cross street", "additional info", "special features",
        "location\\s*(?:&|and|&amp;)?\\s*hours", "amenities and more", "about the business",
      ];
      for (const marker of sectionCutMarkers) {
        const markerRegex = new RegExp(`(?:^|\\n)#+?\\s*${marker}|(?:^|\\n)\\*\\*${marker}`, "im");
        const idx = bookingMarkdown.search(markerRegex);
        if (idx > 200) { // Only cut if there's enough content before
          bookingMarkdown = bookingMarkdown.substring(0, idx);
        }
      }

      // Strip lines that look like operating-hours tables (e.g. "| Mon | - 4:00 PM - 9:00 PM |")
      // These contain close/open times that get falsely extracted as reservation slots
      if (isYelp) {
        bookingMarkdown = bookingMarkdown.split("\n").filter(line => {
          // Match day-of-week table rows: "| Mon | - 4:00 PM - 9:00 PM |"
          if (/\|\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s*\|/i.test(line)) return false;
          // Match "Closed now" or standalone "Closed"
          if (/^\s*\|?\s*Closed\s*(now)?\s*\|?\s*$/i.test(line)) return false;
          return true;
        }).join("\n");
      }

      // Determine meal window from requested time
      const [reqH] = params.time.split(":").map(Number);
      let windowStart: number;
      let windowEnd: number;
      let mealLabel: string;

      // Meal label still used for Resy section selection
      if (reqH < 10) {
        mealLabel = "breakfast";
      } else if (reqH < 12) {
        mealLabel = "brunch";
      } else if (reqH < 16) {
        mealLabel = "lunch";
      } else {
        mealLabel = "dinner";
      }

      // Universal ±2 hour window from requested time
      const reqMinsForWindow = reqH * 60 + (parseInt(params.time.split(":")[1]) || 0);
      windowStart = Math.max(0, reqMinsForWindow - 120);    // -2 hours
      windowEnd = Math.min(1439, reqMinsForWindow + 120);    // +2 hours

      let foundTimes: { time: string; minutes: number }[] = [];
      const seenTimes = new Set<string>();
      const [reqHour, reqMin] = params.time.split(":").map(Number);
      const requestedMinutes = reqHour * 60 + (reqMin || 0);

      const parseTimeStr = (raw: string): { time: string; minutes: number } | null => {
        const m12 = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
        if (!m12) return null;
        const rawH = parseInt(m12[1]);
        const mins = parseInt(m12[2]);
        const ampm = m12[3].toLowerCase();
        let h24 = rawH;
        if (ampm === "pm" && rawH !== 12) h24 += 12;
        if (ampm === "am" && rawH === 12) h24 = 0;
        const totalMin = h24 * 60 + mins;
        const displayH = h24 % 12 || 12;
        const displayAmpm = h24 >= 12 ? "PM" : "AM";
        const formatted = `${displayH}:${mins.toString().padStart(2, "0")} ${displayAmpm}`;
        return { time: formatted, minutes: totalMin };
      };

       if (isYelp) {
        const timeRegex = /(\d{1,2}:\d{2}\s*(?:AM|PM))/gi;
        const source = `${markdown}\n${html}`;
        const allTimesInSource = source.match(timeRegex) || [];

        const hoursRangeRegex = /\d{1,2}:\d{2}\s*(?:AM|PM)\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:AM|PM)/gi;
        const hoursRanges = source.match(hoursRangeRegex) || [];
        const hoursTimesSet = new Set<string>();
        for (const range of hoursRanges) {
          const rangeMatches = range.match(timeRegex) || [];
          for (const t of rangeMatches) hoursTimesSet.add(t.trim().toUpperCase());
        }

        for (const rawTime of allTimesInSource) {
          const trimmed = rawTime.trim();
          if (hoursTimesSet.has(trimmed.toUpperCase())) continue;
          const parsed = parseTimeStr(trimmed);
          if (parsed && !seenTimes.has(parsed.time)) {
            seenTimes.add(parsed.time);
            foundTimes.push(parsed);
          }
        }

        console.log(`  ${r.name} [yelp]: Firecrawl extracted times: ${foundTimes.length} — ${foundTimes.map(t => t.time).slice(0, 8).join(", ")}`);

        if (!yelpHasConcreteSlotEvidence) {
          foundTimes = [];
        }
      }

      // ── OPENTABLE-SPECIFIC: Parse "Select a time" section ──
      // Helper: parse OT slots from markdown content
      const parseOTSlots = (md: string): { time: string; minutes: number }[] => {
        const slots: { time: string; minutes: number }[] = [];
        const seen = new Set<string>();
        
        const selectTimeIdx = md.indexOf("### Select a time");
        const selectTimeLower = md.toLowerCase().indexOf("select a time");
        
        if (selectTimeIdx !== -1 || selectTimeLower !== -1) {
          const sectionStart = selectTimeIdx !== -1 ? selectTimeIdx : selectTimeLower;
          const sectionEnd = md.indexOf("\n#", sectionStart + 10);
          const otSection = md.substring(sectionStart, sectionEnd !== -1 ? sectionEnd : sectionStart + 2000);
          
          const cleanedSection = otSection.replace(/\+\d{1,3}(,\d{3})?\s*pts/gi, '');
          
          // Pattern A: list items
          const otListRegex = /^[\s]*[-•*]\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/gm;
          let otMatch;
          while ((otMatch = otListRegex.exec(cleanedSection)) !== null) {
            const afterMatch = cleanedSection.substring(otMatch.index, otMatch.index + otMatch[0].length + 30);
            if (/notify/i.test(afterMatch)) continue;
            const parsed = parseTimeStr(otMatch[1]);
            if (parsed && !seen.has(parsed.time)) { seen.add(parsed.time); slots.push(parsed); }
          }
          
          // Pattern B: link-wrapped times
          const otLinkRegex = /\[(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\]\([^)]*\)/gi;
          let otLinkMatch;
          while ((otLinkMatch = otLinkRegex.exec(cleanedSection)) !== null) {
            const afterMatch = cleanedSection.substring(otLinkMatch.index, otLinkMatch.index + otLinkMatch[0].length + 30);
            if (/notify/i.test(afterMatch)) continue;
            const parsed = parseTimeStr(otLinkMatch[1]);
            if (parsed && !seen.has(parsed.time)) { seen.add(parsed.time); slots.push(parsed); }
          }
          
          // Pattern C: standalone times
          if (slots.length === 0) {
            const otStandaloneRegex = /^\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\s*$/gm;
            let otStandalone;
            while ((otStandalone = otStandaloneRegex.exec(cleanedSection)) !== null) {
              const parsed = parseTimeStr(otStandalone[1]);
              if (parsed && !seen.has(parsed.time)) { seen.add(parsed.time); slots.push(parsed); }
            }
          }
        }
        return slots;
      };

      // Helper: parse OT slots from raw HTML (more reliable than markdown for JS-rendered widgets)
      const parseOTSlotsFromHTML = (html: string): { time: string; minutes: number }[] => {
        const slots: { time: string; minutes: number }[] = [];
        const seen = new Set<string>();
        
        // OT renders time slots as buttons with data-test="time-button" or similar,
        // or as list items within a time-selection section.
        // Pattern 1: button elements with time text like ">6:30 PM<" or ">7:00 PM<"
        // Look for the availability/time-slot section first
        const timeSelectionIdx = html.indexOf('Select a time');
        if (timeSelectionIdx === -1) return slots;
        
        // Extract a chunk around the time selection area
        const sectionChunk = html.substring(timeSelectionIdx, Math.min(html.length, timeSelectionIdx + 5000));
        
        // Find all time patterns in this section — buttons, links, or plain text
        const htmlTimeRegex = /(\d{1,2}:\d{2}\s*(?:AM|PM))/gi;
        let htmlMatch;
        while ((htmlMatch = htmlTimeRegex.exec(sectionChunk)) !== null) {
          // Skip if near "Notify" (waitlist, not bookable)
          const context = sectionChunk.substring(Math.max(0, htmlMatch.index - 50), htmlMatch.index + htmlMatch[0].length + 50);
          if (/notify/i.test(context)) continue;
          // Skip dropdown/picker times (those appear in long concatenated lists)
          if (/\d{1,2}:\d{2}\s*(?:AM|PM)\d{1,2}:\d{2}/i.test(context)) continue;
          
          const parsed = parseTimeStr(htmlMatch[1]);
          if (parsed && !seen.has(parsed.time)) {
            seen.add(parsed.time);
            slots.push(parsed);
          }
        }
        return slots;
      };
      
      if (isOT) {
        const otVerifyStart = Date.now();
        // Early exit: if page looks blocked (tiny markdown = anti-bot), skip immediately
        const mdLen = markdown.length;
        const looksBlocked = mdLen < 300 || /access denied|permission|reference #/i.test(markdown);
        if (looksBlocked && !markdown.toLowerCase().includes("select a time")) {
          console.log(`✗ ${r.name} [opentable] — blocked (mdLen=${mdLen}), skipping`);
          return null;
        }
        
        // First pass: parse OT slots from markdown
        foundTimes = parseOTSlots(markdown);
        // Populate seenTimes from markdown slots BEFORE HTML merge to avoid dupes
        foundTimes.forEach(t => seenTimes.add(t.time));
        
        const hadSelectSection = markdown.toLowerCase().includes("select a time");
        
        if (foundTimes.length > 0) {
          console.log(`  ${r.name} [opentable]: extracted ${foundTimes.length} times from md: ${foundTimes.map(t=>t.time).join(", ")}`);
        }
        
        // Second pass: try HTML parser if markdown had no slots
        if (foundTimes.length === 0 && html) {
          const htmlSlots = parseOTSlotsFromHTML(html);
          for (const s of htmlSlots) {
            if (!seenTimes.has(s.time)) { seenTimes.add(s.time); foundTimes.push(s); }
          }
          if (foundTimes.length > 0) {
            console.log(`  ${r.name} [opentable]: extracted ${foundTimes.length} times from HTML: ${foundTimes.map(t=>t.time).join(", ")}`);
          }
        }
        
        // If still no OT-specific slots found, strip dropdown noise and fall through to generic regex
        if (foundTimes.length === 0) {
          const lines = bookingMarkdown.split("\n");
          const cleanedLines = lines.filter(line => {
            const timeMatches = line.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/g);
            return !timeMatches || timeMatches.length < 10;
          });
          bookingMarkdown = cleanedLines.join("\n");
          console.log(`  ${r.name} [opentable]: no slots from "Select a time", falling through to generic regex (dropdown noise stripped) | selectSection=${hadSelectSection}, mdLen=${mdLen}, blocked=${looksBlocked}`);
        }
        
        // Apply ±2h OT time window
        if (foundTimes.length > 0) {
          const otWindowStart = windowStart;
          const otWindowEnd = windowEnd;
          
          const otFiltered = foundTimes.filter(t => t.minutes >= otWindowStart && t.minutes <= otWindowEnd);
          
          if (otFiltered.length > 0) {
            otFiltered.sort((a, b) => Math.abs(a.minutes - requestedMinutes) - Math.abs(b.minutes - requestedMinutes));
            const top5 = otFiltered.slice(0, 5).sort((a, b) => a.minutes - b.minutes);
            
            // Deferred cuisine check for OT: now that we have real slots, apply cuisine filter
            const deferredTokens = (r as any)._deferredCuisineTokens as string[] | undefined;
            if (deferredTokens && deferredTokens.length > 0) {
              const otName = (r.name || "").toLowerCase();
              const otPageText = `${lower} ${otName}`;
              const otIsDish = (r as any)._deferredIsDishSearch as boolean;
              // Relaxed check for OT: name match OR any token in page OR just accept if OT page is thin
              const otHasMatch = deferredTokens.some(token => {
                if (otPageText.includes(token)) return true;
                const singular = token.endsWith("s") ? token.slice(0, -1) : null;
                if (singular && otPageText.includes(singular)) return true;
                const plural = !token.endsWith("s") ? token + "s" : null;
                if (plural && otPageText.includes(plural)) return true;
                return false;
              });
              // If page is very thin (< 1000 chars), trust the discovery query's relevance
              if (!otHasMatch && mdLen > 1000) {
                console.log(`✗ ${r.name} [opentable] — deferred cuisine check failed (${deferredTokens.join(", ")}), ${Date.now() - otVerifyStart}ms`);
                return null;
              }
              if (!otHasMatch) {
                console.log(`  ${r.name} [opentable]: thin page (${mdLen} chars), trusting discovery relevance`);
              }
            }
            
            r.timeSlots = top5.map(t => ({ time: t.time }));
            console.log(`✓ Verified ${r.name} [opentable] — ${top5.length} slots in OT window (${Math.floor(otWindowStart/60)}:${(otWindowStart%60).toString().padStart(2,"0")}–${Math.floor(otWindowEnd/60)}:${(otWindowEnd%60).toString().padStart(2,"0")}): ${top5.map(t => t.time).join(", ")} | ${Date.now() - otVerifyStart}ms`);
            return r;
          } else {
            console.log(`✗ ${r.name} [opentable] — found ${foundTimes.length} slots but none in OT window (${Math.floor(otWindowStart/60)}:${(otWindowStart%60).toString().padStart(2,"0")}–${Math.floor(otWindowEnd/60)}:${(otWindowEnd%60).toString().padStart(2,"0")}). Found: ${foundTimes.map(t => t.time).join(", ")} | ${Date.now() - otVerifyStart}ms`);
            return null;
          }
        }
      }

      // ── RESY-SPECIFIC: Parse meal section from markdown directly ──
      if (isResy) {
        const mealSectionRegex = new RegExp(
          `## (?:${mealLabel}|all day)([\\s\\S]*?)(?=##|$)`, "i"
        );
        const mealMatch = markdown.match(mealSectionRegex);
        
        if (mealMatch) {
          const mealSection = mealMatch[1];
          const hasNotify = /\bnotify\b/i.test(mealSection);
          
          if (hasNotify) {
            console.log(`✗ ${r.name} [resy] — "${mealLabel}" section contains Notify marker, rejecting`);
            return null;
          }
          
          const resyTimeRegex = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
          let resyMatch;
          while ((resyMatch = resyTimeRegex.exec(mealSection)) !== null) {
            const parsed = parseTimeStr(resyMatch[0]);
            if (parsed && !seenTimes.has(parsed.time)) {
              seenTimes.add(parsed.time);
              foundTimes.push(parsed);
            }
          }
          
          if (foundTimes.length > 0) {
            console.log(`  ${r.name} [resy]: extracted ${foundTimes.length} times from "${mealLabel}" section: ${foundTimes.map(t=>t.time).join(", ")}`);
          } else {
            console.log(`✗ ${r.name} [resy] — no times in "${mealLabel}" section`);
            return null;
          }
        } else {
          if (/\bnotify\b/i.test(markdown)) {
            console.log(`✗ ${r.name} [resy] — no "${mealLabel}" section and Notify detected`);
            return null;
          }
        }
      }

      // Extract all time slots from the page
      const timeSlotRegex12 = /\b(\d{1,2}):(\d{2})\s?(am|pm)\b/gi;
      const timeSlotRegex24 = /\b((?:[01]?\d|2[0-3]):([0-5]\d))\b/g;
      const hasBookingAction = /\b(book|reserve|select|notify)\b/i.test(bookingMarkdown);
      // Tightened: require actual Yelp widget markers, not just the generic word "reservations"
      // Yelp reservation markers — relaxed since discovery uses Yelp's reservation search filter
      const hasYelpAvailabilityMarker = isYelp && /\b(find\s+a\s+table|select\s+(a\s+)?time|choose\s+(a\s+)?time|request\s+a\s+reservation|book\s+a\s+table|takes?\s+reservations?|make\s+a\s+reservation|party\s+size|reservation|available\s+times?)\b/i.test(markdown);

      // ── STRATEGY 1: For Resy, times already extracted from meal section above ──
      // ── STRATEGY 2: Regex on cleaned booking markdown (non-Resy only) ──
      if (!isResy && !isYelp && foundTimes.length === 0) {
        let match12;
        while ((match12 = timeSlotRegex12.exec(bookingMarkdown)) !== null) {
          // Context check: skip times near "notify", "sold out", "waitlist"
          const ctxStart = Math.max(0, match12.index - 60);
          const ctxEnd = Math.min(bookingMarkdown.length, match12.index + match12[0].length + 60);
          const context = bookingMarkdown.substring(ctxStart, ctxEnd).toLowerCase();
          if (/notify|sold\s*out|waitlist|wait\s*list|unavailable/i.test(context)) {
            continue;
          }

          const rawH = parseInt(match12[1]);
          const m = parseInt(match12[2]);
          const ampm = match12[3].toLowerCase();
          let h24 = rawH;
          if (ampm === "pm" && rawH !== 12) h24 += 12;
          if (ampm === "am" && rawH === 12) h24 = 0;
          const totalMin = h24 * 60 + m;
          const displayH = h24 % 12 || 12;
          const displayAmpm = h24 >= 12 ? "PM" : "AM";
          const formatted = `${displayH}:${m.toString().padStart(2, "0")} ${displayAmpm}`;

          if (seenTimes.has(formatted)) continue;
          seenTimes.add(formatted);
          foundTimes.push({ time: formatted, minutes: totalMin });
        }

        // If no 12h times found but 24h times + booking action exist, try 24h
        if (foundTimes.length === 0 && hasBookingAction) {
          let match24;
          while ((match24 = timeSlotRegex24.exec(bookingMarkdown)) !== null) {
            const ctxStart = Math.max(0, match24.index - 60);
            const ctxEnd = Math.min(bookingMarkdown.length, match24.index + match24[0].length + 60);
            const context = bookingMarkdown.substring(ctxStart, ctxEnd).toLowerCase();
            if (/notify|sold\s*out|waitlist|wait\s*list|unavailable/i.test(context)) {
              continue;
            }

            const [hStr, mStr] = match24[1].split(":");
            const totalMin = parseInt(hStr) * 60 + parseInt(mStr);
            if (totalMin >= 360 && totalMin <= 1380) {
              const displayH = parseInt(hStr) % 12 || 12;
              const displayAmpm = parseInt(hStr) >= 12 ? "PM" : "AM";
              const formatted = `${displayH}:${mStr} ${displayAmpm}`;
              if (seenTimes.has(formatted)) continue;
              seenTimes.add(formatted);
              foundTimes.push({ time: formatted, minutes: totalMin });
            }
          }
        }
      }

      if (isYelp && foundTimes.length === 0) {
        console.log(`✗ ${r.name} [yelp] — no verified reservation slots found after Firecrawl extraction`);
        return null;
      }

      // C. Filter times to those within the meal window
      let matchingTimes = foundTimes.filter((t) =>
        t.minutes >= windowStart && t.minutes <= windowEnd
      );

      // D. Sort by proximity to requested time, keep closest 5
      matchingTimes.sort((a, b) =>
        Math.abs(a.minutes - requestedMinutes) - Math.abs(b.minutes - requestedMinutes)
      );
      matchingTimes = matchingTimes.slice(0, 5);

      // E. Re-sort chronologically for display
      matchingTimes.sort((a, b) => a.minutes - b.minutes);

      if (matchingTimes.length > 0) {
        // ── YELP OPERATING-HOURS REJECTION ──
        // If exactly 2 slots spanning 4+ hours, these are likely open/close hours, not real slots
        // Real reservation slots have granular 15-30 min spacing
        if (isYelp && matchingTimes.length <= 2) {
          if (matchingTimes.length === 2) {
            const gap = Math.abs(matchingTimes[1].minutes - matchingTimes[0].minutes);
            if (gap >= 180) { // 3+ hours apart = operating hours
              console.log(`✗ ${r.name} [yelp] — rejected: 2 slots ${gap}min apart (likely operating hours): ${matchingTimes.map(t=>t.time).join(", ")}`);
              return null;
            }
          } else {
            // Only 1 slot from Yelp — likely an open/close time, not a real bookable slot
            console.log(`✗ ${r.name} [yelp] — rejected: only 1 slot (likely operating hours): ${matchingTimes[0].time}`);
            return null;
          }
        }
        

        r.timeSlots = matchingTimes.map((t) => ({ time: t.time }));
        console.log(`✓ Verified ${r.name} [${r.platform}] — ${matchingTimes.length} ${mealLabel} slots (${windowStart/60|0}:${(windowStart%60).toString().padStart(2,"0")}–${windowEnd/60|0}:${(windowEnd%60).toString().padStart(2,"0")}): ${matchingTimes.map(t => t.time).join(", ")}`);
        return r;
      }

      // Yelp trust-marker fallback removed — slots now come from search page discovery

      // OpenTable: Do NOT fabricate fallback times from booking markers.
      // If real slots exist but are outside window, or parser found nothing, reject.
      if (isOT && foundTimes.length === 0) {
        console.log(`✗ ${r.name} [opentable] — no parseable time slots found, rejecting (no fabricated fallback) | selectSection=${markdown.toLowerCase().includes("select a time")}, mdLen=${markdown.length}, blocked=${markdown.length < 200 || /access denied/i.test(markdown)}`);
        return null;
      }

      if (foundTimes.length > 0) {
        console.log(`✗ ${r.name} [${r.platform}] — found ${foundTimes.length} slots but none in ${mealLabel} window (found: ${foundTimes.map(t => t.time).join(", ")})`);
      } else {
        console.log(`No time slots for ${r.name} [${r.platform}]`);
      }
      return null;
    } catch (err) {
      console.log(`Verify error for ${r.name} [${r.platform}]:`, err);
      return null;
    }
  }));

  // Diagnostic: per-provider timeout summary (helps spot Firecrawl contention)
  const totalCands = candidates.length;
  const platformCands = candidates.reduce<Record<string, number>>((acc, c) => {
    acc[c.platform] = (acc[c.platform] || 0) + 1; return acc;
  }, {});
  const timeoutSummary = Object.entries(timeoutCounts)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${p}: ${n}/${platformCands[p] || 0}`)
    .join(", ");
  if (timeoutSummary) {
    console.log(`[VERIFY] Scrape timeouts — ${timeoutSummary} (of ${totalCands} total candidates)`);
  }

  return checked.filter(Boolean) as Restaurant[];
}

// ─── Amenity / experience keywords ───
// These are NOT standard cuisines — they describe an experience or venue feature.
// When a user searches for these, we must verify the restaurant actually offers it.
// "rooftop" is STRICT — must specifically mention rooftop, not just generic outdoor.
// "patio" and "outdoor" are merged — either term matches the combined synonym set.
const AMENITY_KEYWORDS: Record<string, string[]> = {
  rooftop: ["rooftop", "roof top", "roof deck", "rooftop bar", "rooftop dining", "rooftop patio", "rooftop terrace", "rooftop lounge", "rooftop restaurant", "sky bar", "sky deck", "sky lounge"],
  waterfront: ["waterfront", "water front", "lakefront", "riverside", "oceanfront", "harborside", "dockside", "bayfront"],
  patio: ["patio", "outdoor dining", "outdoor seating", "al fresco", "garden dining", "sidewalk cafe", "sidewalk café", "outdoor", "outside dining", "outside seating", "open air", "open-air", "courtyard", "terrace", "beer garden", "biergarten", "covered patio", "heated patio", "dog-friendly patio"],
  outdoor: ["patio", "outdoor dining", "outdoor seating", "al fresco", "garden dining", "sidewalk cafe", "sidewalk café", "outdoor", "outside dining", "outside seating", "open air", "open-air", "courtyard", "terrace", "beer garden", "biergarten", "covered patio", "heated patio"],
  brunch: ["brunch", "brunch menu", "bottomless brunch", "weekend brunch"],
  breakfast: ["breakfast", "morning menu", "breakfast menu"],
  "live music": ["live music", "live band", "live jazz", "live entertainment", "live performance"],
  "private dining": ["private dining", "private room", "private event", "private party"],
  "happy hour": ["happy hour", "drink specials", "bar specials"],
};

function extractAmenityTerms(cuisine: string, query: string): string[] {
  const combined = `${cuisine} ${query}`.toLowerCase();
  const matched: string[] = [];
  for (const [keyword] of Object.entries(AMENITY_KEYWORDS)) {
    if (combined.includes(keyword)) {
      // "outdoor" and "patio" share synonyms — normalize to "patio" to avoid double-filtering
      if (keyword === "outdoor") {
        if (!matched.includes("patio")) matched.push("patio");
      } else if (keyword === "patio") {
        if (!matched.includes("patio")) matched.push("patio");
      } else {
        matched.push(keyword);
      }
    }
  }
  return matched;
}

function checkRelevanceInMarkdown(markdown: string, amenities: string[]): boolean {
  if (amenities.length === 0) return true; // no amenity filter needed
  const lower = markdown.toLowerCase();
  // Restaurant page must mention at least ONE synonym for each required amenity
  return amenities.every((amenity) => {
    // For "rooftop", use STRICT synonyms only — don't match generic outdoor/patio terms
    const STRICT_ROOFTOP = ["rooftop", "roof top", "roof deck", "rooftop bar", "rooftop dining",
      "rooftop patio", "rooftop terrace", "rooftop lounge", "rooftop restaurant",
      "sky bar", "sky deck", "sky lounge"];
    const synonyms = amenity === "rooftop" ? STRICT_ROOFTOP : (AMENITY_KEYWORDS[amenity] || [amenity]);
    return synonyms.some((syn) => lower.includes(syn));
  });
}

// ─── Utilities ───

function dedupeByName(results: Restaurant[]): Restaurant[] {
  // Strip common suffixes/platform noise to normalize names for comparison
  const STRIP_WORDS = /\b(restaurant|ristorante|trattoria|pizzeria|steakhouse|bar|grill|lounge|cafe|café|bistro|tavern|kitchen|eatery|chophouse|house)\b/gi;

  function normalizeForDedup(name: string, city: string): string {
    return name
      .toLowerCase()
      .replace(/\s*-\s*(atlanta|austin|boston|charlotte|chicago|dallas|denver|houston|los angeles|miami|nashville|new york|phoenix|portland|san francisco|seattle|washington|dc|nyc|la)\b/gi, "")
      .replace(new RegExp(`\\b${city.toLowerCase()}\\b`, "g"), "")
      .replace(STRIP_WORDS, "")
      .replace(/[^a-z0-9]/g, "");
  }

  const kept: Restaurant[] = [];
  const keys: string[] = [];
  // Infer city from the first result or use empty
  const city = results[0]?.neighborhood || "";

  for (const r of results) {
    const key = normalizeForDedup(r.name, city);
    const isDupe = keys.some((existing) =>
      existing === key || existing.startsWith(key) || key.startsWith(existing)
    );
    if (!isDupe) {
      kept.push(r);
      keys.push(key);
    }
  }
  return kept.slice(0, 60);
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

// ─── Provider Adapters ───

const resyAdapter: ProviderAdapter = {
  platform: "resy",
  async discover(params, keys, amenityTerms) {
    const raw = await searchFirecrawl(params, keys.firecrawlKey, "resy", amenityTerms);
    return normalizeCandidates("resy", raw, params);
  },
  async verify(candidates, params, keys, amenityTerms) {
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms, keys._startTime);
  },
};

const opentableAdapter: ProviderAdapter = {
  platform: "opentable",
  async discover(params, keys, amenityTerms) {
    const raw = await searchFirecrawl(params, keys.firecrawlKey, "opentable", amenityTerms);
    return normalizeCandidates("opentable", raw, params);
  },
  async verify(candidates, params, keys, amenityTerms) {
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms, keys._startTime);
  },
};

const yelpAdapter: ProviderAdapter = {
  platform: "yelp",
  async discover(params, keys, amenityTerms) {
    const raw = await searchFirecrawl(params, keys.firecrawlKey, "yelp", amenityTerms);
    return normalizeCandidates("yelp", raw, params);
  },
  async verify(candidates, params, keys, amenityTerms) {
    console.log(`Yelp verify: checking ${candidates.length} candidates on reservation pages for real time slots`);
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms, keys._startTime);
  },
};
