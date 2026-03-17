import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

// ─── UK Test Query Definitions ───

interface TestQuery {
  id: number;
  query: string;
  category: string;
  tags: string[];
  lat: number;
  lng: number;
}

const LONDON = { lat: 51.5074, lng: -0.1278 };
const MANCHESTER = { lat: 53.4808, lng: -2.2426 };
const EDINBURGH = { lat: 55.9533, lng: -3.1883 };
const BIRMINGHAM = { lat: 52.4862, lng: -1.8904 };

const UK_QUERIES: TestQuery[] = [
  { id: 101, query: "Italian restaurant in London tonight for 2", category: "cuisine", tags: ["cuisine:italian", "city:london", "country:gb"], ...LONDON },
  { id: 102, query: "Sushi in London Friday 7pm for 2", category: "cuisine", tags: ["cuisine:japanese", "city:london", "country:gb"], ...LONDON },
  { id: 103, query: "Steakhouse in London Saturday 8pm for 4", category: "cuisine", tags: ["cuisine:steakhouse", "city:london", "country:gb"], ...LONDON },
  { id: 104, query: "Indian curry house Manchester tonight for 3", category: "cuisine", tags: ["cuisine:indian", "city:manchester", "country:gb"], ...MANCHESTER },
  { id: 105, query: "Fine dining Edinburgh Friday 8pm for 2", category: "cuisine", tags: ["cuisine:fine dining", "city:edinburgh", "country:gb"], ...EDINBURGH },
  { id: 106, query: "Gastropub in Birmingham tonight for 4", category: "amenity", tags: ["amenity:gastropub", "city:birmingham", "country:gb"], ...BIRMINGHAM },
  { id: 107, query: "Seafood restaurant London tonight for 2", category: "cuisine", tags: ["cuisine:seafood", "city:london", "country:gb"], ...LONDON },
  { id: 108, query: "Thai food Manchester tomorrow 7pm for 2", category: "cuisine", tags: ["cuisine:thai", "city:manchester", "country:gb"], ...MANCHESTER },
  { id: 109, query: "Rooftop restaurant London tonight for 2", category: "amenity", tags: ["amenity:rooftop", "city:london", "country:gb"], ...LONDON },
  { id: 110, query: "Brunch in London Saturday 11am for 4", category: "time", tags: ["meal:brunch", "city:london", "country:gb"], ...LONDON },
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

function validateUKResponse(tq: TestQuery, data: any): ValidationResult[] {
  const results: ValidationResult[] = [];

  // 1. Response structure
  const hasResults = Array.isArray(data?.results);
  const hasParams = data?.params && typeof data.params === "object";
  results.push({
    criterion: "response_structure",
    passed: hasResults && hasParams,
    detail: `results=${hasResults}, params=${hasParams}`,
  });
  if (!hasResults || !hasParams) return results;

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

  // 3. UK country detection
  const countryIsGB = (params.country || "").toLowerCase() === "gb";
  results.push({
    criterion: "uk_country_detection",
    passed: countryIsGB,
    detail: `country="${params.country}" (expected "gb")`,
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

  // 6. No fabricated slots
  const otResults = restaurants.filter((r: any) => r.platform === "opentable");
  const otNoSlots = otResults.filter((r: any) => !r.timeSlots || r.timeSlots.length === 0);
  results.push({
    criterion: "no_fabricated_slots",
    passed: otNoSlots.length === 0,
    detail: `OT: ${otResults.length} total, ${otNoSlots.length} with no slots`,
  });

  // 7. OpenTable UK domain check
  const otUKDomain = otResults.filter((r: any) => {
    const url = r.platformUrl || "";
    return url.includes("opentable.co.uk") || url.includes("opentable.com");
  });
  if (otResults.length > 0) {
    const ukDomainCount = otResults.filter((r: any) => (r.platformUrl || "").includes("opentable.co.uk")).length;
    results.push({
      criterion: "opentable_uk_domain",
      passed: ukDomainCount > 0 || otResults.length === 0,
      detail: `${ukDomainCount}/${otResults.length} OT results use .co.uk domain`,
    });
  }

  // 8. No duplicates
  const names = restaurants.map((r: any) => (r.name || "").toLowerCase().trim());
  const uniqueNames = new Set(names);
  results.push({
    criterion: "no_duplicates",
    passed: uniqueNames.size === names.length,
    detail: uniqueNames.size === names.length ? `${names.length} unique` : `${names.length - uniqueNames.size} duplicates`,
  });

  // 9. Result count
  results.push({
    criterion: "result_count",
    passed: restaurants.length >= 1,
    detail: `${restaurants.length} results`,
  });

  // 10. Slot ordering
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
        lat: tq.lat,
        lng: tq.lng,
      }),
    });
    const body = await resp.text();
    const elapsed = Date.now() - start;

    if (!resp.ok) {
      return {
        id: tq.id, query: tq.query, category: tq.category,
        responseTimeMs: elapsed, resultCount: 0,
        validations: [{ criterion: "http_status", passed: false, detail: `${resp.status}: ${body.slice(0, 200)}` }],
        error: `HTTP ${resp.status}`,
      };
    }

    const data = JSON.parse(body);
    const validations = validateUKResponse(tq, data);
    return {
      id: tq.id, query: tq.query, category: tq.category,
      responseTimeMs: elapsed, resultCount: (data.results || []).length,
      validations,
    };
  } catch (e) {
    return {
      id: tq.id, query: tq.query, category: tq.category,
      responseTimeMs: Date.now() - start, resultCount: 0,
      validations: [], error: e instanceof Error ? e.message : String(e),
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
      console.log(`  [${status}] #${r.id} "${r.query}" — ${r.resultCount} results, ${r.responseTimeMs}ms, ${passCount}✓ ${failCount}✗`);
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

function printSummary(results: QueryResult[]) {
  console.log("\n\n══════════════════════════════════════════════════════");
  console.log("           UK SEARCH TEST REPORT");
  console.log("══════════════════════════════════════════════════════\n");

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

  const criterionMap = new Map<string, { pass: number; fail: number }>();
  for (const r of results) {
    for (const v of r.validations) {
      const entry = criterionMap.get(v.criterion) || { pass: 0, fail: 0 };
      if (v.passed) entry.pass++; else entry.fail++;
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

const BATCH_SIZE = 2;

const UK_GROUPS: [string, number, number][] = [
  ["UK Batch 1: London cuisine (#101-103)", 0, 3],
  ["UK Batch 2: Manchester/Edinburgh/Birmingham (#104-106)", 3, 6],
  ["UK Batch 3: London seafood/Thai/rooftop (#107-109)", 6, 9],
  ["UK Batch 4: London brunch (#110)", 9, 10],
];

for (const [name, start, end] of UK_GROUPS) {
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    const queries = UK_QUERIES.slice(start, end);
    console.log(`\nRunning ${queries.length} UK queries in batches of ${BATCH_SIZE}...\n`);

    const results = await runBatch(queries, BATCH_SIZE);
    printSummary(results);

    // Assert no errors
    const errors = results.filter((r) => r.error);
    assertEquals(errors.length, 0, `${errors.length} queries had errors: ${errors.map((e) => `#${e.id}: ${e.error}`).join(", ")}`);

    // Assert critical criteria
    const criticalCriteria = ["response_structure", "query_parsing", "time_slot_format", "uk_country_detection"];
    for (const criterion of criticalCriteria) {
      const entries = results.flatMap((r) => r.validations.filter((v) => v.criterion === criterion));
      const failures = entries.filter((v) => !v.passed);
      assert(
        failures.length === 0,
        `Critical criterion "${criterion}" failed ${failures.length}/${entries.length} times`
      );
    }
  });
}
