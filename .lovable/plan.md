## Problem

The user lives in an unincorporated area outside Atlanta proper. The browser correctly detects coords + reverse-geocodes them to "Atlanta, GA", but distance ranking then uses **downtown Atlanta's geocoded centroid** as the origin instead of the user's actual coordinates. Result: restaurants near the user appear "far," and downtown picks dominate.

Looking at `supabase/functions/search/index.ts` (lines 903–926), after disambiguation the code sets `parsed.lat/lng` to the *city centroid* from Nominatim, overwriting the user's precise browser coords. The platform discovery layer needs the city name (Resy/OpenTable/Yelp need slugs like `atlanta`), but distance math should use the user's actual location whenever available.

## Fix

Decouple the **discovery city** (used for platform slugs) from the **distance origin** (used for ranking).

### Change 1: Preserve user coords as the distance origin

In `parseQueryWithGemini` (around lines 903–926):

- Keep selecting the city centroid for things that need a "city center" (e.g., AI fallback geocoding sanity).
- BUT when `lat`/`lng` (browser coords) are present AND the user did not type a different city explicitly in the query (i.e., `cityFromBrowser === true` OR the parsed city matches `browserCity`), set `parsed.lat = lat; parsed.lng = lng;` so distance is measured from the user's actual position.

Concretely, replace the block:

```ts
if (selectedCandidate && !cityFromBrowser) {
  parsed.lat = selectedCandidate.lat;
  parsed.lng = selectedCandidate.lng;
}
```

with logic that:
1. If user has precise browser coords AND parsed city matches browser city → use browser coords (origin = the user).
2. Else if a candidate centroid was found → use it (origin = city center, e.g., user typed a different city than detected).
3. Else fall back to browser coords.

### Change 2: Bump distance caps slightly for "near me" searches

In the distance-filtering block (around lines 413–425 and `RANK CAPS` in memory), when the origin is the user's precise location (not a city centroid), keep the existing 15/30 mile caps but ensure suburban results aren't filtered out. No code change is strictly needed since the caps already accommodate suburbs — the real fix is using the right origin.

### Change 3: Log which origin is in use

Add a one-line `console.log` when distance origin is set, indicating "user coords" vs "city centroid: <city>". Helps debug future location complaints.

## Out of Scope

- Frontend changes — `src/pages/Index.tsx` already sends precise `coords` and reverse-geocoded `location`.
- Platform discovery (Resy/OpenTable/Yelp city slugs) — still uses `parsed.city`, unchanged.
- AI geocoding fallback — still uses city centroid for sanity checks (the 200-mile guard).

## Files Changed

- `supabase/functions/search/index.ts` — ~10-line edit to the coordinate-selection block (lines 903–926) + one log line.

## Memory Update

Update `mem://features/location-resolution`: distance origin is the user's precise browser coordinates whenever available and the searched city matches detected city; centroid is only used when the user types a different city.
