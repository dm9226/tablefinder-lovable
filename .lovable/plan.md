

## Findings

**Firecrawl search cannot rank by rating.** It's a Google-powered web search — results are ranked by web search relevance. The only sort option is `sbd:1` (sort by date). There's no rating, popularity, or review-count parameter.

However, we can **influence Google's ranking** by modifying our search queries to include terms like "top rated" or "best" — Google naturally surfaces higher-rated restaurants for those queries.

## Plan

### 1. Revert Option C changes

- **Line 184**: Change cap from `30` back to `24`, remove `params` argument
- **Lines 1397-1409**: Delete `scoreCandidateRelevance()` function
- **Lines 1411-1444**: Revert `selectCandidatesForVerification()` to original 2-argument signature with unsorted buckets

### 2. Improve discovery queries to favor top-rated results

Instead of adding more Firecrawl calls (which costs money), modify the **existing** query strings to include "top rated" or "best rated" phrasing. For example:

- Current: `site:opentable.com/r Atlanta GA italian restaurant reserve`
- Changed: `site:opentable.com/r Atlanta GA best rated italian restaurant`

This nudges Google to surface higher-rated restaurants in its results, which means our existing 24-slot cap naturally captures better candidates — no extra API calls, no extra cost, no extra latency.

### Cost impact
- **Reverts** the 6 extra Firecrawl scrapes from Option C (saves ~$0.006/search and ~2-3s latency)
- **Zero additional cost** from query phrasing changes (same number of API calls)

### Files changed
- `supabase/functions/search/index.ts` — revert Option C + update query strings

