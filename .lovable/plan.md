

## Performance Audit: Search Edge Function

### Current Timing Breakdown (typical search)

Based on the logs and code analysis, a typical search takes ~30-40 seconds:

```text
Phase              Duration    Notes
─────────────────  ─────────   ──────────────────────────────
AI query parse     ~2-3s       gemini-2.5-flash-lite (fast)
Discovery          ~3-5s       3 adapters in parallel (good)
Verification       ~15-25s     24 candidates scraped in parallel, but retries add latency
Geocoding          ~3-8s       Sequential with 100ms stagger + 200ms retry delays
AI enrichment      ~3-5s       Runs in parallel with geocoding (good)
─────────────────  ─────────   ──────────────────────────────
Total              ~25-40s
```

### Bottlenecks Identified

**1. Geocoding stagger is too conservative (saves ~2-4s)**
- Line 1692: Each restaurant geocoded with 100ms stagger — for 12 restaurants, that's 1.2s of pure idle wait before the last one even starts
- Line 1664: 200ms delay between geocoding retry strategies per restaurant — adds 200-400ms per restaurant that needs a fallback strategy
- Combined: ~2-4 seconds of unnecessary serial delays

**2. OpenTable initial waitFor is 5000ms (saves ~2s per candidate)**
- Line 1875: Every OT scrape waits 5000ms for JS rendering
- The HTML parser (added as a secondary extraction) compensates for cases where markdown misses slots
- Reducing to 3500ms is safe because the HTML fallback catches edge cases

**3. OpenTable retry waitFor is 8000ms (saves ~2-3s when triggered)**
- Line 2365: When no "Select a time" section found on first pass, retries with 8000ms
- 6000ms is sufficient — if the widget hasn't loaded in 6s, 8s rarely helps

**4. Yelp retry waitFor is 5000ms (saves ~1-2s when triggered)**
- Line 2551: Second-pass retry with 5000ms after first pass at 3000ms found nothing
- 4000ms is a safer middle ground

**5. Geocoding 200ms inter-strategy delays are unnecessary**
- Lines 1664, 1672: Explicit 200ms sleeps between address simplification retries
- Nominatim can handle rapid sequential queries from the same client

**6. Yelp fallback batch runs even with plenty of results (saves ~5-10s when skipped)**
- Lines 353-371: If zero Yelp results survived, scrapes up to 4 more candidates even if we already have 15+ Resy/OT results
- Should skip if verified count is already ≥12 (diminishing returns)

### Proposed Changes (single file: `supabase/functions/search/index.ts`)

| # | Change | Est. Savings | Risk |
|---|--------|-------------|------|
| 1 | Reduce geocoding stagger from 100ms → 40ms | ~700ms | None — Nominatim handles burst |
| 2 | Remove 200ms inter-strategy geocoding delays | ~1-2s | None — same endpoint, different query |
| 3 | Reduce OT initial waitFor from 5000ms → 3500ms | ~1.5s per OT candidate | Low — HTML parser compensates |
| 4 | Reduce OT retry waitFor from 8000ms → 5500ms | ~2.5s when triggered | Low — incremental gain over first pass |
| 5 | Reduce Yelp retry waitFor from 5000ms → 4000ms | ~1s when triggered | Low — first pass at 3000ms already loaded most |
| 6 | Skip Yelp fallback batch if ≥12 verified results | ~5-10s | None — already have enough results |
| 7 | Batch geocoding in groups of 4 in parallel (no stagger within batch) | ~1-2s | Minimal — Nominatim tolerates small bursts |

### Expected Impact
- **Typical search**: 5-8 seconds faster (from ~35s → ~27-30s)
- **Worst case** (many retries): 10-15 seconds faster
- **Result quality**: Unchanged — no candidates removed, no verification weakened

### What NOT to change
- Discovery parallelization — already optimal (Promise.all across adapters)
- AI model choice — gemini-2.5-flash-lite is already the fastest option
- Candidate cap (24) — directly controls result quality
- Resy scrape settings — no waitFor needed, already fast
- Enrichment parallelization — already runs concurrent with geocoding

