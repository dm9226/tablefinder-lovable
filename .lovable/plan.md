# Run a test search from your current location

## Goal
Trigger a real search using your browser's geolocation (so the new ZIP-based hyperlocal discovery kicks in for Yelp + OpenTable), then inspect the edge function logs to confirm:
1. Your ZIP was successfully reverse-geocoded from your coords
2. Yelp's `find_loc` used the ZIP
3. OpenTable's supplemental ZIP query ran
4. The closest result distances improved vs. the previous ~4.2 mi floor

## Steps

1. **Open the preview in the automated browser** at `/` and wait for geolocation to resolve (location chip in the search bar should show your detected city).

2. **Run a representative search** — something broad enough to surface many candidates so we can judge proximity. Suggested query: `dinner tonight for 2`. (Open to your preference — Italian, sushi, steakhouse, etc.)

3. **Wait for results to render**, then screenshot the results grid showing the distance badges on the top cards.

4. **Pull the edge function logs** for that run and extract:
   - The `[ZIP]` resolution log line (confirms reverse-geocode succeeded)
   - The Yelp discovery URL (confirms `find_loc=<zip>`)
   - The OpenTable supplemental query line (confirms `site:opentable.com/r <zip> ...`)
   - The final distance distribution of returned results

5. **Report back** with:
   - Screenshot of top results + distances
   - Resolved ZIP
   - Closest result distance (and whether it improved vs. the prior ~4.2 mi)
   - Any anomalies (ZIP not resolved, Yelp falling back to city, etc.)

## Notes
- Browser shares the preview's session, so geolocation prompt should already be granted from your earlier searches.
- If geolocation is somehow not granted in the automated browser, I'll fall back to asking you to run the search manually and I'll just inspect the logs.
- No code changes planned — this is purely a verification run. If the logs reveal a bug (e.g. ZIP not propagating), I'll flag it and propose a fix in a follow-up.
