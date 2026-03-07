

## UI Changes: 4 Items

### 1. Remove photo thumbnail from RestaurantCard
**File**: `src/components/RestaurantCard.tsx`
- Delete the entire thumbnail `<div>` block (lines 43-65)
- Remove unused imports (`resyLogo`, `opentableLogo`, `yelpLogo`, `PLATFORM_LOGOS`)

### 2. Limit time slots to 3
**File**: `src/components/RestaurantCard.tsx`
- Change `slots.slice(0, 6)` → `slots.slice(0, 3)` (line 137)
- Change the "+N more" threshold from 6 to 3 (line 145)

### 3. Reduce header/search padding
**File**: `src/pages/Index.tsx`
- Header: `pt-16 pb-10` → `pt-6 pb-3` (line 161)
- Search section: `pb-10` → `pb-3` (line 171)

### 4. Show search criteria above results
**File**: `src/pages/Index.tsx`
- Store `params` from the edge function response in new state `searchMeta`
- Pass `searchMeta` to `ResultsGrid`

**File**: `src/components/ResultsGrid.tsx`
- Accept `searchMeta` prop (date, time, partySize, city, state)
- Render a summary line above results like: `"Tonight · 7:00 PM · 2 guests · Atlanta, GA"`

**File**: `src/types/restaurant.ts`
- Add `SearchMeta` interface for the params passed to ResultsGrid

