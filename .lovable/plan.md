
# Comprehensive Search Verification Overhaul

## Root Cause Analysis

The last search ("sushi" near Atlanta) took **132 seconds** and returned only 4 results (2 Resy, 2 Yelp, 0 OpenTable). Here is every problem I found:

### Problem 1: Semaphore pools are per-adapter, not global
Line 392 runs all 3 adapters in parallel, and each adapter calls `verifyAvailability` which creates its **own** local semaphore pools. So:
- Resy creates a fast pool of 6 + OT pool of 3 (but only uses fast)
- OT creates a fast pool of 6 + OT pool of 3 (but only uses OT)
- Yelp creates pools too but **never uses them** — fires all 8 scrapes simultaneously with no concurrency control

**Actual concurrent Firecrawl requests: up to 14 Resy + 3 OT + 8 Yelp = 25.** This causes mass Firecrawl congestion.

### Problem 2: OT enhanced retry doubles cost for 0% return
Every OT stealth failure (25s) triggers an "enhanced" proxy retry (30s). In the last search, **all 8 OT attempts failed both stealth AND enhanced** — burning ~55s per candidate for zero results. The "enhanced" proxy has a 0% success rate against OpenTable's Akamai.

### Problem 3: Resy starved by congestion
10/14 Resy candidates timed out at 15s — not because Resy is slow (it's the fastest provider), but because Firecrawl was overloaded by 25+ simultaneous requests from all three providers.

### Problem 4: Yelp has no concurrency control
The Yelp path (lines 2674-2718) fires all candidates simultaneously via raw `fetch()` with only a 15s `AbortController`. It doesn't use `acquireFcSlot` or any pool. The compatibility shims (`acquireFcSlot = acquireFastFcSlot`) are defined but never called.

### Problem 5: No early-return with partial results
The function waits for ALL verification to complete before returning anything. If OT burns 60s and Resy is done in 15s, the user waits 60s for results that were ready at 15s.

### Problem 6: VERIFY_DEADLINE_MS (105s) is too generous
With a 120s global timeout, a 105s verification deadline means verification can run until 105s, then geocoding/enrichment still need time. The 132s total proves this is cutting it too close to the edge function limit.

---

## The Fix (all in `supabase/functions/search/index.ts`)

### Change 1: Global shared semaphore passed into verifyAvailability
Move semaphore creation out of `verifyAvailability` and into the main handler (near line 390). Pass the pools as a parameter. This gives true global concurrency control across all three parallel adapter calls.

- **Fast pool (Resy + Yelp): 5 slots** — both providers are fast (< 15s) and share bandwidth
- **OT pool: 2 slots** — stealth scrapes are 25s+ each, cap low
- Total: 7 concurrent Firecrawl requests (down from 25)

### Change 2: Yelp uses the fast pool
Route Yelp scrapes through `acquireFastFcSlot`/`releaseFastFcSlot` instead of raw unthrottled `fetch()`. This prevents Yelp from flooding Firecrawl and starving Resy.

### Change 3: Remove OT enhanced retry entirely
The "enhanced" proxy has 0% success and adds 30s per candidate. Remove the retry block (lines 2786-2823). If stealth fails, log and move on.

### Change 4: Verify Resy first, then OT + Yelp
Change line 392 from parallel all-3 to a two-phase approach:
1. **Phase 1**: Verify Resy candidates (fast, high success rate, ~10-15s)
2. **Phase 2**: Verify OT + Yelp in parallel (heavier, lower success)

This ensures Resy gets clean Firecrawl bandwidth first. If we already have enough results after Phase 1, we can time-cap Phase 2.

### Change 5: Lower VERIFY_DEADLINE_MS from 105s to 70s
Ensures verification finishes with enough headroom for geocoding + enrichment + response serialization before the 120s global timeout.

### Change 6: Cap OT candidates to 5
Reduce OT's maximum selection from proportional allocation (currently up to 8) to a hard cap of 5. Given OT's current ~0% success rate with Firecrawl proxies, fewer candidates means less wasted time. This is a one-line change in `selectCandidatesForVerification` or right after it.

### Change 7: Reduce OT client timeout from 30s to 20s
The stealth scrape payload already has a 25s Firecrawl-side timeout. The 30s client timeout adds 5s of unnecessary waiting. Reduce to 20s — if Firecrawl hasn't responded in 20s, it won't.

---

## Expected Outcome

| Metric | Before | After |
|--------|--------|-------|
| Total time | 132s | ~40-60s |
| Firecrawl concurrency | ~25 | 7 |
| Resy success | 2/14 (86% timeout) | Most verified |
| OT wasted time | ~60s (retry) | ~20s (no retry) |
| Yelp concurrency | Unlimited | 5-slot pool |

## Files Changed

- `supabase/functions/search/index.ts` only (7 surgical changes, no refactoring)
