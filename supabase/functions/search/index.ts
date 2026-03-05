import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FIRECRAWL_API = "https://api.firecrawl.dev/v1";

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

    // Step 1: Parse natural language query with AI
    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Step 2: Scrape Resy for real-time availability
    const resyResults = await scrapeResy(params, FIRECRAWL_API_KEY);

    // Step 3: Scrape OpenTable for real-time availability
    const otResults = await scrapeOpenTable(params, FIRECRAWL_API_KEY);

    const results = [...resyResults, ...otResults];
    console.log(`Total results: ${results.length} (Resy: ${resyResults.length}, OpenTable: ${otResults.length})`);

    // Step 4: If no scraped results, use AI to extract from broader search
    if (results.length === 0) {
      console.log("No scraped results, trying Firecrawl web search...");
      const searchResults = await firecrawlWebSearch(params, FIRECRAWL_API_KEY, LOVABLE_API_KEY);
      results.push(...searchResults);
    }

    return new Response(
      JSON.stringify({ results, params }),
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

// ── Parse query with AI ──────────────────────────────────────────────

interface SearchParams {
  cuisine: string;
  date: string;
  time: string;
  partySize: number;
  city: string;
  state: string;
  lat: number;
  lng: number;
}

async function parseQuery(
  query: string, lat: number | undefined, lng: number | undefined,
  location: string | undefined, apiKey: string
): Promise<SearchParams> {
  const today = new Date();
  const parsePrompt = `You parse restaurant search queries. Extract structured params.

Current date: ${today.toISOString().split("T")[0]}
Current day of week: ${today.toLocaleDateString("en-US", { weekday: "long" })}
User's detected location: ${location || "unknown"}
User's coordinates: lat=${lat || "unknown"}, lng=${lng || "unknown"}

Return JSON:
- cuisine: string (type of food, e.g. "Italian". If not specified, use "")
- date: string (YYYY-MM-DD. "tonight"/"today" = today, "tomorrow" = tomorrow, day name = next occurrence)
- time: string (HH:MM 24h. "dinner"/"night" = "19:00", "lunch" = "12:00". Default "19:00")
- partySize: number (default 2)
- city: string (from query or detected location)
- state: string (abbreviated, e.g. "GA")

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

  if (!aiResp.ok) {
    const errText = await aiResp.text();
    console.error("AI parse error:", aiResp.status, errText);
    throw new Error("Failed to parse your search query");
  }

  const aiData = await aiResp.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Failed to parse query");

  const params = JSON.parse(toolCall.function.arguments);
  if (!params.lat && lat) params.lat = lat;
  if (!params.lng && lng) params.lng = lng;

  // Geocode if needed
  if ((!params.lat || params.lat === 0) && params.city && params.city !== "unknown") {
    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(params.city + (params.state ? ", " + params.state : ""))}&format=json&limit=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const geoData = await geoResp.json();
      if (geoData?.[0]) {
        params.lat = parseFloat(geoData[0].lat);
        params.lng = parseFloat(geoData[0].lon);
      }
    } catch (e) {
      console.error("Geocoding error:", e);
    }
  }

  // Default to New York
  if ((!params.city || params.city === "unknown") && (!params.lat || params.lat === 0)) {
    params.city = "New York";
    params.state = "NY";
    params.lat = 40.7128;
    params.lng = -74.006;
  }

  return params;
}

// ── Scrape Resy ──────────────────────────────────────────────────────

async function scrapeResy(params: SearchParams, firecrawlKey: string): Promise<any[]> {
  try {
    const citySlug = params.city.toLowerCase().replace(/\s+/g, "-");
    const cuisineQuery = params.cuisine ? `?query=${encodeURIComponent(params.cuisine)}` : "";
    const resyUrl = `https://resy.com/cities/${citySlug}${cuisineQuery}`;
    console.log("Scraping Resy:", resyUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: resyUrl,
        formats: [
          "markdown",
          {
            type: "json",
            schema: {
              type: "object",
              properties: {
                restaurants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      cuisine: { type: "string" },
                      neighborhood: { type: "string" },
                      price_range: { type: "string" },
                      rating: { type: "number" },
                      image_url: { type: "string" },
                      resy_url: { type: "string" },
                      available_times: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            prompt: `Extract all restaurants shown on this Resy page. For each, get: name, cuisine type, neighborhood, price range (like $$ or $$$), rating if shown, image URL, the restaurant's Resy booking link, and any available reservation times shown. Date: ${params.date}, party size: ${params.partySize}.`,
          },
        ],
        waitFor: 3000,
      }),
    });

    const data = await resp.json();
    console.log("Resy scrape status:", resp.status);

    const restaurants = data?.data?.json?.restaurants || data?.json?.restaurants || [];
    console.log("Resy restaurants found:", restaurants.length);

    return restaurants.map((r: any, i: number) => ({
      id: `resy-${i}-${Date.now()}`,
      name: r.name || "Unknown",
      cuisine: r.cuisine || "Restaurant",
      neighborhood: r.neighborhood || params.city,
      rating: r.rating || undefined,
      priceRange: r.price_range || undefined,
      imageUrl: r.image_url || null,
      platform: "resy" as const,
      platformUrl: r.resy_url || `https://resy.com/cities/${citySlug}`,
      timeSlots: (r.available_times || []).slice(0, 8).map((t: string) => ({
        time: t,
      })),
    }));
  } catch (err) {
    console.error("Resy scrape error:", err);
    return [];
  }
}

// ── Scrape OpenTable ─────────────────────────────────────────────────

async function scrapeOpenTable(params: SearchParams, firecrawlKey: string): Promise<any[]> {
  try {
    const dateFormatted = params.date; // YYYY-MM-DD
    const timeFormatted = params.time.replace(":", "%3A");
    const cityQuery = encodeURIComponent(params.city + (params.state ? " " + params.state : ""));
    const cuisinePart = params.cuisine ? `+${encodeURIComponent(params.cuisine)}` : "";
    const otUrl = `https://www.opentable.com/s?dateTime=${dateFormatted}T${timeFormatted}&covers=${params.partySize}&term=${cityQuery}${cuisinePart}`;
    console.log("Scraping OpenTable:", otUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: otUrl,
        formats: [
          {
            type: "json",
            schema: {
              type: "object",
              properties: {
                restaurants: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      cuisine: { type: "string" },
                      neighborhood: { type: "string" },
                      price_range: { type: "string" },
                      rating: { type: "number" },
                      image_url: { type: "string" },
                      opentable_url: { type: "string" },
                      available_times: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            prompt: `Extract all restaurants from this OpenTable search results page. Get: name, cuisine, neighborhood, price range, rating, image URL, OpenTable booking link, and available reservation time slots shown.`,
          },
        ],
        waitFor: 3000,
      }),
    });

    const data = await resp.json();
    console.log("OpenTable scrape status:", resp.status);

    const restaurants = data?.data?.json?.restaurants || data?.json?.restaurants || [];
    console.log("OpenTable restaurants found:", restaurants.length);

    return restaurants.map((r: any, i: number) => ({
      id: `opentable-${i}-${Date.now()}`,
      name: r.name || "Unknown",
      cuisine: r.cuisine || "Restaurant",
      neighborhood: r.neighborhood || params.city,
      rating: r.rating || undefined,
      priceRange: r.price_range || undefined,
      imageUrl: r.image_url || null,
      platform: "opentable" as const,
      platformUrl: r.opentable_url || "https://www.opentable.com",
      timeSlots: (r.available_times || []).slice(0, 8).map((t: string) => ({
        time: t,
      })),
    }));
  } catch (err) {
    console.error("OpenTable scrape error:", err);
    return [];
  }
}

// ── Fallback: Firecrawl web search ───────────────────────────────────

async function firecrawlWebSearch(
  params: SearchParams, firecrawlKey: string, lovableKey: string
): Promise<any[]> {
  try {
    const searchQuery = `${params.cuisine || "restaurant"} reservations ${params.city} ${params.state || ""} ${params.date} party of ${params.partySize}`;
    console.log("Firecrawl web search:", searchQuery);

    const resp = await fetch(`${FIRECRAWL_API}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: searchQuery,
        limit: 5,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });

    const data = await resp.json();
    if (!data?.success || !data?.data?.length) return [];

    // Use AI to extract restaurant info from search results
    const combinedContent = data.data
      .map((r: any) => `URL: ${r.url}\nTitle: ${r.title}\n${(r.markdown || "").slice(0, 1500)}`)
      .join("\n\n---\n\n");

    const aiResp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `Extract restaurant reservation info from these web search results. Return JSON array of restaurants with: name, cuisine, neighborhood, priceRange (like "$$"), rating (number), platformUrl (booking link), platform ("resy" or "opentable" or "yelp" based on the source URL), timeSlots (array of {time: "7:00 PM"} objects for available times).

Only include restaurants that appear to have availability for ${params.date}, party of ${params.partySize}. If no specific times are shown, include the restaurant with empty timeSlots.

Search results:
${combinedContent}`,
        }],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiResp.ok) {
      await aiResp.text();
      return [];
    }

    const aiData = await aiResp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const restaurants = parsed.restaurants || parsed || [];

    return (Array.isArray(restaurants) ? restaurants : []).map((r: any, i: number) => ({
      id: `search-${i}-${Date.now()}`,
      name: r.name || "Unknown",
      cuisine: r.cuisine || "Restaurant",
      neighborhood: r.neighborhood || params.city,
      rating: r.rating || undefined,
      priceRange: r.priceRange || undefined,
      imageUrl: r.imageUrl || null,
      platform: r.platform || "resy",
      platformUrl: r.platformUrl || "#",
      timeSlots: (r.timeSlots || []).slice(0, 8),
    }));
  } catch (err) {
    console.error("Web search fallback error:", err);
    return [];
  }
}
