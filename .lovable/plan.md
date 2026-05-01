I agree: Yelp needs to remain a hard requirement. I found a viable path that does not use the paid Yelp API and does not rely on blocked direct Yelp search scraping.

Current problem:
- The deployed search function now returns `yelp: 0` because Yelp discovery is explicitly disabled.
- Direct Yelp `/search` scraping from backend is blocked by 403/DataDome.
- However, external indexed search results can surface Yelp `/reservations/...` pages, and those pages expose real reservation slots when fetched through the existing scraping path.

Plan:

1. Re-enable Yelp discovery without the Yelp API
- Replace the disabled `fetchYelpCandidates()` return path with search-engine discovery for `site:yelp.com/reservations`.
- Use multiple query variants for recall, e.g.:
  - `site:yelp.com/reservations {cuisine} {city} {state}`
  - `site:yelp.com/reservations {dishKeyword} {city} {state}`
  - parent cuisine fallback for dish searches, e.g. oysters -> seafood, sushi -> Japanese/Sushi Bars
- Keep `/biz` pages only as secondary hints if needed, but prioritize `/reservations/` URLs because they are directly bookable.

2. Normalize Yelp candidates correctly
- Parse search results into `Restaurant` objects with canonical `https://www.yelp.com/reservations/{alias}` URLs.
- Add Yelp deep-link params: `covers`, `date`, and `time`.
- Extract name, cuisine, rating, and neighborhood where available from search snippets, but treat this as metadata only.

3. Make Yelp verification strict but fast
- Do not return Yelp results from discovery alone.
- Verify every Yelp result by scraping the actual Yelp reservation URL with the requested date/time/party size.
- Parse concrete slot evidence from the reservation page:
  - standalone time slots such as `6:30 pm`, `7:00 pm`, etc.
  - reject generic operating-hour ranges and non-slot text.
- Filter slots to the existing strict ±2 hour window around the requested time.
- Return only restaurants with verified matching slots.

4. Avoid Steel.dev for the common path
- Keep Steel as an optional fallback only if scraping a Yelp reservation page fails unexpectedly.
- Do not use Steel for Yelp search-page discovery because the hobby-tier browser path is too slow/blocked.
- This keeps costs low and preserves the 25–30 second target.

5. Preserve Resy/OpenTable performance
- Keep the current batched verification and Firecrawl timeout reductions for Resy/OpenTable.
- Ensure Yelp discovery runs in parallel with Resy and OpenTable discovery and does not block them beyond the discovery cap.
- Cap Yelp verification candidates to a small number, e.g. 6, so Yelp contributes results without blowing the request budget.

6. Test end-to-end after implementation
- Deploy the updated search function.
- Run `oysters in NYC tonight for 2` and inspect logs/results for:
  - Yelp candidates discovered
  - Yelp reservation URLs scraped
  - concrete time slots parsed
  - final Yelp results returned only after verification
- Also run `sushi tomorrow night for 2 in NYC` to verify the previous failure case improves while staying near the time cap.

Technical notes:
- This aligns with the hard rule: every returned restaurant must have verified availability from the actual booking URL.
- It avoids the expensive Yelp API.
- It avoids blocked direct Yelp `/search` scraping.
- It uses indexed `/reservations/` pages as discovery seeds, then performs strict first-party reservation-page verification before returning anything.