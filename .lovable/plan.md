

## Smart Defaults: Tonight, 2 People, User's Location

### Current Behavior
The AI parser prompt already defaults to `partySize: 2` and `time: "19:00"` (dinner). The date default is handled by the "tonight" rule. So for a query like "mexican", the parser *should* already return tonight's date, 19:00, party of 2. The location fallback at line 530-546 already reverse-geocodes browser coords when no city is specified.

The main gaps are:
1. **No explicit "default to tonight" instruction** — the prompt says `dinner/tonight defaults to time "19:00"` but doesn't explicitly say "if no date mentioned, default to today's date". The AI model usually does this, but it's not guaranteed.
2. **Browser coords get overwritten** — as identified in the previous plan, lines 637-640 overwrite the user's precise browser coordinates with the city center point. A query like "mexican" would resolve to browser location city, then overwrite coords with that city's center.
3. **The prompt doesn't clearly state the defaults philosophy** — needs a clear statement: "If no time/date/party size/location specified, default to: tonight, 19:00, 2 people, browser location."

### Changes

**File**: `supabase/functions/search/index.ts`

#### 1. Update the parse prompt (around line 375-383) to add explicit default rules

Add a clear defaults block:
```
DEFAULTS (apply when user does NOT specify):
- Date: today (${now.toISOString().split("T")[0]})
- Time: "19:00" (dinner tonight)
- Party size: 2
- Location: use browser coordinates (reverse-geocode to city)

The user can override any of these. Examples:
- "mexican" → tonight, 19:00, 2 people, browser location
- "mexican for 4" → tonight, 19:00, 4 people, browser location  
- "mexican Saturday" → this Saturday, 19:00, 2 people, browser location
- "mexican in Decatur" → tonight, 19:00, 2 people, Decatur
```

#### 2. Preserve browser coordinates when city came from reverse-geocode (lines 530-640)

Track when the city was resolved from browser coords with a `cityFromBrowser` flag. At line 637-640, skip the city-center coordinate override when `cityFromBrowser` is true — keep the user's actual position for accurate distance sorting.

```typescript
let cityFromBrowser = false;

// At line 531-541, after reverse-geocode succeeds:
if (lat && lng) {
  // ... existing reverse-geocode ...
  if (parsed.city) {
    cityFromBrowser = true;
  }
}

// At line 637-640:
if (selectedCandidate && !cityFromBrowser) {
  parsed.lat = selectedCandidate.lat;
  parsed.lng = selectedCandidate.lng;
}
```

This ensures "mexican" with shared browser location → distances measured from user's actual position, not city center.

### Scope
- Single file: `supabase/functions/search/index.ts`
- Prompt text update + `cityFromBrowser` flag logic (~15 lines changed)

