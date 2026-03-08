

## Analysis

Your Google screenshot shows Forza Storico as result #3 for `site:opentable.com/r Atlanta GA best rated italian restaurant` — the exact query we send to Firecrawl. This confirms the problem: **Firecrawl's search engine returns different results than Google**. Firecrawl is not a Google proxy; it uses its own index.

No amount of query tuning will guarantee Firecrawl mirrors Google's ranking. The results will always diverge.

## Options

### Option A: Add candidate URL logging (diagnostic, no fix)
Log all discovered URLs before selection so we can confirm whether Firecrawl ever returns Forza Storico. Zero cost, but doesn't fix anything — just gives us data.

### Option B: Use Google Custom Search API for discovery instead of Firecrawl search
Replace the Firecrawl `search` endpoint with Google's actual Custom Search JSON API for the discovery phase. This would give us the exact same results as the screenshot. Firecrawl would still be used for verification/scraping (which it's good at).

- Cost: Google Custom Search is free for 100 queries/day, then $5/1000 queries
- Requires a Google API key + Custom Search Engine ID
- Would give deterministic, Google-matching results

### Option C: Add Forza Storico's URL pattern as a "known restaurant" fallback
Not scalable, but would guarantee this specific restaurant appears.

## Recommendation

**Option A first** (add logging), then run one search to confirm whether Firecrawl is finding-but-cutting or never-finding Forza Storico. That data will tell us whether we need Option B or just need to increase the selection cap.

### Changes
- `supabase/functions/search/index.ts` — add `console.log` of all discovered candidate URLs per platform before selection

