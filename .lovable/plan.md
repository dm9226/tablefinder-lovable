# Fix the actual failures from today's run

The 46s / 2-result / no-metadata outcome is not a "tune the timeouts more" problem. The logs show three specific, fixable causes. This plan addresses each one directly. No broad revert, no architecture rewrite.

## What the logs actually proved

From the Atlanta dinner search at 46s:

1. **Firecrawl returned HTTP 408 on 6+ scrapes.** Every OpenTable scrape, every Yelp scrape, and 3 of 5 Resy scrapes failed with 408. Today's "no retry" change meant every 408 became a permanent skip. That is why verified = `resy=2, opentable=0, yelp=0`.

2. **Resy verification succeeded but address extraction failed.** Both verified Resy pages logged `[ADDR_MISS] No address pattern found`. Without an address, Nominatim cannot geocode, so `distanceMiles` stays null. That is why no distances showed up.

3. **AI enrichment was skipped entirely.** Log line: `Skipping AI enrichment — already 46577ms elapsed`. The 32s skip-enrichment threshold tripped because verification overran. That is why no descriptions, ratings, or vibe tags showed up.

4. **The 38s hard deadline isn't actually hard.** The run took 46.5s. Firecrawl calls are not being aborted at the deadline — they're allowed to finish.

## What to change

### 1. Handle Firecrawl 408 correctly (the real fix)

A 408 from Firecrawl means "scrape attempt timed out on their side" — not that the target site is broken, and not that retrying is wasteful. Today's change to "skip on 408 with no retry" was wrong for this provider.

- Reintroduce a **single fast retry on 408 only** (not on 4xx generally), with a tighter per-call timeout (~10s instead of 15s) so a retry fits inside the lane budget.
- Cap retries at 1 per candidate, and only if there's >8s of wall-clock budget left.
- Keep "no retry" behavior for 403 / 429 / DataDome blocks, where retrying is genuinely pointless.

Expected impact: Resy verified should rise from 2/5 to 4–5/5, OT from 0/4 to 2–3/4, Yelp from 0/3 to 0–1/3 (Yelp will remain limited by DataDome — that's known and unrelated).

### 2. Actually enforce the wall-clock deadline

- Wrap every Firecrawl call in `Promise.race` against an `AbortController` tied to the global deadline, not just the per-call timeout. If the global budget is gone, in-flight scrapes get aborted, not awaited.
- Move the verification cutoff from 32s to 28s so enrichment has a guaranteed 6–8s window.

### 3. Fix address extraction so distances appear

The Resy markdown does contain addresses — the current regex cascade in `extractAddressFromMarkdown` is just missing Resy's specific format. Two-part fix:

- Add a Resy-specific extraction pattern (Resy pages render addresses in a known structure near the venue name; check the actual markdown for both verified candidates and write a pattern that matches).
- As a fallback when regex misses, ask the AI enrichment step to return a `address` field alongside description/vibe tags. Enrichment runs anyway, costs nothing extra, and gives Nominatim something to geocode.

### 4. Make enrichment non-skippable for returned results

Right now if verification overruns, enrichment is skipped entirely and the user gets bare cards. Better behavior:

- Always run enrichment on the final returned set, even if it's only 2 results.
- Give enrichment its own small budget (4s) carved out of the 30s window before verification starts, not after.
- If enrichment times out, ship what came back rather than dropping fields silently.

### 5. Add a `[REJECT_SUMMARY]` log line

Complement the existing `[SEARCH_SUMMARY]` with one line counting rejection reasons:
```
[REJECT_SUMMARY] firecrawl_408=6 firecrawl_403=0 no_slots=0 outside_window=0 anti_bot=0
```
So the next failed run is diagnosable in one glance instead of scrolling through per-candidate logs.

## What this will and won't fix

**Will fix:**
- Result count should go from 2 to 6–9 on a typical search.
- Descriptions, ratings, vibe tags should appear (enrichment runs).
- Distances should appear on Resy results (address extraction + AI fallback).
- Total response time should land in the 22–28s range instead of 46s.

**Won't fix:**
- Yelp thoroughness. DataDome still blocks Firecrawl from rendering Yelp's reservation widget. Yelp will contribute 0–1 results per search, sometimes zero. Solving that requires a paid proxy/browser path (Browserbase with proxies, ScrapingBee, etc.) and is a separate decision.

## Files touched

- `supabase/functions/search/index.ts` — retry logic, deadline enforcement, address regex, enrichment scheduling, new log line.
- `supabase/functions/search/link-verify.test.ts` — assertion that returned results have `description` and (for Resy/OT) `distanceMiles != null`.
- No DB changes. No new secrets.

## How we'll know it worked

Run the same Atlanta dinner search after the change. Success criteria, all three must hold:
1. `[SEARCH_SUMMARY]` shows `elapsedMs < 30000` and `returned >= 5`.
2. Returned cards in the UI have descriptions and ratings populated.
3. At least one Resy or OT result has a distance value.

If any of those fail, the next step is the proxy decision, not more timeout tuning.
