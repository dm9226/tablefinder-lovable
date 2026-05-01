You’re right to call this out. The honest status is: I overpromised. I said I was “proceeding” as if I could keep working in the background, but Lovable does not keep executing after that response. Work only happens during an active turn, and right now I’m in read-only planning mode, so I can inspect but not edit/deploy/run regressions.

I inspected the current code. The restoration is not implemented yet:

- Backend still has a 120s global timeout.
- Discovery still allows 45s.
- OpenTable verification still allows ~90s lane budget and 50–55s scrape waits.
- Frontend does not send `originZip`.
- Distances can still be based on broad city/browser/AI fallback rather than explicit shared zip origin.
- Tests do not yet enforce the full requirements: ≤25s, 100% descriptions, 100% time slots, zip-origin distance, and deep-link params for every returned result.

## Build plan for the next implementation turn

### 1. Enforce a real 25s initial-search deadline
Replace the current long-running search model with one shared deadline object across parsing, discovery, verification, geocoding, enrichment, and response serialization.

Target schedule:

```text
0–3s      Parse query + resolve explicit zip/postcode origin
0–8s      Discover candidates from Resy, OpenTable, Yelp in parallel
8–22s     Verify availability in provider lanes with strict per-call budgets
22–24s    Complete metadata + distance normalization
<=25s     Return initial response
```

No operation gets to start if it cannot finish inside the remaining budget. No initial OpenTable path gets 50–90 seconds anymore.

### 2. Fix zip/postcode origin handling end-to-end
Add first-class zip/postcode origin support:

- Frontend search UI captures an optional shared zip/postcode.
- `Index.tsx` sends `originZip` with the search body.
- Backend accepts `originZip` separately from the natural language query.
- Backend geocodes `originZip` once at request start.
- Distance is calculated from that zip-derived coordinate.
- If no zip is supplied, use precise browser coordinates if available.
- If neither exists, distance is explicit/unavailable rather than fabricated.

### 3. Make returned results complete or exclude them
Before returning, every result must have:

- verified available time slots
- description
- rating when provider/discovery data exposes it
- distance when zip/browser origin exists
- cuisine
- neighborhood/location label
- platform
- direct booking URL
- vibe tags

Fallback metadata is allowed. Fallback availability is not allowed.

### 4. Restore provider-specific availability lanes
Implement provider lanes so one slow platform cannot starve the others.

- **Resy**: prioritize direct availability/API-style extraction where possible; scrape only as fallback inside the remaining budget.
- **OpenTable**: investigate/restore the previously working path rather than accepting the current slow Firecrawl-only behavior. Bound it tightly for initial results. If OpenTable is blocked for a given query, fail closed rather than returning guessed availability.
- **Yelp**: preserve content verification, make it deadline-aware, and ensure links include date/time/covers.

The initial response should include Resy, OpenTable, and Yelp when candidates are actually available and verifiable within the 25s window.

### 5. Tighten deep links
Ensure every returned result links directly to the reservation flow with criteria preselected:

- Resy: date, seats, time
- OpenTable: `dateTime`, covers/party size
- Yelp: date, time, covers

Generic restaurant pages do not pass unless the platform offers no deeper reservation URL and the page itself contains verified booking slots.

### 6. Strengthen regression tests before declaring done
Update the existing US, UK, and link verification suites to fail if any returned result violates the requirements.

Required assertions:

- initial response ≤25s
- every result has at least one actual slot
- every slot is within ±2 hours of requested time
- every result has non-empty description
- every result has non-empty vibe tags
- every result has distance when zip/postcode/browser origin is supplied
- every deep link contains date/time/party size params
- no duplicate restaurants
- provider counts are reported by platform

Add explicit zip-origin test cases:

- Atlanta `30309`
- New York `10003`
- Chicago `60614`
- London postcode

### 7. Deploy and run live regressions
After edits, deploy the search backend and run live regression calls against representative searches. I will only report completion with an actual pass/fail table showing:

```text
query
response time
result count
Resy / OpenTable / Yelp counts
% with descriptions
% with ratings where available
% with distances
% with verified slots
% with valid deep-link params
pass/fail
```

If any gate fails, I keep iterating in that implementation turn instead of calling it done.