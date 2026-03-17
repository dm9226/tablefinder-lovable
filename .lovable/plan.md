
Root cause: the search you ran was a US search, and Yelp discovery actually worked. The logs show:

```text
Yelp candidates: 11
Yelp after cuisine filter: 6/11
[DISCOVERY] yelp (6): EATaliano Kitchen | Il Porto Di Venezia | Mangiamo Ristorante & Pizzería | Dominick's | D’Italia Pizzeria Napoletana | Chef Paco's
Verifying (capped): ... yelp=4
```

So the problem is not the UK Yelp fix. The four Yelp candidates that were verified were then rejected by the verification gate:

```text
✗ Dominick's [yelp] — failed cuisine relevance (category) for: italian
✗ Il Porto Di Venezia [yelp] — failed cuisine relevance (category) for: italian
✗ Mangiamo Ristorante & Pizzería [yelp] — failed cuisine relevance (category) for: italian
✗ EATaliano Kitchen [yelp] — found 1 slots but none in dinner window (found: 11:00 AM)
```

Why this is happening:
1. Discovery trusts Yelp API category data and correctly finds Italian candidates.
2. Verification then re-checks cuisine using Firecrawl markdown only.
3. Yelp reservation pages often do not expose cuisine/category text strongly enough in markdown.
4. The current cuisine verification for category searches is strict:
   - token in restaurant name, or
   - token in first 500 chars, or
   - token appears 3+ times in full text.
5. That rule works for Resy/OpenTable pages, but is too strict for Yelp because Yelp’s structured category data was already good enough upstream.

Plan to fix:
1. Preserve Yelp category metadata on each Yelp candidate
   - Add transient Yelp fields on the search function’s `Restaurant` type for category titles/aliases from the Yelp API.
   - Populate them in `fetchYelpCandidates()`.

2. Make Yelp verification use Yelp API metadata as a first-class relevance signal
   - In the unified verification gate, for `platform === "yelp"`, check the stored Yelp categories/name before relying on scraped markdown.
   - If the Yelp API already matched `italian`, accept relevance even when markdown is sparse.
   - Keep the existing markdown-based relevance logic for Resy/OpenTable.

3. Keep real availability validation intact
   - Do not bypass time-slot checks.
   - Yelp results should still need an actual reservation page and an in-window slot.
   - This means EATaliano Kitchen would still be excluded for your dinner search because only 11:00 AM was found.

4. Add a Yelp-specific fallback so one weak verified candidate does not wipe out the platform
   - If all selected Yelp candidates fail only on relevance, prefer trying remaining discovered Yelp candidates before returning zero Yelp results.
   - This reduces false negatives caused by proportional candidate capping.

5. Extend regression coverage
   - Add/adjust tests for US Yelp cuisine searches like Italian/seafood so discovery success plus sparse Yelp markdown does not cause zero-result regressions.
   - Include one end-to-end case where Yelp candidates are discovered via API categories and must survive verification.

Files to update:
- `supabase/functions/search/index.ts`
- possibly `supabase/functions/search/index.test.ts`

Expected outcome:
- Your “italian next tuesday night” search should start returning Yelp restaurants when Yelp API categories clearly indicate Italian and valid dinner slots exist.
- Yelp will still correctly exclude restaurants with only brunch/lunch availability.
