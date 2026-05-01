I agree with your assessment: the current implementation is not close enough to useful. The recent “make it faster” changes treated the symptom by cutting timeouts and candidate counts, but that also made OpenTable nearly impossible to verify and reduced Resy/Yelp coverage. The fix needs to step back from the current scrape-everything-synchronously pipeline.

## What is actually going wrong

1. **OpenTable regressed because we removed the behavior that made it work**
   - Earlier OpenTable worked when it had enough render time and dual extraction from both `markdown` and `html`.
   - The current code now gives OpenTable only ~9s Firecrawl timeout and `waitFor: 1500ms`.
   - Live logs show OpenTable discovery is fine, but verification is almost all Firecrawl `408` timeouts:
     - `THE CHASTAIN`, `Le Bon Nosh`, `Ray's in the City`, `The Americano`, etc.
   - So OT is not “not found”; it is being discovered and then killed by the new timeout budget.

2. **The initial search returns too few results because the cap is now too low and too brittle**
   - Last live run selected only 12 candidates: `resy=6`, `opentable=3`, `yelp=3`.
   - It returned only 2 results because 10/12 verification attempts failed/timed out.
   - Extended search later found 5 more Resy results from candidates that were already discovered, proving the issue is candidate selection/verification budget, not supply.

3. **Resy is still using the wrong primary verifier**
   - Resy is still verified through Firecrawl page scraping.
   - That is slower and more fragile than using Resy’s direct availability endpoint as the primary path.
   - Logs show multiple Resy `408`s, while the same remaining Resy pool later yielded valid results.

4. **The current “Find more results” flow hides a core product failure**
   - It is useful as a secondary feature, but initial search must return enough useful results.
   - Right now “hasMore=true” often means “we discovered many valid candidates but didn’t verify them effectively.”

## Plan

### 1. Restore OpenTable’s reliable verification path instead of starving it

In `supabase/functions/search/index.ts`:

- Restore OpenTable scrape settings closer to the last known working approach:
  - `formats: ["markdown", "html"]`
  - `waitFor: 5000` for OpenTable
  - a longer OT-specific scrape timeout/abort budget, around 18–22s
- Keep OpenTable verification limited in the initial pass so it does not block the whole search:
  - initial OT quota: 2–3 restaurants
  - extended OT quota can be larger
- Keep the existing HTML parser and markdown parser, but strengthen it so OT returns only concrete slot times from “Select a time”/booking widget content.
- Do not fabricate OT results if slots are not present.

Expected effect: OpenTable should return again for OT-heavy searches, but only a small number is attempted initially so one slow OT run cannot stall everything.

### 2. Add a direct Resy availability fast path

Add a Resy-specific verifier before Firecrawl scraping:

- Extract the Resy city slug and venue slug from candidate URLs.
- Use a direct Resy availability request as the primary verification method for each candidate.
- Parse real available slots from the API response.
- Filter to the strict ±2 hour window for the requested time.
- Build the same deep-linked Resy URL with `date`, `seats`, and `time` params.
- Use Firecrawl Resy page scraping only as fallback if the direct path fails or cannot identify the venue.

Expected effect: Resy should stop burning the Firecrawl budget and should return multiple valid results quickly.

### 3. Change initial verification from provider-wide waiting to staged fast lanes

Current code waits for all provider adapter verifications to finish. Replace that with staged verification:

```text
Discovery all providers
  ↓
Stage A: fast Resy direct availability + quick Yelp/OT attempts
  ↓ return if enough results
Stage B: limited OpenTable render scrape + limited Yelp scrape
  ↓ return by hard deadline
Remaining candidates preserved for Find More
```

Implementation details:

- Use a hard initial response target around 18–25s.
- Return as soon as either:
  - at least 6 verified results exist, or
  - the deadline is reached with whatever verified results exist.
- Do not let OpenTable or Yelp prevent already-verified Resy results from returning.
- Preserve all unverified candidates in `remainingCandidates`.

Expected effect: the user sees useful initial results instead of waiting for every slow scrape.

### 4. Stop over-pruning initial candidates

Adjust candidate allocation:

- For vague broad searches, do not cap at only 12 total; use staged quotas instead.
- Initial target:
  - Resy: up to 8–10 direct-fast candidates
  - OpenTable: 2–3 render candidates
  - Yelp: 2–3 render candidates
- Extended search:
  - verify remaining candidates in balanced chunks, not first 18 in the raw list.

Expected effect: no more “1 Resy / 1 Yelp” when the system already discovered dozens of candidates.

### 5. Make extended search provider-balanced

The current extended search takes the next 18 candidates in list order. That can over-focus on one provider.

Update extended mode to use the same provider-balanced selector, with different quotas:

- Resy first if direct API is fast.
- OpenTable with a smaller but real render budget.
- Yelp capped to avoid consuming the entire run.

Expected effect: “Find more results” adds a useful mix instead of random leftovers.

### 6. Add clear provider diagnostics to every response/log

Add structured logs for:

- discovered counts by provider
- selected counts by provider
- verified counts by provider
- timeout counts by provider
- final counts by provider
- elapsed time by phase

Optionally include a non-user-facing `debug` object in function output only during tests/logging, not in the UI.

Expected effect: the next time a provider is missing, we can immediately see whether it was discovery, verification, relevance filtering, distance filtering, or timeout.

### 7. Validate against real searches after implementation

Run live backend tests for:

- `dinner tonight for 2 in Atlanta, GA`
- `Italian tonight for 2 in Atlanta, GA`
- `steakhouse tonight for 4 in Chicago`
- `sushi tonight for 2 in New York`
- one Yelp-native reservation search in Atlanta/Miami

Success criteria:

- Initial search returns materially faster than the prior 37s behavior.
- Initial result count is useful, not 1–2, when candidates exist.
- Resy returns multiple results when availability exists.
- OpenTable appears again on OT-heavy searches.
- Yelp remains included but cannot dominate verification time.
- Every returned result still has verified availability and booking deep-link params.

## Files to change

- `supabase/functions/search/index.ts`
  - provider-specific verification paths
  - Resy direct availability verifier
  - OpenTable render budget restoration
  - staged/early-return verification orchestration
  - provider-balanced extended search
  - diagnostics

No frontend changes are required unless we decide to expose provider diagnostics in the UI, which I do not recommend for users right now.