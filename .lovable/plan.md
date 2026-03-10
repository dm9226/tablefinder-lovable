

## Diagnosis

### Issue 1: "Cumberland" location error
The user's browser detects location as **"Cumberland, Georgia"** (via Nominatim reverse geocode on the frontend). When the user searches just "dinner", the AI parses `city: "Cumberland"` from the browser location fallback. Then `hasExplicitStateInQuery()` checks the raw query text `"dinner"` — finds no state. Nominatim returns Cumberland in MD, RI, IA, KY → ambiguous → throws error.

**Root cause**: When the city comes from browser reverse-geocoding (line 496-513, `cityFromBrowser = true`), `parsed.state` is already set correctly. But the disambiguation check at line 576 ignores it because `hasExplicitState` only looks at the user's typed query.

**Fix**: Skip the multi-state ambiguity check when `cityFromBrowser` is true — the state is already resolved from coordinates. Also add "cumberland|ga" to the `RESY_METRO_MAP` for Atlanta metro.

### Issue 2: Missing distances for Resy and some OT results
From the logs:
- `[ADDR_MISS]` for Lucian Books and Wine [resy], Le Bon Nosh [opentable], Lazy Betty [opentable]
- With `onlyMainContent: true` for Resy, the address block is inconsistently stripped
- For OT with `onlyMainContent: false`, the address regex still misses some pages where the address format doesn't match any pattern

**Root cause**: The address extraction is entirely regex-based on page markdown. When the regex doesn't match the specific formatting of a page, there's no fallback. For restaurants where addresses can't be extracted from the page, there's no alternative geocoding strategy.

**Fix**: Add a fallback geocoding strategy — when no address is extracted from the page content, use the **restaurant name + city** as a Nominatim search query. This is less precise but will produce a reasonable distance estimate rather than `null`. Nominatim handles queries like "Lucian Books and Wine, Atlanta, GA" well for known businesses.

## Plan

### 1. Fix browser-detected location disambiguation (edge function)
- At line 576, add `cityFromBrowser` to the condition: if city came from browser, treat it as having an explicit state (skip the ambiguity error)
- Add `"cumberland|ga": "atlanta"` to the RESY_METRO_MAP

### 2. Add name+city geocoding fallback for missing addresses (edge function)  
- After the address regex cascade (around line 1586), when `[ADDR_MISS]` would be logged, instead attempt to geocode using `"<restaurant name>, <city>, <state>"` via Nominatim
- Use a flag like `_addressFromName` to distinguish from precise street-address geocoding
- This ensures all non-Yelp results get at least an approximate distance

### 3. Fix frontend state format
- In `Index.tsx`, the reverse-geocode returns `data.address?.state` which gives "Georgia" (full name). Change to prefer `data.address?.["ISO3166-2-lvl4"]` or use state abbreviation mapping so "Cumberland, GA" is sent instead of "Cumberland, Georgia" — making the AI's job easier.

