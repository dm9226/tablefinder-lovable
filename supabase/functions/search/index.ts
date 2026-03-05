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

    const params = await parseQuery(query, lat, lng, location, LOVABLE_API_KEY);
    console.log("Parsed params:", JSON.stringify(params));

    // Scrape both platforms in parallel
    const [resyResults, otResults] = await Promise.all([
      scrapeResy(params, FIRECRAWL_API_KEY),
      scrapeOpenTable(params, FIRECRAWL_API_KEY),
    ]);

    let results = [...resyResults, ...otResults];
    console.log(`Results: ${results.length} (Resy: ${resyResults.length}, OT: ${otResults.length})`);

    // Fallback to web search if no results
    if (results.length === 0) {
      console.log("No scraped results, trying web search fallback...");
      results = await firecrawlWebSearch(params, FIRECRAWL_API_KEY, LOVABLE_API_KEY);
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

// ── Parse query ──────────────────────────────────────────────────────

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
Day of week: ${today.toLocaleDateString("en-US", { weekday: "long" })}
User location: ${location || "unknown"}
Coordinates: lat=${lat || "unknown"}, lng=${lng || "unknown"}

IMPORTANT: For the city, use the major metro area, not suburbs. E.g. "North Druid Hills" → "Atlanta", "Brooklyn" → "New York", "Pasadena" → "Los Angeles".

Return JSON:
- cuisine: string (e.g. "Italian". If not specified, "")
- date: string (YYYY-MM-DD)
- time: string (HH:MM 24h. Default "19:00")
- partySize: number (default 2)
- city: string (MAJOR CITY name, not suburb)
- state: string (abbreviated)

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
    await aiResp.text();
    throw new Error("Failed to parse your search query");
  }

  const aiData = await aiResp.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("Failed to parse query");

  const params = JSON.parse(toolCall.function.arguments);
  if (!params.lat && lat) params.lat = lat;
  if (!params.lng && lng) params.lng = lng;

  // Geocode if needed
  if ((!params.lat || params.lat === 0) && params.city) {
    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(params.city + ", " + (params.state || ""))}&format=json&limit=1`,
        { headers: { "User-Agent": "TableFinder/1.0" } }
      );
      const geoData = await geoResp.json();
      if (geoData?.[0]) {
        params.lat = parseFloat(geoData[0].lat);
        params.lng = parseFloat(geoData[0].lon);
      }
    } catch (_e) { /* ignore */ }
  }

  if (!params.city || params.city === "unknown") {
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
    // Use the Resy search URL format that actually works
    const resyUrl = `https://resy.com/cities/${citySlug}?date=${params.date}&seats=${params.partySize}`;
    console.log("Scraping Resy:", resyUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: resyUrl,
        formats: [{
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
                    slug: { type: "string", description: "The restaurant's URL slug from its link, e.g. 'gio-s-chicken-amalfitano' from the href" },
                  },
                },
              },
            },
          },
          prompt: `Extract ALL restaurants listed on this Resy city page. For each restaurant, get: name, cuisine type, neighborhood, price range (like $$ or $$$), rating if shown, image URL, and most importantly the restaurant's URL slug from its link (the last part of the URL path like "restaurant-name").${params.cuisine ? ` Focus on ${params.cuisine} restaurants.` : ""}`,
        }],
        waitFor: 3000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Resy scrape error:", resp.status, errText.slice(0, 300));
      return [];
    }

    const data = await resp.json();
    const restaurants = data?.data?.json?.restaurants || data?.json?.restaurants || [];
    console.log("Resy restaurants found:", restaurants.length);

    // Filter by cuisine if specified
    let filtered = restaurants;
    if (params.cuisine) {
      const cl = params.cuisine.toLowerCase();
      filtered = restaurants.filter((r: any) =>
        (r.cuisine || "").toLowerCase().includes(cl) ||
        (r.name || "").toLowerCase().includes(cl)
      );
      // If filter is too aggressive, keep all
      if (filtered.length === 0) filtered = restaurants;
    }

    return filtered.slice(0, 15).map((r: any, i: number) => {
      const slug = r.slug || r.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "";
      const bookingUrl = `https://resy.com/cities/${citySlug}/${slug}?date=${params.date}&seats=${params.partySize}`;
      return {
        id: `resy-${i}-${Date.now()}`,
        name: r.name || "Unknown",
        cuisine: r.cuisine || "Restaurant",
        neighborhood: r.neighborhood || params.city,
        rating: r.rating || undefined,
        priceRange: r.price_range || undefined,
        imageUrl: r.image_url || null,
        platform: "resy",
        platformUrl: bookingUrl,
        timeSlots: [],
      };
    });
  } catch (err) {
    console.error("Resy scrape error:", err);
    return [];
  }
}

// ── Scrape OpenTable ─────────────────────────────────────────────────

async function scrapeOpenTable(params: SearchParams, firecrawlKey: string): Promise<any[]> {
  try {
    // OpenTable URL format: /s?dateTime=YYYY-MM-DDTHH:MM&covers=N&term=city
    const otUrl = `https://www.opentable.com/s?dateTime=${params.date}T${params.time}&covers=${params.partySize}&term=${encodeURIComponent((params.cuisine ? params.cuisine + " " : "") + params.city)}`;
    console.log("Scraping OpenTable:", otUrl);

    const resp = await fetch(`${FIRECRAWL_API}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: otUrl,
        formats: [{
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
                    opentable_slug: { type: "string", description: "The restaurant slug from its OpenTable URL, e.g. 'r/restaurant-name-city' or '/r/restaurant-name-city'" },
                  },
                },
              },
            },
          },
          prompt: "Extract ALL restaurants from this OpenTable search results page. For each, get: name, cuisine, neighborhood, price range, rating, image URL, and the restaurant's OpenTable URL slug (the /r/restaurant-name part from the link).",
        }],
        waitFor: 3000,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("OpenTable scrape error:", resp.status, errText.slice(0, 300));
      return [];
    }

    const data = await resp.json();
    const restaurants = data?.data?.json?.restaurants || data?.json?.restaurants || [];
    console.log("OpenTable restaurants found:", restaurants.length);

    return restaurants.slice(0, 15).map((r: any, i: number) => {
      let bookingUrl = "https://www.opentable.com";
      const slug = r.opentable_slug || "";
      if (slug) {
        const cleanSlug = slug.startsWith("/") ? slug : `/${slug}`;
        bookingUrl = `https://www.opentable.com${cleanSlug}?dateTime=${params.date}T${params.time}&covers=${params.partySize}`;
      }
      return {
        id: `opentable-${i}-${Date.now()}`,
        name: r.name || "Unknown",
        cuisine: r.cuisine || "Restaurant",
        neighborhood: r.neighborhood || params.city,
        rating: r.rating || undefined,
        priceRange: r.price_range || undefined,
        imageUrl: r.image_url || null,
        platform: "opentable",
        platformUrl: bookingUrl,
        timeSlots: [],
      };
    });
  } catch (err) {
    console.error("OpenTable scrape error:", err);
    return [];
  }
}

// ── Fallback: web search ─────────────────────────────────────────────

async function firecrawlWebSearch(
  params: SearchParams, firecrawlKey: string, lovableKey: string
): Promise<any[]> {
  try {
    const searchQuery = `${params.cuisine || ""} restaurant reservations ${params.city} ${params.state || ""} ${params.date}`.trim();
    console.log("Web search fallback:", searchQuery);

    const resp = await fetch(`${FIRECRAWL_API}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: searchQuery,
        limit: 8,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });

    const data = await resp.json();
    if (!data?.success || !data?.data?.length) return [];

    const combinedContent = data.data
      .map((r: any) => `URL: ${r.url}\nTitle: ${r.title}\n${(r.markdown || "").slice(0, 1500)}`)
      .join("\n---\n");

    const aiResp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
          role: "user",
          content: `Extract restaurants from these search results. Return a JSON object with a "restaurants" array. Each restaurant needs:
- name: string
- cuisine: string
- neighborhood: string  
- priceRange: string (like "$$")
- rating: number or null
- imageUrl: string or null
- platform: "resy" or "opentable" (based on source URL)
- platformUrl: the DIRECT booking/reservation URL for this specific restaurant (must be a real URL from the search results, include date=${params.date}&seats=${params.partySize} params if it's a resy link, or dateTime=${params.date}T${params.time}&covers=${params.partySize} if opentable)

Only include real restaurants with real URLs. Max 15.

${combinedContent}`,
        }],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiResp.ok) { await aiResp.text(); return []; }

    const aiData = await aiResp.json();
    const content = aiData.choices?.[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const restaurants = parsed.restaurants || [];

    return (Array.isArray(restaurants) ? restaurants : []).slice(0, 15).map((r: any, i: number) => ({
      id: `search-${i}-${Date.now()}`,
      name: r.name || "Unknown",
      cuisine: r.cuisine || "Restaurant",
      neighborhood: r.neighborhood || params.city,
      rating: r.rating || undefined,
      priceRange: r.priceRange || undefined,
      imageUrl: r.imageUrl || null,
      platform: r.platform || "resy",
      platformUrl: r.platformUrl || "#",
      timeSlots: [],
    }));
  } catch (err) {
    console.error("Web search fallback error:", err);
    return [];
  }
}
