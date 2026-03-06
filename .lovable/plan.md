

## Problem Analysis

Looking at the screenshot, the pattern is clear:

- **Yelp results**: ALL have distances (17.6 mi, 15.9 mi, 36.0 mi, etc.) — because the Yelp Fusion API returns real `distance` in meters
- **Resy/OT results**: NONE have distances — because we're relying on Gemini to "guess" lat/lng coordinates, and the 0.3-mile rejection guard is filtering most of them out (rightfully — AI coordinates are unreliable)
- **Neighborhoods are wrong**: Some results say "Decatur" when they're actually in Buckhead, Smyrna, etc. — because the AI defaults to the search city

The core issue: **AI cannot reliably provide geographic coordinates.** The previous Nominatim approach was correct in principle but failed due to rate-limiting. The 0.3-mile guard was a band-aid that just made distances disappear entirely.

## Proposed Fix: Extract Addresses During Verification Scrape

We're **already scraping every restaurant's page** during the verification step. The scraped markdown almost always contains the restaurant's street address. The fix:

1. **During verification** (zero extra latency — we already have the page content): Extract the restaurant's street address from the scraped markdown using a regex pattern (e.g., "123 Main St, Atlanta, GA 30309")
2. **Store extracted addresses** on the restaurant object as a new transient field (`_address`)
3. **After verification, before AI enrichment**: Batch-geocode only the Resy/OT results that have extracted addresses using Nominatim — but with a **smarter approach**:
   - Use `street` search mode with structured query params (more reliable than free-text)
   - Fire all requests in parallel (not sequential) with a 300ms stagger
   - This is ~5-8 restaurants max (only non-Yelp verified results), so 2-3 seconds total
4. **Remove lat/lng from the AI enrichment prompt** entirely — stop asking Gemini for coordinates since it's unreliable
5. **Fix neighborhoods**: Use the address city/area extracted from the page content as the neighborhood, falling back to the AI-provided neighborhood only when no address is found

## Technical Changes

**File: `supabase/functions/search/index.ts`**

### 1. Add address extraction helper
A regex function that finds US street addresses in markdown (e.g., "1065 Huff Rd NW, Atlanta, GA 30318"). Common patterns from Resy/OT pages.

### 2. Extract address during verification scrape
Inside `verifyAvailability`, after scraping the page, extract the address and attach it to the restaurant object. Zero extra latency.

### 3. Batch geocode after verification
New function `geocodeVerifiedResults()` that takes verified Resy/OT restaurants with extracted addresses and geocodes them via Nominatim in parallel with 300ms stagger. Only ~5-8 calls needed.

### 4. Remove coordinates from AI enrichment
Remove `lat`, `lng` from the Gemini prompt and the distance calculation in `enrichWithAI`. Distance is now calculated from Nominatim geocoded coords or Yelp API coords.

### 5. Fix neighborhood assignment
Use the city/area from the extracted address as the neighborhood for Resy/OT results, rather than trusting the AI which tends to echo back the search city.

## Expected Impact
- **Distances**: Should appear for most Resy/OT results (any that have a street address on their page)
- **Neighborhoods**: Will be accurate — derived from actual address data on the page
- **Latency**: Adds ~2-3 seconds for geocoding (parallel with stagger), but removes the unreliable AI coordinate step
- **No more hallucinated coordinates**: Nominatim geocodes real addresses, not AI guesses

