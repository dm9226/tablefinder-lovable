

## Root Cause: `onlyMainContent: true` is stripping address sections from Resy pages

Line 1460: `onlyMainContent: !isOT` means:
- **OpenTable**: `onlyMainContent: false` — gets full page including address in metadata/footer
- **Resy**: `onlyMainContent: true` — Firecrawl strips "non-main" content, which inconsistently removes the address block (typically in a sidebar or header area)

This explains why some Resy results get addresses and others don't — Firecrawl's "main content" classifier is inconsistent about whether the address/location section is "main content" or peripheral chrome. On the same template, different content lengths or layouts can cause the classifier to make different decisions.

For OpenTable, the address extraction works via OG metadata (`og:street-address`, `og:locality`, `og:region`) which is returned in Firecrawl's metadata object regardless of `onlyMainContent`. But for Resy pages that lack these OG tags, the system falls back to regex on the markdown body — which is the part being inconsistently truncated.

## Fix (single line change)

Set `onlyMainContent: false` for **both** Resy and OpenTable. Yelp doesn't go through this scrape path for addresses (it gets distance from the API), so it's unaffected.

```typescript
// Line 1460: change from
onlyMainContent: !isOT,
// to
onlyMainContent: isYelp,  // false for Resy + OT to capture address sections
```

This ensures the full page markdown is returned for both Resy and OT, giving the regex a consistent body to extract addresses from. The only tradeoff is slightly more markdown to parse for Resy, but the time extraction regex already targets specific sections (`## dinner` etc.) so noise won't affect slot parsing.

