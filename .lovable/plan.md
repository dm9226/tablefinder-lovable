# Auto-extended search with distance-sorted merge

When the initial search returns and `hasMore` is true, automatically kick off the extended search in the background and slot any new results into the existing list ordered by distance (instead of appending them at the bottom behind a "Find more results" button).

## Behavior

- Initial search renders as it does today.
- As soon as results are shown, if `hasMore` is true, fire the extended search automatically (no user click).
- Show a subtle "Searching for more…" indicator at the bottom of the list while the auto-extend runs (reuse existing `isExtending` UI).
- When extended results return, merge them with the existing list, dedupe, then re-sort the entire combined list by `distanceMiles` ascending (nulls last), with rating as the tiebreaker — same ordering rule the edge function already uses.
- Hide the manual "Find more results" button (no longer needed). If the auto-extend fails, fall back silently — no toast spam.
- Only auto-extend once per search to avoid loops, even if the extended response itself returns `hasMore: true`.
- A new search (or cancel) cancels any in-flight auto-extend.

## Files to change

### `src/pages/Index.tsx`
- Add a `useEffect` that watches `hasMore`, `remainingCandidates`, `lastParams`, and `isLoading`. When `!isLoading && hasMore && remainingCandidates.length > 0 && !isExtending` and we haven't auto-extended for this search yet, call `handleExtendedSearch()`.
- Track `autoExtendedFor` (e.g. a ref keyed off the `lastQuery` + timestamp of the initial search) so each search auto-extends at most once.
- In `handleExtendedSearch`, replace the append-only merge with a merge-then-sort:
  - Combine `prev` + `newResults`.
  - Dedupe by `${name}|${platform}` (keep the first occurrence — initial results win, since they're already enriched).
  - Sort by `distanceMiles ?? Infinity` asc, tiebreak by `(rating ?? 0)` desc.
- Remove the success/info toasts for the auto path (keep silent). Keep error handling silent on auto-extend; only surface errors if the user manually triggered it (n/a once button is removed, so just swallow).
- Reset the auto-extend guard inside `handleSearch` and `cancelSearch`.
- Wire an AbortController (or reuse `abortRef`) so a new search aborts the in-flight extend.

### `src/components/ResultsGrid.tsx`
- Remove the "Find more results" button block.
- Keep the `isExtending` spinner row (now serves as the auto-extend indicator).
- Optionally drop the now-unused `hasMore` and `onExtendSearch` props, or leave them in place as no-ops to avoid wider refactors. Prefer removing for cleanliness.

### `supabase/functions/search/index.ts`
No changes. The extended endpoint already returns geocoded, distance-bearing results, and the client-side resort handles ordering.

## Edge cases

- If the extended response returns 0 new results: do nothing, leave the list as-is.
- If the user starts a new search while auto-extend is running: `abortRef.current?.abort()` plus the new search resetting state already prevents stale results from being merged (guard with a captured `controller.signal.aborted` check before `setResults`).
- Soft-verified Yelp entries with `distanceMiles == null` will sort to the end, which matches current behavior.

## Out of scope

- No animation/transition on the re-sort (results just snap into the new order).
- No additional rounds of auto-extension beyond the first.
