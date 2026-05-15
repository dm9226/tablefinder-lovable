/**
 * Client-side verification for OT and Yelp.
 *
 * The OT restref API and Yelp availability API are blocked from cloud/datacenter
 * IPs (Akamai Bot Manager + DataDome) but work fine from a real user's browser
 * because these are cross-origin embedding endpoints — OT's widget is embedded on
 * restaurant websites, Yelp's SeatMe widget likewise. Both must allow arbitrary
 * browser origins by design.
 *
 * This module is imported by Index.tsx and called after the edge function returns
 * the initial server-side results. Verified results stream in as each call completes.
 */

import type { Restaurant, TimeSlot } from "@/types/restaurant";

// ── Helpers (mirrors edge function logic) ────────────────────────────────────

function parseDisplayTime(t: string): string {
  // "7:00 PM" → "19:00"
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return t; // assume already 24h
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return `${h.toString().padStart(2, "0")}:${m[2]}`;
}

function displayTo24(t: string): string {
  return parseDisplayTime(t);
}

function extractTimes(text: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();

  // 12h: "7:30 PM"
  const re12 = /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re12.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable|opening\s+hours?/i.test(ctx)) continue;
    let h = +m[1];
    const mn = +m[2];
    if (m[3].toLowerCase() === "pm" && h !== 12) h += 12;
    if (m[3].toLowerCase() === "am" && h === 12) h = 0;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  // 24h: "18:30" (ISO datetimes from OT restref JSON)
  const re24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi;
  while ((m = re24.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).toLowerCase();
    if (/notify|sold\s*out|waitlist|unavailable|opening\s+hours?/i.test(ctx)) continue;
    const h = +m[1], mn = +m[2];
    if (h < 6) continue;
    const t = `${h % 12 || 12}:${mn.toString().padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
    if (!seen.has(t)) { seen.add(t); slots.push({ time: t }); }
  }

  return slots;
}

function filterWindow(slots: TimeSlot[], requestedTime24: string): TimeSlot[] {
  const [rH, rM] = requestedTime24.split(":").map(Number);
  const reqMins = rH * 60 + (rM || 0);
  return slots
    .map(s => {
      const mm = s.time.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
      if (!mm) return null;
      let h = +mm[1], mn = +mm[2];
      if (mm[3].toLowerCase() === "pm" && h !== 12) h += 12;
      if (mm[3].toLowerCase() === "am" && h === 12) h = 0;
      return { slot: s, mins: h * 60 + mn };
    })
    .filter(x => x && Math.abs(x.mins - reqMins) <= 120)  // ±2h window (was ±90min)
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 6)  // show up to 6 slots
    .sort((a, b) => a!.mins - b!.mins)
    .map(x => x!.slot);
}

function buildOTSlotUrl(base: string, date: string, slotTime: string, partySize: number): string {
  const t24 = displayTo24(slotTime);
  return `${base}?dateTime=${date}T${t24}&covers=${partySize}`;
}

function buildYelpSlotUrl(base: string, date: string, slotTime: string, partySize: number): string {
  const t24 = displayTo24(slotTime);
  const tNoColon = t24.replace(":", "");
  return `${base}?covers=${partySize}&date=${date}&time=${tNoColon}`;
}

// ── OT restref ───────────────────────────────────────────────────────────────
// https://www.opentable.com/restref/api/availability?rid=N&covers=P&day=D
// Cross-origin widget endpoint — used by thousands of restaurant websites to
// embed the OT booking widget. CORS-enabled by OT for all origins by design.
// Returns JSON with all available time slots for the day; we filter to ±90 min.

export async function verifyOTRestref(
  r: Restaurant & { _rid?: string | number },
  date: string,        // YYYY-MM-DD
  displayTime: string, // "7:00 PM"
  partySize: number,
): Promise<Restaurant | null> {
  const rid = r._rid;
  if (!rid) return null;

  const time24 = parseDisplayTime(displayTime);

  try {
    const url = `https://www.opentable.com/restref/api/availability?rid=${rid}&covers=${partySize}&day=${date}&lang=en-US&ref=5`;
    console.log(`[clientVerifyOT] ${r.name} (rid=${rid}): fetching ${url}`);
    const resp = await fetch(url, {
      headers: {
        "Accept":          "application/json, text/javascript, */*; q=0.01",
        "Referer":         "https://www.opentable.com/",
        "X-Requested-With":"XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`[clientVerifyOT] ${r.name}: HTTP ${resp.status}`);
      return null;
    }

    const json = await resp.json();
    const text = JSON.stringify(json);
    const slots = filterWindow(extractTimes(text), time24);
    console.log(`[clientVerifyOT] ${r.name}: ${slots.length} slots in window (raw keys: ${Object.keys(json).join(",")})`);
    if (slots.length === 0) return null;

    const base = r.platformUrl.split("?")[0];
    return {
      ...r,
      timeSlots: slots.map(s => ({
        ...s,
        url: buildOTSlotUrl(base, date, s.time, partySize),
      })),
      softVerified: false,
    };
  } catch (err) {
    console.error(`[clientVerifyOT] ${r.name}: fetch error —`, err);
    return null;
  }
}

// ── OT slug-based restref (no RID required) ──────────────────────────────────
// OT's restref endpoint is CORS-enabled (designed for cross-origin widget embedding).
// We normally need a numeric RID, but OT might also accept a `slug` parameter.
// This is undocumented but worth testing: if it works, we can verify any OT restaurant
// discovered via Yahoo search (which returns slug URLs, never profile/RID URLs).
// Worst case: 400/404 response — we log it and return null. Zero risk.

export async function verifyOTBySlug(
  r: Restaurant & { _slug?: string },
  date: string,        // YYYY-MM-DD
  displayTime: string, // "7:00 PM"
  partySize: number,
): Promise<Restaurant | null> {
  const slug = r._slug ?? r.platformUrl.match(/opentable\.com\/r\/([^/?#]+)/i)?.[1];
  if (!slug) return null;

  const time24 = parseDisplayTime(displayTime);

  try {
    // Attempt 1: restref with slug= parameter
    const url = `https://www.opentable.com/restref/api/availability?slug=${encodeURIComponent(slug)}&covers=${partySize}&day=${date}&lang=en-US&ref=5`;
    console.log(`[clientVerifyOTSlug] ${r.name} (slug=${slug}): fetching`);
    const resp = await fetch(url, {
      headers: {
        "Accept":           "application/json, text/javascript, */*; q=0.01",
        "Referer":          "https://www.opentable.com/",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    const body = await resp.text();
    console.log(`[clientVerifyOTSlug] ${r.name}: HTTP ${resp.status} len=${body.length} body=${body.slice(0, 200)}`);
    if (!resp.ok) return null;

    let json: any;
    try { json = JSON.parse(body); } catch { return null; }

    // Check if OT returned a rid in the response — extract and use it for future calls
    const ridFromResp = String(json?.rid ?? json?.restaurantId ?? "").match(/\d+/)?.[0];
    if (ridFromResp) {
      console.log(`[clientVerifyOTSlug] ${r.name}: got rid=${ridFromResp} from slug response!`);
    }

    const text  = JSON.stringify(json);
    const slots = filterWindow(extractTimes(text), time24);
    console.log(`[clientVerifyOTSlug] ${r.name}: ${slots.length} slots in window (keys=${Object.keys(json).join(",")})`);
    if (slots.length === 0) return null;

    const base = r.platformUrl.split("?")[0];
    return {
      ...r,
      timeSlots: slots.map(s => ({
        ...s,
        url: buildOTSlotUrl(base, date, s.time, partySize),
      })),
      softVerified: false,
    };
  } catch (err) {
    console.error(`[clientVerifyOTSlug] ${r.name}: fetch error —`, err);
    return null;
  }
}

// ── OT metro-based browser discovery ─────────────────────────────────────────
// OT's widget/reservation/search endpoint is CORS-enabled by design — it powers
// multi-restaurant booking widgets on hotel/aggregator sites that can't be same-origin.
// We try several plausible endpoint variants. The first one that returns restaurant data
// with RIDs feeds directly into verifyOTRestref.

export async function discoverAndVerifyOT(
  params: { date: string; time: string; partySize: number; metroId: number; cuisine: string },
  onVerified: (r: import("@/types/restaurant").Restaurant) => void,
): Promise<void> {
  const { date, time, partySize, metroId, cuisine } = params;
  const dateTime = `${date}T${time}`;
  const termQ    = cuisine ? `&term=${encodeURIComponent(cuisine)}` : "";

  // Endpoints to probe — most specific (most likely to work) first.
  // The widget/reservation/search endpoint is the authoritative one: it's what hotel
  // and aggregator sites embed to show "book a table nearby" widgets. CORS-enabled by design.
  const candidates = [
    // Multi-restaurant widget search — canonical cross-origin endpoint for hotel/aggregator widgets
    `https://www.opentable.com/widget/reservation/search?covers=${partySize}&dateTime=${dateTime}&metroId=${metroId}${termQ}&type=standard&lang=en-US`,
    // Same endpoint with different type param — some integrators use "widget" type
    `https://www.opentable.com/widget/reservation/search?covers=${partySize}&dateTime=${dateTime}&metroId=${metroId}${termQ}&type=widget&lang=en-US`,
    // restref with metroId instead of rid — might work as a search query
    `https://www.opentable.com/restref/api/availability?metroId=${metroId}&covers=${partySize}&day=${date}&lang=en-US&ref=5`,
    // dapi search — less likely to have CORS but worth one try
    `https://www.opentable.com/dapi/booking/restaurant-availability?metroId=${metroId}&covers=${partySize}&dateTime=${dateTime}`,
  ];

  for (const url of candidates) {
    try {
      console.log(`[discoverOT] probing: ${url.slice(0, 100)}`);
      const resp = await fetch(url, {
        headers: {
          "Accept":           "application/json, */*",
          "Referer":          "https://www.opentable.com/",
          "X-Requested-With": "XMLHttpRequest",
        },
        signal: AbortSignal.timeout(8000),
      });
      const body = await resp.text();
      console.log(`[discoverOT] ${resp.status} len=${body.length} body=${body.slice(0, 300)}`);
      if (!resp.ok || body.length < 10) continue;

      let json: any;
      try { json = JSON.parse(body); } catch { continue; }

      // Extract restaurants from various possible shapes
      const restaurants: any[] = Array.isArray(json) ? json
        : Array.isArray(json.restaurants)   ? json.restaurants
        : Array.isArray(json.results)        ? json.results
        : Array.isArray(json.data)           ? json.data
        : Array.isArray(json.items)          ? json.items
        : [];

      console.log(`[discoverOT] found ${restaurants.length} restaurants from ${url.slice(0, 60)}`);
      if (restaurants.length === 0) continue;

      // Process each restaurant — look for RID and availability slots
      await Promise.all(restaurants.slice(0, 12).map(async (item: any) => {
        const rid = String(item.rid ?? item.restaurantId ?? item.id ?? "").match(/\d+/)?.[0];
        if (!rid) return;

        const name      = item.name ?? item.restaurantName ?? "Restaurant";
        const slug      = item.urlSlug ?? item.slug ?? rid;
        const baseUrl   = `https://www.opentable.com/r/${slug}`;
        const platformUrl = `${baseUrl}?covers=${partySize}&dateTime=${dateTime}`;

        // Build a minimal Restaurant object and verify availability via restref
        const candidate: import("@/types/restaurant").Restaurant & { _rid: string } = {
          id:          `opentable-${slug}`,
          name,
          cuisine:     item.cuisine ?? cuisine ?? "Restaurant",
          neighborhood: item.neighborhood ?? item.city ?? "",
          rating:      item.stars ?? item.rating,
          reviewCount: item.reviewCount ?? item.reviews,
          platform:    "opentable",
          platformUrl,
          timeSlots:   [],
          distanceMiles: null,
          _rid:        rid,
        };

        const verified = await verifyOTRestref(candidate, date, time, partySize);
        if (verified) onVerified(verified);
      }));

      // Found and processed a working endpoint — stop trying others
      return;
    } catch (err) {
      console.log(`[discoverOT] error: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }
}

// ── Yelp SeatMe availability ──────────────────────────────────────────────────
// https://www.yelp.com/reservations/SLUG/availability?covers=P&date=D&time=T
// SeatMe widget endpoint — same cross-origin embedding use-case as OT restref.
// DataDome allows real browsers (it checks TLS fingerprint + behavioral signals,
// not just User-Agent). Blocked from datacenter IPs but works from user browsers.
//
// Note: we intentionally omit X-Requested-With here so the browser sends a
// simple GET (no CORS preflight). OT's endpoint requires it; Yelp's does not —
// preflight adds latency and may trigger DataDome challenge on the OPTIONS call.

export async function verifyYelpAvailability(
  r: Restaurant,
  date: string,        // YYYY-MM-DD
  displayTime: string, // "7:00 PM"
  partySize: number,
): Promise<Restaurant | null> {
  const slugM = r.platformUrl.match(/yelp\.com\/(?:reservations\/|biz\/)([^/?#\s]+)/i);
  if (!slugM) return null;
  const slug = slugM[1];

  const time24 = parseDisplayTime(displayTime);
  // Yelp availability endpoint uses colon-free time (e.g. "1900" not "19:00")
  const timeNoColon = time24.replace(":", "");

  try {
    const url = `https://www.yelp.com/reservations/${slug}/availability?covers=${partySize}&date=${date}&time=${timeNoColon}`;
    console.log(`[clientVerifyYelp] ${r.name}: fetching ${url}`);
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`[clientVerifyYelp] ${r.name}: HTTP ${resp.status}`);
      return null;
    }

    const json = await resp.json();
    const text  = JSON.stringify(json);
    const slots = filterWindow(extractTimes(text), time24);
    console.log(`[clientVerifyYelp] ${r.name}: ${slots.length} slots in window (raw keys: ${Object.keys(json).join(",")})`);
    if (slots.length === 0) return null;

    const base = `https://www.yelp.com/reservations/${slug}`;
    return {
      ...r,
      timeSlots: slots.map(s => ({
        ...s,
        url: buildYelpSlotUrl(base, date, s.time, partySize),
      })),
      softVerified: false,
    };
  } catch (err) {
    console.error(`[clientVerifyYelp] ${r.name}: fetch error —`, err);
    return null;
  }
}
