

## Fix Time Slot Extraction: False Positives, Duplicates, and Ordering

### Problems Identified

1. **Resy false positives (e.g. Hayakawa showing 6:00 PM x3)**: The regex `/\b(\d{1,2}):(\d{2})\s?(am|pm)\b/gi` captures every time-like string on the page — including "Notify" buttons for sold-out slots, operating hours, and repeated mentions of the same time. No deduplication occurs.

2. **Wrong times shown (e.g. Tomo showing 7:00, 10:00, 9:30)**: All extracted times within the meal window are kept. They are not sorted or filtered by proximity to the user's requested time.

3. **No chronological ordering**: Times are returned in the order they appear in the page markdown.

### Changes to `supabase/functions/search/index.ts`

**In the `verifyAvailability` function (lines ~1704-1810):**

**A. Filter out Resy "Notify" slots**
Before collecting times, detect lines/contexts containing "notify" near a time. When iterating regex matches, check the surrounding markdown (~50 chars) for "notify", "sold out", "waitlist" signals. Skip those times.

**B. Deduplicate times**
After collecting `foundTimes`, deduplicate by the formatted time string (e.g. only keep one "6:00 PM").

**C. Sort chronologically**
Sort `matchingTimes` by `minutes` ascending before assigning to `r.timeSlots`.

**D. Select times closest to requested time**
After filtering to the meal window, sort by absolute distance from the requested time. Keep the closest N times (all of them for verification, but store sorted by proximity). Then re-sort the final displayed slots chronologically so the UI shows them in order.

### Pseudocode for the fix

```
// After regex extraction, before filtering to meal window:

// A. Skip times near "notify"/"sold out" context
for each regex match:
  context = markdown.substring(match.index - 50, match.index + 50)
  if context contains "notify" or "sold out" or "waitlist":
    skip this time

// B. Deduplicate by formatted time string
foundTimes = unique by .time

// C. Filter to meal window (existing)
matchingTimes = foundTimes.filter(in window)

// D. Sort by proximity to requested time, take closest 5
matchingTimes.sort(by |t.minutes - requestedMinutes|)
matchingTimes = matchingTimes.slice(0, 5)

// E. Re-sort chronologically for display
matchingTimes.sort(by t.minutes)
```

### Scope
Single file: `supabase/functions/search/index.ts`, verification section (~lines 1704-1810).

