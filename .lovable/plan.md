

## Review-Based Relevance: Zero Extra Latency

Good news: **we already have the review data** — it's in the scraped markdown from each restaurant's page during verification. Yelp pages include review snippets, and those are captured in the markdown we're already fetching. No additional API calls or scrape time needed.

The real problem is that "brunch" (and terms like "breakfast") are currently **stripped before we ever check the text**. The `MEAL_TERMS` set on lines 1503 and 2066 removes these words from the token list, so the relevance check never looks for them — even though they're sitting right there in the reviews.

### What changes

**File: `supabase/functions/search/index.ts`**

1. **Create a `MEAL_AS_CUISINE` set** for terms like "brunch" and "breakfast" that represent genuine search intent (not just time hints like "dinner" or "lunch")

2. **Preserve these tokens in three places:**
   - **Yelp API query** (~line 1504): Keep "brunch" in the search term so Yelp returns brunch-relevant restaurants instead of generic ones
   - **Yelp category filter** (~line 1505): Keep "brunch" in `cuisineTokens` so candidates are filtered by brunch-related categories (e.g., `breakfast_brunch`)
   - **Verification relevance check** (~line 2067): Keep "brunch" in `verifyTokens` so the scraped page text (including review snippets) is checked for mentions of "brunch"

3. **Use loose matching for meal-as-cuisine terms**: Since reviews may mention "brunch" only once or twice, use the dish-style loose matching (any mention passes) rather than the strict 3+ frequency threshold used for cuisine categories

### Performance impact
Zero. We're already scraping these pages and analyzing the text. This just stops throwing away a search token before checking it.

### What this covers beyond brunch
The same pattern works for "breakfast", and can be extended to any meal-type term that users genuinely search for as a category. "Dinner" and "lunch" stay stripped since they're time hints, not cuisine categories.

