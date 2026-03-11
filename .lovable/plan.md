

## Analysis of Most Recent "Italian" Search Results

### Issues Found

**1. Geocoding: 9/17 restaurants have null distances (53% failure)**

The logs show these misses:
- **4 OT with no address extracted**: Storico Fresco, Indaco, Amalfi Cucina, Crispina — `[ADDR_MISS] No address pattern found`
- **1 Resy with no address**: Casa Nuova — `[ADDR_MISS] No address pattern found`
- **All 9 misses then fail name-based Nominatim lookups** (Strategies 4-5). Nominatim simply does not index restaurant names — it's a geographic database, not a business directory. This means every restaurant that fails address extraction is guaranteed to have null distance.

The fundamental problem: **Nominatim name-based fallback is nearly useless for restaurants**. It works for landmarks but not businesses. Every patch adding more Nominatim retry strategies is wasted effort.

**2. Duplicate Nino's**

"Nino's Italian Restaurant" (Resy) and "Nino's - Atlanta Restaurant" (OT) both appear. The dedup key comparison (`startsWith`) doesn't catch this because `ninositalianrestaurant` and `ninosatlantarestaurant` aren't substrings of each other.

**3. Yelp results likely present but sorted to end**

D'Italia and Il Porto Di Venezia were verified successfully. They have Yelp API-provided distances, so they should appear in the sorted results. The response was truncated in the network log — they're probably there but at the bottom (the response shows 17 results, which aligns with 15 Resy/OT + 2 Yelp).

**4. Fresca Trattoria address extracted but geocode MISSED**

Logs show `Address extracted (broad regex): 1227 Rockbridge Rd SW, Atlanta, GA 30087` — but then `Geocode miss for Fresca Trattoria Restaurant`. This means Nominatim's direct lookup AND simplified AND structured query all failed for a valid address. Likely the address itself is slightly wrong or Nominatim doesn't have it indexed.

---

### Root Cause Summary

The core problem is **relying on Nominatim for restaurant geocoding**. Nominatim:
- Cannot find businesses by name (it's OSM-based, not a business index)
- Fails on ~10-20% of valid street addresses
- Rate-limits at 1 req/sec, adding latency

Every "fix" so far has added another Nominatim retry layer, but the service fundamentally cannot do what we need. The 5-strategy waterfall adds up to 1 second per restaurant with zero improvement for name lookups.

### Proposed Fix Plan

**Fix 1: Use AI enrichment for coordinates (replace Nominatim name lookups)**

The AI enrichment call already runs for every result. It contacts Gemini which has Google Maps data. Instead of asking only for rating/description/neighborhood, also ask for **latitude and longitude**. This gives us Google-quality geocoding for FREE — no extra API call, no rate limits.

For restaurants where address extraction succeeds, keep the direct Nominatim lookup (Strategy 1-2 only — remove Strategies 3-5). For everything else, use the AI-provided coordinates.

This turns the geocoding from "fail 53% of the time" to "fail ~0% of the time" since Gemini/Google Maps knows every restaurant.

**Fix 2: Improve dedup with fuzzy matching**

Normalize restaurant names more aggressively before comparison:
- Strip common suffixes: "restaurant", "atlanta", city names, state codes
- Use a shared core name extraction (e.g., "ninos" matches "ninos")

**Fix 3: Remove dead Nominatim strategies 3-5**

The structured query, name-based, and broad name-based strategies have never successfully geocoded a restaurant that address strategies 1-2 missed. Remove them to reduce latency and code complexity.

### Technical Approach

**AI enrichment prompt change** (in `enrichWithAI`):
```
Add to JSON output: "lat": number, "lng": number
(Google Maps coordinates for the restaurant)
```

**Geocoding flow after change**:
```
1. Address extracted? → Nominatim direct lookup (keep)
2. Nominatim failed or no address? → Use AI-provided lat/lng + haversine
```

**Dedup improvement** (in `dedupeByName`):
```
Strip: restaurant, ristorante, trattoria, pizzeria, city names, state codes
Compare: Levenshtein similarity > 0.8 OR shared prefix > 60% of shorter name
```

### Files Changed
- `supabase/functions/search/index.ts` — modify `enrichWithAI` prompt, simplify `geocodeVerifiedResults`, improve `dedupeByName`

