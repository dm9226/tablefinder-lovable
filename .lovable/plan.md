

## You're Right — The Approach is Wrong

Your two points expose the real issue:

1. **C&S Seafood is in Atlanta, not Colorado.** The regex matched menu text ("1 lb. Lobster, Tuna Tartar") and "CO" looked like a state abbreviation. That's a regex bug, but it reveals the deeper problem — regex is the wrong tool for this.

2. **Of course Resy and OpenTable have addresses.** Every restaurant booking page displays the physical address so diners know where to go. The problem isn't that the data doesn't exist — it's that our brittle regex fails to find it in the messy markdown.

## Better Approach: Use Firecrawl's JSON Extraction

We're already scraping every page with Firecrawl during verification. Firecrawl has a built-in **JSON extraction** format that uses AI to pull structured data from a page. Instead of fragile regex, we add a JSON extraction format to the existing scrape call — **zero extra API calls, same scrape request**.

### Change in `verifyAvailability`

For Resy and OpenTable scrapes only, change the formats from:
```
formats: ["markdown"]
```
to:
```
formats: ["markdown", { type: "json", prompt: "Extract the restaurant's full street address including city, state, and zip code. Return as { \"address\": \"full street address\" } or { \"address\": null } if not found." }]
```

This piggybacks on the existing scrape — Firecrawl returns the address as structured data alongside the markdown, with no extra request.

### What Changes

**File: `supabase/functions/search/index.ts`**

1. **Update scrape payload** for Resy/OT: add JSON extraction format for address
2. **Read the extracted address** from `data.data?.json?.address` or `data.json?.address` after scrape
3. **Remove `extractAddressFromMarkdown`** entirely — no more regex
4. **Keep everything else the same**: Nominatim geocoding of extracted addresses, distance calculation, neighborhood derivation

### Expected Result
- Firecrawl's AI reads the page and returns the actual restaurant address reliably (no regex false positives like "1 lb. Lobster")
- C&S Seafood returns its real Atlanta address
- Louisiana Bistreaux, Ray's in the City — all get addresses
- No extra latency (same scrape call), no extra cost (JSON extraction is part of the scrape)

