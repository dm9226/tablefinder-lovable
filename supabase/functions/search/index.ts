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
  cuisineType: string;   // broad category: "seafood", "italian", "japanese", ""
  dishKeyword: string;   // specific dish/ingredient: "oysters", "lobster roll", ""
  date: string;
  time: string;
  partySize: number;
  city: string;
  state: string;
  lat?: number;
  lng?: number;
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
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PARSE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeQueryForParseCacheKey(query: string, location: string | undefined): string {
  // Normalize: lowercase, collapse whitespace, trim, include location hint
  const norm = (query || "").toLowerCase().replace(/\s+/g, " ").trim();
  const loc = (location || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm}|${loc}`;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

async function getCachedParse(queryHash: string): Promise<SearchParams | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/parse_cache?query_hash=eq.${encodeURIComponent(queryHash)}&select=parsed_params,created_at&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!resp.ok) { await resp.text(); return null; }
    const rows = await resp.json();
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    const age = Date.now() - new Date(row.created_at).getTime();
    if (age > PARSE_CACHE_TTL_MS) return null;
    return row.parsed_params as SearchParams;
  } catch (e) {
    console.error("Parse cache read error:", e);
    return null;
  }
}

async function setCachedParse(queryHash: string, queryText: string, location: string | undefined, params: SearchParams): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/parse_cache`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        query_hash: queryHash,
        query_text: queryText,
        parsed_params: params,
        location_hint: location || null,
      }),
    });
  } catch (e) {
    console.error("Parse cache write error:", e);
  }
}

function buildCacheKey(params: SearchParams): string {
  const parts = [
    (params.city || "").toLowerCase().trim(),
    (params.state || "").toLowerCase().trim(),
    (params.cuisine || "").toLowerCase().trim(),
    params.date,
    params.time,
    String(params.partySize),
  ];
  return parts.join("|");
}

async function getCachedResults(cacheKey: string): Promise<{ results: Restaurant[]; age: number } | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/search_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&select=results,updated_at&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (age > CACHE_TTL_MS) return null; // stale beyond TTL
    return { results: row.results || [], age };
  } catch (e) {
    console.error("Cache read error:", e);
    return null;
  }
}

async function setCachedResults(cacheKey: string, queryText: string, params: SearchParams, results: Restaurant[]): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/search_cache`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        cache_key: cacheKey,
        query_text: queryText,
        parsed_params: params,
        results,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Cache write error:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, lat, lng, location, cacheOnly } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    const YELP_API_KEY = Deno.env.get("YELP_API_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");

    // Step 1: Parse user query (caching DISABLED for testing)
    // TODO: Re-enable parse cache and search cache when testing is complete
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Build cache key from normalized params
    const cacheKey = buildCacheKey(params);

    // Cache-only mode: DISABLED for testing — always return empty so frontend does fresh search
    if (cacheOnly) {
      return new Response(
        JSON.stringify({ results: [], params, cached: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: Discover candidates from all platforms in parallel
    if (!YELP_API_KEY) {
      console.warn("YELP_API_KEY missing — skipping Yelp");
    }

    // Detect amenity/experience keywords BEFORE discovery so we can add them to search queries
    const amenityTerms = extractAmenityTerms(params.cuisine || "", query);
    if (amenityTerms.length > 0) {
      console.log(`Amenity relevance filter active for: ${amenityTerms.join(", ")}`);
    }

    const [resyCandidates, otCandidates, yelpCandidates] = await Promise.all([
      searchFirecrawl(params, FIRECRAWL_API_KEY, "resy", amenityTerms),
      searchFirecrawl(params, FIRECRAWL_API_KEY, "opentable", amenityTerms),
      YELP_API_KEY
        ? fetchYelpCandidates(params, YELP_API_KEY, amenityTerms)
        : Promise.resolve([] as Restaurant[]),
    ]);

    // Normalize Firecrawl results into Restaurant objects
    const resyRaw = normalizeCandidates("resy", resyCandidates, params);
    const otRaw = normalizeCandidates("opentable", otCandidates, params);

    const allCandidates = dedupeByName([...resyRaw, ...otRaw, ...yelpCandidates]);
    console.log(`Candidates — Resy: ${resyRaw.length}, OT: ${otRaw.length}, Yelp: ${yelpCandidates.length}, deduped: ${allCandidates.length}`);


    // Step 3: UNIFIED VERIFICATION GATE
    const verified = await verifyAvailability(allCandidates, params, FIRECRAWL_API_KEY, amenityTerms);
    console.log(`Verified available: ${verified.length}/${allCandidates.length}`);

    // Step 4: Enrich with AI (ratings, cuisine, neighborhood, coords)
    const enriched = await enrichWithAI(verified, LOVABLE_API_KEY, params);

    // Step 5: Cache write DISABLED for testing
    // await setCachedResults(cacheKey, query, params, enriched);
    console.log(`Cache write SKIPPED (testing mode) — ${enriched.length} results`);

    return new Response(
      JSON.stringify({ results: enriched, params, cached: false }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
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

Rules:
- "today" or "tonight" = ${now.toISOString().split("T")[0]}
- "tomorrow" = the day AFTER today
- **CRITICAL**: If the user explicitly names a city or location in their query (e.g. "Athens, GA", "near Savannah", "in Chicago"), ALWAYS use that city. NEVER override it with the browser location. The browser location is ONLY a fallback when the user does NOT mention any location at all.
- Only convert small neighborhoods/suburbs to their parent metro city (e.g. "North Druid Hills" => "Atlanta", "Brooklyn" => "New York"). Do NOT convert independent cities to other cities — Athens GA is NOT a suburb of Atlanta, Savannah is NOT Atlanta, etc.
- dinner/tonight defaults to time "19:00", lunch = "12:00", breakfast = "08:00", brunch = "10:30"
- If the user mentions a meal type (breakfast, brunch, lunch, dinner), use the corresponding default time above
- If no meal or time is mentioned, default to "19:00"
- IMPORTANT: "brunch" is BOTH a meal time AND a cuisine/experience. When the user says "brunch", set time to "10:30" AND set cuisine to "brunch" (so results include brunch-specific restaurants and menus). Same for "breakfast" — set cuisine to "breakfast" in addition to the time.
- If the user says something like "brunch Italian", set cuisine to "brunch italian" to capture both the meal style and food preference.
- If the user provides a US zip code (5-digit number), put it in the "zipCode" field and leave city/state empty. We will geocode it separately.

IMPORTANT — Cuisine type vs. dish keyword classification:
You MUST distinguish between a CUISINE TYPE (broad restaurant category) and a DISH KEYWORD (specific menu item or ingredient).
- cuisineType: The broad restaurant category that would serve this food. Examples: "seafood", "italian", "japanese", "steakhouse", "mexican", "thai", "indian", "southern", "french". Leave empty if no cuisine is implied.
- dishKeyword: A specific dish, preparation, or ingredient the user is searching for. Examples: "oysters", "lobster roll", "birria tacos", "sushi", "ramen", "steak", "fried chicken". Leave empty if the user is searching by cuisine category, not a specific dish.

Classification examples:
- "seafood near Decatur" → cuisineType: "seafood", dishKeyword: ""
- "oysters tonight Atlanta" → cuisineType: "seafood", dishKeyword: "oysters"
- "Italian for 2" → cuisineType: "italian", dishKeyword: ""
- "birria tacos Friday" → cuisineType: "mexican", dishKeyword: "birria tacos"
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
- state: 2-letter state code (empty if zip code provided instead)
- zipCode: string (5-digit US zip code if provided, "" otherwise)

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
              cuisineType: { type: "string", description: "Broad restaurant category (e.g. seafood, italian, japanese). Empty if none." },
              dishKeyword: { type: "string", description: "Specific dish or ingredient (e.g. oysters, sushi, steak). Empty if none." },
              date: { type: "string" },
              time: { type: "string" }, partySize: { type: "number" },
              city: { type: "string" }, state: { type: "string" },
              zipCode: { type: "string" },
            },
            required: ["cuisine", "cuisineType", "dishKeyword", "date", "time", "partySize", "city", "state"],
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
  
  // Normalize cuisineType and dishKeyword
  parsed.cuisineType = (parsed.cuisineType || "").trim().toLowerCase();
  parsed.dishKeyword = (parsed.dishKeyword || "").trim().toLowerCase();
  
  // If AI didn't classify but we can infer from DISH_TO_CUISINE_MAP
  if (!parsed.cuisineType && parsed.dishKeyword) {
    const mapped = DISH_TO_CUISINE_MAP[parsed.dishKeyword];
    if (mapped && mapped.length > 0) {
      parsed.cuisineType = mapped[0]; // Use first (most likely) parent cuisine
      console.log(`Inferred cuisineType "${parsed.cuisineType}" from dishKeyword "${parsed.dishKeyword}"`);
    }
  }
  
  console.log(`Intent classification — cuisineType: "${parsed.cuisineType}", dishKeyword: "${parsed.dishKeyword}"`);
  const INVALID_CITY = new Set(["unknown", "n/a", "none", "unspecified", ""]);
  parsed.city = INVALID_CITY.has((parsed.city || "").trim().toLowerCase()) ? "" : parsed.city?.trim() || "";
  parsed.state = INVALID_CITY.has((parsed.state || "").trim().toLowerCase()) ? "" : parsed.state?.trim() || "";

  // Handle zip code: geocode to city/state/coords
  const zipCode = (parsed as any).zipCode?.trim() || "";
  if (zipCode && /^\d{5}$/.test(zipCode) && !parsed.city) {
    try {
      const zipResp = await fetch(
        `https://nominatim.openstreetmap.org/search?postalcode=${zipCode}&country=us&format=json&limit=1&addressdetails=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const zipData = await zipResp.json();
      if (zipData && zipData.length > 0) {
        const addr = zipData[0].address;
        // Prefer city/town/village over county — county names like "DeKalb County"
        // don't work well with platform searches (Resy, OpenTable, Yelp)
        let resolvedCity = addr?.city || addr?.town || addr?.village || "";
        parsed.state = extractStateCode(addr) || parsed.state;
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

  // If city is still empty, try reverse-geocoding from coords — otherwise ask the user
  if (!parsed.city) {
    if (lat && lng) {
      try {
        const revResp = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
          { headers: { "User-Agent": "TableFinder/1.0" } }
        );
        const revData = await revResp.json();
        parsed.city = revData.address?.city || revData.address?.town || "";
        parsed.state = revData.address?.state_code || revData.address?.state || "";
      } catch { /* leave empty */ }
    }
    if (!parsed.city) {
      throw new Error("Please include a city, state, or zip code in your search (e.g. 'rooftop dining Friday Decatur GA' or 'sushi tonight 30030') so we can find the right location.");
    }
  }

  // Skip city geocoding if zip code already resolved coordinates
  const resolvedViaZip = zipCode && /^\d{5}$/.test(zipCode) && parsed.lat && parsed.lng;

  const hasExplicitState = hasExplicitStateInQuery(query);

  // Geocode city name (without trusting AI-guessed state) for disambiguation and coordinates.
  let cityGeoResults: any[] = [];
  if (!resolvedViaZip) {
    try {
      const geoCheck = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(parsed.city)}&format=json&limit=12&addressdetails=1&countrycodes=us`,
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
    .filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && !!c.stateCode)
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
        .filter((c: any) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && !!c.stateCode);

  const distinctStates = [...new Set(usableCandidates.map((c: any) => c.stateCode))];

  // If user did NOT explicitly include a state, do NOT guess for ambiguous cities.
  if (!hasExplicitState) {
    if (distinctStates.length > 1) {
      const options = [...new Set(usableCandidates.map((c: any) => `${parsed.city}, ${c.stateCode}`))].slice(0, 4);
      throw new Error(`Multiple locations found for "${parsed.city}". Please include the state or zip code — e.g. ${options.join(" or ")}.`);
    }

    if (distinctStates.length === 1) {
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

  if (selectedCandidate) {
    parsed.lat = selectedCandidate.lat;
    parsed.lng = selectedCandidate.lng;
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
  const cityState = state ? `${city} ${state}` : city;
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
        `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${cuisine} reservation`,
        `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${cuisine} book table`,
        // Dish-aware: add parent cuisine type query for better Resy recall
        ...(needsCuisineTypeQuery ? [
          `site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${cuisineTypeSuffix} restaurant reservation`,
        ] : []),
        ...(amenitySuffix ? [`site:resy.com/cities/${resyCitySlug}/venues/ ${resyMetroName}${amenitySuffix} restaurant`] : []),
      ]
    : platform === "opentable"
    ? [
        `site:opentable.com/r ${cityState}${cuisine} restaurant reserve`,
        `site:opentable.com ${cityState}${cuisine} opentable reservation`,
        // Dish-aware: add parent cuisine type query for better OT recall
        ...(needsCuisineTypeQuery ? [
          `site:opentable.com/r ${cityState}${cuisineTypeSuffix} restaurant reservation`,
        ] : []),
        ...(amenitySuffix ? [`site:opentable.com/r ${cityState}${amenitySuffix} restaurant reservation`] : []),
      ]
    : [
        `site:yelp.com/reservations ${cityState}${cuisine}`,
        `site:yelp.com/biz ${cityState}${cuisine} reservation`,
        ...(needsCuisineTypeQuery ? [
          `site:yelp.com/biz ${cityState}${cuisineTypeSuffix} restaurant reservation`,
        ] : []),
        ...(amenitySuffix ? [`site:yelp.com/biz ${cityState}${amenitySuffix} restaurant reservation`] : []),
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

// Map suburbs, counties, and neighborhoods to their Resy metro city slug.
// Resy organizes restaurants by major metro, not by suburb/county.
const RESY_METRO_MAP: Record<string, string> = {
  // Atlanta metro
  "dekalb county|ga": "atlanta",
  "decatur|ga": "atlanta",
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
};

function getResyCitySlug(params: SearchParams): string {
  const city = (params.city || "").trim().toLowerCase();
  const state = (params.state || "").trim().toLowerCase();
  const key = state ? `${city}|${state}` : city;

  // Check metro mapping first
  const metroSlug = RESY_METRO_MAP[key];
  if (metroSlug) return metroSlug;

  // Fallback: slugify city-state
  const slugCity = slugify(params.city || "");
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
      const citySlug = m[1].toLowerCase();
      const expectedSlug = getResyCitySlug(params).toLowerCase();
      return citySlug === expectedSlug;
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
        neighborhood: extractNeighborhoodFromTitle(c.title, c.description, params.city),
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
  params: SearchParams, yelpKey: string, amenityTerms: string[] = []
): Promise<Restaurant[]> {
  try {
    // Include amenity terms in Yelp search to discover rooftop/patio restaurants
    const amenitySuffix = amenityTerms.length > 0 ? ` ${amenityTerms.join(" ")}` : "";
    // Strip generic meal terms from Yelp search — "dinner restaurants" → "restaurants"
    const YELP_MEAL_STRIP = /\b(dinner|lunch|breakfast|supper|brunch|meal|dining)\b/gi;
    const yelpCuisine = (params.cuisine || "").replace(YELP_MEAL_STRIP, "").trim();
    const sp = new URLSearchParams({
      term: `${yelpCuisine}${amenitySuffix} restaurants`.trim(),
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

    let businesses = resp.ok ? (await resp.json())?.businesses || [] : [];

    // Broaden if few results
    if (businesses.length < 5) {
      console.log(`Yelp reservation filter returned only ${businesses.length}, broadening`);
      sp.delete("attributes");
      const resp2 = await fetch(`${YELP_API}/businesses/search?${sp}`, {
        headers: { Authorization: `Bearer ${yelpKey}` },
      });
      if (resp2.ok) {
        const broader = ((await resp2.json()).businesses || []).filter((b: any) =>
          b.transactions?.includes("restaurant_reservation")
        );
        const seen = new Set(businesses.map((b: any) => b.id));
        for (const b of broader) {
          if (!seen.has(b.id)) { businesses.push(b); seen.add(b.id); }
        }
      }
    }

    console.log(`Yelp candidates: ${businesses.length}`);

    // TWO-TIER CUISINE/DISH RELEVANCE FILTER for Yelp candidates.
    // If user searched for a dish (e.g. "oysters"), accept businesses matching:
    //   1) The dish keyword itself, OR
    //   2) The parent cuisine type (e.g. "seafood") from DISH_TO_CUISINE_MAP
    // If user searched for a cuisine type (e.g. "seafood"), use standard matching.
    const MEAL_TERMS = new Set(["dinner", "lunch", "breakfast", "supper", "brunch", "meal", "eat", "eating", "dining"]);
    const cuisineFilter = (params.cuisine || "").toLowerCase().replace(/\b(restaurant|restaurants|food)\b/g, "").trim();
    const cuisineTokens = cuisineFilter.split(/\s+/).filter(Boolean).filter(t => !MEAL_TERMS.has(t));

    // Build expanded token set for dish searches: include parent cuisine types
    const expandedTokens = [...cuisineTokens];
    if (params.dishKeyword) {
      const parentCuisines = DISH_TO_CUISINE_MAP[params.dishKeyword] || [];
      for (const pc of parentCuisines) {
        if (!expandedTokens.includes(pc)) expandedTokens.push(pc);
      }
      // Also add the explicit cuisineType if set
      if (params.cuisineType && !expandedTokens.includes(params.cuisineType)) {
        expandedTokens.push(params.cuisineType);
      }
    }

    const filtered = businesses.filter((b: any) => {
      if (!b.alias) return false;
      if (expandedTokens.length === 0) return true; // no cuisine filter
      // Check if any Yelp category or business name matches any token (dish OR parent cuisine)
      const cats = (b.categories || []).map((c: any) => `${c.alias || ""} ${c.title || ""}`.toLowerCase()).join(" ");
      const bizName = (b.name || "").toLowerCase();
      const searchText = `${cats} ${bizName}`;
      return expandedTokens.some((token: string) => {
        if (searchText.includes(token)) return true;
        const singular = token.endsWith("s") ? token.slice(0, -1) : null;
        const plural = !token.endsWith("s") ? token + "s" : null;
        if (singular && searchText.includes(singular)) return true;
        if (plural && searchText.includes(plural)) return true;
        return false;
      });
    });

    console.log(`Yelp after cuisine filter: ${filtered.length}/${businesses.length} (tokens: "${expandedTokens.join(", ")}", dish: "${params.dishKeyword}", cuisineType: "${params.cuisineType}")`);

    return filtered
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
  } catch (err) {
    console.error("Yelp error:", err);
    return [];
  }
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
- index, rating (Google Maps /5), reviewCount (approximate total Google reviews), cuisine type, neighborhood, priceRange ($-$$$$), lat, lng
- description: ONE sentence (max 15 words) describing the restaurant's signature appeal or what it's known for
- vibeTags: 1-3 short tags describing the vibe/ambiance (e.g. "Date Night", "Casual", "Upscale", "Family-Friendly", "Trendy", "Cozy", "Lively", "Intimate", "Hip", "Classic")

Return JSON: { "restaurants": [{ "index": number, "rating": number, "reviewCount": number, "cuisine": string, "neighborhood": string, "priceRange": string, "lat": number, "lng": number, "description": string, "vibeTags": string[] }] }

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

    // Use the SEARCHED city's coordinates for distance calculation, not the user's browser location.
    // This ensures that when a user in south GA searches "Decatur" (near Atlanta), distances are
    // measured from Decatur, not from the user's home 200 miles away.
    const cityLat = params.lat || 0;
    const cityLng = params.lng || 0;

    const enriched = results.map((r, i) => {
      const e = eMap.get(i);
      if (!e) return r;

      let dist = r.distanceMiles;
      if (!dist && e.lat && e.lng && cityLat && cityLng) {
        dist = haversine(cityLat, cityLng, e.lat, e.lng);
      }

      return {
        ...r,
        rating: e.rating ?? r.rating,
        reviewCount: e.reviewCount ?? r.reviewCount,
        cuisine: e.cuisine || r.cuisine,
        description: e.description || r.description,
        vibeTags: e.vibeTags || r.vibeTags,
        // Yelp provides accurate location from Fusion API — don't let AI overwrite it
        neighborhood: r.platform === "yelp" ? r.neighborhood : (e.neighborhood || r.neighborhood),
        priceRange: e.priceRange || r.priceRange,
        distanceMiles: dist,
      };
    });

    // Filter out restaurants beyond 12 miles
    // Keep restaurants with unknown distance — they passed verification so they're likely valid
    const MAX_DISTANCE_MILES = 12;
    const nearby = enriched.filter((r) => {
      const d = r.distanceMiles;
      if (d === null || d === undefined) return true; // keep verified results even without distance
      return d <= MAX_DISTANCE_MILES;
    });

    return nearby.sort((a, b) => {
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

  const cursors = { resy: 0, opentable: 0, yelp: 0 };
  const selected: Restaurant[] = [];

  while (selected.length < maxCandidates) {
    let pushedInRound = false;

    for (const platform of platformOrder) {
      const cursor = cursors[platform];
      const bucket = buckets[platform];
      if (cursor < bucket.length) {
        selected.push(bucket[cursor]);
        cursors[platform] = cursor + 1;
        pushedInRound = true;
        if (selected.length >= maxCandidates) break;
      }
    }

    if (!pushedInRound) break;
  }

  return selected;
}

async function verifyAvailability(
  candidates: Restaurant[],
  params: SearchParams,
  firecrawlKey: string,
  amenityTerms: string[] = []
): Promise<Restaurant[]> {
  // Keep latency bounded, but ensure platform diversity in the verification set.
  const limited = selectCandidatesForVerification(candidates, 24);
  const limitedCounts = limited.reduce(
    (acc, r) => {
      acc[r.platform] += 1;
      return acc;
    },
    { resy: 0, opentable: 0, yelp: 0 }
  );
  console.log(
    `Verifying (capped): total=${limited.length}, resy=${limitedCounts.resy}, ot=${limitedCounts.opentable}, yelp=${limitedCounts.yelp}`
  );

  // Run ALL scrapes in parallel (Firecrawl handles concurrency)
  const checked = await Promise.all(limited.map(async (r) => {
    try {
      const isYelp = r.platform === "yelp";

      const scrapePayload: Record<string, unknown> = {
        url: r.platformUrl,
        formats: ["markdown"],
        onlyMainContent: true,
      };
      if (isYelp) {
        // Yelp reservation widgets are more JS-heavy; short wait improves extraction without large latency hit.
        scrapePayload.waitFor = 2000;
      }

      const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firecrawlKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(scrapePayload),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "(no body)");
        console.log(`Scrape failed (${resp.status}) for ${r.name} [${r.platform}]: ${errBody.slice(0, 300)}`);
        return null;
      }

      const data = await resp.json();
      const markdown = extractFirecrawlMarkdown(data);
      if (!markdown) {
        console.log(`No content for ${r.name} [${r.platform}]`);
        return null;
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
      const MEAL_TERMS_SET = new Set(["dinner", "lunch", "breakfast", "supper", "brunch", "meal", "eat", "eating", "dining"]);
      const cuisineTokens = cuisineFilter.split(/\s+/).filter(Boolean).filter(t => !MEAL_TERMS_SET.has(t));
      
      // Build expanded check tokens: include parent cuisine types for dish searches
      const verifyTokens = [...cuisineTokens];
      if (params.dishKeyword) {
        const parentCuisines = DISH_TO_CUISINE_MAP[params.dishKeyword] || [];
        for (const pc of parentCuisines) {
          if (!verifyTokens.includes(pc)) verifyTokens.push(pc);
        }
        if (params.cuisineType && !verifyTokens.includes(params.cuisineType)) {
          verifyTokens.push(params.cuisineType);
        }
      }
      
      if (verifyTokens.length > 0) {
        const pageText = `${lower} ${(r.name || "").toLowerCase()}`;
        const hasMatch = verifyTokens.some((token) => {
          if (pageText.includes(token)) return true;
          const singular = token.endsWith("s") ? token.slice(0, -1) : null;
          const plural = !token.endsWith("s") ? token + "s" : null;
          if (singular && pageText.includes(singular)) return true;
          if (plural && pageText.includes(plural)) return true;
          return false;
        });
        if (!hasMatch) {
          const label = params.dishKeyword 
            ? `dish="${params.dishKeyword}" OR cuisineType="${params.cuisineType}"`
            : cuisineTokens.join(", ");
          console.log(`✗ ${r.name} [${r.platform}] — failed relevance check for: ${label} (checked: ${verifyTokens.join(", ")})`);
          return null;
        }
      }

      // RELEVANCE CHECK: If user searched for an amenity (rooftop, patio, etc.),
      // verify the restaurant page actually mentions it. Zero extra latency — uses already-scraped markdown.
      if (amenityTerms.length > 0 && !checkRelevanceInMarkdown(markdown, amenityTerms)) {
        console.log(`✗ ${r.name} [${r.platform}] — failed relevance check for: ${amenityTerms.join(", ")}`);
        return null;
      }

      // Extract all time slots from the page
      const timeSlotRegex12 = /\b(\d{1,2}):(\d{2})\s?(am|pm)\b/gi;
      const timeSlotRegex24 = /\b((?:[01]?\d|2[0-3]):([0-5]\d))\b/g;
      const hasBookingAction = /\b(book|reserve|select|notify)\b/i.test(markdown);
      const hasYelpAvailabilityMarker = isYelp && /\b(find\s+a\s+table|make\s+a\s+reservation|reservations?|available|party\s*size|select\s+(a\s+)?time|choose\s+(a\s+)?time)\b/i.test(markdown);

      // Determine meal window from requested time
      const [reqH] = params.time.split(":").map(Number);
      // Meal windows (in minutes from midnight):
      // Breakfast: 6:00 AM (360) — 12:00 PM (720)
      // Brunch:   10:30 AM (630) — 3:00 PM (900)
      // Lunch:    11:00 AM (660) — 4:00 PM (960)
      // Dinner:    4:00 PM (960) — 11:59 PM (1439)
      let windowStart: number;
      let windowEnd: number;
      let mealLabel: string;

      if (reqH < 10) {
        // Breakfast window
        windowStart = 360;  // 6:00 AM
        windowEnd = 720;    // 12:00 PM
        mealLabel = "breakfast";
      } else if (reqH < 12) {
        // Brunch window
        windowStart = 630;  // 10:30 AM
        windowEnd = 900;    // 3:00 PM
        mealLabel = "brunch";
      } else if (reqH < 16) {
        // Lunch window
        windowStart = 660;  // 11:00 AM
        windowEnd = 960;    // 4:00 PM
        mealLabel = "lunch";
      } else {
        // Dinner window
        windowStart = 1080; // 6:00 PM
        windowEnd = 1439;   // 11:59 PM
        mealLabel = "dinner";
      }

      // Collect all found times and check if any fall within the window
      const foundTimes: { time: string; minutes: number }[] = [];

      // 12-hour format matches
      let match12;
      while ((match12 = timeSlotRegex12.exec(markdown)) !== null) {
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
        foundTimes.push({ time: formatted, minutes: totalMin });
      }

      // If no 12h times found but 24h times + booking action exist, try 24h
      if (foundTimes.length === 0 && hasBookingAction) {
        let match24;
        while ((match24 = timeSlotRegex24.exec(markdown)) !== null) {
          const [hStr, mStr] = match24[1].split(":");
          const totalMin = parseInt(hStr) * 60 + parseInt(mStr);
          // Skip common non-time numbers (years, prices, etc.)
          if (totalMin >= 360 && totalMin <= 1380) { // 6:00 AM to 11:00 PM
            const displayH = parseInt(hStr) % 12 || 12;
            const displayAmpm = parseInt(hStr) >= 12 ? "PM" : "AM";
            foundTimes.push({ time: `${displayH}:${mStr} ${displayAmpm}`, minutes: totalMin });
          }
        }
      }

      // Filter times to those within the meal window
      const matchingTimes = foundTimes.filter((t) =>
        t.minutes >= windowStart && t.minutes <= windowEnd
      );

      if (matchingTimes.length > 0) {
        // Update the restaurant's timeSlots with verified times
        r.timeSlots = matchingTimes.map((t) => ({ time: t.time }));
        console.log(`✓ Verified ${r.name} [${r.platform}] — ${matchingTimes.length} ${mealLabel} slots (${windowStart/60|0}:${(windowStart%60).toString().padStart(2,"0")}–${windowEnd/60|0}:${(windowEnd%60).toString().padStart(2,"0")})`);
        return r;
      }

      // For Yelp, ONLY use the availability marker fallback if we couldn't extract
      // ANY times at all (i.e. the JS widget didn't render into markdown).
      // If we DID find times but none are in the meal window, that's a real rejection.
      if (foundTimes.length === 0 && hasYelpAvailabilityMarker) {
        console.log(`✓ Verified ${r.name} [yelp] — reservation markers present but no extractable times (trusting marker for ${mealLabel})`);
        return r;
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
    const synonyms = AMENITY_KEYWORDS[amenity] || [amenity];
    return synonyms.some((syn) => lower.includes(syn));
  });
}

// ─── Utilities ───

function dedupeByName(results: Restaurant[]): Restaurant[] {
  const kept: Restaurant[] = [];
  const keys: string[] = [];

  for (const r of results) {
    const key = r.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Check exact match OR substring containment (e.g. "thechophouse" vs "thechophouseaugustarestaurant")
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
