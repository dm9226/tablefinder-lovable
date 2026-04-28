# Why nearby venues are still missing

The distance-from-centroid fix (already deployed) addresses one bug, but the logs from your last search reveal a second, more impactful bug: **the extended-search verification batch is timing out on a cluster of 5–6 nearby OpenTable venues at once**.

From your last search, every one of these timed out at exactly the 25-second abort:
- Rose & Crown (Vinings)
- HOBNOB Neighborhood Tavern - Vinings
- Maggiano's - Cumberland
- Canoe
- Crispina Ristorante & Pizzeria
- National Anthem Atlanta

Six simultaneous timeouts is not a coincidence — it strongly suggests the extended batch is firing too many Firecrawl scrapes in parallel and they're starving each other (or hitting a Firecrawl concurrency limit). These venues all *would have* verified successfully with more time / less contention, since they're real OT-listed restaurants with current availability.

## Fix plan

### 1. Reduce extended-search parallelism for OpenTable verification

In `supabase/functions/search/index.ts`, find the extended-search verification path (where the 18 remaining candidates get verified) and:
- Process OpenTable candidates in **batches of 3** instead of all-at-once.
- Keep Resy/Yelp at higher parallelism (they don't show this problem).
- Add a small (250ms) stagger between batches to avoid Firecrawl rate-limiting.

### 2. Increase the OpenTable scrape timeout from 25s → 35s

The 25s abort is too tight for OpenTable's reservation widget, which routinely needs `waitFor: 8000ms` on retry. A 35s ceiling still keeps us under the 120s global budget but gives slow widget loads room to complete.

### 3. Add a one-time retry for timeout failures

When a scrape aborts at the timeout, retry it ONCE at the end of the verification batch (after all primary work completes). If Firecrawl was just overloaded the first time, the retry usually succeeds. Cap retries at 3 per search to bound the cost.

### 4. Log timeout cluster diagnostics

Log the count of timeouts per provider per search so we can spot this pattern in the future:
```
[EXTENDED] OpenTable timeouts: 6/8 candidates — possible Firecrawl contention
```

### 5. Confirm the distance-fix deployment with a fresh search

The previous deployment (preserving `userLat/userLng` and using them for ranking) is live but hasn't been exercised yet. After the timeout fix above ships, the next search should show the new diagnostic logs (`Coords received`, `Distance ref: user coords`, `User ZIP from coords:`). I'll verify those land correctly.

## Files touched

- `supabase/functions/search/index.ts` — extended-verification batch logic, OpenTable scrape timeout constant, retry-on-timeout helper, diagnostic log.

## Out of scope

- No frontend changes.
- No DB / RLS / auth changes.
- Suburb-aware Firecrawl discovery queries (still deferred to v2).

## Expected outcome

After this ships, Rose & Crown, HOBNOB Vinings, Maggiano's Cumberland, and the other Cumberland/Vinings OpenTable venues should survive verification and appear in your results — provided they have actual availability for your requested time. Combined with the already-deployed distance fix, "near you" should finally mean "near you" instead of "near downtown."
