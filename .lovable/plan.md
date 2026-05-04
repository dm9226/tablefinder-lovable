## Goal

Restore OpenTable verified results without any paid services. Exhaust the no-cost levers before declaring OT dead.

## Changes (all in `supabase/functions/search/index.ts`)

### 1. Kill the Browserbase tax
- Set `BROWSERBASE_MAX_CALLS = 0`. Keep `scrapeWithBrowserbase` defined but gated, with a comment noting it requires a paid plan with proxies to be useful.
- Effect: stop burning ~15s/candidate on guaranteed 402/Akamai failures.

### 2. Fix `rid` extraction so the JSON lane actually fires
- Preserve full discovery URLs (including query string) into the OT candidate object — currently normalization strips `?restaurantIds=...`.
- Expand `extractOpenTableRid` to scan, in order:
  1. `restaurantIds=(\d+)` in the candidate URL
  2. `/r/<slug>-(\d+)` tail-id pattern
  3. `"rid":\s*(\d+)` and `"restaurantId":\s*(\d+)` in any captured discovery markdown/snippet
  4. `correlationId` / `restaurantIds` query params on any links found in markdown
- If still missing, skip JSON and fall through to Firecrawl scrape (current behavior).

### 3. Try the OT availability JSON endpoint with realistic headers
- POST `https://www.opentable.com/dapi/booking/availability` (and fall back to the legacy `/restref/availability` shape) with:
  - `User-Agent` matching a current Chrome
  - `Accept: application/json, text/plain, */*`
  - `Referer: https://www.opentable.com/r/<slug>`
  - `Origin: https://www.opentable.com`
  - `Accept-Language: en-US,en;q=0.9` (or `en-GB` for UK)
- 5s `AbortController` timeout. On 403/Akamai HTML response, log signature once and return `null`.
- Parse `availability[].timeSlots[]` into our `TimeSlot[]`, apply ±2hr filter + top-5 cap.
- This is best-effort: if Akamai blocks the edge IP for JSON too, this lane returns `null` cleanly and we fall through.

### 4. Audit the relevance gate (false negatives)
- Log every rejection in `isCuisineRelevant` / category match with the candidate name + the reason.
- Loosen the gate so verified OT hits are not dropped after the slow scrape succeeds:
  - For broad cuisines (Italian, Thai, Sushi, Steakhouse, etc.), accept if cuisine appears anywhere in name, description, or vibeTags.
  - Only apply strict matching to specific-dish intents (per existing intent-classification memory).

### 5. Restore the 30s contract (now affordable)
| Constant | New |
|---|---|
| `GLOBAL_TIMEOUT_MS` | 28_000 |
| `HANDLER_HARD_CEILING_MS` | 32_000 |
| OT lane deadline | 26_000 |
| OT `LANE_TIME_BUDGET_MS` | 22_000 |
| OT per-scrape Firecrawl timeout | 14_000 |
| `skipEnrichment` threshold | 20_000 |
| AI enrichment timeout | 8_000 |
| Geocoding timeout | 6_000 |

### 6. Verification
- Deploy, then run `link-verify.test.ts` (queries 1–6) and check OT verified counts in logs.
- If JSON endpoint is uniformly Akamai-blocked from the edge IP, document the result and surface OT as soft-verified (existing badge path) for up to 3 candidates per search instead of zero.

## Files

- `supabase/functions/search/index.ts` — all of the above
- `mem://integrations/opentable-json` — record actual JSON endpoint behavior post-test
- `mem://constraints/yelp-failed` (rename to `mem://constraints/opentable-failed` or add new entry) — record any approaches confirmed dead

## Expected outcome

Best case: OT verified count > 0 again via JSON endpoint (sub-second per candidate). Worst case: confirmed that no no-cost path exists from Supabase edge IPs — at which point OT degrades to soft-verified (3 candidates max), clearly labeled, and the project does not need to be killed.

## Risks

- Akamai may block the JSON endpoint from edge IPs the same way it blocks the widget. The fallback to Firecrawl + soft-verified preserves whatever we get today; no regression.
- Loosening the relevance gate could let through marginally off-cuisine results. Mitigation: only loosen for broad cuisines, keep strict matching for dishes.
