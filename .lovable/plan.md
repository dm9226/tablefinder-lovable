

## Comprehensive Search Test Suite

### Problem
Running 50 individual searches manually is impractical — each search takes 30-60 seconds. We need an automated test harness.

### Approach
Create a Deno edge function test file that fires all 50 queries in controlled batches, collects results, and produces a structured pass/fail report against all criteria.

### Test Categories (50 queries)

**Cuisine searches (10)**
1. "Italian for 2 tonight" — strict cuisine match
2. "Sushi near me Friday 7pm" — Japanese cuisine
3. "Thai food tomorrow 8pm party of 4" — Thai
4. "Mexican restaurant tonight for 2" — Mexican
5. "French bistro Saturday 7:30pm" — French
6. "Indian curry tonight for 3" — dish-to-cuisine mapping
7. "Chinese dim sum Sunday 11am for 4" — brunch-time Chinese
8. "Korean BBQ Friday night for 6" — Korean
9. "Mediterranean tonight for 2" — broad cuisine
10. "Vietnamese pho tonight" — dish keyword

**Specific dish searches (8)**
11. "Oysters tonight for 2 in Atlanta" — seafood dish
12. "Best steak dinner tonight for 2" — steakhouse
13. "Lobster roll tonight" — specific dish
14. "Tacos tonight for 4" — Mexican dish
15. "Ramen near me tonight" — Japanese dish
16. "Pizza tonight for 3" — Italian dish
17. "Burgers tonight for 2" — American dish
18. "Fried chicken tonight" — Southern dish

**Time variations (6)**
19. "Breakfast tomorrow 8am for 2" — morning
20. "Brunch Saturday 10:30am for 4" — brunch
21. "Lunch today 12pm for 2" — lunch
22. "Early dinner tonight 5pm for 2" — early dinner
23. "Late dinner tonight 9:30pm for 2" — late dinner
24. "Happy hour today 4pm for 3" — amenity + time

**Location variations (6)**
25. "Italian in New York tonight for 2" — explicit city
26. "Sushi in San Francisco tomorrow 7pm" — West Coast
27. "Steakhouse in Chicago Friday 8pm for 4" — Midwest
28. "Seafood in Miami tonight for 2" — Florida
29. "BBQ in Austin tonight for 3" — Texas
30. "Fine dining in Los Angeles Saturday 8pm" — LA

**Party size variations (4)**
31. "Dinner for 1 tonight" — solo
32. "Romantic dinner for 2 tonight" — couple
33. "Dinner for 6 tonight" — medium group
34. "Dinner for 8 Friday 7pm" — large group

**Amenity/experience searches (6)**
35. "Rooftop restaurant tonight for 2" — rooftop amenity
36. "Outdoor patio dinner tonight for 4" — patio amenity
37. "Restaurant with live music tonight" — live music
38. "Private dining tonight for 8" — private dining
39. "Waterfront restaurant tonight for 2" — waterfront
40. "Bottomless brunch Saturday for 4" — brunch amenity

**Vague/natural language (6)**
41. "Somewhere nice tonight" — no cuisine
42. "Date night Friday" — vibe-based
43. "Fancy dinner Saturday" — vibe-based
44. "Cheap eats tonight" — price-based
45. "Quick lunch near me" — casual
46. "Celebration dinner for 4 Saturday" — occasion

**Edge cases (4)**
47. "Steakhouse this weekend" — weekend parsing
48. "Best restaurants near me" — no cuisine, no time
49. "Dinner tonight" — minimal query
50. "Sushi or Italian tonight for 2" — multi-cuisine

### Validation Criteria (automated checks per result)

For each search, the test validates:

1. **Response structure**: `results` array present, `params` object with date/time/partySize/city
2. **Query parsing**: date is valid ISO, time is HH:MM, partySize >= 1, city is non-empty
3. **State normalization**: state is 2-letter code (not full name)
4. **Time slot accuracy**: every slot is in `H:MM AM/PM` format
5. **Time window compliance**: all slots within ±2 hours of requested time
6. **No fabricated slots**: OT results have real parsed slots (not placeholder)
7. **Platform diversity**: at least 2 platforms represented (when results > 3)
8. **Cuisine relevance**: for cuisine-specific queries, check name/cuisine field contains relevant terms
9. **Amenity relevance**: for amenity queries, verify amenity terms present in results
10. **No duplicates**: no two results share the same name
11. **Distance sanity**: all distanceMiles values < 30 (or 15 for non-metro)
12. **Slot ordering**: time slots are in chronological order
13. **Result count**: at least 1 result returned (warn if 0)

### Implementation

**Single file: `supabase/functions/search/index.test.ts`**

- Imports dotenv for credentials
- Defines all 50 queries with expected criteria tags
- Runs in batches of 3 (parallel within batch, sequential between batches) to avoid overloading
- Each query POSTs to the search function with a fixed lat/lng (Atlanta default)
- Collects pass/fail per criterion per query
- Outputs a summary table at the end

### Execution
After creating the test file, run it via the edge function test tool. The test will take ~15-20 minutes due to the volume of searches. Results will show in the test output as a structured report.

### Files Changed
- `supabase/functions/search/index.test.ts` (new)

