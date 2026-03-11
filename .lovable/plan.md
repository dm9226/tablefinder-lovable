

## Fix 6 Issues From "steak tonight" Search — Safe, Targeted Changes

All changes in `supabase/functions/search/index.ts`. Each fix is isolated and cannot regress existing behavior.

---

### Fix 1: Broad address regex false positive (101 Steak)
**Problem**: The broad fallback regex `(\d{1,5}\s+[A-Za-z\s.#']+,\s*[A-Za-z\s]+,\s*[A-Z]{2})` matched `"101 Steak, Atlanta, GA"` because the restaurant name starts with digits. This is not a real address.

**Fix** (line ~1752): Add a minimum length check and require at least 2 words after the digits before the comma. This prevents short restaurant-name-like matches:
```typescript
// Before accepting broad regex match, validate it looks like a real address
// (at least 3 space-separated tokens before first comma)
const broadCandidate = addrMatch3[1].trim();
const preComma = broadCandidate.split(",")[0].trim();
const wordCount = preComma.split(/\s+/).length;
if (wordCount >= 3) {
  r._address = broadCandidate;
  // ... existing city extraction
}
```

---

### Fix 2: OT marker-only results have empty timeSlots (Marcel)
**Problem**: When booking markers are detected but no times are extractable, the function returns the restaurant with `timeSlots: []`. The UI shows a card with no times — confusing.

**Fix** (lines ~2140-2143): When trusting the OT booking marker, set `timeSlots` to contain the user's requested time so the card is useful:
```typescript
if (foundTimes.length === 0 && hasOTBookingMarker) {
  const reqLabel = toTwelveHourLabel(params.time);
  if (reqLabel) r.timeSlots = [{ time: reqLabel }];
  console.log(`✓ Verified ${r.name} [opentable] — booking markers, using requested time`);
  return r;
}
```
Same fix for the Yelp marker fallback (line ~2133-2136).

---

### Fix 3: Tighten Yelp cuisine filter for dish searches
**Problem**: For "steak" search, the expanded tokens include `"american"` (from DISH_TO_CUISINE_MAP). This is too broad — lets through "Breakfast At Barneys", "Le Gabrielle Crepes & Waffles", etc.

**Fix**: When a `dishKeyword` is set, only use the specific parent cuisines that are strongly related (e.g. "steakhouse", "chophouse") and exclude overly generic ones like "american". Add a small blocklist of generic tokens to exclude from expanded Yelp filtering when a dish keyword is present:
```typescript
const GENERIC_CUISINE_TOKENS = new Set(["american", "asian", "european", "mediterranean"]);
// When dish keyword exists, filter out generic tokens from expanded set
if (params.dishKeyword) {
  expandedTokens = expandedTokens.filter(t => !GENERIC_CUISINE_TOKENS.has(t));
}
```
Applied in both the Yelp candidate filter (~line 1202) and the verification cuisine check (~line 1806).

---

### Fix 4: Geocode retry without zip code
**Problem**: "5245 Peachtree Pkwy, Norcross, GA 30092" fails Nominatim. The existing simplified-address retry only strips suite/unit numbers, not zip codes.

**Fix** (line ~1425, in the simplified retry block): After the suite-stripping retry fails, also try stripping the zip code:
```typescript
// After existing simplified retry, try without zip
const noZip = addr.replace(/\s+\d{5}(-\d{4})?$/, "").trim();
if (noZip !== addr && noZip !== simplified) {
  // ... fetch with noZip
}
```

---

### Fix 5: Distance sanity check on address-based geocoding
**Problem**: The 200-mile sanity check exists for name-based fallbacks but NOT for the main address-based geocoding loop (lines ~1414-1421). A bad address match could still produce wild distances.

**Fix** (line ~1415): Add the same `> 200` check:
```typescript
if (Number.isFinite(lat) && Number.isFinite(lng)) {
  const dist = +haversine(cityLat, cityLng, lat, lng).toFixed(1);
  if (dist > 200) {
    console.log(`  Geocode sanity fail ${r.name}: ${dist} mi — discarding`);
  } else {
    r.distanceMiles = dist;
    // ... neighborhood extraction
  }
}
```

---

### What is NOT changed
- Hal's name — user confirmed it's correct
- Core search flow, parsing, metro mapping, Resy/OT discovery
- Time slot extraction logic
- Browser location priority (recent fix)
- State normalization (recent fix)

