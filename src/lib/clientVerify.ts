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
    .filter(x => x && Math.abs(x.mins - reqMins) <= 90)
    .sort((a, b) => Math.abs(a!.mins - reqMins) - Math.abs(b!.mins - reqMins))
    .slice(0, 5)
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
    const resp = await fetch(url, {
      headers: {
        "Accept":          "application/json, text/javascript, */*; q=0.01",
        "Referer":         "https://www.opentable.com/",
        "X-Requested-With":"XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;

    const text  = JSON.stringify(await resp.json());
    const slots = filterWindow(extractTimes(text), time24);
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
  } catch {
    return null;
  }
}

// ── Yelp SeatMe availability ──────────────────────────────────────────────────
// https://www.yelp.com/reservations/SLUG/availability?covers=P&date=D&time=T
// SeatMe widget endpoint — same cross-origin embedding use-case as OT restref.
// DataDome allows real browsers (it checks TLS fingerprint + behavioral signals,
// not just User-Agent). Blocked from datacenter IPs but works from user browsers.

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

  try {
    const url = `https://www.yelp.com/reservations/${slug}/availability?covers=${partySize}&date=${date}&time=${time24}`;
    const resp = await fetch(url, {
      headers: {
        "Accept":          "application/json",
        "X-Requested-With":"XMLHttpRequest",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;

    const text  = JSON.stringify(await resp.json());
    const slots = filterWindow(extractTimes(text), time24);
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
  } catch {
    return null;
  }
}
