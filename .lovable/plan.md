

## Add UK Support to TableFinder

### What needs to change

There are 6 US-only hardcoded constraints to address:

**1. AI Parse Prompt** — Currently expects US state codes and zip codes only. Need to add `country` field and handle UK cities/postcodes.

**2. Nominatim Geocoding** — Two calls use `country=us` / `countrycodes=us` filters (lines 609, 689). Need to allow `gb` when UK is detected.

**3. State/Region Handling** — `STATE_NAME_TO_CODE` only has US states. `normalizeStateCode` needs to pass through UK regions (e.g. "England", "London") without breaking.

**4. Resy Discovery** — Resy operates in London (slug: `london`). Need to add UK metro mappings and handle Resy URLs without state suffix (London doesn't use `london-xx`).

**5. OpenTable Discovery** — UK restaurants live on `opentable.co.uk`, not `opentable.com`. Firecrawl queries and URL canonicalization need to support both domains.

**6. Yelp Discovery** — Yelp has UK presence. Yelp API `location` param works internationally, so minimal changes needed.

### Implementation

**File: `supabase/functions/search/index.ts`**

1. **Add `country` to `SearchParams`** interface — `country: string` (default `"us"`, `"gb"` for UK)

2. **Update AI parse prompt** to:
   - Detect UK cities (London, Manchester, Edinburgh, Birmingham, etc.) and UK postcodes
   - Return `country: "gb"` when UK location detected
   - Accept UK regions/countries instead of US state codes (e.g. "England", "Scotland")

3. **Update Nominatim calls**:
   - Line 609 (zip): support UK postcodes (e.g. `SW1A 1AA`) alongside US zip codes
   - Line 689 (city geocode): use `countrycodes=gb` when `country === "gb"`, otherwise `us`

4. **Add UK entries to `RESY_METRO_MAP`**:
   - `"shoreditch|england": "london"`, `"soho|england": "london"`, etc.

5. **Update `getResyCitySlug`** — For UK cities, don't append state code (Resy uses `london` not `london-england`)

6. **Update OpenTable discovery queries** — When `country === "gb"`, use `site:opentable.co.uk/r` instead of `site:opentable.com/r`

7. **Update `extractCanonicalUrl`** for OpenTable — Accept `opentable.co.uk` domain alongside `opentable.com`

8. **Update Yelp discovery** — Pass country-appropriate locale to Yelp API

9. **Update `normalizeStateCode`** — Pass through non-US region strings without trying to map them

10. **Relax zip code validation** — Currently checks `^\d{5}$` (US only). Add UK postcode pattern.

### Scope

Single file change: `supabase/functions/search/index.ts`. No frontend changes needed — the search bar and results grid work with any location string.

