

## Fix: Wrap restaurant description text instead of truncating

**File:** `src/components/RestaurantCard.tsx`

**Change:** On the description `<p>` element (line 81), remove the `truncate` class so the text wraps naturally on mobile instead of being cut off with ellipsis.

```tsx
// Before
<p className="text-sm text-muted-foreground/80 font-body italic truncate">

// After
<p className="text-sm text-muted-foreground/80 font-body italic">
```

Single-line change, no other files affected.

