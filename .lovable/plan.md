## Goal

Two things in one change:
1. Restore the **30-second search contract** to the user.
2. Actually bring **OpenTable verified results back** by calling OT's own JSON availability endpoint instead of scraping the Akamai-protected booking widget.

These are complementary: the JSON endpoint typically returns in 300–800ms vs. 15–30s for a Firecrawl scrape, so it makes the 30s budget *easier* to hit, not harder.

## Diagnosis recap

- Latest logs: `elapsedMs=28139 ... verified{resy=2,opentable=0,yelp=2}` — 28s and zero OT verified.
- Browserbase fallback dead: `[BB] session create failed (402) ... "Proxies are not included in the free plan"`. Every OT challenge currently burns ~15s for a 100% failure rate.
- Resy and Yelp work; OT is the only broken lane.

## Plan

### 1. Add OT JSON availability lane (`verifyOpenTableJson`)

In `supabase/functions/search/index.ts`:

- **New helper** `extractOpenTableRid(url, markdown)`: pull the numeric restaurant ID from the OT URL (`/r/<slug>?restaurantIds=12345`) or from the discovery page response (`"rid":12345` or `restaurantIds=` in markdown). Return `null` if not found.
- **New verifier** `verifyOpenTableJson(restaurant, params)`:
  - Resolve `rid`. If missing, return `null` (caller falls back to Firecrawl scrape).
  - POST to OT's availability endpoint with realistic browser headers (`User-Agent`, `Accept: application/json`, `Referer: https://www.opentable.com/r/<slug>`, `Origin: https://www.opentable.com`).
  - Body: `{ rids: [rid], dateTime: "YYYY-MM-DDTHH:MM", partySize, ... }`.
  - **5s hard timeout** via `AbortController`.
  - On success: parse `timeslots[]` (or `availability.timeslots[]`) into our `TimeSlot[]` shape, applying the existing ±2hr filter and top-5 cap.
  - On any non-2xx or parse error: log once and return `null` so the caller falls through.
- **Wire-in** inside the existing OT verification path (around line 2480, right before the Firecrawl scrape):
  1. Try `verifyOpenTableJson` first.
  2. If it returns slots → done, skip the Firecrawl scrape entirely (saves 15–30s).
  3. If it returns `null` → fall through to current Firecrawl scrape.
  4. If Firecrawl is challenged → existing soft-verified path (no Browserbase).

The endpoint is undocumented; if shape changes, Firecrawl scrape remains as fallback so the lane degrades gracefully.

### 2. Disable broken Browserbase fallback

- Set `BROWSERBASE_MAX_CALLS = 0` for all lanes.
- Keep `scrapeWithBrowserbase` function in place with a comment noting why it's gated off and how to re-enable (flip the constant) if the account is upgraded to a paid plan.
- Effect: no more 15s waits per OT candidate hitting `[BB] 402` errors.

### 3. Restore ~30s contract

In `supabase/functions/search/index.ts`:

| Constant | Current | New |
|---|---|---|
| `GLOBAL_TIMEOUT_MS` | 60_000 | **28_000** |
| `HANDLER_HARD_CEILING_MS` | 70_000 | **32_000** |
| OT lane deadline (`laneDeadline`) | 54_000 | **26_000** |
| OT `LANE_TIME_BUDGET_MS` | 52_000 | **22_000** |
| OT per-scrape Firecrawl timeout | 34_000 | **14_000** |
| `skipEnrichment` threshold | 38_000 | **20_000** |
| AI enrichment timeout | 14_000 | **8_000** |
| Geocoding timeout | 12_000 | **6_000** |

These values mirror the (working) Resy/Yelp budgets. The OT JSON endpoint replaces most of the time previously spent on slow OT scrapes, so this isn't a regression — it's the budget the lane *should have had* once verification got fast.

### 4. No frontend changes needed

`src/components/SearchProgress.tsx` already cycles over ~30s. Soft-verified badge in `RestaurantCard.tsx` already covers the OT degradation path when both JSON and Firecrawl fail.

## Files changed

- `supabase/functions/search/index.ts` — new `verifyOpenTableJson` + `extractOpenTableRid`, wire into OT verifier as primary attempt, set `BROWSERBASE_MAX_CALLS = 0`, revert all timeout constants.

## Expected outcome

- **OT verified count**: large jump. Most OT candidates that currently 0-out should return real slots in <1s via JSON.
- **Resy / Yelp**: unchanged.
- **Wall-clock**: search completes inside ~25s for typical queries; 28s hard cap respected.
- **Cost**: down. Each successful JSON call replaces a Firecrawl call (~$0.005 → $0).

## Risks

- **OT JSON endpoint shape may differ from what's documented in public reverse-engineering posts.** Mitigation: log first response body in detail on initial deploy, iterate once if needed. Firecrawl scrape stays as fallback so lane never fully breaks.
- **OT may rate-limit or geo-block the JSON endpoint.** Mitigation: 5s timeout + graceful fallback means worst case is "no improvement vs. today, no regression."
- **`rid` extraction may miss for some discovery URLs.** Mitigation: regex tries multiple patterns; on miss, falls through to Firecrawl as today.

## Memory updates (post-build)

- New: `mem://integrations/opentable-json` — documents the availability JSON endpoint, request shape, fallback chain.
- Update: `mem://integrations/opentable` — note JSON endpoint is tried first, Firecrawl is fallback.
- Update: `mem://constraints/performance` — confirm 28s global / 32s ceiling is the active contract.
- Remove or annotate: prior Browserbase notes — gated to 0 calls pending paid plan.
