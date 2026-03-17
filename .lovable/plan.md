

## Running Comprehensive Regression Tests

### Problem
The existing test suite (50 queries across 5 batches) times out when run through the edge function test runner — each batch of 10 queries takes 3-5 minutes due to real-time Firecrawl scraping, exceeding the 300s timeout.

### Plan

**1. Split US regression tests into smaller batches**
- Break the 5 existing test groups (10 queries each) into 10 groups of 5 queries each, so each test completes within the timeout
- Update `supabase/functions/search/index.test.ts` to use smaller groups

**2. Create UK test suite**
- Add a new file `supabase/functions/search/uk.test.ts` with ~10 UK-specific queries covering:
  - London restaurants (Italian, sushi, steakhouse)
  - Manchester, Edinburgh, Birmingham searches
  - UK postcodes (e.g., "dinner near SW1A 1AA")
  - UK-specific terms (e.g., "gastropub", "curry house")
- Same validation criteria as the US suite (response structure, query parsing, time slots, cuisine relevance, etc.)
- Additional UK-specific validations: `country` param = `"gb"`, OpenTable URLs use `opentable.co.uk`

**3. Run all tests sequentially**
- Run each US batch individually (10 runs × ~2min each)
- Run each UK batch individually (2-3 runs × ~2min each)
- Report consolidated pass/fail results

### Files
- **Modified**: `supabase/functions/search/index.test.ts` — smaller batch sizes
- **New**: `supabase/functions/search/uk.test.ts` — UK-specific test suite

