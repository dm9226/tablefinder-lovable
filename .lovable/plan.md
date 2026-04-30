
## Problem

Steel.dev is returning empty content (`mdLen=0`) for every OpenTable restaurant and hitting 429 rate limits ("Session limit reached for your hobby plan"). OT is completely broken — zero results from every search.

OpenTable previously worked with Firecrawl when it had adequate timeouts and `waitFor` for the JS booking widget to render.

## Plan

### Step 1: Revert OT from Steel back to Firecrawl

Replace the Steel scraping block for OpenTable (lines ~2631-2670) with a Firecrawl scrape identical to how Resy works, but with OT-specific settings:

- `waitFor: 8000` (OT's booking widget needs time to render)
- `formats: ["markdown", "html"]` (keep both for the HTML slot parser fallback)
- `onlyMainContent: false`
- 20s timeout (OT pages are heavier than Resy)
- Single retry on timeout with 15s fallback

### Step 2: Remove Steel dependency

Remove all Steel-related code and the `STEEL_API_KEY` check that currently gates OT scraping. OT will use the same Firecrawl concurrency slot system as Resy.

### Step 3: Validate

Deploy and test with a live search to confirm OT results return with verified time slots.

## Technical Details

The change is confined to `supabase/functions/search/index.ts`, replacing ~40 lines of Steel code with ~30 lines of Firecrawl code matching the existing Resy pattern but with `waitFor: 8000` and a 20s timeout.
