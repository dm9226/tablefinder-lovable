## Goal

Get the initial result count up by attacking the Firecrawl 408 problem from three angles simultaneously: faster scrapes, a failover scraper, and more lenient surfacing of unverified-but-discovered candidates.

## Changes to `supabase/functions/search/index.ts`

### 1. Tighten Firecrawl scrape parameters (Option 1)

Per-lane tuning:

- **Resy verification scrapes**: `waitFor` 3.5s → 2s, `onlyMainContent: true`
- **Yelp verification scrapes**: `waitFor` 3.5s → 2s, `onlyMainContent: true`
- **OpenTable verification scrapes**: keep `waitFor` 3.5s (widget needs it), but add `onlyMainContent: true` to reduce payload
- Drop client-side AbortController timeouts proportionally (Resy/Yelp: 20s → 14s; OT stays 20s)

Rationale: Resy and Yelp render booking widgets faster than OT. Smaller payloads + shorter waits should drop p50 scrape time from ~6–8s to ~3–4s, allowing more candidates per wave inside the same lane budget.

### 2. Multi-scraper failover (Option 2)

Add a `scrapeWithFailover(url, opts)` helper that:

1. Tries Firecrawl first (existing path).
2. On `408`, `AbortError`, or `5xx`, retries the same URL via **Steel** (`STEEL_API_KEY` already configured) using their scrape endpoint, returning markdown.
3. If Steel also fails, falls back to **Browserbase** (`BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` already configured) as a last resort — only for OpenTable, since it's the most blocked.
4. Each failover hop has its own 12s timeout to avoid blowing the lane budget.
5. Logs which provider succeeded so we can monitor mix.

Wire this helper into the existing `verifyResy`, `verifyOpenTable`, and `verifyYelp` paths, replacing direct Firecrawl calls.

### 3. Relax soft-fallback surfacing (Option 3)

Currently:
- Yelp soft-fallback fires when `verified < 2`
- OT soft-fallback fires when `verified < 2`
- Resy has no soft-fallback

Change to:
- All three lanes get soft-fallback when `verified < 3`
- Increase soft-fallback cap from 3 → 5 per lane
- Add `_softVerified: true` flag (already present for OT/Yelp) on Resy soft results

### 4. UI: badge for soft-verified results

In `src/components/RestaurantCard.tsx`:

- Add a small "availability not confirmed — tap to check" badge when `restaurant._softVerified === true` and `timeSlots.length === 0`
- Use muted styling (border + muted-foreground text) so it doesn't compete with verified results visually
- Replace the existing Yelp-specific copy with a platform-agnostic version

## Expected outcome

- Initial pass: **15–20+ verified-or-soft results** for a generic query (vs current 8)
- Wall-clock: similar (~30–35s) since failover is bounded
- User clearly sees which results have confirmed times vs which need a tap-through

## Risk / cost

- Steel and Browserbase calls add cost only on Firecrawl failures (currently ~70% on OT) — bounded by lane budgets
- If Steel/Browserbase also rate-limit, we're no worse off than today

## Files to change

- `supabase/functions/search/index.ts` — scrape params, failover helper, soft-fallback thresholds
- `src/components/RestaurantCard.tsx` — soft-verified badge

## Memory updates after build

- Update `mem://features/yelp-soft-fallback` → rename to `soft-fallback` and document it now applies to all three lanes
- Add `mem://integrations/scraper-failover` documenting Firecrawl → Steel → Browserbase chain
