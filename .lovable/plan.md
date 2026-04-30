You’re right to call this out. From the screenshot and logs, this is not acceptable for the product spec. The current flow is technically returning “verified slots”, but the overall system is failing quality, recall, latency, and background-continuation expectations.

What is wrong with the returned results:

1. Platform mix is broken
- Only one OpenTable result is visible because most OpenTable candidates are failing verification before they can be returned.
- Recent logs show repeated OpenTable scrape failures: 408 timeouts, retry failures, and browser load errors like `ERR_EMPTY_RESPONSE`.
- The current OT verification approach depends on full browser rendering through Firecrawl stealth. That is too slow and too fragile as the primary path.

2. The 30+ second wait is mostly verification time, not parsing or UI
- The latest logged search spent ~55 seconds in verification and almost no time in enrichment/geocoding.
- So the bottleneck is not the React UI and not AI enrichment; it is scraping candidate booking pages.

3. “Background search” technically fires, but it is not a proper background search
- The frontend auto-calls extended search after the first response, but it sends another long synchronous Edge Function request.
- If those follow-up candidates are mostly OpenTable failures, the user sees little or no visible improvement.
- The UI does not clearly communicate incremental provider progress or why additional results are still being checked.

4. Candidate selection is flawed
- The initial selection caps OpenTable at 10 and extended search slices another 12 candidates.
- Because failed OpenTable candidates still consume verification budget, good later candidates may never get checked before the deadline.
- The system is optimizing for “try a balanced batch” rather than “return the best verified restaurants quickly and keep draining the candidate pool.”

5. Some returned restaurants look semantically wrong for “sushi”
- `Paya Thai` and `Wat Room` appearing for sushi suggests discovery/relevance is too loose, especially via Yelp/Resy metadata and page text.
- The app must not just find any restaurant with a time; it needs to enforce query intent much more consistently.

6. Quality issues in the visible cards
- Some rows have no distance.
- Some rows show weak/incorrect neighborhood data.
- Some restaurant names include odd trailing punctuation like `Wat Room -` / `Paya Thai -`.
- Single-slot rows may be valid, but they need stronger confidence that the slot is a real bookable reservation marker, not a stray time.

Why there is only one OT result:

The current OpenTable path is doing this:
- Discover OT URLs through Firecrawl search.
- For each OT URL, scrape the actual OpenTable booking page with browser rendering, stealth proxy, markdown + HTML, wait actions, and a timeout.
- Parse actual time-slot markers.
- Reject everything that times out, is blocked, has no parseable slots, or has no slots in the ±2 hour window.

That is correct in spirit because the product rule says every result must be verified against the actual booking URL. But the implementation is too dependent on expensive, slow page rendering. In the logs, most OT pages are not reaching the parser at all; they are dying at the scrape/load stage. That is why OT recall collapsed.

Plan to fix the whole search flow properly:

1. Replace OpenTable verification with a multi-strategy verifier, not one fragile scrape
- Keep the strict rule: no returned OT result unless real slots are verified for the requested date/time/party size.
- Build OT verification as a cascade:
  - Strategy A: scrape the date/time/covers deep link and parse slots.
  - Strategy B: retry with a lighter payload before using stealth/browser rendering.
  - Strategy C: retry alternate OpenTable URL parameter formats if needed.
  - Strategy D: only use heavyweight stealth rendering as the final fallback, not the default for every candidate.
- This should improve both speed and success rate.

2. Stop one provider from burning the whole request budget
- Add per-provider verification budgets and failure-aware scheduling.
- If OpenTable starts returning repeated 408s/blocked pages, pause/skip that specific scrape mode and continue checking other viable candidates.
- Do not let 10 blocked OT pages consume 30–60 seconds while the user waits.

3. Make candidate selection smarter
- Prioritize candidates by likely relevance and proximity before verification.
- Don’t use a fixed proportional cap that can waste slots on low-quality candidates.
- For sushi near North Druid Hills, candidates closer to the user and clearly sushi/Japanese should be verified first.
- Keep remaining candidates available for continuation, but don’t keep rechecking candidates that already failed with a hard block.

4. Tighten relevance before expensive verification
- Add a pre-verification relevance score using name, title, description, URL slug, cuisine terms, and platform snippets.
- For “sushi”, require strong sushi/Japanese evidence before spending a scrape on a candidate, unless the restaurant name itself is clearly relevant.
- This should remove obvious weak matches like Thai-only restaurants unless they actually advertise sushi.

5. Fix background continuation into real incremental search behavior
- Keep the first response fast with verified results only.
- Continue draining remaining candidates in follow-up requests automatically.
- Merge new verified results into the UI with clear “Checking more tables…” status.
- Prevent auto-extend loops from repeatedly running low-value batches after the system has exhausted useful candidates.
- Deduplicate results across initial and extended batches.

6. Improve result cleanup and display quality
- Clean restaurant names more aggressively to remove trailing punctuation/artifacts.
- Prefer verified/geocoded address-derived neighborhood over loose title parsing.
- If distance cannot be calculated, avoid letting unknown-distance rows outrank nearby known-distance results.
- Keep the ±2 hour slot rule intact and never fabricate fallback times.

7. Add diagnostics so this doesn’t become guesswork again
- Log per-platform counts for: discovered, selected, scrape success, scrape failed, blocked, timeout, no slots, slots outside window, relevance rejected, returned.
- Include timing for each provider separately.
- This will make it immediately obvious whether the next failure is discovery, verification, relevance, or UI continuation.

Files to change:
- `supabase/functions/search/index.ts`
  - OpenTable verifier cascade
  - relevance scoring/filtering
  - provider budgets
  - smarter candidate scheduling
  - diagnostics
  - name cleanup and ranking improvements
- `src/pages/Index.tsx`
  - safer automatic extended-search loop
  - dedupe merge behavior
  - clearer continuation state
- `src/components/ResultsGrid.tsx`
  - show background continuation more clearly when more candidates are being checked

Validation after implementation:
- Run the same `sushi` / North Druid Hills search.
- Confirm results are verified only from real booking content.
- Confirm OpenTable count improves or, if OT is blocked by the upstream site, the diagnostics explicitly show exactly where and why.
- Confirm the first response is faster and follow-up results continue appearing without user interaction.
- Confirm low-relevance results and malformed names are removed.