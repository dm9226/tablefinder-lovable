

## Smarter Cuisine vs. Dish Relevance Filtering

### Current Problem

The query parser already correctly distinguishes cuisine categories ("steakhouse") from dish keywords ("steak"). The problem is downstream — the **verification check** (line 1578-1594) treats both the same way: a single `pageText.includes(token)` match anywhere on the entire scraped page passes the restaurant. This means:

- **"steakhouse"** search: Elektra passes because its Resy page mentions "steakhouse" once (perhaps in a category tag, related restaurants section, or even ad copy)
- **"steak"** dish search: Even worse — any restaurant with one steak menu item passes

### Fix: Context-Aware Relevance Scoring

Replace the binary `includes` check with logic that adapts based on whether the user specified a **cuisine category** or a **dish**:

**For cuisine categories** (cuisineType = "steakhouse", dishKeyword = ""):
- **Auto-pass** if token is in the restaurant **name** (e.g., "STK", "Little Alley Steak")
- **Auto-pass** if the token appears in the first 500 characters of the page (title/header/category area where restaurant identity lives)
- **Frequency threshold**: token must appear 3+ times in full page text — a real steakhouse will mention "steak" or "steakhouse" repeatedly across its menu, not once
- Otherwise **reject** (incidental mention)

**For dish keywords** (dishKeyword = "oysters", cuisineType = "seafood"):
- Keep current behavior: accept if either the dish OR parent cuisine appears anywhere — a seafood restaurant likely serves oysters even if not on the booking page
- This is already working correctly and should stay loose

### Changes

**Single file**: `supabase/functions/search/index.ts`, lines 1578-1594

Replace the `hasMatch` logic with a function that:
1. Checks if `params.dishKeyword` is set → use current loose matching (no change)
2. If pure cuisine search → apply the weighted check (name match, header match, or frequency ≥ 3)

This keeps dish searches broad (good) while making cuisine-category searches strict (filters out Elektra-type false positives).

