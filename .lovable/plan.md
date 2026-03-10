

## Plan: Use Browser Location as Primary Source of Truth

### Problem
The frontend already has reliable, pre-parsed location data (city, state, exact coords) from the browser. But the backend sends it to the AI as "FALLBACK ONLY" and then re-geocodes it, introducing multiple failure points (AI returning wrong state format, city+state merged, etc.).

### Solution
When the browser provides location + coords, parse and use them directly — don't ask the AI or Nominatim to re-derive what we already know.

### Changes (all in `supabase/functions/search/index.ts`, in `parseQuery`)

**1. Parse the frontend `location` string before AI call**

The frontend sends `location: "North Druid Hills, GA"`. Parse this into city + state immediately:

```typescript
let browserCity = "";
let browserState = "";
if (location) {
  const match = location.match(/^(.+),\s*([A-Z]{2})$/);
  if (match) {
    browserCity = match[1].trim();
    browserState = match[2].trim();
  }
}
```

**2. After AI parsing, prefer browser location when user didn't specify one**

If the AI returns an empty or invalid city (meaning the user's query had no explicit location), immediately use the browser-derived city/state/coords instead of doing another Nominatim reverse-geocode:

```typescript
if (!parsed.city && browserCity) {
  parsed.city = browserCity;
  parsed.state = browserState;
  parsed.lat = lat;
  parsed.lng = lng;
  cityFromBrowser = true;
  // Skip the redundant reverse-geocode block entirely
}
```

**3. Always normalize city field after AI parsing**

Regardless of source, strip any embedded state suffix from `parsed.city`:

```typescript
const citySuffix = parsed.city.match(/^(.+),\s*([A-Z]{2})$/);
if (citySuffix) {
  parsed.city = citySuffix[1].trim();
  if (!parsed.state) parsed.state = citySuffix[2];
}
parsed.state = normalizeStateCode(parsed.state);
```

**4. Remove the redundant Nominatim reverse-geocode block (lines 523-541)**

This block re-calls Nominatim with the same coords the frontend already processed. With step 2 above, it's no longer needed. Remove it, keeping only the error throw if no city is resolved at all.

**5. Harden `cleanName` for geocoding**

Strip OT page title junk (` - City, ST on OpenTable`, bullet chars) before name-based geocoding queries. Add distance sanity check: discard geocode results > 200 miles from user coords.

### What this fixes
- **Resy**: Correct metro slug every time (no more `"north-druid-hills-ga-ga"`)
- **Yelp**: Correct metro city for search scope
- **Distance filtering**: `wasMetroNormalized` correctly set → 20mi cap instead of 12mi
- **Geocoding**: Name-based fallback uses correct metro city
- **Eliminates**: AI state format issues, duplicate Nominatim calls, city+state merging bugs

### Files changed
- `supabase/functions/search/index.ts` only

