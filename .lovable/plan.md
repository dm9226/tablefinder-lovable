Here is what is going on, based on the current code and live backend logs:

The system is not failing because it cannot discover Resy/OpenTable candidates. It is discovering them. The failure is in the verification architecture.

Current live trace for a representative Atlanta Italian search:

```text
Parse:            ~0s
Discovery done:   ~3s
Candidates:       Resy 13, OpenTable 13, Yelp 21, deduped 43
Selected verify:  Resy 7, OpenTable 7, Yelp 10 = 24 total
Response:         ~37s after request start
Verified:         5/24
OpenTable:        mostly Firecrawl 408 scrape timeouts
Resy:             some successes, several Firecrawl 408 scrape timeouts
Yelp:             now competes for 10 verification slots and many scrape calls
```

Root causes:

1. Yelp was reintroduced in the most expensive possible part of the pipeline
- Yelp discovery now finds a lot of candidates.
- Because candidate allocation is proportional, Yelp gets a large share of the 24 verification slots.
- Every Yelp candidate is then scraped individually through Firecrawl.
- This means Yelp is now consuming the same limited verification budget as Resy/OpenTable.

2. The function verifies too many slow pages in one synchronous request
- The app waits for discovery, 24 page scrapes, geocoding, and AI enrichment before returning.
- Firecrawl is frequently returning 408 scrape timeouts on Resy/OpenTable/Yelp pages.
- Even though adapter verification runs in parallel, each adapter still performs batched page scrapes, so one slow platform can keep the whole request open.
- The code has a 120s global timeout, while the user experience target is really closer to 10–25s.

3. OpenTable is currently the weakest provider
- OpenTable discovery works.
- Direct OpenTable pages are blocked/slow from server-side automation.
- Firecrawl scrape calls for OpenTable are often timing out before slots render.
- The code correctly refuses to fabricate availability, so OpenTable returns zero when the slots cannot be scraped.

4. Resy is being handled too slowly
- Resy is still verified via Firecrawl page scraping.
- We already identified a faster direct Resy availability path earlier, but it is not implemented in the current file.
- The current code contains no `api.resy.com/4/find` or equivalent fast Resy verification path.

5. Results are only returned after all selected provider verification finishes
- Even if Resy verifies a couple of restaurants early, the function still waits for OpenTable/Yelp verification, geocoding, and AI enrichment.
- That is why the user sees a long spinner instead of usable early results.

Plan to fix this properly:

1. Split verification into a fast lane and slow lane
- Fast lane must return quickly with the best verified results.
- Slow lane can be exposed through the existing “search more” flow later.
- Initial search should verify fewer candidates, not 24.
- Target initial verification cap:
  - Resy: 6–8 candidates, using direct availability API where possible
  - OpenTable: 3–4 candidates, only high-confidence URLs
  - Yelp: 3–4 candidates max, not 10+
- This prevents Yelp from starving Resy/OpenTable.

2. Implement fast Resy verification using the direct Resy availability endpoint
- Add a Resy-specific verifier before the generic Firecrawl verifier.
- Use candidate URL slug/city plus requested date/time/party size to query the direct Resy availability API.
- Parse concrete slots from the API response.
- Keep the existing Firecrawl page scrape as a fallback only when the direct path fails.
- This should make Resy verification near-instant compared with 10–16s scrape attempts.

3. Stop using generic Firecrawl scraping as the primary path for every provider
- Keep Firecrawl search for discovery where it is fast.
- Use provider-specific verification where available.
- Use scraping only as fallback or for providers where no direct path exists.
- This keeps the core rule intact: no result is returned unless date/time/party availability is verified.

4. Rebalance candidate selection so Yelp cannot dominate the budget
- Replace proportional allocation with minimum guaranteed provider quotas.
- Ensure Resy/OpenTable get slots even if Yelp discovery returns many more candidates.
- Example initial allocation:

```text
Resy:      up to 8
OpenTable: up to 4
Yelp:      up to 4
Total:     up to 16, ideally fewer if enough results are found early
```

- If a provider has no candidates, redistribute unused quota.
- Prioritize Resy first because it is the most promising fast path.

5. Add early return once enough verified results exist
- Stop waiting for all providers if we already have a useful result set.
- Return after either:
  - at least 6 verified results, or
  - 18–22 seconds elapsed, whichever comes first.
- Keep `remainingCandidates` so the user can request more results.

6. Make AI enrichment non-blocking or severely capped
- Do not let AI enrichment delay first results.
- For initial response, return verified slots with basic metadata first.
- Either skip enrichment if elapsed time is over ~15s, or enrich only the final verified results with a short timeout.

7. Improve OpenTable strategy without fabricating results
- Keep OpenTable discovery.
- Lower OpenTable scrape budget so it cannot stall the whole request.
- Try a smaller scrape payload first: markdown only, shorter wait, shorter timeout.
- If no “Select a time” section appears, reject quickly and move on.
- Do not return OpenTable unless actual slots are parsed.

8. Add instrumentation that clearly explains provider outcomes
- Log timing by phase:
  - parse
  - discovery per provider
  - verification per provider
  - scrape timeout counts
  - verified counts before/after distance filtering
  - final platform distribution
- This will make future “why no OT/Resy?” issues immediately diagnosable.

9. Test the exact failing paths
- Run live function tests after implementation for:
  - `Italian tonight for 2` near Atlanta
  - `sushi tonight for 2` near NYC
  - `oysters in NYC tonight for 2`
  - one OpenTable-heavy query such as steakhouse in Chicago
- Confirm:
  - initial response time is materially lower
  - Resy results appear when available
  - OpenTable does not block the whole response
  - Yelp remains included but capped
  - every returned result has verified slots and deep-link parameters

Expected result:

- Resy should become the reliable fast provider instead of depending on slow page scraping.
- OpenTable will still be limited by anti-bot/rendering behavior, but it will no longer stall or erase the whole search experience.
- Yelp remains a hard requirement, but capped so it contributes results without consuming the entire verification budget.
- First results should return much faster, with “more results” available for the slower remainder.