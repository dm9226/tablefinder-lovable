

## Root Cause Analysis

The two failed "dinner next tuesday night in london" searches both returned "Failed to fetch" — the edge function exceeded its execution time limit and the connection was dropped before any response could be sent.

**Why this is happening now:** The recent addition of `waitFor: 3000` on ALL Yelp scrapes plus the two-pass retry (`waitFor: 5000`) dramatically increased total execution time. Here's the worst-case math for a London search:

```text
Verification phase (all in parallel via Promise.all):
  9 Yelp candidates × first pass (waitFor:3000)     ~5-8s each server-side
  9 Yelp candidates × retry pass (waitFor:5000)      ~7-10s each server-side
  9 OT candidates × first pass + potential retry      ~5-10s each
  
  Firecrawl rate-limits concurrent requests, so even "parallel" calls
  queue server-side. Effective wall time: 30-60s for initial batch alone.

Yelp fallback (SEQUENTIAL, after main verification):
  4 more Yelp candidates × two passes each           ~30-40s additional

Total verification: 60-100s (before geocoding + AI enrichment)
```

The successful "dinner tomorrow night in london" search completed in ~25s because fewer candidates triggered retries. The "next tuesday" searches hit a slower Firecrawl window and exceeded the 150s Deno limit.

**Evidence:** Edge function logs show NO processing logs at all for the failed requests — not even "Parsed params" — which means the function either crashed during execution (no graceful response) or the log retention window missed them. The shutdown events at 15:27:55 correlate with forced termination.

## Plan

**File: `supabase/functions/search/index.ts`**

### 1. Add elapsed-time guard before Yelp two-pass retry (~line 2312)

Before the Yelp retry with `waitFor: 5000`, check if we're past 80s elapsed. If so, skip the retry — the first pass result (even if empty) is better than timing out.

```typescript
const elapsedMs = Date.now() - verifyStartTime;
if (isYelp && foundTimes.length === 0 && !hasYelpAvailabilityMarker && elapsedMs < 80_000) {
  // proceed with retry
}
```

This requires passing `startTime` (or a verification-phase start timestamp) into `verifyAvailability`.

### 2. Add elapsed-time guard before Yelp fallback batch (~line 262)

Before trying 4 additional Yelp candidates, check if we're past 90s. Skip the fallback if time is short.

```typescript
const elapsedBeforeFallback = Date.now() - startTime;
if (yelpVerified === 0 && elapsedBeforeFallback < 90_000) {
  // proceed with fallback
} else if (yelpVerified === 0) {
  console.log(`[YELP_FALLBACK] Skipped — ${elapsedBeforeFallback}ms elapsed, insufficient time`);
}
```

### 3. Add per-scrape fetch timeout using AbortController

Wrap each Firecrawl scrape call with a 25s timeout so no single scrape can block indefinitely:

```typescript
const scrapeAbort = new AbortController();
const scrapeTimer = setTimeout(() => scrapeAbort.abort(), 25_000);
let resp = await fetch(`${FIRECRAWL_API}/scrape`, {
  signal: scrapeAbort.signal,
  ...
});
clearTimeout(scrapeTimer);
```

This prevents a hung Firecrawl request from consuming the entire time budget.

### 4. Cap Yelp verification candidates lower when waitFor is active

Since each Yelp candidate now costs 2-3x more time (waitFor + potential retry), reduce the Yelp proportional quota. In `selectCandidatesForVerification`, cap Yelp at `min(proportionalQuota, 6)` instead of allowing up to 9-12.

### What this does NOT change
- Discovery logic — untouched
- Yelp category trust for relevance — untouched  
- OpenTable retry logic — untouched
- `waitFor: 3000` on Yelp first pass — kept (this is the fix that makes slots extractable)
- AI enrichment skip at 110s — kept
- 120s global timeout — kept

### Expected outcome
- Searches that currently time out will complete within budget by skipping expensive retries/fallbacks when time is short
- Yelp results still appear when Firecrawl is responsive (most of the time)
- No regressions on US or UK searches that currently work

