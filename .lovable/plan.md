You are right: the requirements are clear, and the current implementation is not meeting them. The fix should not be another timeout tweak. The product must return only verified, bookable tables for the requested date/time/party size, across Resy/OpenTable/Yelp, fast enough to be useful.

What I found:
- Discovery is fine: the last run found 45 deduped candidates: 13 Resy, 15 OpenTable, 17 Yelp.
- Verification is broken: only 2/22 selected candidates verified.
- Most losses are Firecrawl 408s across all providers, including Resy. That means the current architecture is bottlenecked on slow dynamic page scraping.
- OpenTable direct page scraping is now consistently hitting Akamai/challenge/timeout behavior, so relying on rendered OpenTable pages is not a stable product foundation.
- Resy can be made much faster via its public venue lookup and availability endpoints instead of rendered page scraping. I confirmed the public venue endpoint returns venue IDs, address, cuisine, lat/lng, and metadata quickly.
- The current verification runs each provider independently with batch size 6, so it can launch 18 heavy scrapes at once. That likely worsens Firecrawl timeouts and burns the response budget.

Plan to make this work:

1. Replace Resy verification with a direct API fast path
- Extract Resy location slug and venue slug from the candidate URL.
- Call Resy's public venue endpoint to get the venue ID, exact address, neighborhood, cuisine, and coordinates.
- Use Resy's availability endpoint as the primary source of real time slots for the requested date and party size.
- Parse only actual availability slots, filter to the strict ±2 hour window, and return at most the top 5 slots.
- Keep Firecrawl as a fallback only if the direct Resy endpoint fails for a specific venue.
- This should make Resy verification sub-second to low-single-digit seconds instead of 14–17s scrapes.

2. Stop treating OpenTable rendered scraping as the only verification path
- Implement an OpenTable direct verification path before Firecrawl:
  - Extract the OpenTable restaurant slug from `/r/...` URLs.
  - Resolve restaurant metadata/restaurant ID from OpenTable page/search data where available.
  - Call OpenTable’s availability API route with requested date/time/party size and restaurant ID when resolvable.
  - Parse actual timeslots from the availability response only; do not fabricate fallback times.
- Keep page scraping as a fallback, but only for a small number of candidates and with stricter anti-bot detection:
  - If the response is an Akamai/challenge page, fail fast instead of waiting 20s.
  - If the page has no actual `Select a time`/timeslot markers, fail fast.
- If direct OpenTable availability cannot be resolved for a candidate, it should not block Resy/Yelp from returning.

3. Rebuild verification scheduling so one provider cannot stall the whole search
- Do not call `resy.verify`, `opentable.verify`, and `yelp.verify` as three independent scrape storms.
- Use a central scheduler with provider lanes:
  - Resy direct lane first/highest quota because it is fastest after the API fast path.
  - OpenTable direct lane next; fallback scrape only for a few candidates.
  - Yelp lane with capped scrape concurrency.
- Enforce global concurrency limits for heavy scraping, not per-provider batch size 6.
- Return as soon as there are enough verified results, but only after each provider had a real chance to contribute.

4. Fix Yelp result loss without weakening verification
- Keep Yelp verification content-based: actual reservation time markers must exist.
- Remove the overly punitive “only 1 slot means operating hours” rule where the surrounding content clearly indicates a reservation widget/time button.
- Continue rejecting operating-hours tables and generic hours; acceptance must require booking context near the time.
- Reduce Yelp scrape volume so it does not consume provider budget.

5. Tighten relevance checks so verified candidates are not incorrectly discarded
- For OpenTable, use metadata/category fields and visible cuisine labels before rejecting by keyword frequency.
- For Resy, use the `type` field from venue metadata in addition to page text.
- Keep strictness for cuisine/amenity relevance, but stop rejecting real Italian/seafood/etc. restaurants just because the scrape text did not repeat the token enough.

6. Return useful results progressively from the backend response
- Target first response under ~20–30s with a solid verified batch, not 2 results after long waits.
- Include provider diagnostics in logs: discovered, selected, direct-verified, scrape-verified, rejected-no-slots, rejected-relevance, timeout.
- Keep `hasMore` and extended search, but extended search should use the same direct/provider-lane verification instead of another scrape storm.

7. Validate with real deployed function calls and update tests
- Test representative searches:
  - `Italian tonight for 2` in Atlanta
  - `Steakhouse tonight for 4` in Chicago
  - `Seafood tonight for 2` in Miami
  - one UK OpenTable-heavy query
- Confirm every returned result has:
  - non-empty `timeSlots`
  - times within ±2h
  - date/party/time prepopulated in deep link
  - provider distribution where data is actually available
- Update the edge tests to assert minimum useful result counts and provider diagnostics, not just URL parameter shape.

Technical notes:
- The main implementation target is `supabase/functions/search/index.ts`.
- No database migration is needed.
- No roles/auth changes are needed.
- I will not modify the generated Supabase client/types files.
- I will preserve the hard rule: no result is returned unless availability is verified for the requested date/time/party size.

Expected outcome:
- Resy results should come back reliably again because they will not depend primarily on rendered page scraping.
- OpenTable should work via direct availability where possible; when Akamai blocks rendered pages, those candidates fail quickly rather than freezing the whole search.
- Yelp should contribute when actual reservation slots are found, but should not dominate or starve other providers.
- The search should become functionally useful instead of returning 1–2 results after expensive, fragile scraping.