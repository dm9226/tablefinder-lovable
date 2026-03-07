

## Fix: Add retry and response validation to `parseQuery` AI gateway call

**File:** `supabase/functions/search/index.ts` (lines 478-483)

**Change:** Replace the direct `.json()` call with safe text-first parsing and a single retry:

1. Read response as text first with `await aiResp.text()`
2. Check if the text is empty or too short (< 10 chars)
3. If so, retry the AI gateway call once (transient issue)
4. If retry also fails, throw a user-friendly error
5. Use `JSON.parse(respText)` instead of `.json()`

This is a ~15-line change around lines 478-483. No other files need modification.

**Before:**
```typescript
if (!aiResp.ok) throw new Error("Failed to parse search query");
const aiData = await aiResp.json();
```

**After:**
```typescript
if (!aiResp.ok) throw new Error("Failed to parse search query");
let respText = await aiResp.text();
if (!respText || respText.length < 10) {
  console.warn("AI gateway returned empty response, retrying once...");
  // Retry the same request once
  const retryResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!retryResp.ok) throw new Error("Search temporarily unavailable. Please try again.");
  respText = await retryResp.text();
  if (!respText || respText.length < 10) {
    throw new Error("Search temporarily unavailable. Please try again.");
  }
}
let aiData;
try { aiData = JSON.parse(respText); }
catch { throw new Error("Search temporarily unavailable. Please try again."); }
```

To make the retry work cleanly, the request body and headers will be extracted into variables before the initial fetch call (around line 440-476), so both the original call and retry can reuse them.

