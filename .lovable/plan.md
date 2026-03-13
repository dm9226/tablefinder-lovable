

## Prompt Location Sharing

Currently, `navigator.geolocation.getCurrentPosition` is called on mount, which triggers the browser's native location permission prompt. However, if the user denies or dismisses it, nothing happens — the app silently falls back to "Location not available" with no way to retry.

### Plan

**Add a location prompt banner when location is not shared.** When geolocation is denied or unavailable, show a visible, actionable UI element encouraging the user to enable location.

### Changes

**1. Track denial state in `Index.tsx`**
- Add a `locationDenied` state (boolean, default false)
- In the geolocation error callback (line 45-47), set `locationDenied = true`
- Pass `locationDenied` and a `onRequestLocation` retry handler down to `SearchBar`

**2. Update `SearchBar.tsx` — location prompt UI**
- When `locationDenied` is true and no location is set, replace the small "Location not available" text with a more prominent clickable banner:
  - Icon + "Enable location for better results" with a button/link
  - Clicking it calls `navigator.geolocation.getCurrentPosition` again (which re-triggers the browser prompt if the user previously dismissed — though if they blocked it, show a message explaining how to unblock in browser settings)
- When location is available, show the current city/state display as-is

**3. Block search without location (optional but recommended)**
- If no location and no explicit location in the query, show a toast: "Please enable location or include a city in your search"
- This prevents wasted API calls that return irrelevant results

### Files Changed
- `src/pages/Index.tsx` — add `locationDenied` state, retry handler
- `src/components/SearchBar.tsx` — add location prompt banner UI, accept new props

