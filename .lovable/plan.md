
## Problem

Yelp results currently render without a distance value. The pipeline assumes Yelp distance comes from the Yelp API, so geocoding and AI-coordinate fallbacks all skip Yelp:

- `geocodeVerifiedResults` (line 1919): `if (r.platform === "yelp") return;`
- AI-enrichment lat/lng fallback (lines 316, 555): `r.platform !== "yelp"` guard
- Stats logging (lines 566-568) excludes Yelp from "non-Yelp" denominator

Since Yelp candidates are now soft-verified from discovery (DataDome blocks per-page scrapes), there is no API-supplied distance — so the field stays null and the UI shows nothing.

## Fix

Allow distance computation for Yelp via the same name-based geocoding + AI-coordinate fallback used for Resy/OpenTable, but only when the Yelp result has no distance yet (preserves any future API-provided value).

### Changes in `supabase/functions/search/index.ts`

1. **`geocodeVerifiedResults` (line 1919)** — remove the blanket Yelp skip. Replace:
   ```ts
   if (r.platform === "yelp") return; // Yelp has API-provided distance
   if (r.distanceMiles != null) return;
   ```
   with:
   ```ts
   if (r.distanceMiles != null) return; // Already has distance (e.g. Yelp API)
   ```
   Yelp soft-verified entries will then get geocoded by name + city like every other platform.

2. **AI-enrichment lat/lng fallback (lines 316 and 555)** — drop the `r.platform !== "yelp"` clause so that if Gemini returns coordinates for a Yelp restaurant, we use them as a fallback when Nominatim fails.

3. **Stats logging (lines 566-568)** — update the diagnostic to count all platforms instead of "non-Yelp", since Yelp is now part of the geocoded set.

4. **Distance sort/cap (lines 337-343, 575-581)** — already uses `r.distanceMiles ?? 9999` and applies uniformly, so no change required; Yelp will now naturally participate.

### Why this is safe

- Soft-verified Yelp entries already carry `name`, `city`, and (sometimes) `_address` from the Yelp search-page markdown, which is exactly what the existing geocoding helper expects.
- Geocoding has a 200-mile sanity cap (line 1947) that discards bogus matches, so a wrong Nominatim hit won't pollute results.
- Geocoding runs inside an 8s `Promise.race` budget, so adding ~3 Yelp items to the queue won't materially affect latency.
- If both Nominatim and AI fail, `distanceMiles` stays null and the UI behaves exactly as it does today — no regression.

### Out of scope

- No UI changes (`RestaurantCard` already renders `distanceMiles` when present).
- No changes to the soft-verify gating, time-slot logic, or Yelp discovery path.
