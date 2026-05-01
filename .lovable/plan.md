You are right. The prior plan under-specified the actual product requirements. The acceptance target is not “eventually returns something”; it is fast initial results with complete, verified, directly bookable data from every platform.

## Non-negotiable acceptance requirements

Initial search must meet all of these before I report it as done:

1. **Initial results return in 20–25 seconds**
   - Target: ≤25s wall-clock for the initial response.
   - Hard backend cutoff: no initial search is allowed to run into the 60–120s range.

2. **Initial results include all platforms**
   - The initial response must include verified results from **Resy, OpenTable, and Yelp** when candidates exist for the search/location.
   - A slow OpenTable path cannot block Resy/Yelp, and Resy/Yelp cannot be skipped just because OpenTable is slow.

3. **Every returned result is actually available**
   - Every result must have concrete available time slots for the requested date/time/party size.
   - No URL-only results.
   - No guessed availability.
   - Slots must be extracted from real platform availability content/API responses and remain within the ±2 hour search window.

4. **Every returned result has complete visible metadata**
   Each initial result must include:
   - description
   - rating when available from discovery/provider data, with deterministic fallback handling if unavailable
   - distance
   - cuisine
   - neighborhood/location label
   - price range when available
   - vibe tags
   - actual available times

5. **Links deep-link directly to reservation pages**
   - Resy links must include date, party size, and time preselected.
   - OpenTable links must include date/time and party size preselected.
   - Yelp reservation links must include date, time, and party size preselected.
   - The link target must be the reservation/booking flow, not a generic restaurant page whenever the platform supports a reservation URL.

6. **Distance is based on the user’s shared zip code**
   - The app must capture/use the user’s shared zip/postcode as the search origin when provided.
   - Distance must be calculated from that zip-derived lat/lng, not from the broad city center and not from an AI guess.
   - If a zip is not provided but precise browser coordinates are available, use those.
   - If neither is available, show that distance is unavailable rather than fabricating it.

## Backend implementation plan

### 1. Replace the current long-running search budget
Current code still has a 120s global timeout, 45s discovery timeout, and enrichment skip logic that allows verification to consume the whole response budget.

I will change the initial search flow to a strict deadline model:

```text
0–3s      Parse query + resolve zip/location
0–8s      Discover candidates from all providers in parallel
4–21s     Verify provider lanes in parallel
18–24s    Metadata normalization/enrichment/fallbacks
≤25s      Return initial results
```

Implementation details:
- Set initial search hard deadline to ~25s.
- Every discovery, verification, scrape, browser/API call, and enrichment call receives the same deadline object.
- No operation starts if it cannot reasonably finish inside the remaining budget.
- Extended search can still exist, but the first response must satisfy the initial-result requirements.

### 2. Resy: direct availability API first, scraping only as fallback
Current Resy verification is too slow because it relies on page scraping.

I will implement direct Resy availability verification using Resy’s public web API pattern:
- Search/resolve venue availability by date, party size, location/query.
- Extract real available slot times/tokens from JSON.
- Build Resy deep links with `date`, `seats`, and `time` populated.
- Only use Firecrawl fallback if the API path fails and there is enough budget left.

Pass condition:
- Resy results in the initial response have real slots and complete deep links within the 25s response window.

### 3. OpenTable: bounded browser/API verification path
OpenTable cannot be allowed to consume 50–90 seconds.

I will implement a bounded OpenTable verification path:
- Use the existing Browserbase credentials for rendered availability extraction where direct/static extraction is blocked.
- Limit OpenTable initial verification to a small concurrent set so it has representation without blocking the response.
- Use a strict per-candidate browser timeout.
- Extract slot elements from rendered content only; do not return OpenTable results unless actual slot times are found.
- Build links with `dateTime=YYYY-MM-DDTHH:mm` and party size/covers populated.

Pass condition:
- If OpenTable has viable candidates, the initial response includes verified OpenTable results with slot times and preselected booking URLs within 25s.
- If OpenTable is unavailable or platform-blocked for a specific query, it fails closed rather than returning guessed results.

### 4. Yelp: preserve working verification, tighten booking links
Yelp is currently the least broken path, so I will keep the existing Firecrawl-based verification but make it deadline-aware.

I will ensure:
- Yelp reservation URLs include `date`, `time`, and `covers`.
- Yelp results are only returned when reservation evidence/time slots are confirmed.
- Yelp is not starved by OpenTable or Resy.

Pass condition:
- Initial response includes Yelp results with actual availability where Yelp candidates exist.

### 5. Mandatory metadata completion before response
Current code can skip AI enrichment, which is why descriptions disappear.

I will change the output normalization so every returned result receives metadata before being sent:
- Prefer provider/discovery metadata.
- Then AI enrichment if it fits the remaining budget.
- Then deterministic fallback values for description and vibe tags.

Important distinction:
- Fallback metadata is allowed.
- Fallback availability is not allowed.

The response will never include blank descriptions or empty vibe tags for returned verified results.

### 6. Zip-code-origin distance calculation
Current backend can parse a zip in the query, but the frontend does not explicitly capture/share a zip as the user’s origin, and distance can fall back to city/AI-derived coordinates.

I will add first-class zip origin support:
- Add zip/postcode input or zip sharing flow in the search UI.
- Send `zipCode`/`originZip` to the backend with the search request.
- Backend geocodes that zip once at the start of the request.
- Store the resulting origin lat/lng on `params`.
- Calculate every restaurant distance from that zip-origin lat/lng.
- Do not use AI coordinates as the distance origin.
- If restaurant coordinates cannot be confidently determined, do not fabricate distance.

Pass condition:
- Test query with a supplied zip returns distances computed from that zip origin.

## Frontend implementation plan

### 1. Capture the user’s shared zip code
Add a lightweight way for the user to provide/share a zip/postcode as the location origin.

The search request body will include:
```json
{
  "query": "Italian tonight for 2",
  "originZip": "30309",
  "lat": 33.749,
  "lng": -84.388,
  "location": "Atlanta, GA"
}
```

Backend priority for origin:
1. `originZip`
2. zip/postcode parsed from query
3. precise browser coordinates
4. city geocode fallback

### 2. Display complete results only
Restaurant cards already display description, rating, distance, and time slots if present. The backend will guarantee those fields exist for returned results, so the UI will not silently hide missing requirements.

I will also make missing distance explicit if it genuinely cannot be computed, instead of pretending the result is complete.

## Regression tests I will add/update

The current test suites do not fully enforce your requirements. I will update them before using them as the release gate.

### US regression suite
Add assertions that every initial result has:
- response time ≤25s target, with hard failure above the agreed cutoff
- non-empty `description`
- non-empty `vibeTags`
- `rating` present when provider data exposes it
- `distanceMiles` present when zip/browser origin is provided
- at least one `timeSlot`
- valid time slot format
- slot within ±2 hours
- valid reservation URL params
- no duplicate restaurants
- all three platforms represented when available for that market/query

### UK regression suite
Add equivalent assertions for UK postcode/location behavior:
- UK country detection
- UK/postcode origin distance
- OpenTable UK domain behavior where applicable
- valid time slots and booking params
- ≤25s initial response target

### Link verification suite
Strengthen link checks to require:
- Resy: date + seats + time
- OpenTable: dateTime + covers/party size
- Yelp: date + time + covers
- sample re-verification confirms returned slot times are visible from the booking/reservation page/API response

### New zip-origin tests
Add representative cases:
- `Dinner tonight for 2` with `originZip: 30309`
- `Italian tonight for 2` with `originZip: 10003`
- `Sushi Friday 7pm for 2` with `originZip: 60614`
- UK postcode case with `originZip`/postcode

These tests will check that returned `distanceMiles` is calculated from the provided zip/postcode origin.

## Manual/live regression I will run before reporting done

After implementation, I will run live backend tests myself. I will not ask you to spend credits validating this.

Representative live queries:
- `Dinner tonight for 2` with zip `30309`
- `Italian tonight for 2` with zip `30309`
- `Sushi tonight for 2` with zip `10003`
- `Steakhouse Friday 8pm for 4` with zip `60614`
- `Brunch Saturday 10:30am for 4` with zip `30309`
- `Italian tonight for 2` with London postcode

For each live run I will capture:
- total response time
- result count
- platform counts: Resy / OpenTable / Yelp
- count with descriptions
- count with ratings
- count with distances
- count with time slots
- URL param pass rate
- whether logs show enrichment skipped or any provider lane exceeding its budget

## Release gate

I will not report this as fixed unless the regression output shows:

```text
Initial response time: <=25s target for representative searches
Availability:         100% returned results have actual slots
Descriptions:         100% returned results have non-empty descriptions
Distance:             100% returned results have zip-origin distance when zip is supplied
Deep links:           100% returned URLs include date/time/party size criteria
Platform coverage:    Resy + OpenTable + Yelp represented when candidates exist
Logs:                 no enrichment-skip path in successful initial searches
```

If any item fails, I keep iterating and rerun the suite. I will only come back with a release summary after the tests pass, including the actual timing and pass/fail table.