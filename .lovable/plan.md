

## Problem: OpenTable Extracting Incomplete Time Slots

### Root Cause

The OpenTable scrape runs **without `waitFor`** on the first pass. The JS widget partially renders — enough to show 2 out of 5 available slots for Cooks & Soldiers, and 1 out of 4 for Lazy Betty.

The two-pass retry logic only triggers when **zero** slots are found AND no "Select a time" section exists:
```
if (foundTimes.length === 0 && !hadSelectSection) {
  // retry with waitFor: 5000
}
```

Since 1-2 slots ARE found, the retry never fires, and users see incomplete availability.

### Evidence

- **Cooks & Soldiers**: Page has 5 slots (6:30, 6:45, 7:00, 7:15, 7:30 PM). Edge function logs: "extracted 2 times: 6:30 PM, 6:45 PM"
- **Lazy Betty**: Page has 4 slots (5:15, 5:30, 8:30, 8:45 PM). Only 5:15 PM returned.
- Both pages confirmed to have full slots via browser fetch with JS rendering.

### Fix

**File: `supabase/functions/search/index.ts`**

1. **Add `waitFor: 3000` to ALL OpenTable first-pass scrapes** — same pattern already applied to Yelp. This gives the OT widget time to fully render before Firecrawl captures the markdown.

   In the initial scrape payload construction (~line 1865), add OT to the `waitFor` condition:
   ```typescript
   const scrapePayload: Record<string, unknown> = {
     url: r.platformUrl,
     formats: ["markdown"],
     onlyMainContent: isYelp,
     ...(isYelp && { waitFor: 3000 }),
     ...(isOT && { waitFor: 3000 }),   // ← ADD THIS
   };
   ```

2. **Change the retry condition to also trigger when fewer than 3 slots are found** — if the "Select a time" section exists but only yielded 1-2 slots, retry with `waitFor: 5000` since the widget likely didn't finish rendering:
   ```typescript
   if ((foundTimes.length === 0 && !hadSelectSection) || 
       (hadSelectSection && foundTimes.length > 0 && foundTimes.length < 3)) {
     // retry with waitFor: 5000
   }
   ```

3. **Merge retry results with first-pass results** — if the retry yields additional slots, merge them (deduped by `seen` set) rather than replacing.

### What this does NOT change
- Yelp/Resy scrape logic — untouched
- ±2h window filtering — untouched
- Top-5 ranking by proximity — untouched
- Time guards (80s/90s/25s) — untouched

### Expected Outcome
- Cooks & Soldiers returns all 5 slots within window instead of 2
- Lazy Betty returns all 4 slots instead of 1
- Slight increase in scrape latency (~3s) for OT first pass, offset by fewer retries needed

