

## Comprehensive Time Slot & Link Verification Tests

### What This Tests

The current test suite validates response structure, time formats, and window compliance -- but it never verifies that:
1. **Returned time slots actually exist** on the restaurant's booking page
2. **Platform URLs** resolve correctly and contain the right date/time/party size parameters

This plan adds a new "deep verification" test that re-scrapes a sample of returned results and cross-checks the time slots and URLs.

### Approach

Add a new test file `supabase/functions/search/link-verify.test.ts` that:

1. **Runs 6 targeted searches** (2 per platform-heavy query) to get fresh results
2. **For each result**, validates:
   - **URL parameter correctness**: Resy URLs have `date`, `seats`, `time` params; OpenTable URLs have `dateTime`, `covers`; Yelp URLs have `date`, `covers`, `time`
   - **URL reachability**: Fetches each `platformUrl` and confirms it returns 200 (not 404/redirect to error)
   - **Time slot re-verification**: Re-scrapes the platform page via Firecrawl and re-parses time slots, then checks that at least 50% of returned slots appear on the live page (accounting for slots being booked between searches)
3. **Reports** per-platform pass rates for URL validity and slot accuracy

### Test Queries (6 total, covering all 3 platforms)

| # | Query | Target |
|---|-------|--------|
| 1 | "Italian tonight for 2" (Atlanta) | Mixed platforms |
| 2 | "Sushi Friday 7pm for 2" (NYC) | Resy-heavy |
| 3 | "Steakhouse tonight for 4" (Chicago) | OpenTable-heavy |
| 4 | "Thai food tonight for 2" (Atlanta) | Mixed |
| 5 | "Seafood tonight for 2" (Miami) | Yelp + mixed |
| 6 | "French bistro Saturday 7pm" (SF) | Mixed |

### Validation Logic

**URL Parameter Check** (no network needed):
- Resy: URL contains `?date=YYYY-MM-DD&seats=N&time=HHMM`
- OpenTable: URL contains `?dateTime=YYYY-MM-DDThh:mm&covers=N`
- Yelp: URL contains `?covers=N&date=YYYY-MM-DD&time=HHMM`

**URL Reachability** (HEAD request):
- Fetch each URL, accept 200 or 3xx redirect to a valid page (not error/404)
- Sample up to 3 results per platform per query to stay within rate limits

**Slot Cross-Verification** (Firecrawl re-scrape):
- Re-scrape up to 2 results per query using Firecrawl
- Re-parse time slots using the same regex patterns from the main function
- Compare: flag if <50% of originally returned slots are still found (allows for real-time booking changes)

### Files

- **New**: `supabase/functions/search/link-verify.test.ts` — the full verification test
- **No changes** to existing files

### Expected Runtime
~3-5 minutes per test run (6 queries × ~30s search + re-scraping sample results). Tests run in 2 batches of 3.

