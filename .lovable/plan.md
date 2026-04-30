
## Problem

OpenTable verification scrapes are 100% failing. Logs show two failure modes:
- **Blocked** (mdLen=139): Akamai Bot Manager returns a tiny challenge page
- **408 Timeout**: Firecrawl can't render the page in time

Resy and Yelp continue to work fine. OT discovery (finding candidates) works — it's only the verification scrape of individual booking pages that fails.

## Root Cause

The current OT scrape uses basic `waitFor: 5000` which does NOT force Firecrawl to use its full browser engine. Firecrawl's `actions` parameter forces a real browser session and is specifically designed for JS-heavy, anti-bot-protected pages.

## Plan

### Step 1: Use Firecrawl `actions` with `wait` for OT scrapes

Replace the current `waitFor`-based OT payload with an `actions`-based approach that:
- Uses `actions: [{ type: "wait", selector: "[data-test='time-picker']", milliseconds: 8000 }]` to wait for OT's booking widget
- Falls back to a fixed 5s wait if the selector doesn't exist
- Sets `proxy: "auto"` explicitly to ensure enhanced proxies kick in on failure (5 credits per enhanced request, included in existing Firecrawl plan)

### Step 2: Increase OT timeout to 20s with retry on 408

OT pages are heavy. The actions-based scrape needs more time:
- Primary timeout: 20s (actions + browser rendering)
- On 408 or timeout: single retry at 15s (shorter, sometimes the page is cached)
- Cap OT candidates at 6 (current setting)

### Step 3: Remove Steel.dev dependency for OT

The Yelp Steel.dev fallback can stay (it's separate), but remove any remaining Steel references from the OT code path since Steel hobby plan doesn't work for OT.

### Step 4: Validate with live search

Run a live search (e.g. "Italian tonight for 2" in NYC) and confirm OT results appear alongside Resy/Yelp.

## Technical Details

**File**: `supabase/functions/search/index.ts`

OT scrape payload change (~line 2633):
```typescript
// Before
const otPayload = isOT ? { ...scrapePayload, waitFor: 5000 } : scrapePayload;

// After
const otPayload = isOT ? {
  url: r.platformUrl,
  formats: ["markdown", "html"],
  onlyMainContent: false,
  actions: [{ type: "wait", milliseconds: 5000 }],
  proxy: "auto",
} : scrapePayload;
```

Timeout adjustment:
```typescript
const primaryTimeout = isOT ? 20_000 : 15_000;
const retryTimeout = isOT ? 15_000 : 12_000;
```

Re-enable 408 retry for OT only (currently skipped):
```typescript
if (resp.status === 408) {
  if (isOT) {
    // Retry once — actions mode may succeed on second attempt
    attempt = await doScrape(retryTimeout, otPayload);
  } else {
    return null;
  }
}
```

## Cost Impact

- Firecrawl `auto` proxy: 1 credit if basic works, 5 credits if enhanced needed
- With 6 OT candidates per search: worst case 30 credits (vs current 6 credits wasted on blocked pages)
- This is within the existing Firecrawl plan allocation — no new subscriptions needed
