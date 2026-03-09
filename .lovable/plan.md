

## Three Bugs to Fix

All changes in `supabase/functions/search/index.ts`.

### Bug 1: Race Condition Loses All Distances (Not Just OpenTable)

**Root cause**: Lines 203-206 run geocoding and AI enrichment in parallel. `geocodeVerifiedResults` mutates the original objects (`r.distanceMiles = ...`), but `enrichWithAI` does `{ ...r, ... }` (line 1358) which snapshots the object *before* geocoding finishes. The returned `enriched` array has fresh objects where `distanceMiles` is always `undefined`.

From the logs: Geocoding succeeds for 4/5 restaurants (Sotto Sotto, Novo Cucina, Il Premio, Gio's Italian) — but none show distances in the UI because the enriched copies don't have them.

**Fix**: Change `enrichWithAI` to return only the enrichment data (a `Map<number, {...}>`) instead of new objects. After `Promise.all`, merge enrichment data onto the original `verified` array which now has `distanceMiles` set by geocoding.

### Bug 2: OpenTable Shows Only 1 Time Slot

**Root cause**: `onlyMainContent: true` (line 1468) strips OpenTable's availability widget from the scraped markdown. Only the requested time mentioned in the page header survives. The regex then finds just that one "7:00 PM".

From logs: Every OT result shows exactly "1 dinner slots: 7:00 PM" — which is the user's requested time appearing in the header text, not actual availability buttons.

**Fix**: Set `onlyMainContent: false` for OpenTable URLs so the full page including the time-slot picker is captured.

### Bug 3: Address Extraction Fails for Most Restaurants

**Root cause**: The address regex (line 1508) requires a 5-digit zip code at the end. Many restaurant pages (especially OpenTable, but also some Resy) present addresses without zip codes or in formats like "123 Main St, Atlanta, GA" without the zip.

From logs: 19 out of 24 candidates show "No address extracted" — spanning all platforms.

**Fix**: Add a second, more lenient fallback regex that matches addresses without zip codes:
```
/(\d{1,5}\s+[A-Z][A-Za-z\s.]+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Hwy|Cir(?:cle)?|Ter(?:race)?)[.,]?\s+[A-Za-z\s]+,\s*[A-Z]{2})/m
```

### Implementation Details

**Change 1 — Refactor `enrichWithAI` return type** (lines 1304-1377):
- Return a `Map<number, {rating, reviewCount, cuisine, description, vibeTags, neighborhood, priceRange}>` instead of a `Restaurant[]`
- Remove the `results.map(r => ({ ...r, ... }))` spreading

**Change 2 — Merge in main flow** (lines 202-216):
```typescript
const [, enrichmentMap] = await Promise.all([
  geocodeVerifiedResults(verified, params),
  enrichWithAI(verified, LOVABLE_API_KEY, params),
]);

// Apply AI enrichment onto the geocoded originals
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
```
Then use `verified` (not `enriched`) for distance filtering and sorting.

**Change 3 — OT `onlyMainContent: false`** (line 1468):
```typescript
onlyMainContent: isOT ? false : true,
```

**Change 4 — Lenient address regex fallback** (after line 1517):
If the strict regex (with zip) fails, try a second regex without zip:
```typescript
const addrRegexNoZip = /(\d{1,5}\s+[A-Z][A-Za-z\s.]+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Rd|Road|Dr(?:ive)?|Ln|Lane|Way|Pl(?:ace)?|Ct|Court|Pkwy|Hwy|Cir(?:cle)?|Ter(?:race)?)[.,]?\s+[A-Za-z\s]+,\s*[A-Z]{2})\b/m;
```

