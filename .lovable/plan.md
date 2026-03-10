

## Why Yelp and Resy Results Are Missing

**Single root cause**: The LLM returns `state: "Georgia"` instead of `"GA"`. There is no normalization step, so this cascades through the entire system:

```text
state = "Georgia" (should be "GA")
  │
  ├── Resy slug: "north-druid-hills-georgia" (should be "atlanta-ga")
  │   └── 0 Resy results discovered
  │
  ├── getMetroCityName("North Druid Hills", "Georgia") → fails lookup
  │   └── wasMetroNormalized = false → MAX_DISTANCE = 12mi (should be 20mi)
  │       └── Yelp results >12mi filtered out (all 5 verified Yelp gone)
  │
  ├── stateFiltered (line 594): "GEORGIA" !== "GA" → empty array
  │   └── Coordinates fall back incorrectly
  │
  └── Name geocoding: queries "North Druid Hills, Georgia" instead of "Atlanta, GA"
      └── OT address misses stay unresolved
```

The Yelp results ARE verified (5 of them in logs). They get filtered by the 12-mile cap that should be 20 miles.

## Plan: Add State Normalization (one change, fixes everything)

**File**: `supabase/functions/search/index.ts`

### 1. Add a `normalizeStateCode()` function
A simple lookup map of all 50 US state names → 2-letter codes. Applied immediately after line 450 where `parsed.state` is set.

```typescript
// After line 450:
parsed.state = normalizeStateCode(parsed.state);
```

This fixes:
- Resy slug → `atlanta-ga` (correct)
- Metro normalization → `wasMetroNormalized = true` → 20mi cap
- State filtering → `"GA" === "GA"` (match)
- Name geocoding → "Atlanta, GA" (correct)

### 2. Also normalize at line 505 (browser reverse-geocode fallback)
When `state_code` is missing from Nominatim and it falls back to full state name.

### 3. Also normalize at line 466 (zip code resolution)
Same defensive normalization.

### 4. Add geocode fallback for street-address misses
When a valid address like "1577 North Decatur Rd, Atlanta, GA 30307" fails Nominatim (Double Zero), fall through to name-based geocoding instead of giving up.

