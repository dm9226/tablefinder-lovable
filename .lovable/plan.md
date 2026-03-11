

## Fix OT Time Slot Parsing + Update Time Windows to ±2 Hours

### Problems Identified

1. **OT parser stops early**: The regex `otTimeRegex` only matches list items (`- 6:30 PM`). OT markdown sometimes formats slots as `[6:30 PM](link)` or inline text with `+1,000 pts` suffixes that break matching.

2. **OT section too short**: The parser caps extraction at 500 chars from the "Select a time" header. Long slot lists get truncated.

3. **OT time window too tight**: Currently `-1h / +2h` from requested time. Slots like Marcel's 8:45 PM (for a 7 PM search) get excluded even though they're only 1:45h away but within the +2h window — except if the 500-char truncation cuts them first.

4. **Fabricated fallback times**: When OT parser finds zero slots but booking markers exist (line 2054-2059), it shows the user's requested time as if it's available. This produced a fake "7:00 PM" for Marcel when only 8:45/9:00 existed.

5. **Generic (non-OT/Resy) time window** uses broad meal windows, not ±2h from requested time.

### Changes to `supabase/functions/search/index.ts`

**Change 1: Expand OT section capture** (line 1852)
- Increase from 500 to 2000 chars to capture all slots in longer lists.

**Change 2: Improve OT slot regex** (lines 1855-1867)
- Add a second pattern to match link-wrapped times: `[6:30 PM](url)`
- Strip `+X,XXX pts` suffixes before matching
- Don't break on "Notify me" — skip that individual slot but continue parsing

**Change 3: Update ALL time windows to ±2 hours** (lines 1900-1905)
- OT window: change from `-1h/+2h` to `-2h/+2h`
- Also update the generic meal-window filter (lines 2023-2026) to use ±2h from requested time instead of broad meal buckets

**Change 4: Remove fabricated fallback for OT** (lines 2053-2060)
- If the parser found real slots but none in window → reject (already happens)
- If the parser found zero slots AND booking markers exist → reject instead of fabricating. The "booking markers" fallback was causing fake times.
- Keep Yelp fallback (lines 2046-2051) since Yelp's JS widget genuinely doesn't render times into markdown

**Change 5: Non-OT/Resy generic filter** (lines 2023-2026)
- Replace broad meal windows (breakfast 6:00-12:00, dinner 18:00-23:59) with ±2h from requested time
- Keep meal windows only for Resy section selection (determining which `## dinner` / `## lunch` section to parse)

### Summary of window changes

```text
Before:
  OT specific: -1h / +2h from requested time
  Generic:     Meal bucket (e.g. dinner = 18:00-23:59)

After:
  OT specific: -2h / +2h from requested time  
  Generic:     -2h / +2h from requested time
  Resy:        Still uses meal section headers, then ±2h filter on extracted times
```

### Files Changed
- `supabase/functions/search/index.ts`

