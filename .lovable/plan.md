
## Three surgical changes to `supabase/functions/search/index.ts`

No other files touched. No refactoring.

### Change 1 — Restore FC_MAX_CONCURRENT to 6
Line 2614: `const FC_MAX_CONCURRENT = 4` → `const FC_MAX_CONCURRENT = 6`

### Change 2 — Remove OT consecutive failure hard gate
- Line 2632-2634: Remove `OT_MAX_CONSECUTIVE_FAILURES` constant, keep `otConsecutiveFailures` as diagnostic-only counter
- Lines 2650-2655: Delete the `if (isOT && otConsecutiveFailures >= OT_MAX_CONSECUTIVE_FAILURES)` skip block entirely
- Line 3379: Keep the existing `otConsecutiveFailures = 0` reset (unchanged)

### Change 3 — Replace OT cascade with single stealth scrape
- Lines 2714-2722: Delete the unused `scrapePayload` variable
- Lines 2748-2843: Replace the entire light/stealth cascade with a single direct path:
  - OT: `proxy: "stealth"`, `waitFor: 5000ms`, `timeout: 25000`, client timeout 30s
  - Resy: unchanged lightweight scrape, no proxy, client timeout 15s
  - Single attempt per restaurant, no cascade retries
  - Failure counters and slot release logic preserved

### Why this works
The cascade was wasting 12-15s on a guaranteed-to-fail light scrape before falling back to stealth, often exceeding the time budget. A direct stealth scrape with proper wait time is what was working before the "speed optimizations" broke it.
