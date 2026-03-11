

## Complete Rewrite of `supabase/functions/search/index.ts`

The file is 2,360 lines. The architecture (discover → verify → geocode → enrich → filter) is sound, but incremental patches introduced scoping bugs and over-complicated geocoding. This rewrite preserves all working logic while fixing every identified issue.

### Root Causes Identified

1. **`ReferenceError: metroCity is not defined`** (line 1527): The structured geocode fallback was added inside the address-based geocoding loop, but references `metroCity` which is only defined inside a different nested block (the name-based fallback at line 1496). This silently crashes geocoding for every restaurant that reaches the structured fallback — 4 failures in the last search alone.

2. **Yelp results disappearing**: 3 Yelp restaurants pass verification but the distance filter removes them. Yelp API provides distance in meters from the user's browser position. For metro Atlanta, a restaurant in Marietta is 20+ miles from North Druid Hills even though both are in the metro. The 20-mile cap is too tight for large metros.

3. **Geocoding over-complexity**: 6+ retry layers with inconsistent variable scoping. Each layer was added as a patch, creating a fragile chain where one bug (like #1) cascades.

4. **OT address extraction gaps**: 4 of 10 OpenTable restaurants had no address. The regex patterns don't handle all OT markdown layouts.

### What Changes

**Section 1: Geocoding (lines ~1274-1568)**
Complete rewrite of `geocodeVerifiedResults`:
- Define `metroCity` at function scope (fixes the ReferenceError)
- Flatten the retry chain into a single `geocodeOneRestaurant` helper with 3 clear steps:
  1. Direct address lookup
  2. Simplified address (strip suite/zip)
  3. Name-based fallback with structured query
- Remove the separate "name-based geocoding for missing addresses" pre-pass (lines 1276-1360) — fold it into the main geocoding loop to eliminate duplicate logic
- All geocode results get the 200-mile sanity check consistently

**Section 2: Distance Filtering (lines ~261-268)**
- Increase metro distance cap from 20 to 30 miles for large metros (Atlanta, LA, Dallas, Houston)
- Keep 12-mile cap for non-metro searches
- Yelp results with API-provided distances use the same cap (currently they do, but 20 was too tight)

**Section 3: Address Extraction (lines ~1746-1847)**
- Add OT-specific pattern for markdown where address appears as `### Location\n\nStreet, City, ST ZIP`
- Improve the broad regex validation: require a street-type word (St, Ave, Rd, etc.) in addition to the 3-word minimum

**Section 4: Variable Scoping**
- Move all shared variables (`metroCity`, `cityLat`, `cityLng`) to the top of their respective functions
- Remove duplicated `metroCity` definitions scattered across nested blocks

### What Does NOT Change
- Query parsing (parseQuery) — working correctly
- Firecrawl discovery (searchFirecrawl) — working correctly
- Yelp discovery (fetchYelpCandidates) — working correctly
- Time slot extraction (Resy meal sections, OT "Select a time") — working correctly
- AI enrichment — working correctly
- Platform URL construction — working correctly
- Deduplication logic — working correctly
- Amenity/experience filtering — working correctly
- Cuisine/dish relevance checking — working correctly
- All metro mappings — working correctly
- Frontend code — no changes

### Technical Details

The rewrite targets ~300 lines of geocoding code and ~10 lines of distance filtering. The remaining ~2,050 lines are preserved as-is.

```text
geocodeVerifiedResults(results, params)
├── metroCity = getMetroCityName(...)     ← defined ONCE at function scope
├── cityLat/cityLng from params           ← defined ONCE
│
├── Phase 1: Name-based geocoding for results without addresses
│   └── For each result missing _address:
│       └── geocodeByName(name, metroCity, state) → distance + neighborhood
│
└── Phase 2: Address-based geocoding for results with addresses
    └── For each result with _address but no distance:
        └── geocodeByAddress(address, metroCity, state)
            ├── Step 1: Direct lookup
            ├── Step 2: Simplified (strip suite + zip)
            ├── Step 3: Structured query (street + city + state params)
            └── Step 4: Name-based fallback
            All steps: 200mi sanity check
```

Distance filter change:
```text
Before: metro → 20mi, non-metro → 12mi
After:  metro → 30mi, non-metro → 15mi
```

### Files Changed
- `supabase/functions/search/index.ts` — geocoding rewrite + distance filter adjustment

