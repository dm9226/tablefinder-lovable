

## Problem: "Patio" Search Rejects All Results at Cuisine Check

### Root Cause

There are **two separate relevance checks** that run sequentially during verification:

1. **Cuisine relevance check** (line 2090) — checks if the page mentions cuisine tokens with strict matching (3+ occurrences or in name/header)
2. **Amenity relevance check** (line 2172) — checks if the page mentions amenity synonyms (patio, outdoor seating, al fresco, etc.) with loose matching

The problem: when the user searches "patio", the AI parser puts "patio" into `params.cuisine`. This means "patio" ends up in `cuisineTokens` at line 2073 and gets checked as a **cuisine word** with strict matching. Most restaurant pages don't mention "patio" 3+ times in their text or in their name/header, so they fail at step 1 and never reach the amenity check at step 2 — which would have passed them using the synonym list.

The logs confirm this: every rejection says `failed cuisine relevance (category) for: patio (checked: patio)`. The amenity check never runs.

For Yelp specifically, the `_yelpCategories` field is checked for "patio" (line 2122), but Yelp categories are things like "italian", "seafood" — never "patio". So Yelp candidates also fail.

### Fix

**File: `supabase/functions/search/index.ts`**

1. **Filter amenity terms out of `cuisineTokens` and `verifyTokens`** at the cuisine relevance check (around line 2073). Use the existing `AMENITY_KEYWORDS` keys to identify them. If "patio" is the only token, `verifyTokens` becomes empty, and the cuisine check is skipped entirely (`verifyTokens.length > 0` is false).

2. The **amenity check at line 2172 already handles this correctly** — it uses the `AMENITY_KEYWORDS` synonym list with loose matching. No changes needed there.

3. **For Yelp specifically**, also skip the `_yelpCategories` cuisine check when the only tokens are amenity terms, allowing Yelp candidates to pass through to the amenity synonym check.

### What this changes
- Amenity-only searches ("patio", "rooftop", "outdoor") skip the cuisine relevance gate entirely and rely on the purpose-built amenity check
- Mixed searches ("italian patio") still check "italian" via cuisine relevance AND "patio" via amenity check
- No performance impact — just filtering a token array

### Expected Outcome
- Restaurants with patios/outdoor seating pass verification when searching "patio"
- Yelp results return alongside Resy and OpenTable results

