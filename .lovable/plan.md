I found the regression pattern: OpenTable candidates are still being discovered, but the verification scrape is no longer seeing any real OpenTable booking widget content. The logs show every OT candidate going down this path:

```text
[opentable]: no "Select a time" section on first pass
[opentable] RETRY: still no additional slots after waitFor
[opentable] — no parseable time slots found
```

There are also repeated OT address misses, which is a strong signal that the scrape is not receiving the normal restaurant page content at all. The current OT path is spending extra time on a JS-render/wait retry that is producing zero recovered results.

## Plan

### 1. Revert OpenTable verification to the last performant scrape shape
In `supabase/functions/search/index.ts`, change only the OpenTable verification branch:

- Use the historical OpenTable scrape strategy:
  - `onlyMainContent: false` for OT, so the reservation widget can be included.
  - `formats: ["markdown"]` for OT first pass.
  - Remove the OT first-pass `waitFor` delay.
- Keep Resy and Yelp scrape behavior unchanged.

Reason: the older working OT architecture relied on the static markdown representation of the reservation widget (`### Select a time`) and avoided the slow JS-render path. The current `waitFor`/HTML/retry approach is now producing no OT slots and blowing up runtime.

### 2. Keep strict, content-based OT verification
No fake fallback results.

OpenTable will only return a restaurant if the scrape contains real slot markers from the booking page. The parser will:

- Find the OpenTable `Select a time` section.
- Extract concrete time slots from that section.
- Ignore dropdown/time-picker noise such as concatenated all-day time lists.
- Ignore Notify/waitlist contexts.
- Filter to the requested time window required by the project spec.
- Return only restaurants with at least one verified slot.

This preserves the core rule: no restaurant result is returned unless availability was verified from the actual booking URL.

### 3. Remove the wasteful OT retry path
Remove or disable the current second-pass OT retry that logs:

```text
retrying with waitFor: 8000ms
RETRY: still no additional slots after waitFor
```

It is currently recovering zero OT results while adding roughly 10–20 seconds per wave. If the no-wait markdown scrape does not include a parseable `Select a time` section, reject the candidate quickly and let other candidates/platforms continue.

### 4. Add targeted diagnostics for OT only
Add temporary-safe diagnostic logging for OT verification outcomes, without dumping page contents:

- Whether markdown contained `Select a time`.
- Whether markdown looked blocked or empty.
- Number of raw OT slot candidates found before filtering.
- Number of OT slots remaining after the requested-time window filter.
- Per-restaurant OT verification duration.

This will make the next failure obvious: no widget content, blocked scrape, parser miss, or valid slots outside window.

### 5. Validate with live backend tests before calling it fixed
After implementation, run direct backend searches and inspect logs/results for:

- At least one Atlanta query where OpenTable should have inventory, such as steak/Italian/dinner queries.
- One broad Atlanta dinner query to confirm mixed-platform results still return within the first-results budget.
- One Resy-heavy query to confirm Resy behavior is unchanged.
- One Yelp-heavy query to confirm Yelp behavior is unchanged.

Acceptance criteria:

- OpenTable results appear again only when verified slots are extracted from the booking page.
- No fabricated OT times.
- No OT retry waterfall.
- First response target stays at or below the 30-second user-facing cap.
- Resy and Yelp results remain unaffected.