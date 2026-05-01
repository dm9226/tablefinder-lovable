You're right. Reverting to Apr 14 again is not the right recommendation if that is the baseline we've already been trying to repair all day.

The better move now is not another broad revert. It is to stabilize the current code by removing the exact things that are causing the current failures: long provider timeouts, OpenTable stealth retries, parallel lane overrun, and Yelp verification work that cannot reliably produce live buttons.

Plan:

1. Lock the non-negotiable behavior
   - Keep the rule that every returned restaurant must have verified live slot markers.
   - Keep the Yelp hallucination/operating-hours rejection.
   - Do not fabricate fallback slots for any provider.
   - Keep deep-link parameters for date, time, and party size.

2. Put a real hard deadline around the search
   - Replace the current 120s global timeout and 90s OpenTable lane budget with a strict initial-response budget around 28-30s.
   - Stop verification at the deadline and return the verified results already collected.
   - Avoid long “retry once” behavior that burns another 45-50s after a failed OpenTable scrape.

3. Prioritize providers by proven reliability
   - Run Resy first/fast because it is the most reliable verified source.
   - Run OpenTable with a capped, no-long-retry path so it can contribute without freezing the whole search.
   - Keep Yelp discovery available, but Yelp verification must be opportunistic and bounded. If real slot evidence does not render quickly, reject it and move on.

4. Fix the verification scheduler, not the whole architecture
   - Replace the current independent lane budgets with a central wall-clock-aware verifier.
   - Use small provider-balanced batches.
   - Stop after enough verified results are found or the deadline is reached.
   - Prevent one slow provider from starving the others.

5. Add one-line diagnostics for every search
   - Emit a `[SEARCH_SUMMARY]` log showing:
     - candidate counts by provider
     - selected counts by provider
     - verified counts by provider
     - rejection categories such as timeout, no_slots, anti_bot, no_relevance, outside_time_window
     - elapsed milliseconds
   - This gives us evidence immediately instead of guessing after each failed run.

6. Tighten the regression tests
   - Update the link/verification test so it fails if:
     - Yelp operating hours are treated as reservation slots
     - “Loading...” pages are accepted
     - OpenTable/Resy results lack date/time/party parameters
     - returned slots fall outside the requested ±2 hour window

Expected result:

- Searches should stop hanging for 60-120s.
- Returned restaurants should still be verified, not guessed.
- Resy/OpenTable should carry most initial results.
- Yelp will appear only when it truly renders usable slot evidence; otherwise it will not drag down the whole search.
- The next failure will be visible in a single `[SEARCH_SUMMARY]` line instead of requiring a full forensic dig.

Important caveat:

This will make the app faster and more reliable. It will not magically make Yelp thorough without a working anti-bot/proxy path. The evidence from the history is clear: Yelp Fusion expired, Firecrawl hits DataDome/Loading states, Browserbase needed paid proxy capability, and the fake Yelp slots came from operating-hours hallucination. So the right product behavior is: verified Yelp if real evidence renders quickly; otherwise skip Yelp and return verified Resy/OpenTable results fast.

Technical change scope:

- Main file: `supabase/functions/search/index.ts`
- Test file: `supabase/functions/search/link-verify.test.ts`
- No database changes.
- No new secrets unless we later choose a paid Yelp/proxy route.
- No broad project-history revert.