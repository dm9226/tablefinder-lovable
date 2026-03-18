

## Problem

Yelp reservation pages render time slots via JavaScript widgets. The current Firecrawl scrape for Yelp uses **no `waitFor`** parameter, so the JS never executes and time slots are never present in the returned markdown. This is why every Yelp candidate fails verification with "No time slots."

OpenTable already has a two-pass retry with `waitFor: 5000` when the initial scrape finds no slots. Yelp has no equivalent — it just falls through to a "trust markers" fallback that fabricates the requested time, and even that fallback requires specific phrases in the markdown (`hasYelpAvailabilityMarker`).

The `link-verify.test.ts` file already uses `waitFor: 3000` for Yelp scrapes and successfully extracts real slots, proving that adding `waitFor` to Yelp production scrapes should work.

## Plan

**File: `supabase/functions/search/index.ts`**

### 1. Add `waitFor` to Yelp scrapes (primary fix)

In the `verifyAvailability` function (~line 1742), add `waitFor: 3000` to the scrape payload when the platform is Yelp:

```typescript
const scrapePayload: Record<string, unknown> = {
  url: r.platformUrl,
  formats: ["markdown"],
  onlyMainContent: isYelp,
  ...(isYelp && { waitFor: 3000 }),
};
```

This gives Yelp's JS widget time to render actual time slots into the DOM before Firecrawl captures the markdown — matching what `link-verify.test.ts` already does successfully.

### 2. Add Yelp two-pass retry (matching OpenTable pattern)

If the first Yelp scrape with `waitFor: 3000` still finds no time slots AND no availability markers, retry once with `waitFor: 5000` (same pattern as OpenTable's existing retry at ~line 2122). This handles slow-loading Yelp widgets.

### 3. Keep the trust markers fallback as last resort

If even the retry fails to extract slots, the existing trust markers fallback (line 2315) stays as-is. But with `waitFor` enabled, it should rarely be needed.

### 4. Increase Yelp verification quota

Add a Yelp-specific fallback after the main verification loop (~line 2340): if zero Yelp results survived but untested Yelp candidates remain in the discovery pool, try up to 4 more. This prevents proportional capping from killing all Yelp coverage when the first batch happens to have sparse pages.

### Expected Outcome

- Yelp scrapes will now wait for JS widgets to render, enabling real time slot extraction
- Time slots will be real availability data, not fabricated from the request time
- The two-pass retry provides resilience for slow-loading pages
- More Yelp candidates get a chance via the fallback quota

