import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

// ─── Test Queries ───

interface VerifyQuery {
  id: number;
  query: string;
  lat: number;
  lng: number;
  label: string;
}

const QUERIES: VerifyQuery[] = [
  { id: 1, query: "Italian tonight for 2", lat: 33.749, lng: -84.388, label: "Atlanta Italian (mixed)" },
  { id: 2, query: "Sushi Friday 7pm for 2", lat: 40.7128, lng: -74.006, label: "NYC Sushi (Resy-heavy)" },
  { id: 3, query: "Steakhouse tonight for 4", lat: 41.8781, lng: -87.6298, label: "Chicago Steakhouse (OT-heavy)" },
  { id: 4, query: "Thai food tonight for 2", lat: 33.749, lng: -84.388, label: "Atlanta Thai (mixed)" },
  { id: 5, query: "Seafood tonight for 2", lat: 25.7617, lng: -80.1918, label: "Miami Seafood (Yelp+mixed)" },
  { id: 6, query: "French bistro Saturday 7pm", lat: 37.7749, lng: -122.4194, label: "SF French (mixed)" },
];

// ─── URL Parameter Validation ───

interface UrlCheck {
  restaurant: string;
  platform: string;
  url: string;
  hasDate: boolean;
  hasPartySize: boolean;
  hasTime: boolean;
  allPresent: boolean;
}

function validateUrlParams(restaurant: any): UrlCheck {
  const url = restaurant.platformUrl || "";
  const platform = restaurant.platform || "";
  const name = restaurant.name || "";

  let hasDate = false;
  let hasPartySize = false;
  let hasTime = false;

  try {
    const u = new URL(url);
    const sp = u.searchParams;

    if (platform === "resy") {
      hasDate = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") || "");
      hasPartySize = parseInt(sp.get("seats") || "0") >= 1;
      hasTime = /^\d{4}$/.test(sp.get("time") || ""); // HHMM format
    } else if (platform === "opentable") {
      const dt = sp.get("dateTime") || "";
      hasDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt);
      hasPartySize = parseInt(sp.get("covers") || "0") >= 1;
      hasTime = hasDate; // dateTime includes time
    } else if (platform === "yelp") {
      hasDate = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") || "");
      hasPartySize = parseInt(sp.get("covers") || "0") >= 1;
      hasTime = /^\d{4}$/.test(sp.get("time") || ""); // HHMM format
    }
  } catch {
    // Invalid URL
  }

  return {
    restaurant: name,
    platform,
    url,
    hasDate,
    hasPartySize,
    hasTime,
    allPresent: hasDate && hasPartySize && hasTime,
  };
}

// ─── URL Reachability ───

interface ReachResult {
  restaurant: string;
  platform: string;
  url: string;
  status: number;
  reachable: boolean;
  error?: string;
}

async function checkReachability(restaurant: any): Promise<ReachResult> {
  const url = restaurant.platformUrl || "";
  const name = restaurant.name || "";
  const platform = restaurant.platform || "";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TableFinder/1.0)" },
    });
    clearTimeout(timeout);
    const body = await resp.text(); // consume body
    const reachable = resp.status >= 200 && resp.status < 400;
    return { restaurant: name, platform, url, status: resp.status, reachable };
  } catch (e) {
    return {
      restaurant: name,
      platform,
      url,
      status: 0,
      reachable: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Time Slot Re-verification via Firecrawl ───

const TIME_12H_RE = /\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm))\b/g;

function extractTimesFromMarkdown(md: string): string[] {
  const matches = md.match(TIME_12H_RE) || [];
  return [...new Set(matches.map((t) => t.replace(/\s+/g, " ").trim().toUpperCase()))];
}

function normalizeSlotTime(t: string): string {
  return t.replace(/\s+/g, " ").trim().toUpperCase();
}

interface SlotVerifyResult {
  restaurant: string;
  platform: string;
  originalSlots: string[];
  rescrapedSlots: string[];
  matchedSlots: string[];
  matchRatio: number;
  passed: boolean;
  error?: string;
}

async function verifySlots(restaurant: any): Promise<SlotVerifyResult> {
  const name = restaurant.name || "";
  const platform = restaurant.platform || "";
  const url = restaurant.platformUrl || "";
  const originalSlots = (restaurant.timeSlots || []).map((s: any) => normalizeSlotTime(s.time));

  if (originalSlots.length === 0) {
    return {
      restaurant: name, platform, originalSlots, rescrapedSlots: [],
      matchedSlots: [], matchRatio: 0, passed: false, error: "no original slots",
    };
  }

  try {
    const fcKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!fcKey) {
      return {
        restaurant: name, platform, originalSlots, rescrapedSlots: [],
        matchedSlots: [], matchRatio: 0, passed: false, error: "FIRECRAWL_API_KEY not set",
      };
    }

    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${fcKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: false,
        waitFor: platform === "opentable" ? 5000 : 3000,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return {
        restaurant: name, platform, originalSlots, rescrapedSlots: [],
        matchedSlots: [], matchRatio: 0, passed: false,
        error: `Firecrawl ${resp.status}: ${data?.error || "unknown"}`,
      };
    }

    const md = data?.data?.markdown || data?.markdown || "";
    const rescrapedSlots = extractTimesFromMarkdown(md);

    const matchedSlots = originalSlots.filter((os: string) =>
      rescrapedSlots.some((rs: string) => rs === os)
    );

    const matchRatio = originalSlots.length > 0 ? matchedSlots.length / originalSlots.length : 0;

    return {
      restaurant: name, platform, originalSlots, rescrapedSlots,
      matchedSlots, matchRatio, passed: matchRatio >= 0.5,
    };
  } catch (e) {
    return {
      restaurant: name, platform, originalSlots, rescrapedSlots: [],
      matchedSlots: [], matchRatio: 0, passed: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Search Helper ───

async function runSearch(q: VerifyQuery): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ query: q.query, lat: q.lat, lng: q.lng }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Search failed ${resp.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

// ─── Report Printer ───

function printReport(
  queryLabel: string,
  urlChecks: UrlCheck[],
  reachResults: ReachResult[],
  slotResults: SlotVerifyResult[],
) {
  console.log(`\n── ${queryLabel} ──`);

  // URL Params
  const urlPass = urlChecks.filter((c) => c.allPresent).length;
  console.log(`  URL Params: ${urlPass}/${urlChecks.length} have all required params`);
  for (const c of urlChecks.filter((c) => !c.allPresent)) {
    console.log(`    ✗ ${c.restaurant} (${c.platform}): date=${c.hasDate} party=${c.hasPartySize} time=${c.hasTime}`);
    console.log(`      URL: ${c.url}`);
  }

  // Reachability
  const reachPass = reachResults.filter((r) => r.reachable).length;
  console.log(`  Reachability: ${reachPass}/${reachResults.length} reachable`);
  for (const r of reachResults.filter((r) => !r.reachable)) {
    console.log(`    ✗ ${r.restaurant} (${r.platform}): ${r.status} ${r.error || ""}`);
  }

  // Slot verification
  if (slotResults.length > 0) {
    const slotPass = slotResults.filter((s) => s.passed).length;
    console.log(`  Slot Verify: ${slotPass}/${slotResults.length} passed (≥50% match)`);
    for (const s of slotResults) {
      const status = s.passed ? "✓" : "✗";
      console.log(`    ${status} ${s.restaurant} (${s.platform}): ${s.matchedSlots.length}/${s.originalSlots.length} matched (${(s.matchRatio * 100).toFixed(0)}%)`);
      if (!s.passed) {
        console.log(`      Original: ${s.originalSlots.join(", ")}`);
        console.log(`      Rescraped: ${s.rescrapedSlots.slice(0, 10).join(", ")}${s.rescrapedSlots.length > 10 ? "..." : ""}`);
        if (s.error) console.log(`      Error: ${s.error}`);
      }
    }
  }
}

// ─── Tests ───

const BATCH_1 = QUERIES.slice(0, 3);
const BATCH_2 = QUERIES.slice(3, 6);

for (const [batchName, batch] of [
  ["Link Verify Batch 1 (queries 1-3)", BATCH_1],
  ["Link Verify Batch 2 (queries 4-6)", BATCH_2],
] as [string, VerifyQuery[]][]) {
  Deno.test({
    name: batchName,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async () => {
    let totalUrlChecks = 0;
    let totalUrlPass = 0;
    let totalReachChecks = 0;
    let totalReachPass = 0;
    let totalSlotChecks = 0;
    let totalSlotPass = 0;

    for (const q of batch) {
      console.log(`\nSearching: "${q.query}" [${q.label}]...`);
      const data = await runSearch(q);
      const results = data.results || [];
      console.log(`  Got ${results.length} results`);

      if (results.length === 0) {
        console.log(`  ⚠ No results for "${q.query}", skipping`);
        continue;
      }

      // 1. URL Parameter validation (all results)
      const urlChecks = results.map(validateUrlParams);
      totalUrlChecks += urlChecks.length;
      totalUrlPass += urlChecks.filter((c: UrlCheck) => c.allPresent).length;

      // 2. Reachability (sample up to 3 per platform)
      const byPlatform = new Map<string, any[]>();
      for (const r of results) {
        const list = byPlatform.get(r.platform) || [];
        list.push(r);
        byPlatform.set(r.platform, list);
      }
      const reachSample: any[] = [];
      for (const [, list] of byPlatform) {
        reachSample.push(...list.slice(0, 3));
      }

      const reachResults: ReachResult[] = [];
      // Check 2 at a time to avoid overwhelming
      for (let i = 0; i < reachSample.length; i += 2) {
        const batchSlice = reachSample.slice(i, i + 2);
        const batchResults = await Promise.all(batchSlice.map(checkReachability));
        reachResults.push(...batchResults);
      }
      totalReachChecks += reachResults.length;
      totalReachPass += reachResults.filter((r) => r.reachable).length;

      // 3. Slot re-verification (sample up to 2 results with slots)
      const withSlots = results.filter((r: any) => r.timeSlots && r.timeSlots.length > 0);
      const slotSample = withSlots.slice(0, 2);
      const slotResults: SlotVerifyResult[] = [];
      for (const r of slotSample) {
        const result = await verifySlots(r);
        slotResults.push(result);
      }
      totalSlotChecks += slotResults.length;
      totalSlotPass += slotResults.filter((s) => s.passed).length;

      printReport(q.label, urlChecks, reachResults, slotResults);
    }

    // ─── Summary ───
    console.log("\n\n══════════════════════════════════════════════════════");
    console.log("        LINK & SLOT VERIFICATION SUMMARY");
    console.log("══════════════════════════════════════════════════════");
    console.log(`  URL Params:    ${totalUrlPass}/${totalUrlChecks} (${totalUrlChecks > 0 ? ((totalUrlPass / totalUrlChecks) * 100).toFixed(0) : 0}%)`);
    console.log(`  Reachability:  ${totalReachPass}/${totalReachChecks} (${totalReachChecks > 0 ? ((totalReachPass / totalReachChecks) * 100).toFixed(0) : 0}%)`);
    console.log(`  Slot Accuracy: ${totalSlotPass}/${totalSlotChecks} (${totalSlotChecks > 0 ? ((totalSlotPass / totalSlotChecks) * 100).toFixed(0) : 0}%)`);
    console.log("══════════════════════════════════════════════════════\n");

    // Assert critical: all URLs must have correct params
    assert(
      totalUrlPass === totalUrlChecks,
      `${totalUrlChecks - totalUrlPass}/${totalUrlChecks} URLs missing required parameters`
    );

    // Assert: at least 80% of sampled URLs are reachable
    const reachRate = totalReachChecks > 0 ? totalReachPass / totalReachChecks : 1;
    assert(
      reachRate >= 0.8,
      `URL reachability too low: ${(reachRate * 100).toFixed(0)}% (need ≥80%)`
    );
  });
}
