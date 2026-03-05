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

    // Geocode the city if we don't have coordinates
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
          console.log("Geocoded:", params.city, "→", params.lat, params.lng);
        }
      } catch (geoErr) {
        console.error("Geocoding error:", geoErr);
      }
    }

    // Default to New York if no location at all
    if ((!params.city || params.city === "unknown") && (!params.lat || params.lat === 0)) {
      params.city = "New York";
      params.state = "NY";
      params.lat = 40.7128;
      params.lng = -73.9060;
    }

    console.log("Final params:", params);

    // Step 2: Search Resy
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

const RESY_HEADERS = {
  Authorization: `ResyAPI api_key="${RESY_API_KEY}"`,
  "Content-Type": "application/json",
  Origin: "https://resy.com",
  Referer: "https://resy.com/",
};

async function searchResy(params: SearchParams) {
  try {
    // DEBUG: Test if /4/find works at all with a known venue
    const testUrl = `https://api.resy.com/4/find?lat=40.7128&long=-74.0060&day=${params.date}&party_size=${params.partySize}&venue_id=35676`;
    const testResp = await fetch(testUrl, { headers: RESY_HEADERS });
    const testBody = await testResp.text();
    console.log("DEBUG /4/find test status:", testResp.status, "body:", testBody.slice(0, 300));

    // Use venue search to find venues
    const searchBody: any = {
      per_page: 20,
      query: params.cuisine || "restaurant",
    };

    // Add geo
    if (params.lat && params.lng) {
      searchBody.geo = {
        latitude: params.lat,
        longitude: params.lng,
        radius: 25,
      };
    }

    console.log("Resy search body:", JSON.stringify(searchBody));

    let resp = await fetch("https://api.resy.com/3/venuesearch/search", {
      method: "POST",
      headers: RESY_HEADERS,
      body: JSON.stringify(searchBody),
    });

    // If geo fields fail, try without geo
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Resy search error (with geo):", resp.status, errBody);
      
      delete searchBody.geo;
      console.log("Retrying without geo:", JSON.stringify(searchBody));
      
      resp = await fetch("https://api.resy.com/3/venuesearch/search", {
        method: "POST",
        headers: RESY_HEADERS,
        body: JSON.stringify(searchBody),
      });
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Resy search error (no geo):", resp.status, errBody);
      return [];
    }

    const data = await resp.json();
    console.log("Search response:", JSON.stringify(data).slice(0, 500));
    const hits = data?.search?.hits || [];
    console.log("Search hits:", hits.length);

    if (hits.length === 0) {
      // Try with just query, no geo
      if (searchBody.geo) {
        console.log("Retrying without geo...");
        delete searchBody.geo;
        const retry = await fetch("https://api.resy.com/3/venuesearch/search", {
          method: "POST",
          headers: RESY_HEADERS,
          body: JSON.stringify(searchBody),
        });
        if (retry.ok) {
          const retryData = await retry.json();
          const retryHits = retryData?.search?.hits || [];
          console.log("Retry hits:", retryHits.length);
          if (retryHits.length > 0) {
            return await checkVenueAvailability(retryHits, params);
          }
        } else {
          await retry.text();
        }
      }
      return [];
    }

    return await checkVenueAvailability(hits, params);
  } catch (err) {
    console.error("Resy search error:", err);
    return [];
  }
}

async function checkVenueAvailability(hits: any[], params: SearchParams) {
  const results = await Promise.all(
    hits.slice(0, 10).map(async (hit: any) => {
      const venueId = hit.id?.resy || hit.venue_id || hit.id;
      if (!venueId) return null;

      try {
        const findUrl = `https://api.resy.com/4/find?lat=${params.lat || 0}&long=${params.lng || 0}&day=${params.date}&party_size=${params.partySize}&venue_id=${venueId}`;
        const findResp = await fetch(findUrl, { headers: RESY_HEADERS });
        if (!findResp.ok) {
          await findResp.text();
          return null;
        }
        const findData = await findResp.json();
        const venue = findData?.results?.venues?.[0];
        if (!venue?.slots?.length) return null;

        if (params.cuisine) {
          const cl = params.cuisine.toLowerCase();
          const vc = (venue.venue?.cuisine || []).map((c: string) => c.toLowerCase());
          if (!vc.some((c: string) => c.includes(cl) || cl.includes(c))) return null;
        }

        return formatResyVenue(venue, params);
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}




function formatResyVenue(venue: any, params: SearchParams) {
  const meta = venue.venue;
  if (!meta) return null;

  const timeSlots = (venue.slots || [])
    .map((slot: any) => {
      const dt = slot.date?.start;
      if (!dt) return null;
      const time = new Date(dt).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return { time, token: slot.config?.token, type: slot.config?.type || "" };
    })
    .filter(Boolean)
    .slice(0, 8);

  if (timeSlots.length === 0) return null;

  const priceRange = meta.price_range ? "$".repeat(meta.price_range) : undefined;
  const citySlug = (params.city || "").toLowerCase().replace(/\s+/g, "-");
  const nameSlug = (meta.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return {
    id: `resy-${meta.id?.resy || Math.random().toString(36).slice(2)}`,
    name: meta.name || "Unknown",
    cuisine: meta.cuisine?.join(", ") || "Restaurant",
    neighborhood: meta.location?.neighborhood || meta.location?.city || params.city,
    rating: meta.rating ? parseFloat(meta.rating.toFixed(1)) : undefined,
    priceRange,
    imageUrl: meta.images?.[0] || null,
    platform: "resy" as const,
    platformUrl: `https://resy.com/cities/${citySlug}/${nameSlug}`,
    timeSlots,
  };
}
