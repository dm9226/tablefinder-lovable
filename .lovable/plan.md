## Problem

Searching "dinner for 6 people" with browser location "Atlanta, GA" detected fails with: *"Multiple locations found for 'Atlanta'..."*

Root cause is in `supabase/functions/search/index.ts` (location resolution block, ~lines 700–877):

1. The frontend correctly sends `location: "Atlanta, GA"` plus precise coordinates.
2. The server parses this into `browserCity = "Atlanta"`, `browserState = "GA"`.
3. The AI parser, however, returns `parsed.city = "Atlanta"` (since the user wrote "Atlanta" implicitly via context) with no state.
4. The "use browser location" block (line 772) only runs `if (!parsed.city)`. Since `parsed.city` is already "Atlanta", that block is skipped — and crucially `cityFromBrowser` stays `false`.
5. Disambiguation at line 866 then runs, finds 5+ Atlantas across states, and throws the error — even though the browser already told us the user is in Atlanta, GA.

## Fix

In `supabase/functions/search/index.ts`, when `parsed.city` matches `browserCity` (case-insensitive) and `parsed.state` is empty, trust the browser-provided state and coordinates instead of throwing a disambiguation error.

### Change 1: Adopt browser state when AI city matches browser city

After the existing browser-location parse (around line 722), add:

```ts
// If AI returned the same city the browser detected but no state, trust the browser state/coords.
if (
  browserCity &&
  browserState &&
  parsed.city &&
  !parsed.state &&
  normalizePlaceToken(parsed.city) === normalizePlaceToken(browserCity)
) {
  parsed.state = browserState;
  if (lat && lng) {
    parsed.lat = lat;
    parsed.lng = lng;
  }
  cityFromBrowser = true; // hoist declaration above this block
}
```

This requires hoisting `let cityFromBrowser = false;` from line 771 up to before this new block.

### Change 2: Defensive fallback in disambiguation

Update the disambiguation guard at line 866 so that even if the above didn't fire, a browser-provided state matching one of the candidate states auto-resolves instead of throwing:

```ts
} else if (!hasExplicitState && !cityFromBrowser) {
  if (distinctStates.length > 1) {
    // If browser told us the state and it's among the candidates, use it.
    if (browserState && distinctStates.includes(browserState.toUpperCase())) {
      parsed.state = browserState.toUpperCase();
    } else {
      const options = [...new Set(usableCandidates.map(...))].slice(0, 4);
      throw new Error(`Multiple locations found ...`);
    }
  } else if (distinctStates.length === 1) {
    parsed.state = distinctStates[0];
  }
}
```

## Files Changed

- `supabase/functions/search/index.ts` — two small edits in the location resolution block (~lines 707–877).

## Out of Scope

- Frontend changes — `src/pages/Index.tsx` already sends location and coords correctly.
- AI parser prompt changes — fix handles ambiguous AI output without retraining the prompt.
