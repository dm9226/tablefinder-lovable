import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

// ─── Test Query Definitions ───

interface TestQuery {
  id: number;
  query: string;
  category: string;
  tags: string[]; // criteria tags: "cuisine:italian", "time:dinner", "city:atlanta", etc.
  lat?: number;
  lng?: number;
}

const ATLANTA = { lat: 33.749, lng: -84.388 };
const NYC = { lat: 40.7128, lng: -74.006 };
const SF = { lat: 37.7749, lng: -122.4194 };
const CHICAGO = { lat: 41.8781, lng: -87.6298 };
const MIAMI = { lat: 25.7617, lng: -80.1918 };
const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const LA = { lat: 34.0522, lng: -118.2437 };

const TEST_QUERIES: TestQuery[] = [
  // Cuisine searches (1-10)
  { id: 1, query: "Italian for 2 tonight", category: "cuisine", tags: ["cuisine:italian"], ...ATLANTA },
  { id: 2, query: "Sushi near me Friday 7pm", category: "cuisine", tags: ["cuisine:japanese", "cuisine:sushi"], ...ATLANTA },
  { id: 3, query: "Thai food tomorrow 8pm party of 4", category: "cuisine", tags: ["cuisine:thai"], ...ATLANTA },
  { id: 4, query: "Mexican restaurant tonight for 2", category: "cuisine", tags: ["cuisine:mexican"], ...ATLANTA },
  { id: 5, query: "French bistro Saturday 7:30pm", category: "cuisine", tags: ["cuisine:french"], ...ATLANTA },
  { id: 6, query: "Indian curry tonight for 3", category: "cuisine", tags: ["cuisine:indian", "dish:curry"], ...ATLANTA },
  { id: 7, query: "Chinese dim sum Sunday 11am for 4", category: "cuisine", tags: ["cuisine:chinese", "dish:dim sum"], ...ATLANTA },
  { id: 8, query: "Korean BBQ Friday night for 6", category: "cuisine", tags: ["cuisine:korean", "dish:bbq"], ...ATLANTA },
  { id: 9, query: "Mediterranean tonight for 2", category: "cuisine", tags: ["cuisine:mediterranean"], ...ATLANTA },
  { id: 10, query: "Vietnamese pho tonight", category: "cuisine", tags: ["cuisine:vietnamese", "dish:pho"], ...ATLANTA },

  // Specific dish searches (11-18)
  { id: 11, query: "Oysters tonight for 2 in Atlanta", category: "dish", tags: ["dish:oysters", "cuisine:seafood"], ...ATLANTA },
  { id: 12, query: "Best steak dinner tonight for 2", category: "dish", tags: ["dish:steak", "cuisine:steakhouse"], ...ATLANTA },
  { id: 13, query: "Lobster roll tonight", category: "dish", tags: ["dish:lobster", "cuisine:seafood"], ...ATLANTA },
  { id: 14, query: "Tacos tonight for 4", category: "dish", tags: ["dish:tacos", "cuisine:mexican"], ...ATLANTA },
  { id: 15, query: "Ramen near me tonight", category: "dish", tags: ["dish:ramen", "cuisine:japanese"], ...ATLANTA },
  { id: 16, query: "Pizza tonight for 3", category: "dish", tags: ["dish:pizza", "cuisine:italian"], ...ATLANTA },
  { id: 17, query: "Burgers tonight for 2", category: "dish", tags: ["dish:burgers", "cuisine:american"], ...ATLANTA },
  { id: 18, query: "Fried chicken tonight", category: "dish", tags: ["dish:fried chicken", "cuisine:southern"], ...ATLANTA },

  // Time variations (19-24)
  { id: 19, query: "Breakfast tomorrow 8am for 2", category: "time", tags: ["meal:breakfast"], ...ATLANTA },
  { id: 20, query: "Brunch Saturday 10:30am for 4", category: "time", tags: ["meal:brunch"], ...ATLANTA },
  { id: 21, query: "Lunch today 12pm for 2", category: "time", tags: ["meal:lunch"], ...ATLANTA },
  { id: 22, query: "Early dinner tonight 5pm for 2", category: "time", tags: ["meal:dinner"], ...ATLANTA },
  { id: 23, query: "Late dinner tonight 9:30pm for 2", category: "time", tags: ["meal:dinner"], ...ATLANTA },
  { id: 24, query: "Happy hour today 4pm for 3", category: "time", tags: ["meal:happy_hour"], ...ATLANTA },

  // Location variations (25-30)
  { id: 25, query: "Italian in New York tonight for 2", category: "location", tags: ["cuisine:italian", "city:new york"], ...NYC },
  { id: 26, query: "Sushi in San Francisco tomorrow 7pm", category: "location", tags: ["cuisine:japanese", "city:san francisco"], ...SF },
  { id: 27, query: "Steakhouse in Chicago Friday 8pm for 4", category: "location", tags: ["cuisine:steakhouse", "city:chicago"], ...CHICAGO },
  { id: 28, query: "Seafood in Miami tonight for 2", category: "location", tags: ["cuisine:seafood", "city:miami"], ...MIAMI },
  { id: 29, query: "BBQ in Austin tonight for 3", category: "location", tags: ["cuisine:bbq", "city:austin"], ...AUSTIN },
  { id: 30, query: "Fine dining in Los Angeles Saturday 8pm", category: "location", tags: ["cuisine:fine dining", "city:los angeles"], ...LA },

  // Party size variations (31-34)
  { id: 31, query: "Dinner for 1 tonight", category: "party_size", tags: ["party:1"], ...ATLANTA },
  { id: 32, query: "Romantic dinner for 2 tonight", category: "party_size", tags: ["party:2"], ...ATLANTA },
  { id: 33, query: "Dinner for 6 tonight", category: "party_size", tags: ["party:6"], ...ATLANTA },
  { id: 34, query: "Dinner for 8 Friday 7pm", category: "party_size", tags: ["party:8"], ...ATLANTA },

  // Amenity/experience searches (35-40)
  { id: 35, query: "Rooftop restaurant tonight for 2", category: "amenity", tags: ["amenity:rooftop"], ...ATLANTA },
  { id: 36, query: "Outdoor patio dinner tonight for 4", category: "amenity", tags: ["amenity:patio", "amenity:outdoor"], ...ATLANTA },
  { id: 37, query: "Restaurant with live music tonight", category: "amenity", tags: ["amenity:live music"], ...ATLANTA },
  { id: 38, query: "Private dining tonight for 8", category: "amenity", tags: ["amenity:private dining"], ...ATLANTA },
  { id: 39, query: "Waterfront restaurant tonight for 2", category: "amenity", tags: ["amenity:waterfront"], ...ATLANTA },
  { id: 40, query: "Bottomless brunch Saturday for 4", category: "amenity", tags: ["amenity:bottomless", "meal:brunch"], ...ATLANTA },

  // Vague/natural language (41-46)
  { id: 41, query: "Somewhere nice tonight", category: "vague", tags: ["vague"], ...ATLANTA },
  { id: 42, query: "Date night Friday", category: "vague", tags: ["vague", "vibe:date"], ...ATLANTA },
  { id: 43, query: "Fancy dinner Saturday", category: "vague", tags: ["vague", "vibe:fancy"], ...ATLANTA },
  { id: 44, query: "Cheap eats tonight", category: "vague", tags: ["vague", "vibe:cheap"], ...ATLANTA },
  { id: 45, query: "Quick lunch near me", category: "vague", tags: ["vague", "meal:lunch"], ...ATLANTA },
  { id: 46, query: "Celebration dinner for 4 Saturday", category: "vague", tags: ["vague", "vibe:celebration"], ...ATLANTA },

  // Edge cases (47-50)
  { id: 47, query: "Steakhouse this weekend", category: "edge", tags: ["cuisine:steakhouse", "time:weekend"], ...ATLANTA },
  { id: 48, query: "Best restaurants near me", category: "edge", tags: ["vague"], ...ATLANTA },
  { id: 49, query: "Dinner tonight", category: "edge", tags: ["meal:dinner"], ...ATLANTA },
  { id: 50, query: "Sushi or Italian tonight for 2", category: "edge", tags: ["cuisine:japanese", "cuisine:italian"], ...ATLANTA },
];

// ─── Validation Functions ───

interface ValidationResult {
  criterion: string;
  passed: boolean;
  detail: string;
}

interface QueryResult {
  id: number;
  query: string;
  category: string;
  responseTimeMs: number;
  resultCount: number;
  validations: ValidationResult[];
  error?: string;
}

const TIME_SLOT_REGEX = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;

function parseTime12to24(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return -1;
  let h = parseInt(m[1]);
  const min = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

function parseTime24(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function validateResponse(tq: TestQuery, data: any): ValidationResult[] {
  const results: ValidationResult[] = [];

  // 1. Response structure
  const hasResults = Array.isArray(data?.results);
  const hasParams = data?.params && typeof data.params === "object";
  results.push({
    criterion: "response_structure",
    passed: hasResults && hasParams,
    detail: `results=${hasResults}, params=${hasParams}`,
  });
  if (!hasResults || !hasParams) return results; // can't continue without structure

  const params = data.params;
  const restaurants = data.results;

  // 2. Query parsing
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(params.date || "");
  const timeValid = /^\d{2}:\d{2}$/.test(params.time || "");
  const partySizeValid = (params.partySize || 0) >= 1;
  const cityValid = (params.city || "").length > 0;
  results.push({
    criterion: "query_parsing",
    passed: dateValid && timeValid && partySizeValid && cityValid,
    detail: `date=${params.date}(${dateValid}) time=${params.time}(${timeValid}) party=${params.partySize}(${partySizeValid}) city=${params.city}(${cityValid})`,
  });

  // 3. State normalization
  const state = params.state || "";
  const stateOk = state.length === 0 || /^[A-Z]{2}$/.test(state);
  results.push({
    criterion: "state_normalization",
    passed: stateOk,
    detail: `state="${state}"`,
  });

  // 4. Time slot format
  const allSlots = restaurants.flatMap((r: any) => (r.timeSlots || []).map((s: any) => s.time));
  const badSlots = allSlots.filter((t: string) => !TIME_SLOT_REGEX.test(t));
  results.push({
    criterion: "time_slot_format",
    passed: badSlots.length === 0,
    detail: badSlots.length === 0 ? `${allSlots.length} slots all valid` : `bad: ${badSlots.slice(0, 5).join(", ")}`,
  });

  // 5. Time window compliance (±2 hours)
  if (timeValid && allSlots.length > 0) {
    const requestedMin = parseTime24(params.time);
    const outOfWindow = allSlots.filter((t: string) => {
      const slotMin = parseTime12to24(t);
      if (slotMin === -1) return true;
      const diff = Math.abs(slotMin - requestedMin);
      const wrapDiff = Math.min(diff, 1440 - diff);
      return wrapDiff > 120;
    });
    results.push({
      criterion: "time_window_compliance",
      passed: outOfWindow.length === 0,
      detail: outOfWindow.length === 0
        ? `all ${allSlots.length} slots within ±2h of ${params.time}`
        : `${outOfWindow.length} out of window: ${outOfWindow.slice(0, 3).join(", ")}`,
    });
  }

  // 6. No fabricated slots (OT results should have real slots)
  const otResults = restaurants.filter((r: any) => r.platform === "opentable");
  const otNoSlots = otResults.filter((r: any) => !r.timeSlots || r.timeSlots.length === 0);
  results.push({
    criterion: "no_fabricated_slots",
    passed: otNoSlots.length === 0,
    detail: `OT: ${otResults.length} total, ${otNoSlots.length} with no slots`,
  });

  // 7. Platform diversity
  if (restaurants.length > 3) {
    const platforms = new Set(restaurants.map((r: any) => r.platform));
    results.push({
      criterion: "platform_diversity",
      passed: platforms.size >= 2,
      detail: `platforms: ${[...platforms].join(", ")} (${platforms.size})`,
    });
  } else {
    results.push({ criterion: "platform_diversity", passed: true, detail: `skipped (only ${restaurants.length} results)` });
  }

  // 8. Cuisine relevance
  const cuisineTags = tq.tags.filter((t) => t.startsWith("cuisine:")).map((t) => t.split(":")[1]);
  if (cuisineTags.length > 0 && restaurants.length > 0) {
    const relevantTerms = cuisineTags.flatMap((c) => {
      const synonyms: Record<string, string[]> = {
        italian: ["italian", "pizza", "pasta", "trattoria", "ristorante", "osteria"],
        japanese: ["japanese", "sushi", "ramen", "izakaya", "omakase"],
        thai: ["thai"],
        mexican: ["mexican", "taco", "taqueria", "cantina", "tex-mex"],
        french: ["french", "bistro", "brasserie", "café"],
        indian: ["indian", "curry", "tandoori", "masala"],
        chinese: ["chinese", "dim sum", "szechuan", "cantonese", "wok"],
        korean: ["korean", "bbq", "bibimbap"],
        mediterranean: ["mediterranean", "greek", "turkish", "lebanese", "middle eastern"],
        vietnamese: ["vietnamese", "pho", "banh mi"],
        seafood: ["seafood", "fish", "oyster", "crab", "lobster", "shrimp"],
        steakhouse: ["steak", "steakhouse", "chophouse", "prime", "beef"],
        american: ["american", "burger", "grill", "diner"],
        southern: ["southern", "soul", "fried chicken", "comfort"],
        bbq: ["bbq", "barbecue", "barbeque", "smokehouse", "smoked"],
        "fine dining": ["fine dining", "upscale", "prix fixe", "tasting menu"],
      };
      return [c, ...(synonyms[c] || [])];
    });

    const matchCount = restaurants.filter((r: any) => {
      const text = `${r.name} ${r.cuisine} ${(r.vibeTags || []).join(" ")} ${r.description || ""}`.toLowerCase();
      return relevantTerms.some((term) => text.includes(term));
    }).length;
    const ratio = matchCount / restaurants.length;
    results.push({
      criterion: "cuisine_relevance",
      passed: ratio >= 0.3, // at least 30% relevant
      detail: `${matchCount}/${restaurants.length} (${(ratio * 100).toFixed(0)}%) matched [${cuisineTags.join(",")}]`,
    });
  }

  // 9. Amenity relevance
  const amenityTags = tq.tags.filter((t) => t.startsWith("amenity:")).map((t) => t.split(":")[1]);
  if (amenityTags.length > 0 && restaurants.length > 0) {
    const matchCount = restaurants.filter((r: any) => {
      const text = `${r.name} ${r.cuisine} ${(r.vibeTags || []).join(" ")} ${r.description || ""}`.toLowerCase();
      return amenityTags.some((term) => text.includes(term));
    }).length;
    results.push({
      criterion: "amenity_relevance",
      passed: matchCount > 0,
      detail: `${matchCount}/${restaurants.length} matched amenity [${amenityTags.join(",")}]`,
    });
  }

  // 10. No duplicates
  const names = restaurants.map((r: any) => (r.name || "").toLowerCase().trim());
  const uniqueNames = new Set(names);
  results.push({
    criterion: "no_duplicates",
    passed: uniqueNames.size === names.length,
    detail: uniqueNames.size === names.length ? `${names.length} unique` : `${names.length - uniqueNames.size} duplicates`,
  });

  // 11. Distance sanity
  const distances = restaurants.map((r: any) => r.distanceMiles).filter((d: any) => d != null && d !== undefined);
  const maxDist = 30;
  const farResults = distances.filter((d: number) => d > maxDist);
  results.push({
    criterion: "distance_sanity",
    passed: farResults.length === 0,
    detail: farResults.length === 0
      ? `${distances.length} distances all ≤${maxDist}mi`
      : `${farResults.length} too far: ${farResults.slice(0, 3).join(", ")}mi`,
  });

  // 12. Slot ordering (each restaurant's slots in chronological order)
  let orderOk = true;
  for (const r of restaurants) {
    const slots = (r.timeSlots || []).map((s: any) => parseTime12to24(s.time)).filter((m: number) => m >= 0);
    for (let i = 1; i < slots.length; i++) {
      if (slots[i] < slots[i - 1]) { orderOk = false; break; }
    }
    if (!orderOk) break;
  }
  results.push({
    criterion: "slot_ordering",
    passed: orderOk,
    detail: orderOk ? "all sorted" : "out of order detected",
  });

  // 13. Result count
  results.push({
    criterion: "result_count",
    passed: restaurants.length >= 1,
    detail: `${restaurants.length} results`,
  });

  return results;
}

// ─── Batch Execution ───

async function runQuery(tq: TestQuery): Promise<QueryResult> {
  const url = `${SUPABASE_URL}/functions/v1/search`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        query: tq.query,
        lat: tq.lat || ATLANTA.lat,
        lng: tq.lng || ATLANTA.lng,
      }),
    });
    const body = await resp.text();
    const elapsed = Date.now() - start;

    if (!resp.ok) {
      return {
        id: tq.id,
        query: tq.query,
        category: tq.category,
        responseTimeMs: elapsed,
        resultCount: 0,
        validations: [{ criterion: "http_status", passed: false, detail: `${resp.status}: ${body.slice(0, 200)}` }],
        error: `HTTP ${resp.status}`,
      };
    }

    const data = JSON.parse(body);
    const validations = validateResponse(tq, data);
    return {
      id: tq.id,
      query: tq.query,
      category: tq.category,
      responseTimeMs: elapsed,
      resultCount: (data.results || []).length,
      validations,
    };
  } catch (e) {
    return {
      id: tq.id,
      query: tq.query,
      category: tq.category,
      responseTimeMs: Date.now() - start,
      resultCount: 0,
      validations: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function runBatch(queries: TestQuery[], batchSize: number): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    console.log(`\n── Batch ${Math.floor(i / batchSize) + 1}: queries ${batch.map((q) => q.id).join(", ")} ──`);
    const batchResults = await Promise.all(batch.map(runQuery));
    for (const r of batchResults) {
      const passCount = r.validations.filter((v) => v.passed).length;
      const failCount = r.validations.filter((v) => !v.passed).length;
      const status = r.error ? "ERROR" : failCount === 0 ? "PASS" : "FAIL";
      console.log(
        `  [${status}] #${r.id} "${r.query}" — ${r.resultCount} results, ${r.responseTimeMs}ms, ${passCount}✓ ${failCount}✗`
      );
      if (failCount > 0) {
        for (const v of r.validations.filter((v) => !v.passed)) {
          console.log(`    ✗ ${v.criterion}: ${v.detail}`);
        }
      }
      if (r.error) console.log(`    ERROR: ${r.error}`);
    }
    results.push(...batchResults);
  }
  return results;
}

// ─── Summary Report ───

function printSummary(results: QueryResult[]) {
  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("           COMPREHENSIVE SEARCH TEST REPORT");
  console.log("══════════════════════════════════════════════════════\n");

  // Overall stats
  const totalQueries = results.length;
  const errors = results.filter((r) => r.error).length;
  const allPass = results.filter((r) => !r.error && r.validations.every((v) => v.passed)).length;
  const someFail = totalQueries - errors - allPass;

  console.log(`Total queries: ${totalQueries}`);
  console.log(`  ✓ All criteria passed: ${allPass}`);
  console.log(`  ✗ Some criteria failed: ${someFail}`);
  console.log(`  ⚠ Errors: ${errors}`);
  console.log(`  Avg response time: ${Math.round(results.reduce((s, r) => s + r.responseTimeMs, 0) / totalQueries)}ms`);
  console.log(`  Avg results/query: ${(results.reduce((s, r) => s + r.resultCount, 0) / totalQueries).toFixed(1)}`);

  // Per-criterion summary
  const criterionMap = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    for (const v of r.validations) {
      const entry = criterionMap.get(v.criterion) || { pass: 0, fail: 0 };
      if (v.passed) entry.pass++;
      else entry.fail++;
      criterionMap.set(v.criterion, entry);
    }
  }

  console.log("\n── Per-Criterion Summary ──");
  for (const [criterion, counts] of criterionMap) {
    const total = counts.pass + counts.fail;
    const pct = ((counts.pass / total) * 100).toFixed(0);
    const status = counts.fail === 0 ? "✓" : "✗";
    console.log(`  ${status} ${criterion}: ${counts.pass}/${total} (${pct}%)`);
  }

  // Per-category summary
  console.log("\n── Per-Category Summary ──");
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPass = catResults.filter((r) => !r.error && r.validations.every((v) => v.passed)).length;
    console.log(`  ${cat}: ${catPass}/${catResults.length} fully passed`);
  }

  // Failed queries detail
  const failedQueries = results.filter((r) => r.error || r.validations.some((v) => !v.passed));
  if (failedQueries.length > 0) {
    console.log("\n── Failed Queries Detail ──");
    for (const r of failedQueries) {
      console.log(`\n  #${r.id} "${r.query}" [${r.category}]`);
      if (r.error) console.log(`    ERROR: ${r.error}`);
      for (const v of r.validations.filter((v) => !v.passed)) {
        console.log(`    ✗ ${v.criterion}: ${v.detail}`);
      }
    }
  }

  console.log("\n══════════════════════════════════════════════════════\n");
}

// ─── Test Runner ───
// Run a subset to stay within timeout. Adjust BATCH_SIZE and QUERY_LIMIT as needed.

const BATCH_SIZE = 2; // parallel queries per batch
const QUERY_LIMIT = parseInt(Deno.env.get("TEST_QUERY_LIMIT") || "50"); // how many to run

Deno.test({
  name: "Comprehensive search test suite",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const queries = TEST_QUERIES.slice(0, QUERY_LIMIT);
  console.log(`\nRunning ${queries.length} queries in batches of ${BATCH_SIZE}...\n`);

  const results = await runBatch(queries, BATCH_SIZE);
  printSummary(results);

  // Assert no errors
  const errors = results.filter((r) => r.error);
  assertEquals(errors.length, 0, `${errors.length} queries had errors: ${errors.map((e) => `#${e.id}: ${e.error}`).join(", ")}`);

  // Assert critical criteria pass rate
  const criticalCriteria = ["response_structure", "query_parsing", "time_slot_format", "no_fabricated_slots"];
  for (const criterion of criticalCriteria) {
    const entries = results.flatMap((r) => r.validations.filter((v) => v.criterion === criterion));
    const failures = entries.filter((v) => !v.passed);
    assert(
      failures.length === 0,
      `Critical criterion "${criterion}" failed ${failures.length}/${entries.length} times`
    );
  }
});
