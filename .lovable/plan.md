

## Fix: Resy Verification Crash — Variable Declaration Order Bug

### Root Cause

The Resy-specific markdown parsing block (lines 1786–1825) references three variables — `mealLabel`, `foundTimes`, and `seenTimes` — that are declared **later** in the function (lines 1842, 1867, 1868). JavaScript's `let` has a temporal dead zone, so any access before declaration throws:

```
ReferenceError: Cannot access 'mealLabel' before initialization
```

This silently kills every Resy candidate in the `Promise.all`, causing them all to return `null`.

### Fix

Move the meal window calculation (`windowStart`, `windowEnd`, `mealLabel`) and the `foundTimes`/`seenTimes` declarations **above** the Resy markdown parsing block. Specifically:

1. Move lines 1833–1868 (meal window calc + foundTimes/seenTimes declarations) to just before line 1782 (the `// RESY-SPECIFIC` comment).
2. No other logic changes needed — just reordering declarations so they exist before first use.

### File

- `supabase/functions/search/index.ts` — reorder variable declarations (lines 1782–1868)

