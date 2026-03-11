

## Fix OT Slot Extraction: Two-Pass Scrape with Retry

### Problem
Firecrawl sometimes captures OT page markdown before the reservation widget renders. This is page-specific (Marcel fails while Chops/Morton's work). The `waitFor` parameter tells Firecrawl to delay capture, but a blanket delay adds unnecessary latency to pages that already work.

### Approach: Retry on Failure

**In `supabase/functions/search/index.ts`, modify the OT verification path:**

1. **First pass (current behavior):** Scrape OT page with no `waitFor` — fast, works for most restaurants.

2. **If the OT parser finds zero content** (no "Select a time" section AND generic regex finds nothing), **retry once** with `waitFor: 5000` (5 seconds). This gives slow-rendering widgets time to load.

3. **Log the retry** so we can monitor which restaurants need it.

### Code Changes (single file: `supabase/functions/search/index.ts`)

**Change 1: Add `waitFor` to scrape payload for OT pages on retry** (~line 1542-1554)

Wrap the existing scrape logic so that after the OT-specific parsing block (line ~1910), if `isOT && foundTimes.length === 0` and the markdown had no "Select a time" section, re-scrape with `waitFor: 5000` and re-run the OT parser on the new markdown.

```text
Flow:
  scrape(url)  →  parse OT slots  →  found slots? → done
                                   →  no slots?   → re-scrape(url, waitFor: 5000)
                                                   → parse OT slots again
                                                   → still nothing? → reject
```

**Change 2: Extract the scrape + parse into a helper** to avoid duplicating the scrape call and OT parsing logic. The helper takes `(url, waitFor?)` and returns parsed `foundTimes[]`.

### What This Does NOT Do
- Does not use the OT mobile API (requires auth tokens we don't have)
- Does not add latency to OT pages that already work
- Does not affect Resy or Yelp scraping

### Tradeoffs
- **Pro:** Zero impact on restaurants that already parse correctly
- **Pro:** 5-second wait gives generous time for JS widget rendering
- **Con:** Failed OT restaurants take ~5s longer (one extra API call)
- **Con:** Uses one additional Firecrawl credit per retry

### Files Changed
- `supabase/functions/search/index.ts`

