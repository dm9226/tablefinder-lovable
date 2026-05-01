You do not want options. You want the implementation that satisfies the product requirements. I’m going to treat the requirement as: return multiple verified, bookable restaurant results fast, with real date/time/party availability, across Resy, OpenTable, and Yelp, without fabricating slots.

Current diagnosis from code and live logs:
- Discovery is not the main failure. The latest Atlanta Italian run found 45 deduped candidates: 13 Resy, 15 OpenTable, 17 Yelp.
- Verification is the bottleneck. It returned 8 results in ~42s, but 7 were Resy and 1 was Yelp; OpenTable was never reached because the shared queue front-loaded Resy/Yelp and early-exited before OT.
- The previous “Resy first so we get something” fix improved result count but broke provider diversity and regressed OpenTable visibility.
- Firecrawl page scraping is the wrong primary verification mechanism for all providers. It is too slow and too failure-prone for real product behavior.

Implementation plan:

1. Split verification by provider lanes, not one global queue
- Replace the current ordered single queue with independent Resy, OpenTable, and Yelp lanes running concurrently under a global wall-clock budget.
- Each lane gets its own concurrency and timeout policy.
- Do not allow one provider to starve another.
- Initial target per search:
  - Resy: up to 6 verified
  - OpenTable: up to 5 verified
  - Yelp: up to 5 verified
  - Overall return cap: 12-15 results
- Return as soon as either:
  - enough useful verified results are available with at least two providers represented, or
  - the hard budget is reached.

2. Replace Resy verification scraping with Resy API verification
- Extract the Resy venue id from the Resy venue page once, preferably using lightweight HTML/script parsing or Resy config endpoint discovery.
- Verify availability through Resy’s public availability endpoint (`api.resy.com/4/find`) using:
  - `day`
  - `party_size`
  - `venue_id`
  - lat/long when available
- Parse returned slots/configs directly instead of scraping visible page text.
- Keep the Resy deep link unchanged with `date`, `seats`, and `time` params.
- Use scraping only as a fallback if venue id extraction fails.
- Expected result: Resy verification becomes API-fast instead of 10-17s per page.

3. Restore OpenTable by moving it out of Firecrawl-first verification
- Stop relying on Firecrawl-rendered OpenTable pages as the primary OT verifier. Logs show the app currently discovers 15 OT candidates but never verifies them in the initial response.
- Implement an OpenTable lane that tries these in order:
  1. Direct/internal availability JSON endpoints discovered from OT page/network/script data.
  2. If direct JSON is unavailable, Browserbase-backed browser verification using the existing `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` secrets.
  3. Firecrawl only as a last-resort fallback, with a strict short timeout.
- Browserbase verification will load the OT booking URL with date/time/covers, wait for the time selector, extract actual visible time buttons, reject challenge/no-availability pages, and close the session.
- Parse only concrete bookable time buttons/links; never fabricate.
- This restores actual OT results instead of silently leaving OT candidates in `remainingCandidates`.

4. Fix Yelp result depth
- Yelp currently discovers many candidates but only one made it through in the sample run.
- Re-enable a higher-signal Yelp discovery path using Yelp reservation/search pages where slots are visible for the requested date/time/party, not only Google/Firecrawl candidate discovery.
- Keep the strict anti-fabrication rule, but remove overly punitive rejection when there is concrete reservation-page evidence.
- Yelp lane target: verify enough candidates to return multiple Yelp results when the market has them.

5. Remove premature early exit that prevents provider diversity
- The current `early exit at 8 verified` happens before OpenTable is reached.
- Replace it with provider-aware stopping:
  - do not exit before OpenTable lane has had a real chance unless it hard-fails quickly;
  - prefer a mixed result set over a Resy-only set;
  - continue a short second pass if the response is heavily single-provider and budget remains.

6. Tighten timing budget around useful output
- Target first complete response: 15-30 seconds.
- Enforce per-provider limits:
  - Resy API: low single-digit seconds for many candidates.
  - Yelp: bounded scrape/search verification.
  - OpenTable Browserbase: bounded to a small number of sessions/candidates so it cannot dominate.
- Defer/skip enrichment and expensive geocoding if it threatens result latency. Verified availability comes first.

7. Add explicit diagnostics to the response/logs
- Include internal logs for:
  - discovered count per provider
  - verified count per provider
  - verification method used (`resy_api`, `opentable_browserbase`, `opentable_direct`, `firecrawl_fallback`, etc.)
  - rejection reason counts
  - elapsed time by phase
- This makes failures actionable instead of opaque.

8. Validate against the actual product requirements
- Run deployed edge-function tests against representative queries:
  - Atlanta Italian for 2 tonight
  - Chicago steakhouse for 4
  - NYC sushi Friday 7pm
  - Miami seafood tonight
  - London Italian tonight
- Acceptance criteria:
  - every returned result has non-empty timeSlots within ±2h of requested time;
  - every returned link contains date/time/party params;
  - no fabricated fallback slots;
  - OpenTable appears when OT candidates have real availability;
  - typical result count is useful, not 1-2;
  - response usually completes under 30s.

Technical notes:
- Main implementation remains in `supabase/functions/search/index.ts`, consistent with the existing monolithic edge-function constraint.
- Existing secrets already include `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `FIRECRAWL_API_KEY`, and `LOVABLE_API_KEY`; no new secrets should be needed.
- I will not modify generated Lovable Cloud client/types files.
- I will preserve the hard rule: no restaurant is returned unless availability is verified from provider content/API/browser-observed booking UI.