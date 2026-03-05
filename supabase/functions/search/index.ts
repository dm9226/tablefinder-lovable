import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const RESY_API_KEY = "VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5";
const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, lat, lng, location } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Step 1: Parse natural language query with AI
    const today = new Date();
    const parsePrompt = `You parse restaurant search queries. Extract structured params from the user's query.

Current date: ${today.toISOString().split("T")[0]}
Current day of week: ${today.toLocaleDateString("en-US", { weekday: "long" })}
User's detected location: ${location || "unknown"}
User's coordinates: lat=${lat || "unknown"}, lng=${lng || "unknown"}

Return JSON with these fields:
- cuisine: string (the type of food, e.g. "Italian", "Sushi", "Steakhouse". If not specified, use "")
- date: string (YYYY-MM-DD format. If "tonight" or "today", use today. If "tomorrow", use tomorrow. If a day name like "Friday", use the next occurrence.)
- time: string (HH:MM in 24h format. If "dinner" or "night", use "19:00". If "lunch", use "12:00". Default "19:00")
- partySize: number (default 2)
- city: string (from query or detected location)
- state: string (abbreviated, e.g. "NY")
- lat: number or null
- lng: number or null

User query: "${query}"`;

    const aiResp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "user", content: parsePrompt }],
        tools: [
          {
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
                  lat: { type: "number" },
                  lng: { type: "number" },
                },
                required: ["cuisine", "date", "time", "partySize", "city"],
                additionalProperties: false,
              },
            },
          },
        ],
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
    console.log("Parsed params:", params);

    // Use provided coords if AI didn't extract any
    if (!params.lat && lat) params.lat = lat;
    if (!params.lng && lng) params.lng = lng;

    // Step 2: If we still don't have coordinates, geocode the city
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
          console.log("Geocoded city:", params.city, "→", params.lat, params.lng);
        }
      } catch (geoErr) {
        console.error("Geocoding error:", geoErr);
      }
    }

    // If city is still unknown and no coords, default to New York
    if ((!params.city || params.city === "unknown") && (!params.lat || params.lat === 0)) {
      params.city = "New York";
      params.state = "NY";
      params.lat = 40.7128;
      params.lng = -73.9060;
      console.log("Defaulting to New York");
    }

    console.log("Final params:", params);

    // Step 3: Search Resy
    const resyResults = await searchResy(params);

    return new Response(
      JSON.stringify({ results: resyResults, params }),
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

interface SearchParams {
  cuisine: string;
  date: string;
  time: string;
  partySize: number;
  city: string;
  state?: string;
  lat?: number;
  lng?: number;
}

async function searchResy(params: SearchParams) {
  const headers = {
    Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
    "Content-Type": "application/json",
  };

  try {
    // Step A: Find venues matching cuisine + location
    const searchBody: any = {
      per_page: 20,
      types: ["venue"],
      query: params.cuisine || params.city,
    };

    // If we have coordinates, use geo search for better results
    if (params.lat && params.lng) {
      searchBody.geo = {
        lat: params.lat,
        lon: params.lng,
        radius: 25, // miles
      };
    }

    const searchResp = await fetch("https://api.resy.com/3/venuesearch/search", {
      method: "POST",
      headers,
      body: JSON.stringify(searchBody),
    });

    if (!searchResp.ok) {
      console.error("Resy venue search error:", searchResp.status);
      return [];
    }

    const searchData = await searchResp.json();
    const hits = searchData?.search?.hits || [];

    if (hits.length === 0) {
      console.log("No Resy venues found for query");
      return [];
    }

    // Step B: For each venue, check availability using /4/find
    const venueIds = hits.slice(0, 10).map((h: any) => h.id?.resy);
    const validVenueIds = venueIds.filter(Boolean);

    const results = await Promise.all(
      validVenueIds.map(async (venueId: number) => {
        try {
          const findUrl = `https://api.resy.com/4/find?lat=${params.lat || 0}&long=${params.lng || 0}&day=${params.date}&party_size=${params.partySize}&venue_id=${venueId}`;

          const findResp = await fetch(findUrl, { headers });
          if (!findResp.ok) return null;

          const findData = await findResp.json();
          const venue = findData?.results?.venues?.[0];
          if (!venue || !venue.slots?.length) return null;

          const venueMeta = venue.venue;
          const cuisineType = venueMeta?.cuisine?.join(", ") || "Restaurant";

          // Filter by cuisine if specified
          if (params.cuisine) {
            const cuisineLower = params.cuisine.toLowerCase();
            const venueCuisines = (venueMeta?.cuisine || []).map((c: string) => c.toLowerCase());
            const venueName = (venueMeta?.name || "").toLowerCase();
            const matchesCuisine =
              venueCuisines.some((c: string) => c.includes(cuisineLower) || cuisineLower.includes(c)) ||
              venueName.includes(cuisineLower);

            if (!matchesCuisine) return null;
          }

          // Parse time slots
          const timeSlots = venue.slots
            .map((slot: any) => {
              const dt = slot.date?.start;
              if (!dt) return null;
              const time = new Date(dt).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              });
              return {
                time,
                token: slot.config?.token,
                type: slot.config?.type || "",
              };
            })
            .filter(Boolean)
            .slice(0, 8);

          if (timeSlots.length === 0) return null;

          const priceRange = venueMeta?.price_range
            ? "$".repeat(venueMeta.price_range)
            : undefined;

          return {
            id: `resy-${venueId}`,
            name: venueMeta?.name || "Unknown",
            cuisine: cuisineType,
            neighborhood: venueMeta?.location?.neighborhood || venueMeta?.location?.city || params.city,
            rating: venueMeta?.rating
              ? parseFloat(venueMeta.rating.toFixed(1))
              : undefined,
            priceRange,
            imageUrl: venueMeta?.images?.[0] || null,
            platform: "resy" as const,
            platformUrl: `https://resy.com/cities/${(params.city || "").toLowerCase().replace(/\s+/g, "-")}/${(venueMeta?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            timeSlots,
          };
        } catch (err) {
          console.error(`Error checking venue ${venueId}:`, err);
          return null;
        }
      })
    );

    return results.filter(Boolean);
  } catch (err) {
    console.error("Resy search error:", err);
    return [];
  }
}
