

## Extended Search Feature

**Concept**: After initial results load, show a "Find More Results" button that triggers a second verification pass on the remaining untested candidates from the same discovery pool. This avoids re-running discovery (which is the same query) and instead verifies the candidates that were skipped due to the proportional cap.

### How it works

```text
Initial Search (current flow):
  Discovery → 40-60 candidates
  Verify cap → 18-24 selected → ~8-15 verified results returned
  
Extended Search (new):
  User clicks "Find More" → sends same query + flag
  Edge function skips discovery, uses cached candidates
  Verifies remaining ~20-30 untested candidates
  Returns additional results appended to existing ones
```

### Backend Changes (supabase/functions/search/index.ts)

1. **Cache discovery candidates**: After discovery, store `allCandidates` plus `selectedIds` (the ones already verified) in the `search_cache` table alongside the existing results cache.

2. **New `extended: true` parameter**: When the edge function receives `{ query, extended: true, cacheKey }`, it:
   - Loads the cached candidates from `search_cache`
   - Filters out already-verified candidates
   - Runs verification on up to 18 more candidates (with the same time guards)
   - Returns the new results only

3. **Response shape**: Add `hasMore: boolean` to the response so the frontend knows whether to show the button. Set `hasMore = true` when `allCandidates.length > selected.length`.

### Frontend Changes

4. **Index.tsx**: 
   - Track `hasMore` and `lastQuery` state
   - Add `handleExtendedSearch` that calls the edge function with `extended: true`
   - Append extended results to existing results (don't replace)
   - Track `isExtending` loading state (separate from initial `isLoading`)

5. **ResultsGrid.tsx**:
   - Accept new props: `hasMore`, `onExtendSearch`, `isExtending`
   - Below the results list, render a "Find More Results" button when `hasMore && !isExtending`
   - Show a small spinner with "Searching for more..." when `isExtending`
   - After extended results arrive, update the count and hide the button if no more remain

6. **SearchMeta type**: Add `hasMore?: boolean` to the response type and `SearchMeta` interface.

### UX

- Button appears below results: "Search for more results" with a subtle secondary style
- Clicking shows inline loading indicator (not the full-screen SearchProgress)
- New results append at the bottom with a brief highlight/fade-in
- Button disappears when no untested candidates remain

### Technical Notes

- Reuses the existing `search_cache` table (already has `results` JSON column) — extend it to also store `candidates` and `verified_ids`
- Discovery is NOT re-run, saving significant time and API calls
- The same time guards (80s Yelp retry, 90s fallback, 25s per-scrape) apply to extended search
- Cache entries expire naturally via the existing TTL logic

