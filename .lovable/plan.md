

## Provider Adapter Refactor Plan

### Overview
Reorganize the 2,059-line `supabase/functions/search/index.ts` into a provider adapter pattern. Zero behavior change — same logic, same execution order, same results.

### Interface

```typescript
interface ProviderAdapter {
  platform: "resy" | "opentable" | "yelp";
  discover(params: SearchParams, keys: ApiKeys, amenityTerms: string[]): Promise<Restaurant[]>;
  verify(candidates: Restaurant[], params: SearchParams, keys: ApiKeys, amenityTerms: string[]): Promise<Restaurant[]>;
}

interface ApiKeys {
  firecrawlKey: string;
  yelpKey?: string;
}
```

### File Organization (all in index.ts)

The file will be reorganized into clearly labeled sections:

```text
1. Imports, constants, interfaces, types (~130 lines — unchanged)
2. Cache layer functions (~120 lines — unchanged)
3. serve() handler — refactored to loop over adapters (~80 lines)
4. parseQuery() and geo helpers (~450 lines — unchanged)
5. Shared utilities: URL helpers, name cleaning, dedup, haversine, amenity checks (~200 lines — unchanged)
6. resyAdapter object — wraps: searchFirecrawl("resy"), normalizeCandidates("resy"), Resy verification logic
7. opentableAdapter object — wraps: searchFirecrawl("opentable"), normalizeCandidates("opentable"), OT verification logic
8. yelpAdapter object — wraps: fetchYelpCandidates(), Yelp verification logic
```

### What changes in serve()

Current (lines 297-338):
```typescript
const [resyCandidates, otCandidates, yelpCandidates] = await Promise.all([
  searchFirecrawl(params, FIRECRAWL_API_KEY, "resy", amenityTerms),
  searchFirecrawl(params, FIRECRAWL_API_KEY, "opentable", amenityTerms),
  YELP_API_KEY ? fetchYelpCandidates(...) : [],
]);
const resyRaw = normalizeCandidates("resy", resyCandidates, params);
const otRaw = normalizeCandidates("opentable", otCandidates, params);
const allCandidates = dedupeByName([...resyRaw, ...otRaw, ...yelpCandidates]);
const verified = await verifyAvailability(allCandidates, params, FIRECRAWL_API_KEY, amenityTerms);
```

Becomes:
```typescript
const keys: ApiKeys = { firecrawlKey: FIRECRAWL_API_KEY, yelpKey: YELP_API_KEY };
const adapters: ProviderAdapter[] = [resyAdapter, opentableAdapter];
if (YELP_API_KEY) adapters.push(yelpAdapter);

const discovered = await Promise.all(
  adapters.map(a => a.discover(params, keys, amenityTerms))
);
const allCandidates = dedupeByName(discovered.flat());

const verified = (await Promise.all(
  adapters.map(a => a.verify(
    allCandidates.filter(c => c.platform === a.platform),
    params, keys, amenityTerms
  ))
)).flat();
```

### What each adapter contains

**resyAdapter.discover()**: Calls `searchFirecrawl(params, key, "resy", amenityTerms)` then `normalizeCandidates("resy", ...)`. Identical logic.

**resyAdapter.verify()**: Runs Firecrawl scrape with markdown-only format, applies Resy meal-section parsing (lines 1826-1863), cuisine relevance check, amenity check. Returns verified restaurants with time slots.

**opentableAdapter.discover()**: Calls `searchFirecrawl(params, key, "opentable", amenityTerms)` then `normalizeCandidates("opentable", ...)`.

**opentableAdapter.verify()**: Runs Firecrawl scrape with markdown+extract format, uses structured `availableTimes` extraction, falls back to regex. Same OT-specific logic currently in `verifyAvailability()`.

**yelpAdapter.discover()**: Calls existing `fetchYelpCandidates()` directly (already returns `Restaurant[]`).

**yelpAdapter.verify()**: Runs Firecrawl markdown scrape, uses Yelp availability marker fallback. Same Yelp-specific logic.

### Shared code that stays as-is
- `searchFirecrawl()` — still called by Resy and OT adapters
- `normalizeCandidates()` — still called by Resy and OT adapters  
- `fetchYelpCandidates()` — called by Yelp adapter
- `parseQuery()`, all geo/cache/enrichment functions
- `selectCandidatesForVerification()` — called within each adapter's verify, but applied per-platform bucket
- All constants, maps, and helper functions

### Verification cap adjustment
Currently `selectCandidatesForVerification` caps at 24 total across all platforms with round-robin. With per-adapter verification, each adapter will cap at 8 candidates (24/3), maintaining the same total verification budget.

### What this enables
After this refactor, replacing Firecrawl in any single adapter (e.g., swapping `searchFirecrawl` for a direct Resy API call inside `resyAdapter.discover()`) requires editing only that adapter — no other code touched.

