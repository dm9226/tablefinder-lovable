

## Why Yelp Results Stopped Working

### Root Cause

The UK support changes introduced two modifications to the Yelp discovery logic that break UK Yelp searches:

1. **`attributes=reservation` doesn't work for UK locations** — Yelp's Fusion API reservation attribute is US-only. When combined with `locale=en_GB` and `location=London, UK`, the API returns exactly 0 businesses. The broadening fallback (removing the attribute) *also* returns 0 because it still checks `b.transactions?.includes("restaurant_reservation")`, which UK businesses don't have.

2. **The broadening filter is too strict for UK** — Line ~1360: when the reservation filter is removed and the broadened query runs, results are filtered to only include businesses with `restaurant_reservation` in their transactions. UK Yelp businesses don't have this transaction type, so all get filtered out.

Your US searches were not affected by these changes — the Yelp issues you saw earlier (11 candidates found, all rejected) were a pre-existing cuisine relevance verification issue unrelated to the UK work.

### Fix

**File: `supabase/functions/search/index.ts`**

1. **Skip `attributes=reservation` for UK Yelp searches** — Don't include this parameter when `country === "gb"` since it's a US-only Yelp feature.

2. **Skip the `restaurant_reservation` transaction filter for UK** — In the broadening logic (~line 1360), don't filter UK results by `b.transactions?.includes("restaurant_reservation")` since UK businesses don't populate this field.

3. **Keep the locale and location format** — `locale=en_GB` and `City, UK` are correct for UK Yelp discovery; the issue is only the reservation-specific filters.

These are ~5 lines of conditional logic changes in the Yelp discovery function.

