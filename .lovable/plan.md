

## The Problem

Right now the system treats everything in the `cuisine` field the same — whether it's a **cuisine type** ("seafood", "Italian", "Thai") or a **specific dish** ("oysters", "lobster roll", "birria tacos"). These are fundamentally different:

- **Cuisine type** → describes the restaurant's category. All three platforms can filter on this directly (Yelp categories, Resy/OT page content). A "seafood" restaurant will self-identify as seafood.
- **Specific dish** → describes a menu item. No platform reliably categorizes restaurants by individual dishes. A restaurant that serves oysters might be categorized as "American", "Southern", or "Seafood" — the word "oysters" may only appear in menus or reviews.

The current system fails because it applies the same strict cuisine relevance check to both. A search for "oysters" will reject a restaurant whose scraped page doesn't literally contain the word "oyster" — even if it's a seafood restaurant that obviously serves oysters.

## Plan

### 1. Add cuisine vs. dish classification to the AI parser

Extend the `parseQuery` prompt and tool schema to return a new field:

- `cuisineType`: string — the broad restaurant category (e.g., "seafood", "italian", "japanese", "")
- `dishKeyword`: string — the specific dish/ingredient if any (e.g., "oysters", "lobster roll", "")

The AI is well-suited to make this inference. Examples:
- "seafood near Decatur" → `cuisineType: "seafood"`, `dishKeyword: ""`
- "oysters tonight Atlanta" → `cuisineType: "seafood"`, `dishKeyword: "oysters"`
- "Italian for 2" → `cuisineType: "italian"`, `dishKeyword: ""`
- "birria tacos Friday" → `cuisineType: "mexican"`, `dishKeyword: "birria tacos"`
- "steak dinner" → `cuisineType: "steakhouse"`, `dishKeyword: "steak"`

### 2. Build a dish-to-cuisine synonym map

For verification fallback, maintain a lightweight map so that when a dish is searched, the system knows which cuisine categories are relevant:

```
oysters → seafood, raw bar, cajun, southern
sushi → japanese, sushi bar
tacos → mexican, tex-mex
steak → steakhouse, american, chophouse
```

### 3. Tailor platform discovery per type

**Cuisine type** (e.g., "seafood"):
- Resy/OT Firecrawl queries: use the cuisine word directly (current behavior — works well)
- Yelp API: pass as `term` (current behavior)

**Dish keyword** (e.g., "oysters"):
- Resy/OT Firecrawl queries: search with BOTH the dish keyword AND its parent cuisine type. e.g., query 1: `site:resy.com ... oysters`, query 2: `site:resy.com ... seafood restaurant`
- Yelp API: search with the dish keyword in `term` (Yelp indexes reviews/menus)

### 4. Update the relevance verification gate

**Cuisine type searches**: Keep current behavior — scraped page must mention the cuisine type or a close synonym.

**Dish keyword searches**: Use a **two-tier** check:
1. Does the page mention the dish keyword (or singular/plural variant)? → pass
2. Does the page mention the **parent cuisine type** (from the synonym map)? → pass (a seafood restaurant likely serves oysters even if the word "oysters" isn't on the booking page)
3. Neither → reject

### 5. Update Yelp pre-filter similarly

For dish searches, accept Yelp businesses whose categories match the parent cuisine type, not just the literal dish word.

### Technical changes

**File: `supabase/functions/search/index.ts`**

- `SearchParams` interface: add `cuisineType` and `dishKeyword` fields
- `parseQuery()`: update prompt + tool schema to extract both fields
- New constant: `DISH_TO_CUISINE_MAP` — maps common dish terms to parent cuisine categories
- `searchFirecrawl()`: when `dishKeyword` is set, add a parallel query using the parent cuisine type
- `verifyAvailability()` cuisine relevance check: apply two-tier logic (dish match OR parent cuisine match)
- Yelp pre-filter: same two-tier logic
- No frontend changes needed — the `cuisine` field on results stays as-is for display

