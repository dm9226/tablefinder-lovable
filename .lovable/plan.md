

## Option C: Increase Cap to 30 + Relevance-Based Candidate Ranking

### Changes

**1. Add `scoreCandidateRelevance()` function** (~20 lines)
- Scores each candidate 0-3 based on how well it matches the search query
- +1 if restaurant name contains a cuisine keyword (e.g., "italian" in "Forza Storico" won't match, but "Italian Kitchen" would)
- +1 if the platform URL contains a cuisine keyword
- +1 if the candidate's `cuisine` field matches the search cuisine
- Candidates with higher scores sort first within each platform bucket

**2. Modify `selectCandidatesForVerification()`** (lines 1397-1429)
- Accept `params: SearchParams` as a third argument
- Before round-robin selection, sort each platform bucket by `scoreCandidateRelevance()` descending
- This ensures the most relevant candidates are picked first when the cap cuts off

**3. Update cap from 24 to 30** (line 184)
- Change `selectCandidatesForVerification(allCandidates, 24)` → `selectCandidatesForVerification(allCandidates, 30, params)`
- Adds ~2-3 seconds latency, ~25% more Firecrawl cost per search

### What this fixes
Forza Storico (and similar restaurants) that appear lower in Firecrawl search results will now be included in verification because: (a) there are 6 more verification slots, and (b) relevance sorting pushes cuisine-matching candidates higher in each bucket before the cap is applied.

