
## Problem

Two issues from your last search:

1. **OpenTable results failing**: 5 of 6 OT candidates failed verification — 4 got 408 timeouts, 1 was blocked by Akamai. Only Murphy's Restaurant made it through. The current code uses `waitFor: 5000` which doesn't force Firecrawl to use a full browser session, so anti-bot protection kills the request.

2. **Extended search never runs**: The backend returned `hasMore=true` with 36 remaining candidates, but the frontend never auto-triggers the extended search. The function exists but nothing calls it.

## Plan

### 1. Fix OT scraping with Firecrawl `actions` parameter

Replace `waitFor`-based OT payload with `actions`-based approach that forces a real browser session:

```
actions: [{ type: "wait", milliseconds: 5000 }]
```

This tells Firecrawl to spin up a full headless browser (required to bypass Akamai). Also add a retry on 408 for OT specifically, since the second attempt often succeeds when the page is cached.

Cost impact: `actions` mode uses 5 credits per scrape (enhanced proxy). With 6 OT candidates, worst case is 30 credits per search — within the existing Firecrawl plan.

### 2. Auto-trigger extended search

Add a `useEffect` in `Index.tsx` that automatically calls `handleExtendedSearch` when:
- `hasMore` is true
- Not already extending
- Not loading
- There are remaining candidates

This makes the search continue in the background after initial results appear, finding more OT/Resy/Yelp results from the 36 remaining candidates.

## Files Changed

- `supabase/functions/search/index.ts` — OT scrape payload uses `actions`, 408 retry for OT
- `src/pages/Index.tsx` — useEffect to auto-trigger extended search
