

## Fix: Firecrawl 400 Error Dropping All Resy/OpenTable Results

**Root cause**: Lines 1488-1493 pass `{ type: "json", prompt: "..." }` inside the `formats` array. Firecrawl's REST API only accepts string values (`"markdown"`, `"extract"`, etc.). This causes a 400 BAD_REQUEST for every Resy/OT scrape, silently dropping all results.

**File**: `supabase/functions/search/index.ts`

**Change 1** (lines 1486-1499): Replace the invalid format object with the correct API syntax:
```typescript
const scrapeFormats: string[] = isYelp ? ["markdown"] : ["markdown", "extract"];

const scrapePayload: Record<string, unknown> = {
  url: r.platformUrl,
  formats: scrapeFormats,
  onlyMainContent: true,
};

if (!isYelp) {
  scrapePayload.extract = {
    prompt: "Extract the restaurant's full street address including street number, street name, city, state, and zip code. Return as { \"address\": \"full street address\" } or { \"address\": null } if not found.",
  };
}
```

**Change 2** (line 1529): Update the data path to read from `extract` instead of `json`:
```typescript
const jsonData = data?.data?.extract || data?.extract;
```

That's it. Two surgical changes. Everything downstream (geocoding, distance calculation, neighborhood assignment) already works — it was just never receiving data because the scrapes were failing.

