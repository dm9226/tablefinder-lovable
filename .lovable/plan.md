

## Diagnosis

I traced the exact path through the code and logs. There are **two distinct problems** causing only OpenTable results to appear:

### Problem 1: Resy slug format is wrong (0 candidates)

The `RESY_METRO_MAP` maps `decatur|ga` → `"atlanta"`, which produces the Firecrawl query:
```
site:resy.com/cities/atlanta/venues/ ...
```

But Resy's actual URL format is `atlanta-ga` (city + state suffix). When the user searches directly for "Atlanta, GA", the fallback in `getResyCitySlug` correctly produces `atlanta-ga` via `slugify("Atlanta") + "-" + slugify("GA")`. But the metro map shortcircuits this fallback and returns the wrong slug.

This affects **every suburb in the metro map** — all 40+ Atlanta suburbs, all NYC boroughs, all LA suburbs, etc.

**Fix**: Modify `getResyCitySlug` to append the state code to metro map slugs. When the map returns `"atlanta"` and the state is `"ga"`, produce `"atlanta-ga"`. This is universal — works for all cities without changing every map entry.

### Problem 2: Yelp results filtered out by 12-mile distance cap

Logs show 15 restaurants were verified (including Yelp: Fusion Restaurant & Bar, Big Joe's Grille, High Noon Brunchery, Parkside District, etc.). But after AI enrichment, the 12-mile distance filter removed the Yelp results because `params.lat/lng` points to Decatur's coordinates (33.77, -84.29), and many Yelp-discovered restaurants in the broader Atlanta metro are beyond 12 miles from that point.

This is a tension: we normalize the search city to "Atlanta" for broader discovery, but then measure distance from Decatur. For a 15-mile-wide metro like Atlanta, 12 miles is too strict when the search city was normalized.

**Fix**: When the search city was metro-normalized (i.e., user said "Decatur" but we searched "Atlanta"), increase the distance cap to 20 miles. When the user searches a major city directly, keep 12 miles.

### Technical Changes

**File: `supabase/functions/search/index.ts`**

1. **`getResyCitySlug()`** (line ~889): After looking up the metro slug, append `-{state}` if state is available. e.g., `"atlanta"` + `"ga"` → `"atlanta-ga"`. This matches Resy's actual URL format universally.

2. **Distance filter in `enrichWithAI()`** (line ~1287): Track whether a metro normalization occurred (city differs from search city). If so, use 20-mile cap instead of 12.

3. Pass a `wasMetroNormalized` flag through to the enrichment step, or compute it inline by checking if `getMetroCityName(params.city, params.state) !== params.city`.

