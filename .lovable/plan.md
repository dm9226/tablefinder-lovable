## Diagnosis

The latest "dinner Wednesday" search shows the new concurrency settings are working — but the bottleneck has moved upstream to **candidate selection**, not scraping speed.

From the logs:
```
candidates  {resy=21, opentable=17, yelp=24}   ← 62 discovered
selected    {resy=5,  opentable=4,  yelp=3}    ← only 12 verified (cap)
verified    {resy=2,  opentable=3,  yelp=1}    ← 6 returned initially
[EXTENDED] Verified: 10/18                      ← 16 total after auto-extend
elapsedMs=27341                                 ← 27s, well under budget
```

You discovered **62 viable candidates** but only verified **12** on the initial pass because of an explicit cap (`maxCandidates = 12` for vague queries like "dinner Wednesday"). The remaining 50 sit on the bench. Auto-extend then verifies 18 more — but that takes another ~10s and the user sees the small initial list first.

The cap exists to protect the 22s lane wall-clock, but with the new concurrency (14 in-flight scrapes, larger batch sizes), each lane can chew through more candidates per wave. We're leaving headroom on the table.

## Plan

Three small changes to `supabase/functions/search/index.ts`:

### 1. Raise the initial candidate cap
- Vague queries: `12 → 20`
- Specific queries (cuisine/dish): `16 → 24`

This moves Resy/OT/Yelp selection from `5/4/3` to roughly `8/7/5` per lane — well within the now-larger batch sizes (Resy=6, OT=4, Yelp=5), so they fit in 1–2 waves per lane.

### 2. Slightly extend lane wall-clocks
- Resy: `22s → 26s`
- Yelp: `22s → 26s`
- OpenTable: stays `26s`

Total budget still well under the 120s global timeout, and 4 extra seconds = 1 more verification wave for the slow lane.

### 3. Lower the bar for surfacing the soft-verified Yelp fallback
Currently Yelp soft-fallback only fires when verification returns 0. Change it to also fire when verified < 2 — Yelp DataDome blocks are still common, and discovery alone is a strong signal.

## Expected outcome

For a generic "dinner Wednesday" query:
- Initial pass: **~12–16 verified results** (up from 6)
- Total wall-clock: ~30–34s (up from 27s, still comfortable)
- Auto-extend still runs to fill in another 6–8 results, ending around **20+ total**

## What stays the same

- No caching (per your rule)
- No new providers / no new APIs
- Auto-extend behavior unchanged
- Global 120s timeout, 14-concurrent Firecrawl cap unchanged

## Risk

Slightly higher Firecrawl spend per search (verifying 20 instead of 12). Most are fast scrapes; the wall-clock guard still prevents runaway cost. If spend climbs uncomfortably, we can dial the cap back to 16.

## Files to change

- `supabase/functions/search/index.ts` — cap constants (line ~416), lane deadlines (lines ~454–456), Yelp soft-fallback threshold (search for `Yelp soft-fallback`)
