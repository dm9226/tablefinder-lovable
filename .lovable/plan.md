

## Analysis: Why Distances Keep Failing

Looking at the latest "steak tomorrow night" logs, **2 of 13 results have `distanceMiles: null`**:

1. **KR SteakBar (Resy)**: Address is on the page (349 Peachtree Hills Ave NE, Atlanta, GA 30305) but never extracted because **Resy scrapes use `onlyMainContent: true`** (line 1683), which strips the sidebar/footer where the address lives. Then the name-based Nominatim fallback fails because "KR SteakBar" isn't a known place in Nominatim.

2. **101 Steak (OT)**: The actual address (3090 Piedmont Rd NE) IS on the full page, but the specific regex patterns don't match it (likely due to markdown formatting). The broad regex catches "101 Steak, Atlanta, GA" instead (the restaurant name, not address) — correctly rejected by our word-count fix. Then name-based lookup matches something 4,881 miles away (Turkey).

**Root cause**: Resy pages are scraped with `onlyMainContent: true`, which strips location data. This was done to "avoid noise in meal-section parsing" but the time parser already handles noise (it targets specific section headers like "dinner", "Select a time").

### Fix (single line change + one safety net)

**1. Set `onlyMainContent: false` for Resy too** (line 1683)
Change from only OT getting full page to both Resy and OT:
```typescript
onlyMainContent: isYelp,  // Yelp only — Resy and OT need full page for address extraction
```
This immediately exposes Resy addresses to the existing regex extractors. The time parsing logic already isolates "dinner" sections by header matching, so extra page content won't create false time matches.

**2. Add Google Maps geocoding fallback for remaining misses**
For any restaurant still missing `distanceMiles` after all Nominatim attempts, try one more query format: `"restaurant name" + "address" + metro city` using Nominatim's structured query mode (`street=` + `city=` + `state=` params) which is more reliable than free-text search for partial matches.

```typescript
// After all other geocoding, for remaining misses:
const nameStructured = `${cleanName}&city=${metroCity}&state=${state}`;
// Use Nominatim structured query: ?street=...&city=...&state=...
```

### What this fixes
- KR SteakBar: address regex will now find "349 Peachtree Hills Ave NE" in the full Resy page
- Future Resy results: all addresses now extractable (was previously 5/6, should be 6/6)
- 101 Steak and similar OT edge cases: structured Nominatim query as safety net

### What's NOT changed
- Time slot parsing logic (already section-targeted)
- OT scraping (already `onlyMainContent: false`)
- Yelp scraping (stays `onlyMainContent: true` — no addresses available anyway)
- All existing geocoding retry logic preserved

### Files changed
- `supabase/functions/search/index.ts` only

