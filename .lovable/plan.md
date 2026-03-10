
What happened:
- You’re right: the previous change did not actually solve the OpenTable distance problem.
- From the code, OT distance extraction still depends on:
  1. OG metadata if present, or
  2. one of three generic regexes over markdown.
- So even with full-page scraping enabled, OT still fails whenever the address is split across lines, wrapped in bullets, includes suite text, or appears in a structured block the current regex does not match.
- Separately, the Resy breakage was caused by using the same full-page scrape for availability parsing. That added page noise around the meal/booking sections and made the Resy verification logic much easier to reject.

Why OT is still inconsistent:
- The change only affected how much page content is scraped.
- It did not change the actual OT address parser.
- OT address extraction is still generic, not OpenTable-specific.
- So pages without complete OG address fields still fall through to brittle regex matching and end up with no distance.

Plan:
1. Undo the coupling between availability parsing and address extraction
   - Use one scrape mode optimized for slot verification.
   - Use a separate address extraction pass or separate parsing path so “more content for addresses” cannot break Resy availability again.

2. Recover Resy results first
   - Restore the safer Resy verification behavior for meal-section parsing.
   - Keep the stricter Resy slot logic, but stop feeding it noisy full-page content.

3. Fix OpenTable distances properly
   - Add OpenTable-specific address extraction instead of relying on the shared regex alone.
   - Parse address from multiple OT patterns in priority order:
     - metadata fields
     - joined multiline street/city/state blocks
     - structured address patterns near location/contact sections
     - normalized text with bullets/newlines collapsed before regex runs

4. Harden shared address normalization
   - Pre-normalize markdown before regex matching:
     - collapse line breaks inside addresses
     - replace bullets/middots with commas/spaces
     - remove duplicate whitespace
     - keep suite/unit text from blocking the main match
   - Then run stricter and broader regexes on normalized text.

5. Improve diagnostics so this cannot be misread again
   - Log separately:
     - metadata address found
     - normalized regex address found
     - address found but geocoder returned no match
     - no address pattern found at all
   - Log platform-specific reason counts for dropped results.

6. Verify against the exact failing path
   - Re-test the “sushi this Thursday” flow.
   - Confirm:
     - Resy results are back
     - OT results keep passing slot verification
     - the previously missing OT distances now populate consistently
     - failures, if any remain, are attributable to geocoding rather than extraction

Technical details:
- Main problem area: `verifyAvailability()` in `supabase/functions/search/index.ts`
- Regressing change: `onlyMainContent` was altered globally for Resy + OT inside the same scrape used for verification.
- Real OT gap: lines around the current address extraction only use generic metadata + regex fallback; there is no OT-specific parser.
- Safer design:
```text
availability parsing != address parsing
```
This isolates Resy slot verification from the extra page noise while still allowing fuller content handling where OT address extraction needs it.
