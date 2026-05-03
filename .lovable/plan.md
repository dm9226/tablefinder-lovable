## Goal

Get verified results back up across all three providers (Resy, OpenTable, Yelp) without paid APIs and without dropping any provider. The core unlock: stop trying to render anti-bot-protected booking widgets via Firecrawl, and instead call the JSON endpoints those widgets themselves call.

## Why this works (and what we're not repeating)

Resy works fine today. The blocked lanes are OpenTable (Akamai on the widget render) and Yelp (DataDome on the widget render). Both platforms' booking widgets, once loaded, fetch availability from internal JSON endpoints. Those endpoints are usually behind much lighter protection than the rendered widget pages, because they're designed to be hit at high volume by the widgets themselves. Calling them directly from the edge function — with proper headers — is free, fast (~200–500ms), and returns structured time-slot data we don't have to parse out of HTML.

This is **not** the Yelp Fusion API (paid, off the table). This is the same JSON the public booking widget hits.

We are also **not** re-trying anything in `mem://constraints/yelp-failed` (Yelp Fusion, Browserbase for Yelp, paid stealth proxies, etc.).

## Plan

### 1. OpenTable: add `/dapi` availability lane

In `supabase/functions/search/index.ts`, add a new verifier `verifyOpenTableDapi(restaurant, params)`:

- Resolve the OT `rid` (restaurant ID) from the discovery URL (already present in OT URLs as `restaurantIds=...` or in the slug page).
- POST to `https://www.opentable.com/dapi/booking/restaurant/availability` with `{ restaurantIds: [rid], dateTime, partySize }` and headers that match a real browser request (UA, `x-csrf-token` if needed — probe first).
- Parse the JSON response: each restaurant has a `slots[]` array with `time`, `dateTime`, `type`. Map directly to our `TimeSlot[]`.
- 5s timeout. On any failure (4xx, 5xx, parse error), fall through to existing Firecrawl OT scrape.

Order in `verifyOpenTable`:
1. Try `/dapi` first (fast, free, structured).
2. On failure, current Firecrawl scrape (existing behavior).
3. On Firecrawl failure, soft-verified candidate (existing behavior).

### 2. Yelp: probe-and-build internal availability endpoint

Same pattern, but Yelp is riskier (DataDome is more aggressive). Two sub-steps:

**2a. Probe (one-time, in code, gated behind a single search):**
Add `verifyYelpInternal(restaurant, params)` that:
- Extracts the Yelp business alias from the discovery URL (`/biz/<alias>`).
- Calls `https://www.yelp.com/reservations/<alias>/search_availability?date=YYYY-MM-DD&time=HH:MM&num_people=N` (the endpoint the Yelp reservation widget hits).
- Sends realistic browser headers + `Referer: https://www.yelp.com/biz/<alias>`.
- 5s timeout.
- Logs the response status and body shape on first call so we can see whether DataDome lets it through.

**2b. Wire-in:**
- If the probe returns JSON with slots: use it as the primary Yelp verifier, push current Firecrawl approach to fallback.
- If DataDome blocks it (403/429/HTML challenge): leave the new function in place but log-and-skip it; Yelp continues with current Firecrawl discovery + soft-verified fallback. No regression.

This is exactly the "probe + build if it works" choice you picked.

### 3. Soft-verified: minor, conservative broadening

Today: cap 3 soft results, only when verified count for that lane < 2, OT and Yelp only.

Change to:
- Same cap (3), same threshold (< 2), but apply to **Resy** too as a safety net (Resy rarely needs it but costs nothing to enable).
- Keep the existing "tap to check" badge styling.

Not raising cap to 5 and not changing the threshold — keeps the page mostly hard-verified, which matches the product's verification mandate.

### 4. UI: badge already exists for OT/Yelp soft results

Extend the existing soft-verified badge in `src/components/RestaurantCard.tsx` to render for any platform when `restaurant._softVerified === true && timeSlots.length === 0`. Same muted styling, platform-agnostic copy: *"availability not confirmed — tap to check"*.

### 5. Tests

Add a focused test in `supabase/functions/search/index.test.ts`:
- One query that historically hit OT-heavy results (Chicago Steakhouse from existing `link-verify.test.ts`).
- Assert that at least one OT result comes back with `timeSlots.length > 0` (proving `/dapi` worked).
- Same shape for a Yelp-heavy query, but soft-assert (log-only) since the Yelp probe outcome is unknown until we run it.

## Expected outcome

- **OpenTable verified count**: large jump. `/dapi` is fast and rarely blocked. Most OT candidates that currently 408 should return slots in <1s.
- **Yelp**: either a similar jump (if internal endpoint works) or unchanged from today (if DataDome blocks it) — no worse case.
- **Resy**: unchanged.
- **Wall-clock**: faster overall, since `/dapi` replaces 6–20s Firecrawl scrapes with ~500ms JSON calls.
- **Cost**: drops. Each successful `/dapi` or Yelp-internal call replaces a Firecrawl call.

## Risk

- OT `/dapi` endpoint is undocumented and could change. Mitigation: Firecrawl scrape stays as fallback, so a `/dapi` shape change degrades gracefully, doesn't break the lane.
- Yelp internal endpoint may be blocked by DataDome. Mitigation: built as additive — failure path is current behavior.
- Both endpoints may require headers we don't anticipate (CSRF, cookies). Mitigation: log first response in detail; iterate once if needed.

## Files changed

- `supabase/functions/search/index.ts` — add `verifyOpenTableDapi`, add `verifyYelpInternal`, wire both into existing verifiers as primary attempts, broaden soft-verified to Resy.
- `src/components/RestaurantCard.tsx` — make soft-verified badge platform-agnostic.
- `supabase/functions/search/index.test.ts` — add OT `/dapi` assertion + Yelp probe log.

## Memory updates after build

- New: `mem://integrations/opentable-dapi` — documents the `/dapi/booking/restaurant/availability` lane, request shape, fallback chain.
- New: `mem://integrations/yelp-internal` — documents the probe outcome (works / blocked) and current behavior.
- Update: `mem://integrations/opentable` — note `/dapi` is tried first, Firecrawl is fallback.
- Update: `mem://features/yelp-soft-fallback` → rename to `mem://features/soft-fallback`, note it now applies to all three lanes.
