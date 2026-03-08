

## Problem: Rating and Distance Data Aren't Available at Selection Time

At the point where `selectCandidatesForVerification` runs (before verification), candidates from **Resy and OpenTable** have **no rating and no distance** — those fields are populated later:

- **Distance** is calculated after verification via geocoding extracted addresses
- **Rating** comes from AI enrichment, which also runs after verification

Only **Yelp** candidates have `distanceMiles` pre-populated (from the Yelp API), and none of the platforms have ratings before verification.

This means we **cannot weight by rating or distance** in the selection phase because the data doesn't exist yet.

## What We Can Do Instead

### Option A: Proportional allocation (no new data needed)
Give platforms more slots proportional to how many candidates they found. This would have given OpenTable 11 slots instead of 9, capturing Forza Storico. Zero cost, simple change.

### Option B: Increase the cap from 24 to 30
More brute force — verify 6 more candidates per search. Costs ~$0.006 more per search and adds ~2-3s latency, but captures deeper into each platform's bucket.

### Option C: Move geocoding before selection (adds latency)
Geocode all ~50 discovered candidates before selecting 24 for verification. This would give us distance data to sort by, but adds 50+ Nominatim API calls and ~5-10s of latency before verification even starts. Not recommended.

## Recommendation

**Option A (proportional allocation)** is the best tradeoff — it's free, fast, and would have captured Forza Storico in the last search. Rating-based sorting simply isn't possible without a fundamentally different discovery approach (like Google Custom Search API, which was discussed earlier).

### Changes
- `supabase/functions/search/index.ts` — update `selectCandidatesForVerification` to allocate slots proportionally per platform instead of equal round-robin

