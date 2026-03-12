

## Does Amenity Search Work Across All Platforms?

**Short answer: Yes, the amenity pipeline is platform-agnostic.** The same amenity logic applies uniformly to Resy, OpenTable, and Yelp. Here's how it flows:

### How It Works Today (All Platforms)

1. **Discovery** -- All 3 platform adapters receive `amenityTerms` and include them in their Firecrawl search queries (e.g., `site:resy.com rooftop restaurant`, `site:opentable.com/r rooftop restaurant`, `site:yelp.com/biz rooftop restaurant`). Yelp API also appends amenity terms to the `term` parameter.

2. **Verification gate** -- `checkRelevanceInMarkdown()` runs on scraped markdown from ALL platforms equally (line 1853). Any restaurant whose page doesn't mention the amenity synonym gets rejected, regardless of platform.

3. **AI enrichment** -- `enrichWithAI()` asks Gemini for amenities for ALL verified restaurants (Resy, OT, Yelp alike), merging them into `vibeTags`.

### Known Issues (From Previous Tests)

The problems identified earlier are **not platform-specific** -- they affect all platforms equally:

| Issue | Affects | Status |
|-------|---------|--------|
| "Rooftop bar" misparsed (cuisine="bar", dish="rooftop") | All platforms | Not yet fixed |
| Non-amenity results leaking through markdown check | All platforms | Not yet fixed |
| Firecrawl scrape timeouts (408) reducing yield | Resy + OpenTable mostly | Not yet fixed |
| AI enrichment adds amenity tags post-verification (too late to help filtering) | All platforms | By design |

### The Core Architectural Gap

The amenity filtering happens in **two places that don't reinforce each other**:

1. **Pre-enrichment** (line 1853): `checkRelevanceInMarkdown()` rejects restaurants whose scraped page doesn't mention the amenity keyword. This is the gatekeeper, but many restaurant pages (especially Resy) don't mention "rooftop" or "patio" in their text even when they have one.

2. **Post-enrichment** (line 1511): AI-returned amenities get merged into `vibeTags` but are **never used for filtering** -- only for display. By this point, non-amenity restaurants have already passed through.

### Recommended Fix (Approved But Not Yet Implemented)

The three fixes from the previously approved plan would address this across all platforms:
1. **Post-parse amenity correction** -- Fix "rooftop bar" → treat "rooftop" as the primary search term
2. **Stricter rooftop markdown matching** -- Only match rooftop-specific synonyms, not generic outdoor terms
3. **Scrape timeout retry** -- Retry once on 408 to recover more candidates

No platform-specific changes are needed -- the fixes apply to the shared verification pipeline.

