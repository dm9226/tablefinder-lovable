

## Fix Plan: False Positives, Speed, and Search Summary

### Problem 1: Hayakawa Still Showing False Availability

**Root cause discovered**: The Firecrawl structured extraction LLM is confused by Resy pages. On Hayakawa's page, the actual booking section shows "NotifyAll Times" (no availability). But the "Need to Know" section contains the text "We provide a reservation only 16-course Omakase Dinner at 6:00pm and 8:30pm" — a description of their seating schedule, NOT availability. The Firecrawl LLM extracts these as `availableTimes` and sets `notifyOnly=false`.

The current code (line 1811-1820) blindly trusts structured extraction when it returns times. It checks `noAvailability`/`notifyOnly` first (line 1612-1616), but those flags are `false` because the LLM got confused.

**Fix**: After structured extraction returns times, cross-validate against the **markdown** for Resy pages. Specifically:
- For Resy: check if the markdown between `## dinner` (or `## lunch`) and `## Need to Know` contains "NotifyAll Times" or "Notify" without any individual time slot listings. If so, discard all structured times and reject the candidate.
- Also: strip "Need to Know" and similar sections from the text **before** sending to Firecrawl extraction — use the `prompt` field to tell the LLM to ignore descriptive text.

**Implementation** in `verifyAvailability` (~line 1740-1820):
1. After getting `structuredTimes` from extraction, if platform is `resy`, scan the raw markdown for the pattern: `## dinner` followed by `Notify` (without individual time slots like `6:00 PM\n\nDining Room` pattern between them). If found, reject candidate regardless of what structured extraction returned.
2. Strengthen the extraction prompt to explicitly say: "IGNORE times mentioned in 'Need to Know', 'About', or descriptive sections. ONLY extract times from the booking/reservation widget area."

### Problem 2: Slow Search (well over 30 seconds)

**Root causes**:
- `waitFor: 1500` (Resy/OT) and `waitFor: 2000` (Yelp) on every scrape adds latency
- Structured `extract` format uses an LLM call per scrape, adding 2-5 seconds each
- 24 candidates scraped in parallel but Firecrawl throttles concurrent requests

**Fixes**:
1. **Remove `waitFor`** — Firecrawl's default rendering is sufficient for these pages (confirmed by fetched content above showing correct data without extra waits)
2. **Drop structured `extract` format for Resy** — Resy pages have a very predictable markdown structure (time slots appear as `6:00 PM\n\nDining Room` lines under `## dinner`). Use regex on the cleaned markdown instead. This eliminates the per-scrape LLM call for Resy.
3. **Keep structured `extract` for OpenTable only** — OT pages benefit from it, but reduce `waitFor` to 0.
4. **For Yelp**: already markdown-only, just remove `waitFor`.
5. **Re-enable parse cache** — saves ~1-2 seconds on the LLM query parsing step for repeated/similar queries.
6. **Re-enable search cache** — for repeated identical searches, return cached results instantly.

**Expected timing**: Without `waitFor` and without Resy LLM extraction, each scrape drops from ~4-6s to ~1-2s. With 24 parallel scrapes, total verification should be ~3-6s instead of ~15-25s.

### Problem 3: Search Criteria Summary Disappears

**Root cause**: `ResultsGrid` returns early for error (line 31) and empty results (line 40) states **before** the `searchMeta` summary is rendered (line 54).

**Fix**: Move the `searchMeta` summary rendering above the early returns, so it always displays after a search completes.

### Files to Modify

1. **`supabase/functions/search/index.ts`**:
   - Add Resy-specific markdown validation after structured extraction (~line 1740-1820)
   - Strengthen extraction prompt to ignore "Need to Know" sections
   - Remove `waitFor` from all scrape payloads (line 1557)
   - Drop `extract` format for Resy scrapes — use markdown-only with regex parsing on the section between `## dinner`/`## lunch` and the next heading
   - Re-enable parse cache and search cache
   - Improve Resy notify detection: parse the actual dinner section from markdown

2. **`src/components/ResultsGrid.tsx`**:
   - Restructure render to show `searchMeta` summary above error/empty states

### Resy Markdown Parsing Strategy (replaces LLM extraction for Resy)

Resy pages have a consistent structure:
```
## dinner

6:00 PM
Dining Room

6:30 PM
Dining Room
...

NotifyAll Times     ← if present, these specific slots above are the notify ones
```

vs. available:
```
## dinner

6:00 PM
Dining Room

6:30 PM
Dining Room
...
```

The regex parser will:
1. Extract text between `## dinner` (or meal heading) and the next `##` heading
2. If that section contains "Notify" → no availability, reject
3. Otherwise, extract times from that section only (not from "Need to Know")

