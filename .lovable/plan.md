

## Problem Summary

From the latest logs, confirmed:
- **OpenTable: 1 time slot every time** — always exactly the user's requested time (7:30 PM or 7:00 PM). This is the page header echoing the request, not actual availability data. The JS availability widget doesn't render in time.
- **OpenTable: 0 addresses extracted** — every single OT result shows "No address extracted". The regex doesn't match OT's address format.
- **Resy + Yelp work fine** — multiple time slots and addresses extracted correctly.

## Root Causes

1. **OT time slots**: OpenTable renders availability via a JavaScript widget. Even with `onlyMainContent: false`, Firecrawl captures the page before JS executes. The only "time" found is the requested time mentioned in the page title/header text.

2. **OT addresses**: OpenTable doesn't format addresses in a way the current regex catches. The address text on OT pages uses formats like `"3637 Peachtree Rd NE Ste 112 Atlanta, GA 30319"` or is embedded in structured metadata rather than visible markdown.

## Fix (all in `supabase/functions/search/index.ts`)

### 1. Add `waitFor: 3000` for OpenTable scrapes

Since all scrapes run in parallel via `Promise.all`, adding a 3-second JS render wait only adds ~3s to total wall time, not per-scrape. This is within the 30s performance budget.

```typescript
const scrapePayload: Record<string, unknown> = {
  url: r.platformUrl,
  formats: ["markdown"],
  onlyMainContent: !isOT,
  ...(isOT && { waitFor: 3000 }),
};
```

### 2. Extract addresses from Firecrawl metadata (before regex)

Firecrawl returns page metadata including `og:street-address`, `og:locality`, `og:region` which OpenTable populates. Check metadata first, fall back to regex.

```typescript
// Before regex fallback, check Firecrawl metadata
const meta = data?.data?.metadata || data?.metadata;
const ogStreet = meta?.["og:street-address"] || meta?.["street-address"];
const ogCity = meta?.["og:locality"] || meta?.locality;
const ogState = meta?.["og:region"] || meta?.region;
const ogZip = meta?.["og:postal-code"] || meta?.["postal-code"];
if (ogStreet && ogCity && ogState) {
  r._address = `${ogStreet}, ${ogCity}, ${ogState}${ogZip ? " " + ogZip : ""}`;
  r._addressCity = ogCity;
}
```

### 3. Add broad fallback address regex

For cases where neither metadata nor strict regex match, add a catch-all that just looks for `number + text + City, ST`:

```typescript
const addrRegexBroad = /(\d{1,5}\s+[A-Za-z\s.#']+,\s*[A-Za-z\s]+,\s*[A-Z]{2}(?:\s+\d{5})?)/m;
```

### Performance Impact

- `waitFor: 3000` adds ~3s to the verification step (parallel, not sequential)
- Metadata extraction: zero additional latency (already have the scrape response)
- Total expected time: ~18-22s (within 30s budget)

