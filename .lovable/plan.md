I checked the current deployed search logs and the current `search` function. The problem is not just “OT is slow” — the pipeline is doing a lot of work, and the current OpenTable path is failing before it ever proves availability.

## What is happening right now

### 1. The latest live run still took about 70s
The direct backend test I triggered timed out from the caller side, but the function continued and eventually logged a response. The important timestamps in the backend logs:

- Verification finished around `15:09:08`
- Final response was not emitted until `15:09:30`
- That means roughly 22s were spent after verification on geocoding / AI enrichment before the user saw the result

So the previous changes shortened some OT scrape waits, but they did not fix the total request path.

### 2. OpenTable selected only 3 candidates, and returned zero
The run selected only 3 OT candidates because the code now hard-caps OT verification at 3:

```ts
hardCaps: { resy: maxCandidates, opentable: 3, yelp: 10 }
```

The logs show:

```text
Forza Storico Restaurant [opentable] — failed cuisine relevance
Florence Tavern [opentable] — failed cuisine relevance
Capolinea Restaurant [opentable] — 6s scrape timeout
```

So the OT slot parser did not actually get a fair shot:

- 2 OT candidates were rejected by the cuisine relevance gate before availability parsing.
- 1 OT candidate timed out at the 6s hard cap.
- Result: 0 OT verified restaurants.

### 3. The OT scrape content looks incomplete
The same two OT candidates also had address misses:

```text
[ADDR_MISS] No address pattern found for Florence Tavern [opentable]
[ADDR_MISS] No address pattern found for Forza Storico Restaurant [opentable]
```

That strongly suggests Firecrawl is not returning the full useful OpenTable page content for those restaurant pages. If the scrape lacks address/cuisine/widget text, the app cannot verify slots. That is why OT suddenly looks “dead” even when discovery finds OT URLs.

### 4. There is also a code mismatch: HTML parser exists, but OT does not fetch HTML
The function contains an OT HTML slot parser, but the current OT scrape payload fetches only markdown:

```ts
formats: ["markdown"]
```

So the HTML parser is effectively dead code for OT. If OpenTable’s slot widget is now only visible in processed HTML or not in markdown, the current verifier will never see it.

### 5. The 70s runtime is not mostly the 6s OT timeout anymore
The old “OT retry waterfall” was reduced, but the total path still blocks on:

- Firecrawl discovery across Resy / OT / Yelp
- Verification of up to 26 restaurants
- Yelp scrapes with 25s caps
- Nominatim geocoding for every verified restaurant
- AI enrichment for every verified restaurant

The last run had 15 verified restaurants, then spent another ~22s on distance/enrichment before returning. That is why the user-facing runtime stayed bad.

## Fix plan

### 1. Add hard stage timers first
Add concise timing logs for:

- query parse
- ZIP reverse-geocode
- discovery per provider
- candidate selection
- verification per provider
- geocoding
- AI enrichment
- final response

This makes every future “it took 70s” report attributable instead of guessing from sparse logs.

### 2. Fix OT verification order
For OpenTable only:

- Parse and verify real slots before applying cuisine relevance.
- Only apply cuisine relevance after slot evidence exists.
- Relax OT cuisine rejection when the restaurant name or discovered snippet is a strong match, because OT page scrapes are currently too thin to use as the sole cuisine source.

This prevents valid OT pages like Forza Storico from being thrown away before the availability parser runs.

### 3. Make OT scrape payload match the parser
Change OT verification to request both markdown and HTML in a single fast scrape:

```ts
formats: ["markdown", "html"]
onlyMainContent: false
```

Then use the existing OT HTML parser when markdown lacks `Select a time`.

Keep the rule intact: no OT result is returned unless real slot markers are found in scraped booking-page content.

### 4. Replace the current “OT hard cap = 3” with a time-budget cap
Instead of always verifying only 3 OT candidates:

- Give OT a small fixed time budget, e.g. 8–10s total.
- Verify 4–6 OT candidates concurrently within that budget.
- Stop OT when the budget expires.

This gives OT enough coverage to return results without letting it dominate the request.

### 5. Stop blocking the first response on slow enrichment
To cut the 70s runtime roughly in half:

- Return verified results once availability is done and basic fields are ready.
- Skip AI enrichment if the request is already past the first-response target.
- Skip or cap geocoding after a short budget, preserving results even if distances are incomplete.

The current code waits on geocoding + AI enrichment even after availability is already verified. That is not acceptable for the first response.

### 6. Tighten non-OT provider budgets too
Since the full request is slow even after OT is capped:

- Reduce Yelp verification timeout from 25s to a smaller per-candidate budget.
- Limit initial verification to enough candidates for a fast first page.
- Keep remaining candidates behind manual “search more”, not automatic background work.

### 7. Validate with live backend tests
After implementation, run direct backend tests for:

1. `Italian dinner in Atlanta tonight for 2`
2. `steak dinner in Atlanta tonight for 2`
3. a broad Atlanta dinner query
4. a Resy-heavy query
5. a Yelp-heavy query

Acceptance criteria:

- First response under ~35s, ideally closer to 25–30s.
- OT returns when real OT slot markers are extracted.
- No fabricated OT times.
- No OT retry waterfall.
- Resy/Yelp still return verified availability.
- Logs clearly show where time is spent.