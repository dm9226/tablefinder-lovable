

## Problem

After switching OpenTable scrapes from `extract` format to `markdown`-only (performance optimization), **all OT results return exactly 1 time slot** instead of multiple.

**Root cause**: Two compounding issues:

1. **`structuredTimes` is always empty** — `jsonData` (from Firecrawl's LLM extraction) is always `null` now since we removed the `extract` format. Strategy 2 (line 1732) never fires.

2. **`bookingMarkdown` truncation is too aggressive** — The `sectionCutMarkers` array includes `"booked .* times today"`, `"dining style"`, `"neighborhood"`, and `"cuisines"` which appear on OpenTable pages *before* the time slot buttons. This cuts the markdown before the regex fallback (Strategy 3) can find the time slots. Only 1 time leaks through from the page header area.

## Fix

**`supabase/functions/search/index.ts`** — Two changes:

### 1. Make section cutting smarter for OpenTable
For OpenTable pages, the time slots typically appear in a "Select a time" or similar section. The current markers like `"booked .* times today"` and `"dining style"` cut too early. Fix by:
- Skipping the `"booked .* times today"` marker entirely (it's inline text, not a section header)
- For OT pages, only cut at markers that are clearly *after* the availability section (like `"need to know"`, `"about the restaurant"`)

### 2. Add OT-specific time extraction pattern
OpenTable markdown renders available times as links/buttons in a specific pattern. Add a targeted regex pass for OT pages that looks for the time slot cluster before falling back to generic regex. OpenTable typically renders times like `[7:00 PM](...)` or lists them as `7:00 PM · 7:15 PM · 7:30 PM`.

### Changes
- Remove `"booked .* times today"`, `"dining style"`, `"neighborhood"`, and `"cuisines"` from `sectionCutMarkers` (these appear mid-page on OT before the slots)
- Keep only true end-of-page markers: `"need to know"`, `"hours of operation"`, `"about the restaurant"`, `"about this restaurant"`, `"cross street"`, `"additional info"`, `"special features"`
- Clean up the dead `structuredTimes` code path (it can never be populated now) to avoid confusion

