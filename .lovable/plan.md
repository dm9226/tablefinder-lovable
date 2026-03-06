

## Two Issues to Fix

### Issue 1: Elektra still passes — `dishKeyword: "steak"` triggers loose matching

**Root cause confirmed from logs**: `cuisineType: "steakhouse", dishKeyword: "steak"`. The prompt example at line 397 explicitly tells the AI: `"steak dinner" → cuisineType: "steakhouse", dishKeyword: "steak"`. For a "steakhouse near Decatur" query, the AI follows this pattern and sets both fields. Since `dishKeyword` is truthy, line 1606 takes the loose path — any single mention of "steak" anywhere passes Elektra.

**Fix**: After parsing (line 457), add post-parse cleanup that clears `dishKeyword` when the user explicitly used a category term in their query. Also update the prompt example to not set dishKeyword for "steakhouse" searches.

```typescript
// After line 457, add:
const CATEGORY_ROOTS: Record<string, string> = {
  steakhouse: "steak", chophouse: "steak", pizzeria: "pizza",
  "sushi bar": "sushi", "sushi restaurant": "sushi",
};
if (parsed.cuisineType && parsed.dishKeyword) {
  const root = CATEGORY_ROOTS[parsed.cuisineType];
  if (root && parsed.dishKeyword === root && query.toLowerCase().includes(parsed.cuisineType)) {
    console.log(`Clearing dishKeyword "${parsed.dishKeyword}" — user said "${parsed.cuisineType}" (category search)`);
    parsed.dishKeyword = "";
  }
}
```

Also update prompt example at line 397:
- Change `"steak dinner" → cuisineType: "steakhouse", dishKeyword: "steak"` to `"steakhouse near Decatur" → cuisineType: "steakhouse", dishKeyword: ""`
- Add `"steak dinner" → cuisineType: "steakhouse", dishKeyword: "steak"` as a separate dish-search example

### Issue 2: KR SteakBar and 101 Steak Restaurant have no distance → sorted last

**Root cause from logs**: Both got "Geocode miss" — Nominatim couldn't resolve their addresses:
- `KR SteakBar: 349 Peachtree Hills Avenue Suite D2, Atlanta, GA 30305`
- `101 Steak Restaurant: 3621 Vinings Slope SE, Atlanta, GA 30339`

Nominatim often fails on addresses with suite numbers or unusual street suffixes. The sort at line 1390 uses `distanceMiles ?? 9999` for null distances, pushing them to the bottom.

**Fix**: Add a geocoding retry that strips suite/unit numbers and retries with a simplified address when the first attempt returns no results.

In the geocode function (around line 1291-1295), when a geocode miss occurs:

```typescript
} else {
  // Try stripping suite/unit numbers and retry
  const simplified = addr.replace(/\b(suite|ste|unit|apt|#)\s*\S+,?\s*/gi, "").replace(/\s+/g, " ").trim();
  if (simplified !== addr) {
    const retryResp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(simplified)}&format=json&limit=1&addressdetails=1`,
      { headers: { "User-Agent": "TableFinder/1.0" } }
    );
    if (retryResp.ok) {
      const retryData = await retryResp.json();
      if (retryData?.[0]) {
        // ... same distance calculation + neighborhood extraction
        console.log(`  Geocoded (simplified) ${r.name}: ${r.distanceMiles} mi`);
        resolve(); return;
      }
    }
  }
  // Still failed
  if (r._addressCity) r.neighborhood = r._addressCity;
  console.log(`  Geocode miss for ${r.name}: ${addr}`);
}
```

### Summary of changes

**Single file**: `supabase/functions/search/index.ts`

1. **Line 397**: Update prompt example — "steakhouse" should NOT set dishKeyword
2. **After line 457**: Post-parse cleanup clears dishKeyword when user explicitly used category term
3. **Lines 1291-1295**: Add simplified-address retry on geocode miss (strip suite/unit numbers)

