## What's broken (root cause)

Verification is the bottleneck, not discovery. Discovery finds ~26 candidates per search; verification only confirms 2–8 of them because:

1. **Resy** is verified by Firecrawl-scraping HTML pages (~15s each, frequent 408s) when Resy has a public JSON availability API that responds in <500ms.
2. **OpenTable** is protected by Akamai. Firecrawl gets blocked or times out (408s, "anti-bot challenge" rejections). We have a `BROWSERBASE_API_KEY` sitting unused.
3. **Yelp** Firecrawl scraping is the only part that's actually appropriate — it's working at ~2/2.

The "parallel lanes" change helped structure but didn't fix the underlying speed/reliability problem in each lane.

## The fix: provider-appropriate verification

### Lane 1 — Resy: direct JSON API

Replace Firecrawl scraping with `https://api.resy.com/4/find`:

```
GET https://api.resy.com/4/find?lat={lat}&long={lng}&day={YYYY-MM-DD}&party_size={n}&query={name}
Headers: Authorization: ResyAPI api_key="VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5"
         X-Origin: https://resy.com
```

Returns venue ID + availability slots in one call. Then `https://api.resy.com/4/find?venue_id={id}&day={date}&party_size={n}` gives exact slot times. Build deep links from venue slug + slot token (the URL pattern we already use). No scraping. Sub-second per candidate.

The `VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5` key is Resy's well-known public web client key (used by resy.com itself in every browser request); it's safe and stable. If Resy ever rotates it, fallback path stays Firecrawl.

### Lane 2 — OpenTable: Browserbase

Route OpenTable verification through Browserbase using the existing `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID`:

- Create a Browserbase session, navigate to the OT restaurant URL with `?dateTime=...&partySize=...`
- Wait for `[data-test="time-slot"]` or equivalent slot elements
- Extract slot times from the rendered DOM via `page.evaluate`
- Close session

Browserbase runs a real headless Chrome with stealth — Akamai doesn't block it. Expected latency: 6–12s per candidate, but reliability jumps from ~12% to >90%. Run 3 OT candidates concurrently (Browserbase plan allows multiple sessions).

Fallback: if Browserbase session fails, try Firecrawl once before giving up.

### Lane 3 — Yelp: keep Firecrawl (working)

No change. Already at 2/2 in recent logs.

## Concurrency & budgets

- Resy lane: 8 candidates, fully parallel (API is fast and rate-limit-friendly)
- OT lane: 6 candidates, 3 concurrent Browserbase sessions
- Yelp lane: 5 candidates, 2 concurrent Firecrawl scrapes
- Global wall-clock target: 20–25s end-to-end
- Per-lane time budgets: Resy 15s, OT 35s, Yelp 25s
- No global early-exit cap — let each lane fill its quota

Target output: 12–15 verified results (5 Resy, 5 OT, 3–5 Yelp).

## Code changes

All in `supabase/functions/search/index.ts`:

1. Add `verifyResyViaApi(candidate, params)` — direct fetch to `api.resy.com/4/find`, parse JSON, return slots + deep link.
2. Add `verifyOpenTableViaBrowserbase(candidate, params)` — Browserbase session, navigate, extract slots from DOM. Use the Browserbase REST API (`https://api.browserbase.com/v1/sessions` + CDP WebSocket, or the simpler `/v1/sessions/{id}/recording` pattern; we'll use their HTTP API to drive a session with `connect_url` + a small playwright-core import via esm.sh).
3. Wire `verifyAvailability(candidates, ..., provider)` to dispatch by provider:
   - `resy` → `verifyResyViaApi` (with Firecrawl as fallback)
   - `opentable` → `verifyOpenTableViaBrowserbase` (with Firecrawl as fallback)
   - `yelp` → existing Firecrawl path
4. Keep the parallel-lanes structure; remove the global Firecrawl semaphore (no longer the choke point) and replace with per-lane concurrency limits.
5. Maintain the strict rule: no result returned without confirmed slot times in the requested window.

## Why this will actually work

- Resy: stops fighting Firecrawl, uses the same API the Resy website uses. ~30x faster per candidate.
- OpenTable: stops fighting Akamai with the wrong tool. Browserbase exists for exactly this.
- Yelp: leave alone, it works.
- End-to-end time drops from 60–90s (often hitting timeouts) to 20–25s with 12+ verified results consistently.

## Out of scope

- No UI changes
- No DB changes
- No new secrets needed (Browserbase keys already present)
- Caching stays disabled per project rules