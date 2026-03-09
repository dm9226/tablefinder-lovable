

## Problem

The reverse-geocoding on line 478 only checks for `city` or `town` in the Nominatim response, but the user's location (North Druid Hills) is classified as a `village` by Nominatim. From the network logs, the response has:

```json
{ "address": { "village": "North Druid Hills", "county": "DeKalb County", "state": "Georgia" } }
```

Since there's no `city` or `town` field, `parsed.city` stays empty and the error is thrown at line 490.

Notably, the **frontend** (Index.tsx line 36) already handles this correctly — it checks `city || town || village`. But the **edge function** (line 478) only checks `city || town`.

## Fix

**`supabase/functions/search/index.ts` line 478** — Add `village` and `suburb` fallbacks to match what the frontend already does:

```typescript
parsed.city = revData.address?.city || revData.address?.town || revData.address?.village || revData.address?.suburb || "";
```

One line change. This ensures locations classified as villages (like North Druid Hills) are properly resolved from browser coordinates.

