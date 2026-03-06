

## Restructure RestaurantCard Layout + Increase Font Sizes

### Changes to `src/components/RestaurantCard.tsx`

**Layout restructure** — Split the current top row (platform badge + name + rating + distance + chevron all on one line) into two lines:

1. **Line 1**: Platform badge + restaurant name (full width, no truncation pressure from rating/distance)
2. **Line 2**: Star rating, review count, distance, chevron — all on a secondary row

**Font size increases** (+2 units across the board):
- Restaurant name: `text-sm` (14px) → `text-base` (16px)
- Platform badge: `text-[10px]` → `text-xs` (12px)
- Rating: `text-xs` → `text-sm`
- Review count: `text-[10px]` → `text-xs`
- Distance: `text-xs` → `text-sm`
- Meta row (cuisine/price/neighborhood): `text-xs` → `text-sm`
- Description: `text-xs` → `text-sm`
- Vibe tags: `text-[10px]` → `text-xs`
- Time slots: `text-[11px]` → `text-[13px]`
- Clock/star/map icons: `h-3 w-3` → `h-3.5 w-3.5`
- Chevron: `h-3.5 w-3.5` → `h-4 w-4`

**Structural change** (lines 69-101): Replace the single flex row with two rows:

```
Row 1: [platform badge] [restaurant name .................]
Row 2: [★ 4.5 (1.2k)]  [📍 2.3 mi]                    [>]
```

This gives the restaurant name the full width minus only the small platform badge, eliminating truncation.

### Scope
Single file: `src/components/RestaurantCard.tsx`

