
Goal: fix three regressions at once — inaccurate “available” times (OpenTable), false positives when no tables exist (Resy/Hayakawa), and missing search criteria summary UI.

What I found (from current code + logs + fetched page content):
1. `verifyAvailability` still extracts times from broad markdown with regex. Even with context filtering, it can pick non-bookable times.
2. Hayakawa markdown contains “NotifyAll Times” (no availability) but later “Need to Know” text includes fixed seatings “6:00pm and 8:30pm”; those are currently being misread as available slots.
3. OpenTable results are sourced from whatever times happen to be extracted, not strictly from the booking-slot section, so “closest times” can still be wrong if extraction source is noisy.
4. Search criteria summary (`searchMeta`) is only in React state, not persisted; it can disappear when results are restored from session. It also only renders in the success branch of `ResultsGrid`.

Implementation plan

1) Harden availability verification (single file: `supabase/functions/search/index.ts`)
- Add platform-specific availability section parsing so time extraction only runs inside booking UI sections, not “Need to Know”, “About”, “Hours”, etc.
- Extend scrape strategy for Resy/OpenTable:
  - use short JS wait (`waitFor`) to improve booking widget render.
  - add structured extraction fields for availability (e.g., `availableTimes`, `noAvailability`, `notifyOnly`).
- New decision order:
  1. Prefer structured extracted `availableTimes`.
  2. Fallback to regex only inside availability sections.
  3. If Resy/OpenTable has notify/no-availability markers without bookable times, reject candidate.
- Keep dedupe + meal-window filtering + proximity ranking, then sort final slots chronologically before returning.

2) Keep “most relevant times” behavior deterministic
- After obtaining trusted times, normalize/dedupe, compute distance from requested time, keep closest set, then re-sort chronologically for display.
- Ensure repeated time strings cannot reappear.

3) Restore and stabilize search summary UI
Files:
- `src/pages/Index.tsx`
- `src/components/ResultsGrid.tsx`
- (optional) `src/types/restaurant.ts` if formatter helpers are added

Changes:
- Persist `searchMeta` to session storage alongside results.
- Hydrate `searchMeta` on mount when restoring previous results.
- Render the summary row above all searched states (results, empty, and error) so it never “disappears” after a completed search.
- Improve formatting (`19:00` → `7:00 PM`) for readability.

Validation checklist after implementation
1. Query reproducing Hayakawa URL should return no slots / no inclusion if no real availability.
2. Tomo should show nearest real bookable times from the booking panel and in chronological order.
3. No duplicate slots in cards.
4. Summary bar visible after search, after refresh, and on empty/error result states.
