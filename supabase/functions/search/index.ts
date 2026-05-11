// TableFinder Search Edge Function — v17
// Platforms: Resy, OpenTable, Yelp
//
// Required env vars:
//   FIRECRAWL_API_KEY
//   LOVABLE_API_KEY
//
// Optional:
//   APIFY_API_TOKEN   — enables OpenTable via Apify
//   SCRAPER_LAMBDA_URL — AWS Lambda scraper URL (enables real-browser Resy + OT)
//   SCRAPER_SECRET     — shared secret for Lambda scraper auth
//
// v16 changes:
//   • lambdaLoad(): replaces bbLoad() CDP WebSocket — simple HTTP call to AWS Lambda
//   • AWS Lambda runs real headless Chrome (@sparticuz/chromium + playwright-core)
//   • discoverResyViaBB/discoverOTViaBB/verifyResyViaBB/verifyOTViaBB now use Lambda
//   • verifyYelp: detects /reservations/→/biz/ redirects (fixes false positives like
//     Poor Calvin's that appear in Yelp search but don't use Yelp reservations)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const AI_GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const FC_API     = "https://api.firecrawl.dev/v2";
const APIFY_API  = "https://api.apify.com/v2";
const PHOTON     = "https://photon.komoot.io/api";

const GLOBAL_TIMEOUT  = 115_000;
const DISCOVER_MS     =  30_000;  // per-platform discovery budget (BB session spin-up needs ~15s headroom)
const VERIFY_MS       =  35_000;  // per-platform verification budget (was 10s — key fix)
const GEOCODE_MS      =  10_000;  // geocodeAndRank hard cap
const ENRICH_MS       =  10_000;  // AI enrichment hard cap
const VERIFY_CONCUR   =       3;  // concurrent scrapes per platform (3 platforms × 3 = 9 peak — safe rate limit)
const VERIFY_MAX      =       8;  // max verified results per platform

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface TimeSlot { time: string; url?: string; }

interface Restaurant {
  id: string;
  name: string;
  cuisine: string;
  neighborhood: string;
  rating?: number;
  reviewCount?: number;
  priceRange?: string;
  description?: string;
  vibeTags?: string[];
  platform: "resy" | "opentable" | "yelp";
  platformUrl: string;
  timeSlots: TimeSlot[];
  distanceMiles?: number | null;
  softVerified?: boolean;
  _lat?: number; _lng?: number;
  _slug?: string; _rid?: string;
  _preVerified?: boolean;
  _address?: string;   // extracted from scraped markdown; geocoding fallback
  _widgetUrl?: string; // OT widget canvas URL (lighter Akamai target than main page)
}

interface SearchParams {
  cuisine: string; cuisineType: string; dishKeyword: string;
  date: string;       // YYYY-MM-DD
  time: string;       // HH:MM 24h
  partySize: number;
  city: string; state: string; country: string;
  lat?: number; lng?: number;
}

interface SearchMeta {
  date: string; dateRaw: string; time: string;
  partySize: number; city: string; state?: string; country?: string;
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const start = Date.now();
  try {
    const body = await req.json();
    const FIRECRAWL      = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
    const AI_KEY         = Deno.env.get("LOVABLE_API_KEY") ?? "";
    const APIFY          = Deno.env.get("APIFY_API_TOKEN") ?? "";
    const SCRAPER_URL    = Deno.env.get("SCRAPER_LAMBDA_URL") ?? "";
    const SCRAPER_SECRET = Deno.env.get("SCRAPER_SECRET") ?? "";
    const BB_KEY         = Deno.env.get("BROWSERBASE_API_KEY")    ?? "";
    const BB_PROJECT     = Deno.env.get("BROWSERBASE_PROJECT_ID") ?? "";

    if (body.extended === true) {
      const extra = await runExtendedSearch(body, FIRECRAWL, AI_KEY, APIFY, SCRAPER_URL, SCRAPER_SECRET);
      return json({ results: extra });
    }

    const { query, lat, lng, location } = body;
    const params = await withTimeout(
      parseQuery(query, lat, lng, location, AI_KEY),
      5_000,
      fallbackParams(lat, lng, location)
    );
    console.log(`[params] ${JSON.stringify(params)}`);

    // ── Discovery ─────────────────────────────────────────────────────────────
    // When Browserbase keys are present, all three platforms run in parallel via
    // real browser (CDP). Otherwise: Resy = 0 (SPA blocks bots), OT = Apify if
    // configured else 0 (Akamai blocks bots), Yelp = always via Firecrawl.
    const [resyCands, otCands, yelpCands] = await Promise.all([
      SCRAPER_URL && SCRAPER_SECRET
        ? abortableDiscover(() => discoverResyViaBB(params, SCRAPER_URL, SCRAPER_SECRET), DISCOVER_MS)
        : Promise.resolve([] as Restaurant[]),
      BB_KEY && BB_PROJECT
        ? abortableDiscover(() => discoverOTViaBB(params, BB_KEY, BB_PROJECT), DISCOVER_MS)
        : APIFY
          ? abortableDiscover(() => discoverOpenTable(params, FIRECRAWL, APIFY), DISCOVER_MS)
          : Promise.resolve([] as Restaurant[]),
      abortableDiscover(() => discoverYelp(params, FIRECRAWL), DISCOVER_MS),
    ]);
    console.log(`[discovery] resy=${resyCands.length} ot=${otCands.length} yelp=${yelpCands.length} at ${Date.now()-start}ms`);

    const resySlice = resyCands.slice(0, 15);
    const otSlice   = otCands.slice(0, 15);
    const yelpSlice = yelpCands.slice(0, 18);

    // ── Verification ──────────────────────────────────────────────────────────
    const verifyStart = Date.now();
    const [resyVer, otVer, yelpVer] = await Promise.all([
      verifyBatch(resySlice,  params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET, "",       ""),
      verifyBatch(otSlice,    params, FIRECRAWL, VERIFY_MS, "",           "",             BB_KEY, BB_PROJECT),
      verifyBatch(yelpSlice,  params, FIRECRAWL, VERIFY_MS),
    ]);
    console.log(`[verify] resy=${resyVer.length} ot=${otVer.length} yelp=${yelpVer.length} in ${Date.now()-verifyStart}ms`);

    let verified = dedup([...resyVer, ...otVer, ...yelpVer]);
    const softVerified  = verified.filter(r => r.softVerified).slice(0, 3);
    const hardVerified  = verified.filter(r => !r.softVerified);

    // ── Geocode + Enrich ──────────────────────────────────────────────────────
    const [ranked] = await Promise.all([
      withTimeout(geocodeAndRank(hardVerified, params), GEOCODE_MS, hardVerified),
      withTimeout(enrich(hardVerified, params, AI_KEY), ENRICH_MS,  hardVerified),
    ]);
    verified = [...ranked, ...softVerified];

    // Remaining candidates for optional second pass
    const verifiedIds = new Set(verified.map(r => r.id));
    const attempted   = new Set([...resySlice, ...otSlice, ...yelpSlice].map(r => r.id));
    const remaining   = dedup(
      [...resyCands, ...otCands, ...yelpCands]
        .filter(r => !attempted.has(r.id) && !verifiedIds.has(r.id))
    ).slice(0, 18);

    const meta: SearchMeta = {
      date:      formatDisplayDate(params.date),
      dateRaw:   params.date,
      time:      formatDisplayTime(params.time),
      partySize: params.partySize,
      city:      params.city,
      state:     params.state,
      country:   params.country,
    };

    const elapsed = Date.now() - start;
    console.log(`[done] ${verified.length} results in ${elapsed}ms`);
    return json({
      results:             verified.slice(0, 24),
      params:              meta,
      hasMore:             remaining.length > 0,
      remainingCandidates: remaining,
      _v:                  "v17b-bb-timeout-fix",
      _debug: {
        elapsed_ms:     elapsed,
        discovery:      { resy: resyCands.length, ot: otCands.length, yelp: yelpCands.length },
        verified:       { resy: resyVer.length, ot: otVer.length, yelp: yelpVer.length },
        scraper_enabled: !!(SCRAPER_URL && SCRAPER_SECRET),
        bb_enabled:      !!(BB_KEY && BB_PROJECT),
      },
    });

  } catch (err: any) {
    console.error("[error]", err);
    return json({ error: err?.message ?? "Search failed. Please try again." }, 500);
  }
});

// ─── ABORT-SAFE DISCOVERY WRAPPER ─────────────────────────────────────────────
// Unlike plain withTimeout, this creates an AbortController and passes it to the
// discover function via a closure, so the underlying Firecrawl HTTP requests are
// actually cancelled when the budget expires.

async function abortableDiscover(
  fn: () => Promise<Restaurant[]>,
  budgetMs: number,
): Promise<Restaurant[]> {
  return withTimeout(fn(), budgetMs, []);
}

// ─── EXTENDED SEARCH ─────────────────────────────────────────────────────────

async function runExtendedSearch(
  body: any, FIRECRAWL: string, AI_KEY: string, APIFY: string, SCRAPER_URL: string, SCRAPER_SECRET: string,
): Promise<Restaurant[]> {
  const { remainingCandidates, extendedParams } = body;
  if (!remainingCandidates?.length) return [];

  const rawDate = extendedParams.dateRaw || extendedParams.date || new Date().toISOString().split("T")[0];
  const rawTime = /^\d{2}:\d{2}$/.test(extendedParams.time ?? "")
    ? extendedParams.time
    : displayTo24(extendedParams.time ?? "7:00 PM");

  const params: SearchParams = {
    cuisine:     extendedParams.cuisine     ?? "",
    cuisineType: extendedParams.cuisineType ?? "",
    dishKeyword: extendedParams.dishKeyword ?? "",
    date:        rawDate,
    time:        rawTime,
    partySize:   Number(extendedParams.partySize) || 2,
    city:        extendedParams.city    ?? "",
    state:       extendedParams.state   ?? "",
    country:     extendedParams.country ?? "us",
    lat:         body.lat ?? extendedParams.lat,
    lng:         body.lng ?? extendedParams.lng,
  };

  const BB_KEY2     = Deno.env.get("BROWSERBASE_API_KEY")    ?? "";
  const BB_PROJECT2 = Deno.env.get("BROWSERBASE_PROJECT_ID") ?? "";
  const batch = (remainingCandidates as Restaurant[]).slice(0, 18);
  const [resyVer, otVer, yelpVer] = await Promise.all([
    verifyBatch(batch.filter(r => r.platform === "resy"),      params, FIRECRAWL, VERIFY_MS, SCRAPER_URL, SCRAPER_SECRET, "",        ""),
    verifyBatch(batch.filter(r => r.platform === "opentable"), params, FIRECRAWL, VERIFY_MS, "",           "",             BB_KEY2, BB_PROJECT2),
    verifyBatch(batch.filter(r => r.platform === "yelp"),      params, FIRECRAWL, VERIFY_MS),
  ]);

  let verified = dedup([...resyVer, ...otVer, ...yelpVer]);
  const [ranked] = await Promise.all([
    withTimeout(geocodeAndRank(verified, params), GEOCODE_MS, verified),
    withTimeout(enrich(verified, params, AI_KEY), ENRICH_MS,  verified),
  ]);
  return ranked;
}

// ─── QUERY PARSING ────────────────────────────────────────────────────────────

async function parseQuery(
  query: string, lat?: number, lng?: number, location?: string, aiKey?: string
): Promise<SearchParams> {
  const todayStr = new Date().toISOString().split("T")[0];
  const locCtx   = location ?? (lat && lng ? `${lat.toFixed(4)},${lng.toFixed(4)}` : "unknown");

  const prompt = `Extract restaurant search parameters. Today is ${todayStr}.
Rules:
- date: YYYY-MM-DD. "tonight"/"today"=${todayStr}. "tomorrow"=next day. Day name=nearest upcoming.
- time: HH:MM 24h. Default 19:00. lunch≈12:00 brunch≈11:00 dinner≈19:00.
- partySize: integer, default 2.
- city: infer from location context. Do not guess.
- state: 2-letter US or empty for UK.
- country: "us" or "gb". Default "us".
- cuisine: specific type (e.g. "Italian","sushi","steakhouse") or "" if none.
- cuisineType: broad category or "".
- dishKeyword: specific dish or "".
Location context: ${locCtx}
Query: "${query}"
Respond ONLY with valid JSON (no markdown):
{"cuisine":"","cuisineType":"","dishKeyword":"","date":"","time":"","partySize":2,"city":"","state":"","country":"us"}`;

  const resp = await fetch(AI_GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`AI gateway ${resp.status}`);
  const data = await resp.json();
  const raw    = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

  return {
    cuisine:     parsed.cuisine     || "",
    cuisineType: parsed.cuisineType || "",
    dishKeyword: parsed.dishKeyword || "",
    date:        parsed.date        || todayStr,
    time:        parsed.time        || "19:00",
    partySize:   Number(parsed.partySize) || 2,
    city:        parsed.city  || extractCityFromLocation(location),
    state:       (parsed.state || "").toUpperCase().slice(0, 2),
    country:     parsed.country || "us",
    lat, lng,
  };
}

function fallbackParams(lat?: number, lng?: number, location?: string): SearchParams {
  const metro = (lat != null && lng != null) ? nearestResyMetro(lat, lng) : null;
  return {
    cuisine: "", cuisineType: "", dishKeyword: "",
    date: new Date().toISOString().split("T")[0],
    time: "19:00", partySize: 2,
    city:    metro?.name ?? extractCityFromLocation(location) ?? "Atlanta",
    state:   metro ? metro.slug.split("-").pop()?.toUpperCase() ?? "" : "",
    country: "us", lat, lng,
  };
}

function extractCityFromLocation(loc?: string): string {
  if (!loc) return "";
  return loc.split(",")[0]?.trim() || "";
}

// ─── LAMBDA SCRAPER CLIENT ────────────────────────────────────────────────────
// Simple HTTP call to our AWS Lambda function that runs real headless Chrome.
// Lambda handles all browser complexity; edge function just sends URL, gets text back.
// evalExpr defaults to document.body.innerText; pass a JS expression for DOM data.

async function lambdaLoad(
  url: string,
  scraperUrl: string,
  scraperSecret: string,
  opts: { waitMs?: number; useProxy?: boolean; evalExpr?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { waitMs = 4000, useProxy = false, evalExpr, timeoutMs = 28_000 } = opts;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(scraperUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ url, waitMs, evalExpr, useProxy, secret: scraperSecret }),
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`Lambda scraper HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(`Lambda: ${data.error}`);
    return String(data.content ?? "");
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── BROWSERBASE CDP CLIENT ───────────────────────────────────────────────────
// Raw CDP over WebSocket — no npm packages, Deno built-in WebSocket.
// Creates a real Chrome session on Browserbase (residential IP pool),
// navigates to the target URL, waits for React/SPA to render, then evaluates
// a JS expression and returns the result as a string.
// Used for OT which blocks all datacenter IPs via Akamai Bot Manager.

async function bbLoad(
  url: string,
  bbKey: string,
  bbProject: string,
  opts: { waitMs?: number; useProxy?: boolean; timeoutMs?: number; evalExpr?: string } = {},
): Promise<string> {
  const { waitMs = 4000, useProxy = true, timeoutMs = 25_000, evalExpr } = opts;

  // Step 1: Create Browserbase session (residential proxy enabled by default for OT)
  const sessResp = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "x-bb-api-key": bbKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: bbProject,
      browserSettings: { solveCaptchas: true },
      ...(useProxy ? { proxies: [{ type: "browserbase" }] } : {}),
    }),
  });
  if (!sessResp.ok) throw new Error(`BB create session: ${sessResp.status}`);
  const { id: sessionId } = await sessResp.json();

  // Step 2: CDP over WebSocket
  let msgId = 0;
  const pending = new Map<number, [(v: any) => void, (e: Error) => void]>();

  const ws = new WebSocket(
    `wss://connect.browserbase.com?apiKey=${bbKey}&sessionId=${sessionId}`
  );

  function cdpSend(method: string, params: any = {}, sid?: string): Promise<any> {
    return new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, [res, rej]);
      const msg: any = { id, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
    });
  }

  let outerResolve!: (v: string) => void;
  let outerReject!:  (e: any)    => void;
  const result = new Promise<string>((res, rej) => {
    outerResolve = res;
    outerReject  = rej;
  });

  const timer = setTimeout(() => {
    ws.close();
    outerReject(new Error(`bbLoad timeout ${timeoutMs}ms for ${url}`));
  }, timeoutMs);

  ws.onmessage = (evt: MessageEvent) => {
    try {
      const msg = JSON.parse(evt.data as string);
      if (msg.id && pending.has(msg.id)) {
        const [res, rej] = pending.get(msg.id)!;
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message ?? "CDP error")) : res(msg.result);
      }
    } catch { /* ignore parse errors */ }
  };

  ws.onerror = () => { clearTimeout(timer); outerReject(new Error("BB WebSocket error")); };

  ws.onopen = async () => {
    try {
      const { targetInfos } = await cdpSend("Target.getTargets");
      const page = (targetInfos as any[]).find(t => t.type === "page");
      if (!page) throw new Error("No page target");

      const { sessionId: pageSid } = await cdpSend("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });

      await cdpSend("Page.navigate", { url }, pageSid);
      await new Promise(r => setTimeout(r, waitMs));

      const expr = evalExpr ?? "document.body.innerText";
      const { result: evalResult } = await cdpSend("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, pageSid);

      clearTimeout(timer);
      ws.close();
      outerResolve(String(evalResult?.value ?? ""));
    } catch (e: any) {
      clearTimeout(timer);
      ws.close();
      outerReject(e);
    }
  };

  try {
    return await result;
  } finally {
    fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
      method: "POST",
      headers: { "x-bb-api-key": bbKey, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    }).catch(() => {});
  }
}

// ─── RESY DISCOVERY ───────────────────────────────────────────────────────────
// PRIMARY: scrape Resy's own search page — pre-filtered for the exact date/time/party size.
// Only restaurants with confirmed availability appear. No Google index dependency.
// Resy does NOT use Akamai, so Firecrawl can access it freely.
// FALLBACK: Google-based site: search if the direct scrape yields < 3 venues.

async function discoverResy(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const slug   = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  const metro  = resyCityName(params.city, params.state, params.lat, params.lng);
  const tNoCol = params.time.replace(":", "");

  // Direct Resy search URL — only shows restaurants available on this date/time/size
  const cuiQ   = params.cuisine ? `&cuisine=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://resy.com/cities/${slug}/venues?seats=${params.partySize}&date=${params.date}&time=${tNoCol}${cuiQ}`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 11_000);
    const resp  = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        url: searchUrl, formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 4000,   // Resy is a React SPA — needs time to render venue list
        timeout: 10000,
      }),
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      const urls = extractResyVenueUrls(md);
      if (urls.length >= 3) {
        console.log(`[Resy direct] ${urls.length} venues found`);
        return urls.map(u => normToResy({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
      }
      console.log(`[Resy direct] only ${urls.length} venues (md=${md.length}) — falling back to Google`);
    } else {
      console.log(`[Resy direct] HTTP ${resp.status} — falling back to Google`);
    }
  } catch (err: any) {
    console.log(`[Resy direct] ${err?.message} — falling back to Google`);
  }

  // Google fallback — inurl: targets the exact URL path pattern that normToResy
  // requires (/cities/slug/venues/slug). site: with path-prefix is unreliable in
  // Firecrawl's search; site: without path returns homepage/category pages that
  // normToResy filters out. inurl: reliably returns individual venue pages.
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const queries = [
    `inurl:resy.com/cities/${slug}/venues ${metro}${cuisine} restaurant`,
    `inurl:resy.com/cities/${slug}/venues ${metro} restaurant reservation`,
  ];
  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToResy(r, params)).filter(Boolean) as Restaurant[];
}

// Extract all Resy venue URLs from a scraped markdown page.
// React SPAs typically render relative hrefs, which Firecrawl preserves in markdown
// as [text](/cities/slug/venues/slug). We match both absolute and relative forms.
function extractResyVenueUrls(md: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Absolute URLs: https://resy.com/cities/atlanta-ga/venues/atlas
  const reAbs = /https?:\/\/resy\.com\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/gi;
  // Relative paths in markdown link syntax: (/cities/atlanta-ga/venues/atlas)
  const reRel = /\(\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/gi;

  for (const re of [reAbs, reRel]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const vSlug = m[2].toLowerCase();
      if (!RESY_SKIP.has(vSlug) && !seen.has(vSlug)) {
        seen.add(vSlug);
        urls.push(`https://resy.com/cities/${m[1]}/venues/${m[2]}`);
      }
    }
  }
  return urls;
}

function normToResy(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  const m   = url.match(/resy\.com\/cities\/([^/]+)\/venues\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[2].toLowerCase();
  if (RESY_SKIP.has(slug)) return null;
  const base       = `https://resy.com/cities/${m[1]}/venues/${m[2]}`;
  const bookingUrl = addResyParams(base, params);
  return {
    id: `resy-${slug}`,
    name: cleanTitle(fc.title, url, "resy"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "resy",
    platformUrl: bookingUrl,
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

const RESY_SKIP = new Set([
  "venues","search","explore","about","faq","gift-cards","events",
  "blog","careers","press","terms","privacy",
]);

// Real-browser Resy discovery via Browserbase CDP.
// Resy is a React SPA — datacenter scrapers only ever see an empty HTML shell.
// A real browser executes the JS bundle and renders the full venue list with
// actual anchor hrefs. DOM querySelectorAll reliably extracts them.
async function discoverResyViaBB(
  params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant[]> {
  const slug   = resyCitySlug(params.city, params.state, params.country, params.lat, params.lng);
  // Resy search page: /search?date=...&seats=... (not /venues? which 404s)
  const cuiQ   = params.cuisine ? `&cuisine=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://resy.com/cities/${slug}/search?date=${params.date}&seats=${params.partySize}${cuiQ}`;

  try {
    const linksJson = await lambdaLoad(searchUrl, scraperUrl, scraperSecret, {
      waitMs: 6000,
      evalExpr: `JSON.stringify([...new Set(Array.from(document.querySelectorAll('a[href*="/venues/"]')).map(a=>a.href.split('?')[0]).filter(h=>/\\/cities\\/[^/]+\\/venues\\/[^/?#]+$/.test(h)))].slice(0,20))`,
    });
    const links: string[] = JSON.parse(linksJson || "[]");
    console.log(`[Resy Lambda] ${links.length} venues discovered`);
    return links.map(u => normToResy({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
  } catch (err: any) {
    console.log(`[Resy Lambda] discovery error: ${err?.message}`);
    return [];
  }
}

// ─── OPENTABLE DISCOVERY ──────────────────────────────────────────────────────
// Akamai blocks datacenter IPs from the main OT restaurant pages.
// Two approaches:
//   1. Apify (residential proxies) — most reliable, requires paid token
//   2. Widget canvas bypass — scrapes opentable.com/widget/reservation/canvas?rid=NNN
//      which is embedded cross-origin on restaurant sites and has lighter Akamai rules.
//      We discover restaurants via Google (Firecrawl /search, no Akamai) then verify
//      via the widget endpoint rather than the main page.

async function discoverOpenTable(params: SearchParams, fcKey: string, apifyToken: string): Promise<Restaurant[]> {
  if (apifyToken) return discoverOTviaApify(params, apifyToken);
  // No Apify — fall back to widget canvas approach.
  // Discovery via Google search (no Akamai issue), verification via widget canvas.
  console.log("[OT] no Apify — trying widget canvas bypass");
  return discoverOTviaWidgetCanvas(params, fcKey);
}

async function discoverOTviaWidgetCanvas(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city    = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const domain  = params.country === "gb" ? "opentable.co.uk" : "opentable.com";

  // inurl: reliably targets pages whose URL contains the /r/ or /restaurant/profile/
  // path. site: with a path prefix is unreliable in Firecrawl's Google search API;
  // both site: and path-prefix queries return 0 usable results in practice.
  const queries = [
    `inurl:${domain}/r/ ${city}${state}${cuisine} restaurant`,
    `inurl:${domain}/r/ ${city}${state} restaurant dinner reservation`,
    `inurl:${domain}/restaurant/profile/ ${city}${state}${cuisine} restaurant`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  const candidates = results.map(r => normToOT(r, params)).filter(Boolean) as Restaurant[];

  // For each candidate with a rid, add the widget canvas URL for verification.
  // The widget canvas endpoint must be cross-origin accessible (it's embedded on
  // restaurant websites worldwide) and typically has lighter Akamai protection.
  for (const c of candidates) {
    if (c._rid) {
      const dt = `${params.date}T${params.time}`;
      c._widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${c._rid}&covers=${params.partySize}&datetime=${dt}&styleid=5&disablegt=true`;
    }
  }
  console.log(`[OT widget] ${candidates.length} candidates (with rids: ${candidates.filter(c => c._rid).length})`);
  return candidates;
}

async function discoverOTviaApify(params: SearchParams, token: string): Promise<Restaurant[]> {
  try {
    const input = {
      location: `${params.city}, ${params.state || params.country.toUpperCase()}`,
      date:     params.date,
      time:     params.time.replace(":", ""),
      covers:   params.partySize,
      keyword:  params.cuisine || undefined,
      maxItems: 15,
    };
    const resp = await fetch(
      `${APIFY_API}/acts/canadesk~opentable/run-sync-get-dataset-items?token=${token}&timeout=50&memory=256`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
    );
    if (!resp.ok) { console.warn(`[Apify OT] ${resp.status}`); return []; }
    const items: any[] = await resp.json();
    console.log(`[Apify OT] ${items.length} results`);

    return items.flatMap(item => {
      const slots: TimeSlot[] = [];
      const bookingUrl = item.link ?? item.url ?? item.bookingUrl ?? "";

      if (Array.isArray(item.availableSlots)) {
        for (const s of item.availableSlots) {
          const t = s.time ?? parseTimeFromDT(s.dateTime ?? "");
          if (t) slots.push({ time: t });
        }
      } else if (item.availableTimes) {
        for (const t of (item.availableTimes as string[])) slots.push({ time: t });
      }

      const filtered = filterWindow(slots, params.time);
      if (filtered.length === 0 && !item.name) return [];

      const rid        = extractRid(bookingUrl);
      const baseOTUrl  = (bookingUrl || `https://www.opentable.com/r/${slugify(item.name || "")}`).split("?")[0];
      const slotsWithUrls = filtered.map(s => ({ ...s, url: buildSlotUrl("opentable", baseOTUrl, params, s.time) }));

      return [{
        id:           `opentable-${rid || slugify(item.name || "")}`,
        name:         item.name ?? "Restaurant",
        cuisine:      item.cuisine ?? params.cuisine ?? "Restaurant",
        neighborhood: item.neighborhood ?? item.location ?? params.city,
        rating:       item.stars ?? item.rating,
        reviewCount:  item.reviewCount ?? item.reviews,
        priceRange:   item.priceRange ?? item.price,
        platform:     "opentable" as const,
        platformUrl:  addOTParams(baseOTUrl, params),
        timeSlots:    slotsWithUrls,
        distanceMiles: null,
        _lat: item.lat, _lng: item.lng,
        _preVerified: slotsWithUrls.length > 0,
        _rid: rid ?? undefined,
      }];
    }).filter(r => r.name);
  } catch (err) {
    console.error("[Apify OT]", err);
    return [];
  }
}

// Real-browser OT discovery via Browserbase CDP + residential proxy.
// OT uses Akamai bot-protection keyed on datacenter IP ranges.
// Browserbase's residential proxy IPs bypass Akamai's blacklist because they
// route through real ISPs indistinguishable from organic user traffic.
async function discoverOTViaBB(
  params: SearchParams, bbKey: string, bbProject: string,
): Promise<Restaurant[]> {
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";
  const dt     = `${params.date}T${params.time}`;
  const cityQ  = encodeURIComponent(params.city + (params.state ? `, ${params.state}` : ""));
  const cuiQ   = params.cuisine ? `&term=${encodeURIComponent(params.cuisine)}` : "";
  const searchUrl = `https://www.${domain}/s/?covers=${params.partySize}&dateTime=${dt}&term=${cityQ}${cuiQ}`;

  try {
    const linksJson = await bbLoad(searchUrl, bbKey, bbProject, {
      waitMs: 3000,
      useProxy: true,
      timeoutMs: 28_000,
      evalExpr: `JSON.stringify([...new Set(Array.from(document.querySelectorAll('a[href*="/r/"],a[href*="/restaurant/profile/"]')).map(a=>a.href))].slice(0,20))`,
    });
    const links: string[] = JSON.parse(linksJson || "[]");
    console.log(`[OT BB] ${links.length} restaurants discovered`);
    return links.map(u => normToOT({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
  } catch (err: any) {
    console.log(`[OT BB] discovery error: ${err?.message}`);
    return [];
  }
}

function normToOT(fc: any, params: SearchParams): Restaurant | null {
  const url    = fc.url ?? "";
  const domain = params.country === "gb" ? "opentable.co.uk" : "opentable.com";
  const mSlug  = url.match(/opentable\.(?:com|co\.uk)\/r\/([^/?#]+)/i);
  const mNum   = url.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
  if (!mSlug && !mNum) return null;
  const slug    = mSlug ? mSlug[1] : mNum![1];
  const baseUrl = `https://www.${domain}/r/${slug}`;
  const rid     = mNum ? mNum[1] : extractRid(url);
  return {
    id: `opentable-${slug}`,
    name: cleanTitle(fc.title, url, "opentable"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "opentable",
    platformUrl: addOTParams(baseUrl, params),
    timeSlots: [],
    distanceMiles: null,
    _rid: rid ?? undefined,
  };
}

// ─── YELP DISCOVERY ───────────────────────────────────────────────────────────
// TWO parallel searches:
//   1. Reservation-filtered (reservation_date/time/covers): returns ONLY native Yelp
//      restaurants. These have confirmed availability for the requested slot.
//   2. General top-rated (sortby=rating, no reservation filter): returns ALL restaurant
//      types regardless of booking platform. OT and Resy restaurants appear here but
//      not in search #1. This pool feeds the OT/Resy cross-platform bridges in verifyYelp.
// Both results are merged (reservation-filtered first) before verification.

async function discoverYelp(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city   = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const domain = params.country === "gb" ? "yelp.co.uk" : "yelp.com";
  const tNoCol = params.time.replace(":", "");
  const loc    = encodeURIComponent(`${city}${params.state ? `, ${params.state}` : ""}`);
  const term   = params.cuisine
    ? `&find_desc=${encodeURIComponent(params.cuisine + " restaurant")}`
    : "&find_desc=restaurants";

  const scrapeYelp = async (url: string, label: string): Promise<string[]> => {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 11_000);
      const resp  = await fetch(`${FC_API}/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, waitFor: 3500, timeout: 10000 }),
      });
      clearTimeout(timer);
      if (!resp.ok) { console.log(`[Yelp ${label}] HTTP ${resp.status}`); return []; }
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      const urls = extractYelpReservationUrls(md);
      console.log(`[Yelp ${label}] ${urls.length} venues (md=${md.length})`);
      return urls;
    } catch (err: any) {
      console.log(`[Yelp ${label}] ${err?.message}`); return [];
    }
  };

  // Search #1: reservation-filtered (native Yelp only)
  const resvUrl = `https://www.${domain}/search?find_loc=${loc}${term.replace("find_desc=","term=")}&reservation_date=${params.date}&reservation_time=${tNoCol}&reservation_covers=${params.partySize}`;
  // Search #2: general top-rated (ALL platforms — feeds OT/Resy bridges)
  const topUrl  = `https://www.${domain}/search?find_loc=${loc}${term}&sortby=rating`;

  const [resvUrls, topUrls] = await Promise.all([
    scrapeYelp(resvUrl, "resv"),
    scrapeYelp(topUrl,  "top"),
  ]);

  // Merge: resv first (native Yelp, high confidence), then top-rated additions
  // (potential OT/Resy restaurants not in resv list)
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const u of [...resvUrls, ...topUrls]) {
    const slug = u.split("/").pop() ?? "";
    if (slug && !seen.has(slug)) { seen.add(slug); combined.push(u); }
  }

  if (combined.length >= 1) {
    console.log(`[Yelp combined] ${combined.length} (resv=${resvUrls.length} top=${topUrls.length})`);
    return combined.map(u => normToYelp({ url: u, title: "", description: "" }, params)).filter(Boolean) as Restaurant[];
  }

  // Google fallback (rarely needed given two direct scrapes above)
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";
  const queries = [
    `inurl:${domain}/reservations/ ${city}${state}${cuisine} restaurant`,
    `inurl:${domain}/reservations/ ${city}${state} restaurant dinner`,
  ];
  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToYelp(r, params)).filter(Boolean) as Restaurant[];
}

// Extract Yelp reservation/biz URLs from a scraped markdown page.
// Matches both absolute URLs and relative markdown hrefs (Yelp SPA renders /biz/ paths).
function extractYelpReservationUrls(md: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  // Absolute: https://www.yelp.com/biz/atlas-restaurant-atlanta
  const reAbs = /https?:\/\/(?:www\.)?yelp\.(?:com|co\.uk)\/(?:reservations|biz)\/([^/?#\s"')]+)/gi;
  // Relative in markdown link syntax: (/biz/slug) or (/reservations/slug)
  const reRel = /\(\/(?:reservations|biz)\/([^/?#\s"')]+)/gi;

  for (const re of [reAbs, reRel]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(md)) !== null) {
      const slug = m[1].toLowerCase();
      if (!seen.has(slug) && !isGarbageYelpSlug(slug)) {
        seen.add(slug);
        urls.push(`https://www.yelp.com/reservations/${slug}`);
      }
    }
  }
  return urls;
}

function isGarbageYelpSlug(slug: string): boolean {
  if (slug.includes("_")) return true; // Yelp real slugs use hyphens only
  // Hash-like segments: 12+ chars mixing letters and digits (e.g. "aso24hnzbuvzniv1mq")
  return slug.split("-").some(seg => seg.length >= 10 && /\d/.test(seg) && /[a-z]/.test(seg));
}

function normToYelp(fc: any, params: SearchParams): Restaurant | null {
  const url  = fc.url ?? "";
  const mRes = url.match(/yelp\.com\/reservations\/([^/?#]+)/i);
  const mBiz = url.match(/yelp\.com\/biz\/([^/?#]+)/i);
  const slug = mRes?.[1] ?? mBiz?.[1];
  if (!slug) return null;
  const canonUrl = `https://www.yelp.com/reservations/${slug}`;
  return {
    id: `yelp-${slug}`,
    name: cleanTitle(fc.title, url, "yelp"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "yelp",
    platformUrl: addYelpParams(canonUrl, params),
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

// ─── TOCK DISCOVERY ───────────────────────────────────────────────────────────
// Tock (exploretock.com) is a reservation platform with no Akamai protection.
// It's popular for tasting-menu / ticketed dining and upscale restaurants.
// URL pattern: exploretock.com/[slug]
// Booking params: ?date=YYYY-MM-DD&time=HH:MM&size=N

async function discoverTock(params: SearchParams, fcKey: string): Promise<Restaurant[]> {
  const city    = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const state   = params.state ? `, ${params.state}` : "";
  const cuisine = params.cuisine ? ` ${params.cuisine}` : "";

  const queries = [
    `site:exploretock.com ${city}${state}${cuisine} restaurant reservation`,
    `site:exploretock.com ${city}${state} restaurant dinner`,
  ];

  const results = await firecrawlSearch(queries, fcKey, 10);
  return results.map(r => normToTock(r, params)).filter(Boolean) as Restaurant[];
}

function normToTock(fc: any, params: SearchParams): Restaurant | null {
  const url = fc.url ?? "";
  // Tock URL: exploretock.com/[slug] or exploretock.com/[slug]/experiences/...
  const m = url.match(/exploretock\.com\/([^/?#]+)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (TOCK_SKIP.has(slug)) return null;
  const baseUrl    = `https://www.exploretock.com/${slug}`;
  const bookingUrl = addTockParams(baseUrl, params);
  return {
    id: `tock-${slug}`,
    name: cleanTitle(fc.title, url, "tock"),
    cuisine: params.cuisine || "Restaurant",
    neighborhood: extractNeighborhood(fc.title, fc.description),
    platform: "tock" as const,
    platformUrl: bookingUrl,
    timeSlots: [],
    distanceMiles: null,
    _slug: slug,
  };
}

const TOCK_SKIP = new Set([
  "about","press","legal","careers","help","contact","gift",
  "explore","blog","privacy","terms","faq","venues","search",
  "how-it-works","restaurant","restaurants","experiences","merch",
]);

async function verifyTock(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 2500,   // Tock is a React SPA; give it time to render
        timeout: 9000,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 80) return null;

    // Check for reservation / booking indicators
    const hasReservations = /\b(select\s+(a\s+)?time|find\s+a\s+table|choose\s+(a\s+)?time|available|book\s+(a\s+)?table|make\s+a\s+reservation|tickets?|experiences?|no\s+experiences|request\s+a\s+time)\b/i.test(md);
    if (!hasReservations) return null;

    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    const ratingM  = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    const priceM   = md.match(/(\$+)\s*(?:·|•|,|\s)/);
    const addr     = r._address || extractAddress(md) || undefined;

    const meta = {
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      priceRange:  priceM  ? priceM[1]                              : r.priceRange,
    };

    if (windowed.length === 0) {
      // Tock often requires date selection — soft-verify if the booking widget exists
      return { ...r, ...meta, timeSlots: [], softVerified: true, _address: addr };
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("tock", base, params, s.time) }));
    return { ...r, ...meta, timeSlots: slotsWithUrls, _address: addr };
  } catch (err) {
    console.error(`[verifyTock] ${r.name}:`, err);
    return null;
  }
}

function addTockParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("date", p.date);
    u.searchParams.set("time", p.time);
    u.searchParams.set("size", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

// ─── VERIFICATION ─────────────────────────────────────────────────────────────

/**
 * KEY FIX: verifyBatch now accepts a budgetMs and tracks a local deadline.
 * It returns PARTIAL results — results accumulated before the deadline are
 * kept even if more candidates remain. This eliminates the previous bug where
 * withTimeout(verifyBatch, 10s) threw away all partially-accumulated results.
 */
async function verifyBatch(
  candidates: Restaurant[],
  params: SearchParams,
  fcKey: string,
  budgetMs: number,
  scraperUrl = "",
  scraperSecret = "",
  bbKey = "",
  bbProject = "",
): Promise<Restaurant[]> {
  if (candidates.length === 0) return [];

  const deadline = Date.now() + budgetMs;
  const results: Restaurant[] = [];

  for (let i = 0; i < candidates.length; i += VERIFY_CONCUR) {
    if (results.length >= VERIFY_MAX) break;
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break; // not enough time for a meaningful scrape batch

    const batch      = candidates.slice(i, i + VERIFY_CONCUR);
    const perScrapeMs = Math.min(remaining - 500, 10_000); // leave 500ms margin
    const settled    = await Promise.allSettled(
      batch.map(r => withTimeout(verifyOne(r, params, fcKey, scraperUrl, scraperSecret, bbKey, bbProject), perScrapeMs, null))
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== null) results.push(s.value);
    }
  }

  return results;
}

async function verifyOne(
  r: Restaurant, params: SearchParams, fcKey: string,
  scraperUrl = "", scraperSecret = "", bbKey = "", bbProject = "",
): Promise<Restaurant | null> {
  if (r._preVerified && r.timeSlots.length > 0) return r;
  if (r.platform === "resy")      return scraperUrl && scraperSecret
    ? verifyResyViaBB(r, params, scraperUrl, scraperSecret)
    : verifyResy(r, params, fcKey);
  if (r.platform === "opentable") return bbKey && bbProject
    ? verifyOTViaBB(r, params, bbKey, bbProject)
    : verifyOT(r, params, fcKey);
  if (r.platform === "yelp")      return verifyYelp(r, params, fcKey);
  return null;
}

// ── Resy ──────────────────────────────────────────────────────────────────────

async function verifyResy(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 1500,  // Resy is a React SPA — 500ms was too short
        timeout: 9000,
      }),
    });
    if (!resp.ok) { console.log(`[verifyResy] ${r.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) { console.log(`[verifyResy] ${r.name}: short markdown (${md.length})`); return null; }

    // Bail if page is purely notify/waitlist with zero time slots visible
    if (/\bnotify\b/i.test(md) && !/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(md)) return null;

    // Try to narrow to the relevant meal section; fall back to full page
    const mealLabel = getMealLabel(params.time);
    const mealRegex = new RegExp(`## (?:${mealLabel}|all\\s*day)([\\s\\S]*?)(?=##|$)`, "i");
    const mealMatch = md.match(mealRegex);
    const section   = mealMatch ? mealMatch[1] : md;

    const slots    = extractTimes(section);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[verifyResy] ${r.name}: no slots in window (section len=${section.length})`);
      return null;
    }

    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("resy", base, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[verifyResy] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err) {
    console.error(`[verifyResy] ${r.name}:`, err);
    return null;
  }
}

// Real-browser Resy venue verification — renders the booking page JS and extracts
// actual time slot buttons from innerText.
async function verifyResyViaBB(
  r: Restaurant, params: SearchParams, scraperUrl: string, scraperSecret: string,
): Promise<Restaurant | null> {
  try {
    const text = await lambdaLoad(r.platformUrl, scraperUrl, scraperSecret, { waitMs: 4000 });
    if (text.length < 100) { console.log(`[Resy Lambda] ${r.name}: short text (${text.length})`); return null; }
    if (/\bnotify\b/i.test(text) && !/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(text)) return null;

    const slots    = extractTimes(text);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[Resy Lambda] ${r.name}: no slots in window`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("resy", base, params, s.time) }));
    const ratingM = text.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = text.match(/\(([\d,]+)\s*review/i);
    console.log(`[Resy Lambda] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
    };
  } catch (err: any) {
    console.log(`[Resy Lambda] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ── OpenTable ─────────────────────────────────────────────────────────────────
// Akamai blocks Firecrawl on main OT restaurant pages.
// Strategy: if _widgetUrl is set (widget canvas endpoint), try that first —
// it's cross-origin accessible by design and may have lighter Akamai protection.
// Apify-sourced candidates are already _preVerified so this function is skipped.

async function verifyOT(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  if (!fcKey) return null;

  // Try widget canvas first (lighter Akamai protection), then fall back to main page.
  const urlsToTry = r._widgetUrl
    ? [r._widgetUrl, r.platformUrl]
    : [r.platformUrl];

  for (const scrapeUrl of urlsToTry) {
    const isWidget = scrapeUrl === r._widgetUrl;
    try {
      const resp = await fetch(`${FC_API}/scrape`, {
        method: "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: scrapeUrl, formats: ["markdown"],
          onlyMainContent: false,
          waitFor: isWidget ? 3500 : 3000,
          timeout: 10000,
        }),
      });
      if (!resp.ok) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: HTTP ${resp.status}`);
        continue; // try next URL
      }
      const data = await resp.json();
      const md: string = data.data?.markdown ?? "";
      if (md.length < 50) continue;
      if (/access denied|security check|enable javascript|are you a robot|just a moment/i.test(md)) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: Akamai blocked`);
        continue;
      }
      const slots    = extractTimes(md);
      const windowed = filterWindow(slots, params.time);
      if (windowed.length === 0) {
        console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: no matching slots in markdown (len=${md.length})`);
        continue;
      }
      const base         = r.platformUrl.split("?")[0];
      const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
      const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
      const reviewM = md.match(/\(([\d,]+)\s*review/i);
      console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: ${windowed.length} slots ✓`);
      return {
        ...r,
        timeSlots:   slotsWithUrls,
        rating:      ratingM ? parseFloat(ratingM[1]) : r.rating,
        reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
        _address:    r._address || extractAddress(md) || undefined,
      };
    } catch (err: any) {
      console.log(`[OT ${isWidget ? "widget" : "main"}] ${r.name}: ${err?.message}`);
    }
  }

  // Path 3: Jina AI reader — different infrastructure/IPs from Firecrawl.
  // Akamai's IP blacklists target datacenter ranges used by Firecrawl/cloud scrapers.
  // Jina (r.jina.ai) runs its own headless browser fleet with separate IP space.
  // Free for basic use, no API key needed.
  return verifyOTviaJina(r, params);
}

async function verifyOTviaJina(r: Restaurant, params: SearchParams): Promise<Restaurant | null> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const resp = await fetch(`https://r.jina.ai/${r.platformUrl}`, {
      headers: {
        "Accept":          "text/plain",
        "User-Agent":      "Mozilla/5.0 (compatible; TableFinder/2.0)",
        "X-Return-Format": "markdown",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.log(`[OT Jina] ${r.name}: HTTP ${resp.status}`); return null; }
    const md = await resp.text();
    if (md.length < 100) return null;
    if (/access denied|security check|are you a robot|just a moment|enable javascript/i.test(md)) {
      console.log(`[OT Jina] ${r.name}: blocked`);
      return null;
    }
    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT Jina] ${r.name}: no slots (md=${md.length})`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[OT Jina] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1]) : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      _address:    r._address || extractAddress(md) || undefined,
    };
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name !== "AbortError") console.log(`[OT Jina] ${r.name}: ${err?.message}`);
    return null;
  }
}

// Real-browser OT verification — residential proxy bypasses Akamai on restaurant pages.
async function verifyOTViaBB(
  r: Restaurant, params: SearchParams, bbKey: string, bbProject: string,
): Promise<Restaurant | null> {
  try {
    const text = await bbLoad(r.platformUrl, bbKey, bbProject, {
      waitMs: 4000,
      useProxy: true,
    });
    if (text.length < 50) { console.log(`[OT BB] ${r.name}: short text`); return null; }
    if (/access denied|security check|are you a robot|just a moment/i.test(text)) {
      console.log(`[OT BB] ${r.name}: Akamai blocked`);
      return null;
    }
    const slots    = extractTimes(text);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT BB] ${r.name}: no slots`);
      return null;
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", base, params, s.time) }));
    const ratingM = text.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = text.match(/\(([\d,]+)\s*review/i);
    console.log(`[OT BB] ${r.name}: ${windowed.length} slots ✓`);
    return {
      ...r,
      timeSlots:   slotsWithUrls,
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
    };
  } catch (err: any) {
    console.log(`[OT BB] ${r.name}: ${err?.message}`);
    return null;
  }
}

// ── Yelp ──────────────────────────────────────────────────────────────────────

async function verifyYelp(r: Restaurant, params: SearchParams, fcKey: string): Promise<Restaurant | null> {
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: r.platformUrl, formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 3000,  // Yelp JS widget is slow — 2000ms was sometimes too short
        timeout: 10000,
      }),
    });
    if (!resp.ok) { console.log(`[verifyYelp] ${r.name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 100) { console.log(`[verifyYelp] ${r.name}: short markdown (${md.length})`); return null; }

    // Detect /reservations/ → /biz/ redirect: Yelp shows the restaurant in its
    // reservation search but the restaurant doesn't actually use Yelp reservations.
    // Firecrawl follows the redirect silently; ogUrl reveals the final landing URL.
    // We still run OT/Resy bridge checks below — bridges may fire from the biz page.
    // But we will NOT soft-verify as a native Yelp result if no bridge matches.
    const finalUrl: string = data.data?.metadata?.ogUrl ?? data.data?.metadata?.url ?? "";
    const isYelpNative = !(
      r.platformUrl.includes("/reservations/") &&
      /yelp\.com\/biz\//.test(finalUrl) &&
      !finalUrl.includes("/reservations/")
    );
    if (!isYelpNative) {
      console.log(`[verifyYelp] ${r.name}: /reservations/ redirected to /biz/ — not Yelp-native`);
    }

    // ── OT Bridge ─────────────────────────────────────────────────────────────
    // Yelp reservation pages often embed an OT booking link with the restaurant's
    // rid. Try the OT widget canvas first (hard result with slots). If Akamai
    // blocks it, return a soft-verified OT result rather than dropping entirely —
    // the rid is definitive proof this restaurant is on OpenTable.
    const otRidM = md.match(/opentable\.(?:com|co\.uk)[^\s"'<>]*[?&]rid=(\d+)/i)
                ?? md.match(/opentable\.(?:com|co\.uk)\/restaurant\/profile\/(\d+)/i);
    if (otRidM) {
      const rid      = otRidM[1];
      const otResult = await tryOTWidgetScrape(r.name, rid, params, fcKey);
      if (otResult) return otResult; // Hard OT result with time slots ✓
      // Widget blocked by Akamai → emit soft-verified OT (shows "Check on OT" link)
      const profileUrl = `https://www.opentable.com/restaurant/profile/${rid}`;
      console.log(`[verifyYelp] ${r.name}: OT rid=${rid} found but widget blocked → OT soft-verified`);
      return {
        ...r,
        id:          `opentable-${rid}`,
        platform:    "opentable" as const,
        platformUrl: addOTParams(profileUrl, params),
        timeSlots:   [],
        softVerified: true,
        _rid: rid,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Resy Bridge ───────────────────────────────────────────────────────────
    // If the Yelp page links to a specific Resy venue URL, surface a soft-verified
    // Resy result. This fires even when Resy Google discovery returns 0 (bot block).
    const resyVenueM = md.match(/resy\.com\/cities\/([^/\s"']+)\/venues\/([^/?#\s"')]+)/i);
    if (resyVenueM) {
      const resyBase = `https://resy.com/cities/${resyVenueM[1]}/venues/${resyVenueM[2]}`;
      const vSlug    = resyVenueM[2].toLowerCase();
      console.log(`[verifyYelp] ${r.name}: Resy venue found → soft-verified Resy (${vSlug})`);
      return {
        ...r,
        id:          `resy-${vSlug}`,
        platform:    "resy" as const,
        platformUrl: addResyParams(resyBase, params),
        timeSlots:   [],
        softVerified: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Reject pages that mention Resy/OT by name but had no extractable URL above.
    // (Generic "Reserve on Resy" text without a venue link — not enough to act on.)
    const usesOtherPlatform = /\b(reserve\s+on\s+resy|book\s+on\s+resy|resy\.com|reserve\s+on\s+opentable|book\s+on\s+opentable)\b/i.test(md);
    if (usesOtherPlatform) {
      console.log(`[verifyYelp] ${r.name}: redirects to Resy/OT (no extractable URL) — skipping`);
      return null;
    }

    // NOTE: We do NOT gate on native widget text here. Firecrawl can't render Yelp's
    // JS time-picker even with waitFor:3000, so phrases like "select a time" / "party size"
    // never appear in the markdown. Candidates already came from Yelp's own reservation
    // search URL and passed the usesOtherPlatform filter — that's sufficient evidence.

    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    const ratingM  = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM  = md.match(/\(([\d,]+)\s*review/i);
    const priceM   = md.match(/(\$+)\s*(?:·|•|,|\s)/);
    const meta     = {
      rating:      ratingM ? parseFloat(ratingM[1])                 : r.rating,
      reviewCount: reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : r.reviewCount,
      priceRange:  priceM  ? priceM[1]                              : r.priceRange,
    };
    const addr = r._address || extractAddress(md) || undefined;

    if (windowed.length === 0) {
      // If the page redirected from /reservations/ to /biz/, this restaurant isn't
      // on Yelp natively — drop it (bridges above already had a chance to fire).
      if (!isYelpNative) {
        console.log(`[verifyYelp] ${r.name}: non-native redirect + no slots — skipping`);
        return null;
      }
      // Soft-verify: the time-picker widget likely didn't render (JS-heavy), but the
      // restaurant was found via Yelp's own reservation search URL and doesn't redirect
      // to Resy/OT. Accept if there's any reservation-related language on the page.
      const hasAnyReservationHint = /\b(reservation|book\s+a\s+table|waitlist|party\s+of|guests?|dining|dine\s+in)\b/i.test(md);
      if (!hasAnyReservationHint) { console.log(`[verifyYelp] ${r.name}: no reservation language — skipping`); return null; }
      console.log(`[verifyYelp] ${r.name}: soft-verified (widget likely not rendered)`);
      return { ...r, ...meta, timeSlots: [], softVerified: true, _address: addr };
    }
    const base          = r.platformUrl.split("?")[0];
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("yelp", base, params, s.time) }));
    console.log(`[verifyYelp] ${r.name}: ${windowed.length} slots ✓`);
    return { ...r, ...meta, timeSlots: slotsWithUrls, _address: addr };
  } catch (err) {
    console.error(`[verifyYelp] ${r.name}:`, err);
    return null;
  }
}

/**
 * Scrape the OT widget canvas endpoint — cross-origin accessible since it's
 * embedded on restaurant websites. May bypass Akamai's stricter datacenter IP
 * rules that block the main OpenTable restaurant pages.
 */
async function tryOTWidgetScrape(
  name: string, rid: string, params: SearchParams, fcKey: string
): Promise<Restaurant | null> {
  const dt        = `${params.date}T${params.time}`;
  const widgetUrl = `https://www.opentable.com/widget/reservation/canvas?rid=${rid}&covers=${params.partySize}&datetime=${dt}&styleid=5&disablegt=true`;
  try {
    const resp = await fetch(`${FC_API}/scrape`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: widgetUrl, formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 3500,
        timeout: 10000,
      }),
    });
    if (!resp.ok) { console.log(`[OT widget] ${name}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const md: string = data.data?.markdown ?? "";
    if (md.length < 50) return null;
    if (/access denied|security check|enable javascript|are you a robot|just a moment/i.test(md)) {
      console.log(`[OT widget] ${name}: Akamai blocked`);
      return null;
    }
    const slots    = extractTimes(md);
    const windowed = filterWindow(slots, params.time);
    if (windowed.length === 0) {
      console.log(`[OT widget] ${name}: no slots found (md len=${md.length})`);
      return null;
    }
    const baseOTUrl     = `https://www.opentable.com/r/${slugify(name)}`;
    const otBookingUrl  = addOTParams(baseOTUrl, params);
    const slotsWithUrls = windowed.map(s => ({ ...s, url: buildSlotUrl("opentable", baseOTUrl, params, s.time) }));
    const ratingM = md.match(/(\d\.\d)\s*(?:stars?|★|\()/i);
    const reviewM = md.match(/\(([\d,]+)\s*review/i);
    console.log(`[OT widget] ${name}: ${windowed.length} slots ✓ (rid=${rid})`);
    return {
      id:           `opentable-${rid}`,
      name,
      cuisine:      params.cuisine || "Restaurant",
      neighborhood: "",
      platform:     "opentable" as const,
      platformUrl:  otBookingUrl,
      timeSlots:    slotsWithUrls,
      distanceMiles: null,
      rating:       ratingM ? parseFloat(ratingM[1]) : undefined,
      reviewCount:  reviewM ? parseInt(reviewM[1].replace(/,/g, "")) : undefined,
      _rid: rid,
    };
  } catch (err: any) {
    console.log(`[OT widget] ${name}: ${err?.message}`);
    return null;
  }
}

// ─── GEOCODING & RANKING ──────────────────────────────────────────────────────

async function geocodeAndRank(restaurants: Restaurant[], params: SearchParams): Promise<Restaurant[]> {
  if (restaurants.length === 0) return [];

  const userLat = params.lat;
  const userLng = params.lng;
  const geoCity = (params.lat != null && params.lng != null)
    ? (nearestResyMetro(params.lat, params.lng)?.name ?? params.city)
    : params.city;
  const geoRegion = params.state || params.country;
  const bboxParam = (userLat != null && userLng != null)
    ? `&bbox=${(userLng-1.5).toFixed(4)},${(userLat-1.5).toFixed(4)},${(userLng+1.5).toFixed(4)},${(userLat+1.5).toFixed(4)}`
    : "";

  const needsGeo = restaurants.filter(r => r._lat == null && r._lng == null);
  if (needsGeo.length > 0) {
    await Promise.all(needsGeo.map(async r => {
      const feats = await photonSearch(`${r.name} ${geoCity} ${geoRegion}`, bboxParam, 3500);
      let best    = pickClosest(feats, userLat, userLng, 30);

      // Fallback: name-only + bbox
      if (!best && bboxParam) {
        const feats2 = await photonSearch(`${r.name} restaurant`, bboxParam, 2500);
        best = pickClosest(feats2, userLat, userLng, 30);
      }
      // Fallback: street address
      if (!best && r._address) {
        const feats3 = await photonSearch(r._address, bboxParam, 2500);
        best = pickClosest(feats3, userLat, userLng, 30);
      }

      if (best) {
        const [lng, lat] = best.geometry.coordinates;
        r._lat = lat; r._lng = lng;
        if (!r.neighborhood) {
          const p = best.properties as any;
          r.neighborhood = p.district ?? p.suburb ?? p.city ?? "";
        }
      }
    }));
  }

  for (const r of restaurants) {
    if (userLat != null && userLng != null && r._lat != null && r._lng != null) {
      r.distanceMiles = haversine(userLat, userLng, r._lat, r._lng);
    }
  }

  const CAP_MI = isMetroArea(params.city) ? 30 : 15;
  return restaurants
    .filter(r => r.distanceMiles == null || r.distanceMiles <= 200)
    .filter(r => r.distanceMiles == null || r.distanceMiles <= CAP_MI)
    .sort((a, b) => {
      const dA = a.distanceMiles ?? 999, dB = b.distanceMiles ?? 999;
      if (Math.abs(dA - dB) > 0.5) return dA - dB;
      return (b.rating ?? 0) - (a.rating ?? 0);
    });
}

async function photonSearch(query: string, bboxParam: string, timeoutMs: number): Promise<any[]> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const q    = encodeURIComponent(query);
    const resp = await fetch(`${PHOTON}/?q=${q}&limit=3${bboxParam}`, {
      headers: { "User-Agent": "TableFinder/2.0" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data?.features ?? [];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

function pickClosest(feats: any[], userLat?: number, userLng?: number, maxMiles = 30): any | null {
  let best: any = null;
  let bestDist  = Infinity;
  for (const feat of feats) {
    if (!feat?.geometry?.coordinates) continue;
    const [fLng, fLat] = feat.geometry.coordinates;
    if (userLat != null && userLng != null) {
      const d = haversine(userLat, userLng, fLat, fLng);
      if (d < bestDist && d <= maxMiles) { bestDist = d; best = feat; }
    } else {
      return feat; // no user coords — take first result
    }
  }
  return best;
}

// ─── AI ENRICHMENT ────────────────────────────────────────────────────────────

async function enrich(restaurants: Restaurant[], params: SearchParams, aiKey: string): Promise<Restaurant[]> {
  if (restaurants.length === 0 || !aiKey) return restaurants;
  const tops   = restaurants.slice(0, 12);
  const prompt = `For each restaurant, write a one-sentence evocative description and pick 1-3 vibe tags.
Tags: Romantic, Lively, Date Night, Outdoor Seating, Chef's Table, Wine Bar, Hidden Gem, Business Dinner, Rooftop, Casual, Fine Dining, Family Friendly.
Restaurants:
${tops.map((r, i) => `${i + 1}. ${r.name} — ${r.cuisine}${r.neighborhood ? ` in ${r.neighborhood}` : ""}`).join("\n")}
Respond ONLY with valid JSON (no markdown):
{"items":[{"description":"...","vibeTags":["..."]}]}`;

  try {
    const resp = await fetch(AI_GATEWAY, {
      method: "POST",
      headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) return restaurants;
    const data   = await resp.json();
    const raw    = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const enriched: any[] = Array.isArray(parsed)
      ? parsed
      : (parsed.items ?? parsed.enrichments ?? parsed.restaurants ?? []);
    tops.forEach((r, i) => {
      if (enriched[i]) { r.description = enriched[i].description; r.vibeTags = enriched[i].vibeTags; }
    });
  } catch { /* optional */ }
  return restaurants;
}

// ─── FIRECRAWL SEARCH ─────────────────────────────────────────────────────────
// KEY FIX: removed scrapeOptions.formats — discovery only needs URL+title, not
// full markdown. Dropping markdown makes each search query 3-5x faster.

async function firecrawlSearch(queries: string[], fcKey: string, limit = 8): Promise<any[]> {
  const results: any[] = [];
  const seen            = new Set<string>();

  await Promise.all(queries.map(async (query) => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000); // per-query hard deadline
    try {
      const resp = await fetch(`${FC_API}/search`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
        signal:  ctrl.signal,
        body:    JSON.stringify({ query, limit }), // no scrapeOptions — discovery needs URL/title only
      });
      clearTimeout(timer);
      if (!resp.ok) { console.warn(`[search] HTTP ${resp.status} for "${query.slice(0,60)}"`); return; }
      const data  = await resp.json();
      let   items: any[] = [];
      if      (Array.isArray(data))                    items = data;
      else if (Array.isArray(data.data))               items = data.data;
      else if (Array.isArray(data.results))            items = data.results;
      else if (Array.isArray(data.data?.results))      items = data.data.results;
      else if (Array.isArray(data.data?.data))         items = data.data.data;
      else { console.warn(`[search] unknown shape: ${JSON.stringify(data).slice(0,200)}`); return; }
      for (const item of items) {
        if (item.url && !seen.has(item.url)) { seen.add(item.url); results.push(item); }
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name !== "AbortError") console.warn(`[search] "${query.slice(0,60)}":`, err?.message);
    }
  }));

  return results;
}

// ─── DEDUP ────────────────────────────────────────────────────────────────────

function dedup(restaurants: Restaurant[]): Restaurant[] {
  const seen = new Map<string, Restaurant>();
  for (const r of restaurants) {
    const key = normName(r.name);
    if (!seen.has(key)) {
      seen.set(key, r);
    } else {
      const existing = seen.get(key)!;
      if (existing.platform === "yelp" && r.platform !== "yelp") seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

function normName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(restaurant|bar|grill|bistro|cafe|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "").trim();
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 3_958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function displayTo24(t: string): string {
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return "19:00";
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${h.toString().padStart(2, "0")}:${m[2]}`;
}

function buildSlotUrl(platform: "resy"|"opentable"|"yelp", base: string, p: SearchParams, slotTime: string): string {
  const t24      = displayTo24(slotTime);
  const tNoColon = t24.replace(":", "");
  if (platform === "resy")      return `${base}?date=${p.date}&seats=${p.partySize}&time=${tNoColon}`;
  if (platform === "opentable") return `${base}?dateTime=${p.date}T${t24}&covers=${p.partySize}`;
  if (platform === "yelp")      return `${base}?covers=${p.partySize}&date=${p.date}&time=${tNoColon}`;
  return base;
}

function filterWindow(slots: TimeSlot[], requestedTime: string): TimeSlot[] {
  const [rH, rM] = requestedTime.split(":").map(Number);
  const reqMins  = rH * 60 + (rM || 0);
  return slots
    .map(s => {
      const m = s.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
      if (!m) return null;
      let h = +m[1], mn = +m[2];
      if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
      if (m[3].toLowerCase() === "am" && h === 12) h = 0;
      return { slot: s, mins: h * 60 + mn };
    })
    .filter(x => x && Math.abs(x.mins - reqMins) <= 120)
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 5)
    .sort((a, b) => a!.mins - b!.mins)
    .map(x => x!.slot);
}

function extractTimes(text: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen              = new Set<string>();

  // 12h format: "7:30 PM" / "7:30pm"
  const re12 = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re12.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index-60), m.index+m[0].length+60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable/i.test(ctx)) continue;
    let h = +m[1]; const mn = +m[2];
    if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (m[3].toLowerCase() === "am" && h === 12) h = 0;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  // 24h format: "18:30"
  const re24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi;
  while ((m = re24.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index-60), m.index+m[0].length+60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable/i.test(ctx)) continue;
    const h = +m[1], mn = +m[2];
    if (h < 6) continue;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  return slots;
}

function getMealLabel(time: string): string {
  const [h] = time.split(":").map(Number);
  if (h < 11) return "breakfast";
  if (h < 15) return "lunch|brunch";
  return "dinner";
}

function addResyParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("date", p.date);
    u.searchParams.set("seats", String(p.partySize));
    u.searchParams.set("time", p.time.replace(":", ""));
    return u.toString();
  } catch { return base; }
}

function addOTParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("dateTime", `${p.date}T${p.time}`);
    u.searchParams.set("covers", String(p.partySize));
    return u.toString();
  } catch { return base; }
}

function addYelpParams(base: string, p: SearchParams): string {
  try {
    const u = new URL(base);
    u.searchParams.set("covers", String(p.partySize));
    u.searchParams.set("date", p.date);
    u.searchParams.set("time", p.time.replace(":", ""));
    return u.toString();
  } catch { return base; }
}

function extractRid(url: string): string | null {
  const m = url.match(/[?&]rid=(\d+)/i) ?? url.match(/\/(\d{5,})/);
  return m ? m[1] : null;
}

function parseTimeFromDT(dt: string): string | null {
  const m = dt.match(/T(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mn = +m[2];
  return `${h % 12 || 12}:${mn.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

function cleanTitle(title: string | undefined, url: string, platform: string): string {
  if (title) {
    let t = title
      .replace(/\s*[|–-]\s*(Resy|OpenTable|Yelp).*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+on\s+OpenTable$/i, "")
      .replace(/\s+on\s+(OpenTable|Resy|Yelp)$/i, "")
      .replace(/\s*[|•·]\s*[A-Za-z\s&]+$/i, "")
      .replace(/^book\s+(?:your\s+)?(?:reservation\s+(?:at\s+)?)?/i, "")
      .replace(/\s+reservation(s)?.*$/i, "")
      .replace(/\s*-\s*[A-Za-z\s]+,?\s*[A-Z]{2}$/i, "")
      .trim();
    if (platform === "yelp") {
      t = t.replace(/\s*[-–]\s*[A-Za-z &']+(?:,\s*[A-Za-z &']+)+\s*$/, "").trim();
    }
    t = t.replace(/\s*[-–|]\s*$/, "").trim();
    if (t.length > 1) return t;
  }
  // Fallback: derive name from URL slug
  const parts = url.split("/");
  const slug  = (parts[parts.length - 1] || "restaurant").split("?")[0];
  return slug
    .replace(/-\d+$/, "")   // strip trailing disambiguation numbers: "south-city-kitchen-2" → "south-city-kitchen"
    .split("-")
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim() || "Restaurant";
}

function extractAddress(md: string): string {
  const m = md.match(
    /\b(\d{2,5})\s+([\w][^,\n]{3,40}(?:St|Ave|Blvd|Dr|Rd|Way|Ln|Pl|Ct|Pkwy|Hwy|Cir|Ter|NE|NW|SE|SW)\.?)(?:,?\s+(?:NE|NW|SE|SW))?[,\s]+([A-Za-z][A-Za-z\s]{2,25}),\s*([A-Z]{2})\b/i
  );
  return m ? `${m[1]} ${m[2].trim()}, ${m[3].trim()}, ${m[4]}` : "";
}

function extractNeighborhood(title?: string, desc?: string): string {
  const m = `${title||""} ${desc||""}`.match(/[-–|]\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
  return m ? m[1].trim() : "";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isMetroArea(city: string): boolean {
  const metros = new Set(["new york","los angeles","chicago","houston","phoenix","philadelphia","san antonio","san diego","dallas","san jose","austin","jacksonville","fort worth","columbus","charlotte","san francisco","indianapolis","seattle","denver","washington","nashville","oklahoma city","el paso","boston","portland","las vegas","memphis","louisville","baltimore","milwaukee","albuquerque","tucson","fresno","mesa","kansas city","atlanta","omaha","colorado springs","raleigh","long beach","virginia beach","minneapolis","tampa","new orleans","honolulu","anaheim","lexington","aurora","santa ana","corpus christi","riverside","st louis","pittsburgh","anchorage","stockton","cincinnati","st paul","toledo","greensboro","newark","plano","henderson","lincoln","buffalo","fort wayne","jersey city","chula vista","orlando","st petersburg","norfolk","chandler","laredo","madison","durham","lubbock","winston-salem","garland","glendale","hialeah","reno","baton rouge","irvine","chesapeake","scottsdale","north las vegas","fremont","gilbert","san bernardino","birmingham","boise","rochester","richmond","spokane","des moines","montgomery","modesto","fayetteville","tacoma","shreveport","akron","yonkers","huntington beach","little rock","columbus","grand rapids","amarillo","oxnard","tallahassee","huntsville","worcester","knoxville","brownsville","providence","moreno valley","jackson","oceanside","garden grove","chattanooga","fort lauderdale","rancho cucamonga","santa clarita","tempe","cape coral","ontario","vancouver","sioux falls","peoria","elk grove","pembroke pines","corona","sunnyvale","springfield","lancaster","hayward","salinas","lakewood","palmdale","clarksville","pomona","hollywood","escondido","paterson","torrance","bridgeport","alexandria","mcallen","savannah","fullerton","roseville","columbia","surprise","macon","sterling heights","murfreesboro","pasadena","cedar rapids","mesquite","killeen","bellevue","hartford","rockford","dayton","olathe","syracuse","eugene","salt lake city","manchester","port st lucie","fort collins","miami","dallas","london","manchester","birmingham","leeds","glasgow","sheffield","bradford","edinburgh","liverpool","bristol","cardiff"]);
  return metros.has(city.toLowerCase());
}

function formatDisplayDate(date: string): string {
  try {
    const d     = new Date(date + "T12:00:00");
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const diff  = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return "Tonight";
    if (diff === 1) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch { return date; }
}

function formatDisplayTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${m.toString().padStart(2,"0")} ${h >= 12 ? "PM" : "AM"}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── RESY METRO TABLE ─────────────────────────────────────────────────────────

const RESY_METROS: { slug: string; name: string; lat: number; lng: number }[] = [
  { slug: "new-york-ny",       name: "New York",        lat: 40.7128,  lng: -74.0060  },
  { slug: "los-angeles-ca",    name: "Los Angeles",     lat: 34.0522,  lng: -118.2437 },
  { slug: "chicago-il",        name: "Chicago",         lat: 41.8781,  lng: -87.6298  },
  { slug: "san-francisco-ca",  name: "San Francisco",   lat: 37.7749,  lng: -122.4194 },
  { slug: "washington-dc",     name: "Washington DC",   lat: 38.9072,  lng: -77.0369  },
  { slug: "miami-fl",          name: "Miami",           lat: 25.7617,  lng: -80.1918  },
  { slug: "boston-ma",         name: "Boston",          lat: 42.3601,  lng: -71.0589  },
  { slug: "seattle-wa",        name: "Seattle",         lat: 47.6062,  lng: -122.3321 },
  { slug: "portland-or",       name: "Portland",        lat: 45.5051,  lng: -122.6750 },
  { slug: "denver-co",         name: "Denver",          lat: 39.7392,  lng: -104.9903 },
  { slug: "austin-tx",         name: "Austin",          lat: 30.2672,  lng: -97.7431  },
  { slug: "dfw",               name: "Dallas",          lat: 32.7767,  lng: -96.7970  },
  { slug: "houston-tx",        name: "Houston",         lat: 29.7604,  lng: -95.3698  },
  { slug: "atlanta-ga",        name: "Atlanta",         lat: 33.7490,  lng: -84.3880  },
  { slug: "nashville-tn",      name: "Nashville",       lat: 36.1627,  lng: -86.7816  },
  { slug: "philadelphia-pa",   name: "Philadelphia",    lat: 39.9526,  lng: -75.1652  },
  { slug: "minneapolis-mn",    name: "Minneapolis",     lat: 44.9778,  lng: -93.2650  },
  { slug: "phoenix-az",        name: "Phoenix",         lat: 33.4484,  lng: -112.0740 },
  { slug: "new-orleans-la",    name: "New Orleans",     lat: 29.9511,  lng: -90.0715  },
  { slug: "las-vegas-nv",      name: "Las Vegas",       lat: 36.1699,  lng: -115.1398 },
  { slug: "san-diego-ca",      name: "San Diego",       lat: 32.7157,  lng: -117.1611 },
  { slug: "charlotte-nc",      name: "Charlotte",       lat: 35.2271,  lng: -80.8431  },
  { slug: "raleigh-nc",        name: "Raleigh",         lat: 35.7796,  lng: -78.6382  },
  { slug: "richmond-va",       name: "Richmond",        lat: 37.5407,  lng: -77.4360  },
  { slug: "baltimore-md",      name: "Baltimore",       lat: 39.2904,  lng: -76.6122  },
  { slug: "pittsburgh-pa",     name: "Pittsburgh",      lat: 40.4406,  lng: -79.9959  },
  { slug: "cleveland-oh",      name: "Cleveland",       lat: 41.4993,  lng: -81.6944  },
  { slug: "columbus-oh",       name: "Columbus",        lat: 39.9612,  lng: -82.9988  },
  { slug: "cincinnati-oh",     name: "Cincinnati",      lat: 39.1031,  lng: -84.5120  },
  { slug: "detroit-mi",        name: "Detroit",         lat: 42.3314,  lng: -83.0458  },
  { slug: "milwaukee-wi",      name: "Milwaukee",       lat: 43.0389,  lng: -87.9065  },
  { slug: "kansas-city-mo",    name: "Kansas City",     lat: 39.0997,  lng: -94.5786  },
  { slug: "st-louis-mo",       name: "St Louis",        lat: 38.6270,  lng: -90.1994  },
  { slug: "indianapolis-in",   name: "Indianapolis",    lat: 39.7684,  lng: -86.1581  },
  { slug: "louisville-ky",     name: "Louisville",      lat: 38.2527,  lng: -85.7585  },
  { slug: "memphis-tn-ar",     name: "Memphis",         lat: 35.1495,  lng: -90.0490  },
  { slug: "tampa-bay-fl",      name: "Tampa",           lat: 27.9506,  lng: -82.4572  },
  { slug: "orlando-fl",        name: "Orlando",         lat: 28.5383,  lng: -81.3792  },
  { slug: "salt-lake-city-ut", name: "Salt Lake City",  lat: 40.7608,  lng: -111.8910 },
  { slug: "sacramento-ca",     name: "Sacramento",      lat: 38.5816,  lng: -121.4944 },
  { slug: "portland-me",       name: "Portland ME",     lat: 43.6591,  lng: -70.2568  },
  { slug: "san-antonio-tx",    name: "San Antonio",     lat: 29.4241,  lng: -98.4936  },
  { slug: "jacksonville-fl",   name: "Jacksonville",    lat: 30.3322,  lng: -81.6557  },
  { slug: "london-england",    name: "London",          lat: 51.5074,  lng: -0.1278   },
];

const RESY_SNAP_RADIUS = 60;

function nearestResyMetro(lat: number, lng: number): { slug: string; name: string } | null {
  let best: typeof RESY_METROS[0] | null = null;
  let bestDist = Infinity;
  for (const m of RESY_METROS) {
    const d = haversine(lat, lng, m.lat, m.lng);
    if (d < bestDist) { bestDist = d; best = m; }
  }
  return bestDist <= RESY_SNAP_RADIUS ? best : null;
}

function resyCitySlug(city: string, state: string, _country: string, lat?: number, lng?: number): string {
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.slug;
  }
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.slug;
  }
  return slugify(city);
}

function resyCityName(city: string, _state: string, lat?: number, lng?: number): string {
  if (lat != null && lng != null) {
    const metro = nearestResyMetro(lat, lng);
    if (metro) return metro.name;
  }
  for (const m of RESY_METROS) {
    if (m.name.toLowerCase() === city.toLowerCase()) return m.name;
  }
  return city;
}
