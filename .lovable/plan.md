

## Fix Critical Bug: OpenTable Results Completely Broken

### Root Cause
The edge function logs show **every single OpenTable restaurant** crashing with:
```
TypeError: Assignment to constant variable.
  at file:///...search/index.ts:2122:20
```

**Line 1819** declares `const foundTimes = []`, but **lines 1891 and 1921** attempt to reassign it (`foundTimes = parseOTSlots(...)`). This crashes the verification for every OT restaurant, meaning zero OpenTable results ever make it to the user.

Resy and Yelp results are working — the logs show successful verifications for those platforms. The problem is isolated to OpenTable.

### Fix

**One-line change in `supabase/functions/search/index.ts`:**

Line 1819: change `const foundTimes` to `let foundTimes`

```typescript
// Before (line 1819):
const foundTimes: { time: string; minutes: number }[] = [];

// After:
let foundTimes: { time: string; minutes: number }[] = [];
```

### After Fix: Run Full Test Suite

Once deployed, run all 5 batches of the existing 50-query test suite (`supabase/functions/search/index.test.ts`) to verify:
- OpenTable results now appear alongside Resy and Yelp
- Platform diversity criterion passes
- All 13 validation criteria are evaluated across all 50 queries
- Full summary report with pass/fail rates per criterion and per category

### Expected Impact
- Restores **all OpenTable results** immediately
- Platform diversity scores should jump significantly (currently failing because only Resy/Yelp return)
- Total result counts per query should increase

