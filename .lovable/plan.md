## Problem

Yelp candidates are missing `distanceMiles` because the search edge function still treats Yelp as if it came from the Fusion API (which provided distance directly). Since we moved Yelp discovery to Firecrawl/snippet scraping, Yelp results are pushed with `distanceMiles: null` and three separate code paths refuse to fill it in.

## Fix

Edit `supabase/functions/search/index.ts` in three places to remove the obsolete Yelp exclusions so Yelp goes through the same geocoding and distance-stamping pipeline as Resy and OpenTable.

### 1. Single-shot Nominatim geocoder (line ~2225)
Remove the early-return that skips Yelp. The stale comment ("Yelp has API-provided distance") is no longer true.

```ts
// BEFORE
async function geocodeOne(r: Restaurant): Promise<void> {
  if (r.platform === "yelp") return; // Yelp has API-provided distance
  if (r.distanceMiles != null) return;

// AFTER
async function geocodeOne(r: Restaurant): Promise<void> {
  if (r.distanceMiles != null) return;
```

### 2. Batched geocoder candidate filter (line ~2298)
Include Yelp in the geocoding batch.

```ts
// BEFORE
const toGeocode = results.filter(r => r.platform !== "yelp");

// AFTER
const toGeocode = results.filter(r => r.distanceMiles == null);
```

### 3. Extended-search AI-coord fallback (line ~260)
Drop the Yelp guard so AI-provided coordinates can also stamp distance for Yelp, matching the behavior already in the initial flow at line ~448.

```ts
// BEFORE
if (r.distanceMiles == null && r.platform !== "yelp" && typeof e.lat === "number" ...

// AFTER
if (r.distanceMiles == null && typeof e.lat === "number" ...
```

### 4. Address-extraction guard (line ~2676 area)
Check whether `r.platform !== "yelp" && !r._address` is also blocking Yelp from getting an address fallback used by the geocoder. If yes, remove that Yelp exclusion as well so Yelp pages can contribute an address when available. (Yelp business pages typically expose a street address in markdown.)

## Expected result

After redeploying the `search` function, Yelp results will be geocoded via the same Nominatim → AI-coord cascade used by Resy/OpenTable. They'll show real mileage in the UI and sort by distance alongside the other platforms, so nearby Yelp picks float to the top instead of being buried at the bottom with no distance.

## Files touched
- `supabase/functions/search/index.ts`

No frontend changes needed; the existing sort in `src/pages/Index.tsx` already handles Yelp results once `distanceMiles` is populated.
