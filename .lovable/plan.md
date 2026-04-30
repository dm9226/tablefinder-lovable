
## Problem

All OpenTable scrape attempts are timing out at the 8-second limit. The OT Firecrawl payload also lacks a `waitFor` parameter, so even if the request completes in time, Firecrawl captures the page before the JS booking widget renders.

Latest logs confirm: **6/6 OT candidates timed out at 8s**, resulting in zero OT results.

## Plan

### Step 1: Tune Firecrawl params for OT

In `supabase/functions/search/index.ts`, update the OT scrape payload (~line 2620):

- Add `waitFor: 5000` so Firecrawl waits for the booking widget JS to render
- Increase OT timeout from 8s to 15s (line 2656) to match Resy/Yelp — OT pages are heavier and 8s is consistently too short

```
scrapePayload = {
  url: r.platformUrl,
  formats: ["markdown", "html"],
  onlyMainContent: false,
  waitFor: 5000,        // <-- NEW: wait for JS widget
}
```

Timeout change: `doScrape(isOT ? 8_000 : 15_000, ...)` becomes `doScrape(15_000, ...)` for both OT and Resy.

### Step 2: Add OT retry with Browserbase fallback

If the Firecrawl scrape for an OT candidate returns blocked content (tiny markdown, "access denied") or still times out, attempt a single retry using Browserbase (key already configured as `BROWSERBASE_API_KEY`). This gives OT a full-browser path without changing the Resy/Yelp flow.

Only attempt Browserbase for OT, not other platforms, to keep costs controlled.

### Step 3: Test and validate

- Run a live search for "Italian dinner tonight for 2" in Atlanta
- Confirm OT candidates no longer all time out
- Verify total execution time stays under 30s
- Check that OT results appear with verified time slots

### Why this should work

The 8s timeout is too aggressive for OT's JS-heavy pages. Firecrawl needs both more time AND explicit `waitFor` to let the booking widget render. If OT is actively blocking Firecrawl at the network level (not just slow rendering), the Browserbase fallback provides a full-browser alternative that is harder to block.
