

## Problem

The name-based geocoding fallback (line 1224) uses `params.city` directly — e.g., "Decatur" — instead of the metro city name. Nominatim can't find "Oak Steakhouse Atlanta, Decatur, GA" because the restaurant is in Atlanta, not Decatur.

The fix `getMetroCityName()` already exists and is used everywhere else (Yelp search, OT discovery, distance filtering) — it just wasn't applied to the geocoding fallback.

## Plan

**One change in `supabase/functions/search/index.ts`** (lines 1218-1224):

1. Replace `params.city` with `getMetroCityName(params.city, params.state)` in the name-based geocoding fallback
2. Add a second attempt with just the state if the metro city query returns nothing

```text
Before:  "Oak Steakhouse Atlanta, Decatur, GA"  → no results
After:   "Oak Steakhouse Atlanta, Atlanta, GA"   → found
```

If the metro query still misses, retry with just `"<name>, <state>"` as a broader fallback — this catches cases where Nominatim indexes the restaurant under a different city name entirely.

