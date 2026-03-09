

## Fix: Revert the two changes that broke OpenTable

### What broke it
Two lines changed in `supabase/functions/search/index.ts` during this conversation:

1. **Line 1460**: `onlyMainContent: !isOT` → set to `false` for OpenTable, which pulled in operating hours text ("Opens at 7:30 am") that poisons the time extraction
2. **Line 1461**: `...(isOT && { waitFor: 3000 })` → added unnecessary 3-second delay

### Changes (single file: `supabase/functions/search/index.ts`)

**Lines 1457-1462** — Revert scrape payload to original:
```typescript
const scrapePayload: Record<string, unknown> = {
  url: r.platformUrl,
  formats: ["markdown"],
  onlyMainContent: true,
};
```

This removes both `!isOT` (which disabled main-content filtering for OT) and `waitFor: 3000` (which just added latency). Returns the scrape behavior to exactly what was working on Saturday.

