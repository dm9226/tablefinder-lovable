## Problem

Three compounding issues are making "nearby" results look far:

1. **Distance is measured from the city centroid, not from the user.** `parseQuery` overwrites `params.lat/lng` with the geocoded *city center* (Atlanta = 33.749, -84.388). All `haversine(cityLat, cityLng, ...)` calls then compute "distance from downtown Atlanta," not "distance from you." A restaurant 2 mi from your house in Smyrna can read as 12 mi and get filtered out by the 15-mile cap.

2. **The ZIP-based hyperlocal discovery isn't actually running.** The recent `User ZIP from coords:` log line never appears in the logs from your last search. Either `reverseGeocodeToZip` is throwing silently or `lat/lng` weren't preserved. Yelp `find_loc` and the OpenTable ZIP supplemental query both depend on it, so neither is firing.

3. **All Firecrawl discovery queries use the metro city name** (`Atlanta GA`, `/cities/atl/venues/`). Google ranks intown venues highest, so suburban (and closer-to-you) venues are pushed off the candidate list before verification ever runs.

## Plan

### 1. Preserve the user's true coordinates separately from the city centroid

In `SearchParams`, add `userLat?: number; userLng?: number` alongside the existing `lat/lng` (which represent the city centroid used for discovery).

In the request handler (top of POST), before `parseQuery` runs, capture the raw browser coords:
```ts
const userLat = typeof lat === "number" ? lat : undefined;
const userLng = typeof lng === "number" ? lng : undefined;
// ... after parseQuery:
params.userLat = userLat;
params.userLng = userLng;
```

### 2. Rank distance from the user, not from the city center

Replace both occurrences of:
```ts
const cityLat = params.lat ?? 0;
const cityLng = params.lng ?? 0;
```
(lines ~230 and ~395) with:
```ts
const refLat = params.userLat ?? params.lat ?? 0;
const refLng = params.userLng ?? params.lng ?? 0;
```
Use `refLat/refLng` in every `haversine(...)` call for distance ranking and the 200-mile sanity check. City centroid stays only as a fallback when the user didn't share location.

### 3. Make the distance cap dynamic when user coords are present

Today: 15 mi (or 30 mi if metro normalization happened). When we have the user's actual coords, this is too tight in suburbs because the candidates were discovered from the metro center. Bump to **25 mi when `userLat/userLng` are present** so we don't drop suburban candidates that are actually close to the user but far from city center.

### 4. Fix the ZIP resolution silent failure

In the request handler:
- Log the inputs *before* attempting reverse-geocode: `console.log(\`Coords received: lat=${lat}, lng=${lng}\`);`
- Wrap `reverseGeocodeToZip` so it always logs success OR failure (currently the failure path uses `console.log` but apparently isn't appearing — confirm by adding a sentinel log right before the `if (lat && lng …)` block).
- Add a 5-second timeout on the Nominatim call so a hung request can't swallow the rest of the search silently.

### 5. Add diagnostic logs

- Log `params.userLat/userLng` and `params.lat/lng` once after parseQuery so we can confirm in logs which coords are driving distance.
- Log "Distance ref: user (X,Y)" or "Distance ref: city centroid (X,Y)" once before the geocoding pass.

### 6. (Optional, follow-up) Add a third Firecrawl discovery query per platform that includes the suburb name

Pull `data.address.suburb` (or `town`) from the existing reverse-geocode call in the frontend and pass it along as `params.userSuburb`. Then add one query per platform like `site:opentable.com/r Smyrna GA restaurant` to surface candidates Google would otherwise bury under intown Atlanta. Skipping this for v1 — fixes 1–4 alone should make a visible difference.

## Files touched

- `supabase/functions/search/index.ts` — `SearchParams` interface, request handler, two `cityLat/cityLng` blocks, distance cap logic.

## Out of scope

- No frontend changes required for v1 (browser already sends `lat/lng`).
- No DB / RLS / auth changes.
