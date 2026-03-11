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

function normalizeStateCode(state: string): string {
  if (!state) return state;
  const trimmed = state.trim();
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
}

// ─── Provider Adapter Interface ───
interface ApiKeys {
  firecrawlKey: string;
  yelpKey?: string;
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

  try {
    const { query, lat, lng, location } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    const YELP_API_KEY = Deno.env.get("YELP_API_KEY");

    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
    if (!FIRECRAWL_API_KEY) throw new Error("FIRECRAWL_API_KEY not configured");

    // Step 1: Parse user query (always fresh)
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Step 2: Discover candidates from all platforms via adapters
    if (!YELP_API_KEY) {
      console.warn("YELP_API_KEY missing — skipping Yelp");
    }

    // Detect amenity/experience keywords BEFORE discovery so we can add them to search queries
    const amenityTerms = extractAmenityTerms(params.cuisine || "", query);
    if (amenityTerms.length > 0) {
      console.log(`Amenity relevance filter active for: ${amenityTerms.join(", ")}`);
    }

    const keys: ApiKeys = { firecrawlKey: FIRECRAWL_API_KEY, yelpKey: YELP_API_KEY };
    const adapters: ProviderAdapter[] = [resyAdapter, opentableAdapter];
    if (YELP_API_KEY) adapters.push(yelpAdapter);

    const discovered = await Promise.all(
      adapters.map(a => a.discover(params, keys, amenityTerms))
    );
    const allCandidates = dedupeByName(discovered.flat());

    // Log counts per platform
    const platformCounts = adapters.map((a, i) => `${a.platform}: ${discovered[i].length}`);
    console.log(`Candidates — ${platformCounts.join(", ")}, deduped: ${allCandidates.length}`);

    // Log ALL discovered candidate URLs per platform for diagnostics
    for (const platform of ["resy", "opentable", "yelp"] as const) {
      const urls = allCandidates.filter(c => c.platform === platform).map(c => c.bookingUrl || c.name);
      console.log(`[DISCOVERY] ${platform} (${urls.length}): ${urls.join(" | ")}`);
    }

    // Step 3: Select candidates with round-robin balance, then verify per-adapter
    const selected = selectCandidatesForVerification(allCandidates, 24);
    const selectedCounts = selected.reduce((acc, r) => { acc[r.platform] = (acc[r.platform] || 0) + 1; return acc; }, {} as Record<string, number>);
    console.log(`Verifying (capped): total=${selected.length}, ${Object.entries(selectedCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);

    const verified = (await Promise.all(
      adapters.map(a => a.verify(
        selected.filter(c => c.platform === a.platform),
        params, keys, amenityTerms
      ))
    )).flat();
    console.log(`Verified available: ${verified.length}/${selected.length}`);

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
    const [, enrichmentMap] = await Promise.all([
      geocodeVerifiedResults(verified, params),
      enrichWithAI(verified, LOVABLE_API_KEY, params),
    ]);

    // Merge AI enrichment onto the geocoded originals (preserves distanceMiles)
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
    }

    // Apply distance filtering
    const metroCity = getMetroCityName(params.city || "", params.state || "");
    const wasMetroNormalized = metroCity !== (params.city || "");
    const MAX_DISTANCE_MILES = wasMetroNormalized ? 30 : 15;
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

    return new Response(
      JSON.stringify({ results: finalResults, params, cached: false }),
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
- state: 2-letter state code (empty if zip code provided instead)
- zipCode: string (5-digit US zip code if provided, "" otherwise)

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
  
  // Normalize cuisineType and dishKeyword
  parsed.cuisineType = (parsed.cuisineType || "").trim().toLowerCase();
  parsed.dishKeyword = (parsed.dishKeyword || "").trim().toLowerCase();
  
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
  const INVALID_CITY = new Set(["unknown", "n/a", "none", "unspecified", ""]);
  parsed.city = INVALID_CITY.has((parsed.city || "").trim().toLowerCase()) ? "" : parsed.city?.trim() || "";
  parsed.state = INVALID_CITY.has((parsed.state || "").trim().toLowerCase()) ? "" : parsed.state?.trim() || "";

  // Strip embedded state suffix from city (AI sometimes returns "North Druid Hills, GA")
  const citySuffix = parsed.city.match(/^(.+),\s*([A-Z]{2})$/);
  if (citySuffix) {
    parsed.city = citySuffix[1].trim();
    if (!parsed.state) parsed.state = citySuffix[2];
  }
  parsed.state = normalizeStateCode(parsed.state);

  // Parse browser location string for reliable city/state
  let browserCity = "";
  let browserState = "";
  if (location) {
    const locMatch = location.match(/^(.+),\s*([A-Z]{2})$/);
    if (locMatch) {
      browserCity = locMatch[1].trim();
      browserState = locMatch[2].trim();
    }
  }

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
        parsed.state = normalizeStateCode(extractStateCode(addr) || parsed.state);
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
  let cityFromBrowser = false;
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
        parsed.state = normalizeStateCode(revData.address?.state_code || revData.address?.state || "");
        if (parsed.city) {
          cityFromBrowser = true;
          parsed.lat = lat;
          parsed.lng = lng;
          console.log(`City from reverse-geocode: ${parsed.city}, ${parsed.state} (coords ${lat},${lng})`);
        }
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
  if (!hasExplicitState && !cityFromBrowser) {
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

  if (selectedCandidate && !cityFromBrowser) {
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
  // Use metro city name for OT/Yelp Firecrawl queries — tiny CDPs return no results
  const metroCityName = getMetroCityName(city, state);
  const cityState = state ? `${metroCityName} ${state}` : metroCityName;
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
    ? [
        `site:opentable.com/r ${cityState} best rated${cuisine} restaurant`,
        `site:opentable.com/r ${cityState} top${cuisine} restaurant reservation`,
        // Dish-aware: add parent cuisine type query for better OT recall
        ...(needsCuisineTypeQuery ? [
          `site:opentable.com/r ${cityState}${cuisineTypeSuffix} restaurant reservation`,
        ] : []),
        ...(amenitySuffix ? [`site:opentable.com/r ${cityState}${amenitySuffix} restaurant reservation`] : []),
      ]
    : [
        `site:yelp.com/reservations ${cityState} best${cuisine}`,
        `site:yelp.com/biz ${cityState} top rated${cuisine} reservation`,
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
};

function getResyCitySlug(params: SearchParams): string {
  const city = (params.city || "").trim().toLowerCase();
  const state = (params.state || "").trim().toLowerCase();
  const key = state ? `${city}|${state}` : city;

  // Check metro mapping first — append state suffix to match Resy's URL format (e.g. "atlanta" → "atlanta-ga")
  const metroSlug = RESY_METRO_MAP[key];
  if (metroSlug) {
    return state ? `${metroSlug}-${state}` : metroSlug;
  }

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
  params: SearchParams, yelpKey: string, amenityTerms: string[] = []
): Promise<Restaurant[]> {
  try {
    // Include amenity terms in Yelp search to discover rooftop/patio restaurants
    const amenitySuffix = amenityTerms.length > 0 ? ` ${amenityTerms.join(" ")}` : "";
    // Strip generic meal terms from Yelp search — "dinner restaurants" → "restaurants"
    const YELP_MEAL_STRIP = /\b(dinner|lunch|breakfast|supper|brunch|meal|dining)\b/gi;
    const yelpCuisine = (params.cuisine || "").replace(YELP_MEAL_STRIP, "").trim();
    
    // Use metro city name for Yelp search — tiny CDPs like "Scottdale" return no results
    const yelpCity = getMetroCityName(params.city, params.state);
    const yelpState = params.state;
    
    const sp = new URLSearchParams({
      term: `${yelpCuisine}${amenitySuffix} restaurants`.trim(),
      location: `${yelpCity}, ${yelpState}`,
      limit: "20",
      sort_by: "best_match",
      attributes: "reservation",
    });
    if (params.lat && params.lng) {
      sp.set("latitude", String(params.lat));
      sp.set("longitude", String(params.lng));
    }

    console.log(`Yelp search (reservation, city="${yelpCity}"):`, sp.toString());
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
    const GENERIC_CUISINE_TOKENS = new Set(["american", "asian", "european", "mediterranean"]);
    let expandedTokens = [...cuisineTokens];
    if (params.dishKeyword) {
      const parentCuisines = DISH_TO_CUISINE_MAP[params.dishKeyword] || [];
      for (const pc of parentCuisines) {
        if (!expandedTokens.includes(pc)) expandedTokens.push(pc);
      }
      // Also add the explicit cuisineType if set
      if (params.cuisineType && !expandedTokens.includes(params.cuisineType)) {
        expandedTokens.push(params.cuisineType);
      }
      // Remove overly generic tokens that cause false positives in dish searches
      expandedTokens = expandedTokens.filter(t => !GENERIC_CUISINE_TOKENS.has(t));
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

// Address extraction now handled by Firecrawl JSON extraction format during verification scrape

// ─── Batch geocode verified results ───

async function geocodeVerifiedResults(results: Restaurant[], params: SearchParams): Promise<void> {
  const cityLat = params.lat || 0;
  const cityLng = params.lng || 0;
  if (!cityLat || !cityLng) {
    console.log("No search coordinates for distance calculation, skipping geocode");
    return;
  }

  const metroCity = getMetroCityName(params.city || "", params.state || "");
  const state = params.state || "";

  // Single geocoding helper: tries up to 4 strategies, returns on first success
  async function geocodeOne(r: Restaurant): Promise<void> {
    if (r.platform === "yelp") return; // Yelp has API-provided distance
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
        const dist = +haversine(cityLat, cityLng, lat, lng).toFixed(1);
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
        await new Promise(w => setTimeout(w, 200));
        const url2 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(simplified)}&format=json&limit=1&addressdetails=1`;
        if (await tryGeocode(url2, "simplified")) return;
      }

      // Strategy 3: Structured query (street + city + state params)
      const streetPart = addr.split(",")[0].trim();
      if (streetPart.length > 3) {
        await new Promise(w => setTimeout(w, 200));
        const url3 = `https://nominatim.openstreetmap.org/search?street=${encodeURIComponent(streetPart)}&city=${encodeURIComponent(metroCity)}&state=${encodeURIComponent(state)}&format=json&limit=1&addressdetails=1`;
        if (await tryGeocode(url3, "structured")) return;
      }
    }

    // Strategy 4: Name-based lookup (for missing addresses or all previous failures)
    const nameQuery = `${cleanedName}, ${metroCity}, ${state}`;
    await new Promise(w => setTimeout(w, 200));
    const url4 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(nameQuery)}&format=json&limit=1&addressdetails=1`;
    if (await tryGeocode(url4, "name")) return;

    // Strategy 5: Broader name (name + state only)
    const broaderQuery = `${cleanedName}, ${state}`;
    await new Promise(w => setTimeout(w, 200));
    const url5 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(broaderQuery)}&format=json&limit=1&addressdetails=1`;
    if (await tryGeocode(url5, "name-broad")) return;

    if (r._addressCity) r.neighborhood = r._addressCity;
    console.log(`  Geocode miss for ${r.name}`);
  }

  const toGeocode = results.filter(r => r.platform !== "yelp");
  if (toGeocode.length === 0) return;

  console.log(`Geocoding ${toGeocode.length} restaurants via Nominatim...`);

  // Fire in parallel with 100ms stagger
  const geocodePromises = toGeocode.map((r, i) =>
    new Promise<void>(async (resolve) => {
      await new Promise(w => setTimeout(w, i * 100));
      await geocodeOne(r);
      resolve();
    })
  );

  await Promise.all(geocodePromises);
  const geocoded = toGeocode.filter(r => r.distanceMiles != null).length;
  console.log(`Geocoded ${geocoded}/${toGeocode.length} restaurants`);
}

// ─── AI enrichment ───
// AI provides: rating, reviewCount, cuisine, priceRange, description, vibeTags
// Coordinates and neighborhoods come from geocoding extracted addresses (not AI)

async function enrichWithAI(results: Restaurant[], apiKey: string, params: SearchParams): Promise<Map<number, any>> {
  const emptyMap = new Map<number, any>();
  if (results.length === 0) return emptyMap;

  const metroCity = getMetroCityName(params.city || "", params.state || "");
  const list = results.map((r, i) => `${i}. ${r.name} (${r.platform})`).join("\n");

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `For each restaurant in the ${metroCity || params.city}, ${params.state} metro area, provide:
- index, rating (Google Maps /5), reviewCount (approximate total Google reviews), cuisine type, priceRange ($-$$$$)
- neighborhood: the ACTUAL neighborhood or suburb where the restaurant is physically located (e.g. "Buckhead", "Midtown", "Vinings", "Sandy Springs") — NOT the search city "${params.city}"
- description: ONE sentence (max 15 words) describing the restaurant's signature appeal or what it's known for
- vibeTags: 1-3 short tags describing the vibe/ambiance (e.g. "Date Night", "Casual", "Upscale", "Family-Friendly", "Trendy", "Cozy", "Lively", "Intimate", "Hip", "Classic")

Return JSON: { "restaurants": [{ "index": number, "rating": number, "reviewCount": number, "cuisine": string, "neighborhood": string, "priceRange": string, "description": string, "vibeTags": string[] }] }

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
      if (typeof e.index === "number") eMap.set(e.index, e);
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
    const { _address, _addressCity, ...clean } = r as any;
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

  // Proportional allocation: distribute slots based on candidate volume per platform
  const total = candidates.length || 1;
  const quotas: Record<string, number> = {};
  let assigned = 0;
  for (const platform of platformOrder) {
    const raw = Math.round((buckets[platform].length / total) * maxCandidates);
    // Cap quota to actual bucket size
    quotas[platform] = Math.min(raw, buckets[platform].length);
    assigned += quotas[platform];
  }
  // Distribute any remaining slots (due to rounding or capped buckets) round-robin
  let remaining = maxCandidates - assigned;
  for (const platform of platformOrder) {
    if (remaining <= 0) break;
    const canAdd = buckets[platform].length - quotas[platform];
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
  amenityTerms: string[] = []
): Promise<Restaurant[]> {
  if (candidates.length === 0) return [];

  // Run ALL scrapes in parallel (Firecrawl handles concurrency)
  const checked = await Promise.all(candidates.map(async (r) => {
    try {
      const isYelp = r.platform === "yelp";

      const isResy = r.platform === "resy";
      const isOT = r.platform === "opentable";
      // Yelp: onlyMainContent=true (no addresses available anyway)
      // Resy + OT: onlyMainContent=false to capture address/location sections for geocoding
      // Time parsing already targets specific section headers ("dinner", "Select a time") so extra content won't cause false matches
      const scrapePayload: Record<string, unknown> = {
        url: r.platformUrl,
        formats: ["markdown"],
        onlyMainContent: isYelp,  // only Yelp stays restricted — Resy and OT need full page for address extraction
      };

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

      // Extract structured data from Firecrawl JSON extraction (if present)
      const jsonData = data?.data?.extract || data?.extract;
      
      // Extract address from markdown/metadata (all platforms)
      if (r.platform !== "yelp" && !r._address) {
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
      const MEAL_TERMS_SET = new Set(["dinner", "lunch", "breakfast", "supper", "brunch", "meal", "eat", "eating", "dining"]);
      const cuisineTokens = cuisineFilter.split(/\s+/).filter(Boolean).filter(t => !MEAL_TERMS_SET.has(t));
      
      // Build expanded check tokens: include parent cuisine types for dish searches
      const GENERIC_VERIFY_TOKENS = new Set(["american", "asian", "european", "mediterranean"]);
      let verifyTokens = [...cuisineTokens];
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
        const restaurantName = (r.name || "").toLowerCase();
        const pageText = `${lower} ${restaurantName}`;
        const isDishSearch = !!params.dishKeyword;

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

        if (isDishSearch) {
          // Dish search: keep current loose matching — any mention passes
          hasMatch = verifyTokens.some((token) => tokenMatches(pageText, token));
        } else {
          // Cuisine category search: require stronger signal
          hasMatch = verifyTokens.some((token) => {
            // Auto-pass if token is in the restaurant name
            if (tokenMatches(restaurantName, token)) return true;
            // Auto-pass if token appears in first 500 chars (header/identity area)
            const headerText = lower.slice(0, 500);
            if (tokenMatches(headerText, token)) return true;
            // Frequency threshold: token must appear 3+ times in full text
            if (countOccurrences(lower, token) >= 3) return true;
            return false;
          });
        }

        if (!hasMatch) {
          const label = isDishSearch
            ? `dish="${params.dishKeyword}" OR cuisineType="${params.cuisineType}"`
            : cuisineTokens.join(", ");
          console.log(`✗ ${r.name} [${r.platform}] — failed cuisine relevance (${isDishSearch ? "dish" : "category"}) for: ${label} (checked: ${verifyTokens.join(", ")})`);
          return null;
        }
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
      ];
      for (const marker of sectionCutMarkers) {
        const markerRegex = new RegExp(`(?:^|\\n)#+?\\s*${marker}|(?:^|\\n)\\*\\*${marker}`, "im");
        const idx = bookingMarkdown.search(markerRegex);
        if (idx > 200) { // Only cut if there's enough content before
          bookingMarkdown = bookingMarkdown.substring(0, idx);
        }
      }

      // Determine meal window from requested time
      const [reqH] = params.time.split(":").map(Number);
      let windowStart: number;
      let windowEnd: number;
      let mealLabel: string;

      if (reqH < 10) {
        windowStart = 360;
        windowEnd = 720;
        mealLabel = "breakfast";
      } else if (reqH < 12) {
        windowStart = 630;
        windowEnd = 900;
        mealLabel = "brunch";
      } else if (reqH < 16) {
        windowStart = 660;
        windowEnd = 960;
        mealLabel = "lunch";
      } else {
        windowStart = 1080;
        windowEnd = 1439;
        mealLabel = "dinner";
      }

      const foundTimes: { time: string; minutes: number }[] = [];
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

      // ── OPENTABLE-SPECIFIC: Parse "Select a time" section ──
      if (isOT) {
        // Step 1: Find the "Select a time" section
        const selectTimeIdx = markdown.indexOf("### Select a time");
        const selectTimeLower = markdown.toLowerCase().indexOf("select a time");
        
        if (selectTimeIdx !== -1 || selectTimeLower !== -1) {
          const sectionStart = selectTimeIdx !== -1 ? selectTimeIdx : selectTimeLower;
          // Extract section from header to next heading or end (max 500 chars)
          const sectionEnd = markdown.indexOf("\n#", sectionStart + 10);
          const otSection = markdown.substring(sectionStart, sectionEnd !== -1 ? sectionEnd : sectionStart + 500);
          
          // Step 2: Extract times from markdown list items ("- 6:30 PM")
          const otTimeRegex = /^[\s]*[-•*]\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))/gm;
          let otMatch;
          while ((otMatch = otTimeRegex.exec(otSection)) !== null) {
            // Skip if near "Notify me" marker
            const afterMatch = otSection.substring(otMatch.index, otMatch.index + otMatch[0].length + 30);
            if (/notify/i.test(afterMatch)) continue;
            
            const parsed = parseTimeStr(otMatch[1]);
            if (parsed && !seenTimes.has(parsed.time)) {
              seenTimes.add(parsed.time);
              foundTimes.push(parsed);
            }
          }
          
          // Also try non-list format: standalone times on their own line
          if (foundTimes.length === 0) {
            const otStandaloneRegex = /^\s*(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\s*$/gm;
            let otStandalone;
            while ((otStandalone = otStandaloneRegex.exec(otSection)) !== null) {
              const parsed = parseTimeStr(otStandalone[1]);
              if (parsed && !seenTimes.has(parsed.time)) {
                seenTimes.add(parsed.time);
                foundTimes.push(parsed);
              }
            }
          }
          
          if (foundTimes.length > 0) {
            console.log(`  ${r.name} [opentable]: extracted ${foundTimes.length} times from "Select a time" section: ${foundTimes.map(t=>t.time).join(", ")}`);
          }
        }
        
        // Step 3: If OT parser found nothing, strip dropdown noise and try generic regex
        // The dropdown is a single line with 10+ concatenated times like "12:00 AM12:30 AM..."
        if (foundTimes.length === 0) {
          // Remove lines with 10+ time matches (dropdown noise)
          const lines = bookingMarkdown.split("\n");
          const cleanedLines = lines.filter(line => {
            const timeMatches = line.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)/g);
            return !timeMatches || timeMatches.length < 10;
          });
          bookingMarkdown = cleanedLines.join("\n");
          console.log(`  ${r.name} [opentable]: no "Select a time" section found, falling through to generic regex (dropdown noise stripped)`);
        }
        
        // Step 4: Apply tighter OT time window: requested time -1h to +2h
        if (foundTimes.length > 0) {
          const [rH, rM] = params.time.split(":").map(Number);
          const reqMins = rH * 60 + (rM || 0);
          const otWindowStart = Math.max(0, reqMins - 60);    // -1 hour
          const otWindowEnd = Math.min(1439, reqMins + 120);   // +2 hours
          
          const otFiltered = foundTimes.filter(t => t.minutes >= otWindowStart && t.minutes <= otWindowEnd);
          
          if (otFiltered.length > 0) {
            // Sort by proximity, keep top 5
            otFiltered.sort((a, b) => Math.abs(a.minutes - requestedMinutes) - Math.abs(b.minutes - requestedMinutes));
            const top5 = otFiltered.slice(0, 5).sort((a, b) => a.minutes - b.minutes);
            r.timeSlots = top5.map(t => ({ time: t.time }));
            console.log(`✓ Verified ${r.name} [opentable] — ${top5.length} slots in OT window (${Math.floor(otWindowStart/60)}:${(otWindowStart%60).toString().padStart(2,"0")}–${Math.floor(otWindowEnd/60)}:${(otWindowEnd%60).toString().padStart(2,"0")}): ${top5.map(t => t.time).join(", ")}`);
            return r;
          } else {
            console.log(`✗ ${r.name} [opentable] — found ${foundTimes.length} slots but none in OT window (${Math.floor(otWindowStart/60)}:${(otWindowStart%60).toString().padStart(2,"0")}–${Math.floor(otWindowEnd/60)}:${(otWindowEnd%60).toString().padStart(2,"0")}). Found: ${foundTimes.map(t => t.time).join(", ")}`);
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
      const hasYelpAvailabilityMarker = isYelp && /\b(find\s+a\s+table|make\s+a\s+reservation|reservations?|available|party\s*size|select\s+(a\s+)?time|choose\s+(a\s+)?time)\b/i.test(markdown);

      // ── STRATEGY 1: For Resy, times already extracted from meal section above ──
      // ── STRATEGY 2: Regex on cleaned booking markdown (non-Resy only) ──
      if (!isResy && foundTimes.length === 0) {
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
        r.timeSlots = matchingTimes.map((t) => ({ time: t.time }));
        console.log(`✓ Verified ${r.name} [${r.platform}] — ${matchingTimes.length} ${mealLabel} slots (${windowStart/60|0}:${(windowStart%60).toString().padStart(2,"0")}–${windowEnd/60|0}:${(windowEnd%60).toString().padStart(2,"0")}): ${matchingTimes.map(t => t.time).join(", ")}`);
        return r;
      }

      // For Yelp, ONLY use the availability marker fallback if we couldn't extract
      // ANY times at all (i.e. the JS widget didn't render into markdown).
      // If we DID find times but none are in the meal window, that's a real rejection.
      if (foundTimes.length === 0 && hasYelpAvailabilityMarker) {
        const reqLabel = toTwelveHourLabel(params.time);
        if (reqLabel) r.timeSlots = [{ time: reqLabel }];
        console.log(`✓ Verified ${r.name} [yelp] — reservation markers, using requested time ${reqLabel}`);
        return r;
      }

      // For OpenTable, if generic regex also found nothing but booking markers exist, trust the link
      const hasOTBookingMarker = isOT && /\b(make\s+a\s+reservation|select\s+a\s+time|find\s+a\s+table|book\s+a\s+table|reserve\s+a\s+table)\b/i.test(markdown);
      if (foundTimes.length === 0 && hasOTBookingMarker) {
        const reqLabel2 = toTwelveHourLabel(params.time);
        if (reqLabel2) r.timeSlots = [{ time: reqLabel2 }];
        console.log(`✓ Verified ${r.name} [opentable] — booking markers, using requested time ${reqLabel2}`);
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

// ─── Provider Adapters ───

const resyAdapter: ProviderAdapter = {
  platform: "resy",
  async discover(params, keys, amenityTerms) {
    const raw = await searchFirecrawl(params, keys.firecrawlKey, "resy", amenityTerms);
    return normalizeCandidates("resy", raw, params);
  },
  async verify(candidates, params, keys, amenityTerms) {
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms);
  },
};

const opentableAdapter: ProviderAdapter = {
  platform: "opentable",
  async discover(params, keys, amenityTerms) {
    const raw = await searchFirecrawl(params, keys.firecrawlKey, "opentable", amenityTerms);
    return normalizeCandidates("opentable", raw, params);
  },
  async verify(candidates, params, keys, amenityTerms) {
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms);
  },
};

const yelpAdapter: ProviderAdapter = {
  platform: "yelp",
  async discover(params, keys, amenityTerms) {
    if (!keys.yelpKey) return [];
    return fetchYelpCandidates(params, keys.yelpKey, amenityTerms);
  },
  async verify(candidates, params, keys, amenityTerms) {
    return verifyAvailability(candidates, params, keys.firecrawlKey, amenityTerms);
  },
};
