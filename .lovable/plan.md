# Comprehensive Verification Test

Run all three existing Deno test suites against the deployed `search` edge function and analyze the results against TableFinder's core spec.

## What will be tested

The project already has three comprehensive test suites in `supabase/functions/search/`:

1. **`index.test.ts`** — US queries across cities/cuisines/meal types (Resy, OpenTable, Yelp mix)
2. **`uk.test.ts`** — UK queries (London/Manchester) validating `gb` country, `opentable.co.uk`, Yelp `en_GB`
3. **`link-verify.test.ts`** — For each result, validates:
   - **URL parameter correctness** — date, party size, time present in proper platform format (Resy `date`/`seats`/`time`, OpenTable `dateTime`/`covers`, Yelp `date`/`covers`/`time`)
   - **Reachability** — HTTP fetch of each booking URL
   - **Slot accuracy** — re-scrapes URL via Firecrawl and confirms ≥50% of returned time slots actually appear on the live page

## Spec compliance checks

Against the project rules in memory + custom instructions, the analysis will report:

| Spec rule | How verified |
|---|---|
| Every result must have verified availability | link-verify slot accuracy + index.test slot assertions |
| Verification = scraping actual booking URL | link-verify rescrape pass |
| Never return based on URL pattern alone | Slot-match ratio per result |
| Deep links pre-populate date/time/party | URL parameter validator |
| Meal-type → typical hours | uk.test + index.test brunch/breakfast cases |
| US & UK only | uk.test (gb) + index.test (us) |
| Distance returned for results | Inspect distanceMiles in responses |
| Yelp/Resy/OpenTable all represented | Platform mix per query in reports |
| Performance under 120s global cap | Per-query elapsed time |

## Execution steps

1. Run `index.test.ts` (US suite) via `supabase--test_edge_functions` with timeout 300s
2. Run `uk.test.ts` (UK suite) with timeout 300s
3. Run `link-verify.test.ts` (link/slot integrity) with timeout 300s
4. Pull recent edge function logs to confirm no 120s timeouts and that distance enrichment ran
5. Produce a consolidated pass/fail report broken down by spec rule, with any failing restaurants/queries called out and a recommendation list for follow-ups

## Deliverable

A single summary in chat with:
- Pass/fail counts per suite
- Per-spec-rule compliance table
- Any specific restaurants that failed slot verification or URL param checks
- Performance observations (slowest query, average wave time)
- Recommended next fixes (if any)

No code changes will be made by this task — it is read-only verification.