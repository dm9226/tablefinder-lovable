

## Diagnose Yelp API: Add Error Logging

### Problem
The Yelp API is returning 0 candidates, but the code silently swallows non-200 responses at line 1480:
```typescript
let businesses = resp.ok ? (await resp.json())?.businesses || [] : [];
```
If the API returns 401 (bad key), 403 (revoked), or 429 (rate limited), this line just produces an empty array with no logging.

### Root Cause (Most Likely)
Based on the "stack overflow" hint and historical pattern of Yelp revoking keys, the `YELP_API_KEY` secret is likely expired or invalid. But we can't confirm without seeing the actual HTTP status.

### Plan

**1. Add Yelp API response status logging** (`supabase/functions/search/index.ts`)

After the initial Yelp fetch (line 1476-1480), log the response status when it's not ok:

```typescript
let resp = await fetch(`${YELP_API}/businesses/search?${sp}`, {
  headers: { Authorization: `Bearer ${yelpKey}` },
});

if (!resp.ok) {
  const errBody = await resp.text().catch(() => "");
  console.log(`Yelp API error: status=${resp.status}, body=${errBody.slice(0, 300)}`);
}
let businesses = resp.ok ? (await resp.json())?.businesses || [] : [];
```

Also add the same for the broadened search (line 1486-1489).

**2. Add Yelp API key metadata logging**

At the start of the Yelp adapter's discover function, log the key length and prefix/suffix (not the full key):

```typescript
console.log(`Yelp API key metadata: len=${yelpKey.length}, prefix=${yelpKey.slice(0,4)}, suffix=${yelpKey.slice(-4)}`);
```

### Expected Outcome
After deploying, the next search will reveal exactly why Yelp returns 0 — whether it's a 401 (bad key), 403 (revoked), 429 (rate limited), or something else. Once we see the actual error, we can take the right corrective action (e.g., updating the API key).

### Files Modified
| File | Change |
|------|--------|
| `supabase/functions/search/index.ts` | Add error status + body logging for Yelp API calls, add key metadata logging |

