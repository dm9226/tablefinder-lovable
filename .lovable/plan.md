

## Problem Diagnosis

The OpenTable availability data IS in the scraped markdown. I fetched a real OT page and confirmed:

```text
Line 54: 12:00 AM12:30 AM1:00 AM...7:30 AM...11:30 PM   ← TIME PICKER DROPDOWN (noise)
Line 56: 7:00 PM                                         ← Selected time echo
Line 58: ### Select a time                                ← SECTION HEADER
Line 60: - 6:30 PM                                        ← REAL AVAILABILITY
Line 61: - 6:45 PM
Line 62: - 7:00 PM
Line 63: - 7:15 PM
Line 64: - 7:30 PM
Line 65: Notify me                                        ← End marker
```

**Two competing problems:**
- `onlyMainContent: true` → Firecrawl strips the reservation widget entirely. Zero times found.
- `onlyMainContent: false` → The time picker dropdown (48 concatenated times like `12:00 AM12:30 AM...`) floods the regex. The first match is "7:30 AM" from the dropdown, which falls outside the dinner window.

**The real availability lives in a clearly structured section** (`### Select a time` with `- TIME` list items). The current regex doesn't distinguish this from the dropdown noise.

## Solution

All changes in `supabase/functions/search/index.ts`. No other files affected. Resy and Yelp logic untouched.

### Change 1: OT scrapes use `onlyMainContent: false`

Restore `onlyMainContent: false` for OT only, so the reservation widget appears in the markdown. Keep `true` for Resy/Yelp (working fine).

```typescript
const scrapePayload: Record<string, unknown> = {
  url: r.platformUrl,
  formats: ["markdown"],
  onlyMainContent: !isOT,  // false for OT to capture reservation widget
};
```

### Change 2: OT-specific time extraction (before the generic regex)

Add a dedicated OT parser in the verification function that:

1. **Finds the `Select a time` section** in the markdown
2. **Extracts times from markdown list items** (`- 6:30 PM`, `- 6:45 PM`, etc.) within that section
3. **Skips times adjacent to "Notify me"** (means not actually bookable)
4. **Strips the time picker dropdown** — the concatenated `12:00 AM12:30 AM...11:30 PM` line that contains all 48 half-hour options. This is identified by having 10+ consecutive time matches on a single line.
5. If the OT-specific parser finds times, use them directly and skip the generic regex path

This runs inside the existing `verifyAvailability` function, after address extraction but before the generic regex (line ~1751).

### Change 3: Time window for OT — requested time ±1h/+2h

For OT results specifically, instead of using the broad meal window (18:00–23:59 for dinner), apply a tighter window: **requested time minus 1 hour to requested time plus 2 hours**. This matches the user's requirement exactly.

For a 7:00 PM search: show slots from 6:00 PM to 9:00 PM.

This only applies to OpenTable. Resy and Yelp keep using the existing meal window logic (already working correctly).

### Change 4: OT booking marker fallback

If the OT-specific parser finds zero times but the page has `Make a reservation` or `Select a time` markers (confirming it's a valid OT booking page), include the result with the user's requested time as a single slot. This mirrors the existing Yelp fallback pattern (lines 1828-1831).

### Performance Impact

- No `waitFor` delay added (stays fast)
- `onlyMainContent: false` for OT means slightly more markdown to parse, but the OT-specific parser targets a small section — negligible impact
- All scrapes still run in parallel
- Well within 30-second budget

### What stays the same

- Resy parsing (meal section strategy) — unchanged
- Yelp parsing (generic regex + marker fallback) — unchanged
- Geocoding and distance calculation — unchanged
- AI enrichment — unchanged
- All address extraction — unchanged
- Discovery queries — unchanged
- Deduplication — unchanged

