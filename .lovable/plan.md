

## Performance Optimizations (Without Reducing Candidate Cap)

Based on the logs, the breakdown is roughly:
- Query parse: ~1.8s
- Discovery: ~1.7s  
- **Verification: ~40s** (24 Firecrawl scrapes — the bottleneck)
- Geocoding: ~4.5s (sequential, 300ms stagger)
- AI enrichment: ~3s

Total: ~50s. Target: ~25-30s.

### Changes (all in `supabase/functions/search/index.ts`)

**1. Parallelize geocoding + AI enrichment (~3s saved)**
Lines 202-206 run sequentially but have no dependency on each other. Wrap in `Promise.all`:
```typescript
const [_, enriched] = await Promise.all([
  geocodeVerifiedResults(verified, params),
  enrichWithAI(verified, LOVABLE_API_KEY, params)
]);
```
Note: `enrichWithAI` doesn't use `distanceMiles` — it only adds ratings/descriptions. Distance filtering happens after both complete, so we just need to re-apply the distance filter after geocoding completes.

Actually — `enrichWithAI` does distance filtering at the end (lines 1356-1362). So we need a small refactor: pull distance filtering out of `enrichWithAI` into the main flow, then geocode and enrich truly run in parallel.

**2. Reduce geocode stagger from 300ms to 100ms (~2.4s saved)**
Line 1188: change `i * 300` to `i * 100`. Edge functions use different IPs per invocation so Nominatim's 1 req/s per IP limit won't be hit.

**3. Remove `extract` format from OpenTable scrapes (~2-4s saved per OT scrape)**
OpenTable verification currently uses Firecrawl's LLM `extract` format, which adds significant per-scrape latency. Switch to `markdown` format and use regex to extract availability times (similar to how Resy already works). The regex patterns for time slots (`/\d{1,2}:\d{2}\s*(AM|PM)/gi`) already exist in the codebase as fallbacks.

**4. Reduce Firecrawl search `limit` from 20 to 12 (~0.5s saved)**
Discovery requests 20 results per query but we only verify 24 total across all platforms. 12 per query (with 2 queries per platform) still gives up to 24 per platform before dedup — more than enough to fill the proportional allocation.

### Expected Impact
- Optimization 1: ~3s saved
- Optimization 2: ~2.4s saved  
- Optimization 3: ~5-10s saved (biggest win — removes LLM extraction from each OT scrape)
- Optimization 4: ~0.5s saved

**Combined: ~50s → ~30-35s**, keeping all 24 verification slots.

