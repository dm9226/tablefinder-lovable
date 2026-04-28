# Plan: Make Extended-Search Results Actually Reach the UI

## Root cause

Logs from the latest search confirm everything works on the backend:

- `Rose & Crown Restaurant`: ✓ verified, geocoded **0.1 mi (Marietta)**
- `HOBNOB Vinings`, `Canoe`, `Maggiano's - Cumberland`, `Bonefish Grill`: all ✓ verified in extended pass (`[EXTENDED] Verified: 15/18`)

But the user doesn't see them. Two bugs cause this:

### Bug 1 — Extended search loses the user's true coords

In the **initial** search (`supabase/functions/search/index.ts` ~line 295) we stash the browser's coords:
```ts
params.userLat = lat;
params.userLng = lng;
```
These get sent back to the client inside `params`, then the client echoes `params` back as `extendedParams` on the follow-up call.

**But:** in the extended branch the request body is `{ query, extended, remainingCandidates, extendedParams }` — the top-level `lat`/`lng` are **never sent**, and the extended branch never re-stamps `params.userLat/userLng` from the body. If `extendedParams` arrives without `userLat`/`userLng` (older cached `params`, or any client that strips it), the extended pass falls back to **city-centroid distance** (`hasUserCoords = false` → `MAX_DISTANCE_MILES = 30`), and Marietta/Vinings venues read 15-25+ mi from the Atlanta centroid — they survive the filter but get sorted to the bottom, behind 18+ Buckhead/Midtown venues from the first batch.

### Bug 2 — Client appends extended results without re-sorting by distance

In `src/pages/Index.tsx` `handleExtendedSearch`:
```ts
setResults(prev => [...prev, ...newResults]);
```
Even when the extended batch contains a 0.1 mi venue, it gets concatenated to the **end** of the list. Combined with `MAX_RESULTS = 40` and the auto-extend loop stopping when results.length ≥ 40, the nearby venues are buried and the user has to scroll past 30+ farther restaurants to find them.

## Changes

### 1. `supabase/functions/search/index.ts` — extended branch (~line 203)

- Accept top-level `lat`/`lng` in the extended request and re-stamp `params.userLat`/`params.userLng` (preferring fresh body coords, falling back to whatever `extendedParams` carries).
- Add a diagnostic log mirroring the initial path: `[EXTENDED] Coords received` and `[EXTENDED] Distance ref`.

### 2. `src/pages/Index.tsx` — `handleSearch` and `handleExtendedSearch`

- Send `lat: coords?.lat, lng: coords?.lng` in the extended invoke body too (not just on the initial search).
- After appending extended results, **re-sort the merged list by `distanceMiles` ascending** (with rating tiebreaker matching the backend), then slice to `MAX_RESULTS`. This guarantees a 0.1 mi venue surfaces to the top regardless of which wave it arrived in.

```ts
setResults(prev => {
  const merged = [...prev, ...newResults];
  merged.sort((a, b) => {
    const dA = a.distanceMiles ?? 9999;
    const dB = b.distanceMiles ?? 9999;
    if (Math.abs(dA - dB) > 0.5) return dA - dB;
    return (b.rating ?? 0) - (a.rating ?? 0);
  });
  return merged.slice(0, MAX_RESULTS);
});
```

### 3. Deploy `search` and verify

After deploy, ask the user to run one more search. Confirm via logs:
- `Coords received: lat=…` on initial pass
- `[EXTENDED] Coords received` + `[EXTENDED] Distance ref: user coords` on the follow-up
- Rose & Crown at the top of the rendered list

## Files touched

- `supabase/functions/search/index.ts` (extended branch only)
- `src/pages/Index.tsx` (handleSearch + handleExtendedSearch + merge logic)

## Out of scope

- Distance filter caps (already correct: 25 mi with user coords)
- Backend verification / timeout logic (already healthy: 15-17/18 verified)
- Geocoding (Rose & Crown already geocodes correctly to 0.1 mi)
