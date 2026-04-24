/**
 * Street Park Now — Backend
 * Claude-powered NYC parking intelligence
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const { Pool }  = require("pg");
const Stripe    = require("stripe");
const twilio    = require("twilio");
const crypto    = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;

const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db           = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const JWT_SECRET = process.env.JWT_SECRET || "movemycar-secret-change-in-prod";

// Simple JWT implementation without external dependency
function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg:"HS256", typ:"JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000) })).toString("base64url");
  const sig    = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64url");
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString());
  } catch { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "Invalid token" });
  req.userId = payload.userId;
  req.userTier = payload.tier;
  next();
}

// Tier limits
const TIER_LIMITS = {
  free:      { searches: 8,    savedSearches: 0,  recentOnMap: 0  },
  basic:     { searches: 999,  savedSearches: 0,  recentOnMap: 2  },
  premium:   { searches: Infinity, savedSearches: 0, recentOnMap: 2 },
  unlimited: { searches: Infinity, savedSearches: 10, recentOnMap: 2 },
};

app.use(cors({ origin: "*" }));
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const SOCRATA = "https://data.cityofnewyork.us/resource";

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY || "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error(`Claude API ${r.status}:`, err.substring(0, 200));
    throw new Error(`Claude API ${r.status}`);
  }
  const d = await r.json();
  const text = d.content?.[0]?.text || "";
  if (!text) console.error("Claude returned empty text, full response:", JSON.stringify(d).substring(0, 200));
  return text;
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const STREET_ABBR = {
  AVE:"AVENUE", AV:"AVENUE", AVENUE:"AVENUE",
  ST:"STREET", STR:"STREET", STREET:"STREET",
  PL:"PLACE", PLACE:"PLACE",
  RD:"ROAD", ROAD:"ROAD",
  BLVD:"BOULEVARD", BOULEVARD:"BOULEVARD",
  DR:"DRIVE", DRIVE:"DRIVE",
  CT:"COURT", COURT:"COURT",
  PKWY:"PARKWAY", PARKWAY:"PARKWAY",
  LN:"LANE", LANE:"LANE",
  SQ:"SQUARE", SQUARE:"SQUARE",
  TER:"TERRACE", TERRACE:"TERRACE",
  HWY:"HIGHWAY", HIGHWAY:"HIGHWAY",
  EXT:"EXTENSION", EXTENSION:"EXTENSION",
  PLZ:"PLAZA", PLAZA:"PLAZA",
};
function normStreet(s) {
  if (!s) return "";
  return String(s).toUpperCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map(w => STREET_ABBR[w] || w)
    .join(" ")
    .trim();
}

// ─── CHICAGO STREET SWEEPING (real city data) ───────────────────────────────
// Pulls the official 2026 zone polygons + per-month dates from the Chicago
// data portal (dataset 2r7q-emq3). Each zone is a ward section; the month
// fields hold comma-separated day numbers (e.g. april: "1,2,23,24").
const CHICAGO_ZONES_URL = "https://data.cityofchicago.org/resource/2r7q-emq3.json?$limit=2000";
const CHICAGO_MONTH_FIELDS = { april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11 };
const CHICAGO_BBOX = { minLat: 41.60, maxLat: 42.10, minLng: -87.95, maxLng: -87.52 };
let _chicagoZonesCache = null;
let _chicagoZonesTs = 0;
const CHICAGO_ZONES_TTL = 7 * 24 * 3600 * 1000;

function isChicago(lat, lng) {
  return lat >= CHICAGO_BBOX.minLat && lat <= CHICAGO_BBOX.maxLat &&
         lng >= CHICAGO_BBOX.minLng && lng <= CHICAGO_BBOX.maxLng;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultiPolygon(lng, lat, geom) {
  if (!geom || geom.type !== "MultiPolygon" || !Array.isArray(geom.coordinates)) return false;
  for (const polygon of geom.coordinates) {
    if (!polygon.length) continue;
    if (!pointInRing(lng, lat, polygon[0])) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(lng, lat, polygon[i])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function zoneDates(zone, year) {
  const out = [];
  for (const [field, monthIdx] of Object.entries(CHICAGO_MONTH_FIELDS)) {
    const raw = zone[field];
    if (!raw) continue;
    for (const token of String(raw).split(",")) {
      const day = parseInt(token.trim(), 10);
      if (day >= 1 && day <= 31) {
        out.push(new Date(year, monthIdx - 1, day));
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

async function loadChicagoZones() {
  if (_chicagoZonesCache && Date.now() - _chicagoZonesTs < CHICAGO_ZONES_TTL) {
    return _chicagoZonesCache;
  }
  try {
    const r = await fetch(CHICAGO_ZONES_URL);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const raw = await r.json();
    const year = new Date().getFullYear();
    const zones = raw.map(z => {
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      const geom = z.the_geom;
      if (geom?.coordinates) {
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            for (const [lng, lat] of ring) {
              if (lat < minLat) minLat = lat;
              if (lat > maxLat) maxLat = lat;
              if (lng < minLng) minLng = lng;
              if (lng > maxLng) maxLng = lng;
            }
          }
        }
      }
      return {
        ward_section: z.ward_section,
        ward: z.ward,
        section: z.section,
        geom,
        dates: zoneDates(z, year),
        bbox: { minLat, maxLat, minLng, maxLng },
      };
    });
    _chicagoZonesCache = zones;
    _chicagoZonesTs = Date.now();
    console.log(`Chicago zones loaded: ${zones.length} zones`);
  } catch (e) {
    console.error("Chicago zones load failed:", e.message);
    if (!_chicagoZonesCache) _chicagoZonesCache = [];
  }
  return _chicagoZonesCache;
}

function findChicagoZone(lat, lng, zones) {
  for (const zone of zones) {
    const { minLat, maxLat, minLng, maxLng } = zone.bbox;
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) continue;
    if (pointInMultiPolygon(lng, lat, zone.geom)) return zone;
  }
  return null;
}

function chicagoUrgency(nextDate, today) {
  if (!nextDate) return "gray";
  const daysAway = Math.floor((nextDate - today) / 86400000);
  if (daysAway < 0) return "gray";
  if (daysAway <= 1) return "red";
  if (daysAway <= 3) return "yellow";
  return "green";
}

function chicagoNextCleanLabel(nextDate, today) {
  if (!nextDate) return null;
  const daysAway = Math.floor((nextDate - today) / 86400000);
  const human = nextDate.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
  if (daysAway === 0) return `Today (${human}) 9 AM - 2 PM`;
  if (daysAway === 1) return `Tomorrow (${human}) 9 AM - 2 PM`;
  return `${human} (in ${daysAway} days) 9 AM - 2 PM`;
}

// ─── CHICAGO PERMIT ZONES (dataset u9xt-hiju) ────────────────────────────────
// Per-block permit-only zones with address ranges. Fetched on demand per
// street-name batch so we don't pay to cache every zone in the city up-front.
async function chicagoPermitZones(streetsNormalized) {
  if (!streetsNormalized?.length) return {};
  // u9xt-hiju stores direction + name + type separately. Users search with
  // composed names like "SOUTH MICHIGAN AVENUE" — strip the direction and
  // street-type suffix to match the dataset's street_name column.
  const DIR = { NORTH:"N", SOUTH:"S", EAST:"E", WEST:"W" };
  const SUF = new Set(["AVENUE","AVE","STREET","ST","BOULEVARD","BLVD","ROAD","RD","DRIVE","DR","PLACE","PL","COURT","CT","LANE","LN","PARKWAY","PKWY","TERRACE","TER"]);
  const decompose = (full) => {
    const parts = full.toUpperCase().split(/\s+/);
    let dir = null;
    if (parts.length && DIR[parts[0]]) { dir = DIR[parts.shift()]; }
    while (parts.length && SUF.has(parts[parts.length-1])) parts.pop();
    return { dir, core: parts.join(" ") };
  };
  const coreNames = [...new Set(streetsNormalized.map(s => decompose(s).core).filter(Boolean))];
  if (!coreNames.length) return {};
  const predicate = coreNames.map(n => `street_name='${n.replace(/'/g,"''")}'`).join(" OR ");
  const url = `https://data.cityofchicago.org/resource/u9xt-hiju.json?$where=status%3D'ACTIVE'%20AND%20(${encodeURIComponent(predicate)})&$limit=2000`;
  try {
    const r = await fetch(url);
    if (!r.ok) return {};
    const rows = await r.json();
    const byStreet = {};
    for (const row of rows) {
      const core = String(row.street_name || "").toUpperCase();
      const dir = String(row.street_direction || "").toUpperCase();
      // Match back to the caller's normalized name — prefer exact dir match, fall back to any.
      const match = streetsNormalized.find(s => {
        const d = decompose(s);
        return d.core === core && (!d.dir || !dir || d.dir === dir);
      });
      if (!match) continue;
      if (!byStreet[match]) byStreet[match] = [];
      byStreet[match].push({
        zone: row.zone,
        side: row.odd_even === "O" ? "Odd" : row.odd_even === "E" ? "Even" : "",
        lowAddr: row.address_range_low,
        highAddr: row.address_range_high,
      });
    }
    return byStreet;
  } catch (e) {
    console.error("Chicago permit zones fetch failed:", e.message);
    return {};
  }
}

// ─── CHICAGO PARK DISTRICT EVENTS (dataset pk66-w54g) ────────────────────────
// Returns upcoming events at known park facilities near the given coords.
// Currently whitelists the high-traffic venues whose event permits appear in
// the dataset (Soldier Field, Grant Park, Millennium Park, Maggie Daley).
// Expand the list as new venues become relevant.
const CHICAGO_PARK_VENUES = [
  { match: /SOLDIER FIELD/i,  name: "Soldier Field",    lat: 41.8624, lng: -87.6167 },
  { match: /GRANT PARK/i,     name: "Grant Park",       lat: 41.8756, lng: -87.6244 },
  { match: /MILLENNIUM PARK/i,name: "Millennium Park",  lat: 41.8826, lng: -87.6226 },
  { match: /MAGGIE DALEY/i,   name: "Maggie Daley Park",lat: 41.8847, lng: -87.6195 },
];

async function chicagoNearbyEvents(lat, lng, radiusMi = 0.5) {
  const lt = +lat, ln = +lng;
  if (!isChicago(lt, ln)) return [];
  const RADIUS_KM = radiusMi * 1.60934;
  const nearbyVenues = CHICAGO_PARK_VENUES.filter(v => haversineKm(lt, ln, v.lat, v.lng) <= RADIUS_KM);
  if (!nearbyVenues.length) return [];
  const today = new Date().toISOString().slice(0,10);
  const horizon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0,10);
  const results = [];
  for (const venue of nearbyVenues) {
    const escaped = venue.name.replace(/'/g,"''").toUpperCase();
    const where = `upper(park_facility_name) LIKE '%${escaped}%' AND reservation_start_date >= '${today}' AND reservation_start_date <= '${horizon}' AND permit_status != 'Canceled'`;
    const url = `https://data.cityofchicago.org/resource/pk66-w54g.json?$where=${encodeURIComponent(where)}&$order=reservation_start_date&$limit=20`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const rows = await r.json();
      for (const row of rows) {
        const startStr = row.reservation_start_date || "";
        const start = new Date(startStr);
        const days = Math.max(0, Math.floor((start - new Date()) / 86400000));
        results.push({
          source: "chicago_park_district",
          venue: venue.name,
          venueLat: venue.lat,
          venueLng: venue.lng,
          distanceKm: haversineKm(lt, ln, venue.lat, venue.lng).toFixed(2),
          name: row.event_description || row.event_type || "Park District event",
          startDate: startStr.slice(0,10),
          endDate: (row.reservation_end_date || "").slice(0,10),
          daysAway: days,
          eventType: row.event_type,
        });
      }
    } catch (e) { console.error(`Park events fetch (${venue.name}):`, e.message); }
  }
  results.sort((a,b) => new Date(a.startDate) - new Date(b.startDate));
  return results;
}

// ─── MAJOR SPORTS VENUES (ESPN public scoreboard) ────────────────────────────
// Proximity table used to surface home-game events near the user. Covers the
// Chicago / NYC / LA venues the product cares about plus a few expansion
// candidates; extend as new cities get real-data coverage.
const SPORTS_VENUES = [
  // Chicago
  { key: "Soldier Field",          lat: 41.8624, lng: -87.6167, city: "Chicago",   leagues: ["nfl"] },
  { key: "Wrigley Field",          lat: 41.9484, lng: -87.6553, city: "Chicago",   leagues: ["mlb"] },
  { key: "Guaranteed Rate Field",  lat: 41.8300, lng: -87.6339, city: "Chicago",   leagues: ["mlb"] },
  { key: "Rate Field",             lat: 41.8300, lng: -87.6339, city: "Chicago",   leagues: ["mlb"] }, // rebrand
  { key: "United Center",          lat: 41.8807, lng: -87.6742, city: "Chicago",   leagues: ["nba","nhl"] },
  // NYC metro
  { key: "MetLife Stadium",        lat: 40.8135, lng: -74.0745, city: "East Rutherford", leagues: ["nfl"] },
  { key: "Yankee Stadium",         lat: 40.8296, lng: -73.9262, city: "Bronx",     leagues: ["mlb"] },
  { key: "Citi Field",             lat: 40.7571, lng: -73.8458, city: "Queens",    leagues: ["mlb"] },
  { key: "Madison Square Garden",  lat: 40.7505, lng: -73.9934, city: "New York",  leagues: ["nba","nhl"] },
  // LA metro
  { key: "SoFi Stadium",           lat: 33.9535, lng: -118.3392,city: "Inglewood", leagues: ["nfl"] },
  { key: "Crypto.com Arena",       lat: 34.0430, lng: -118.2673,city: "Los Angeles",leagues: ["nba","nhl"] },
  { key: "Dodger Stadium",         lat: 34.0739, lng: -118.2400,city: "Los Angeles",leagues: ["mlb"] },
];

const ESPN_LEAGUE_PATHS = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
};

const _leagueScheduleCache = new Map(); // league -> {events, ts}
const LEAGUE_SCHEDULE_TTL = 3 * 3600 * 1000; // 3h

async function fetchLeagueSchedule(league) {
  const cached = _leagueScheduleCache.get(league);
  if (cached && Date.now() - cached.ts < LEAGUE_SCHEDULE_TTL) return cached.events;
  const pathSeg = ESPN_LEAGUE_PATHS[league];
  if (!pathSeg) return [];
  const fmt = d => d.toISOString().slice(0,10).replace(/-/g,"");
  const start = new Date();
  const end = new Date(Date.now() + 14 * 86400000);
  const url = `https://site.api.espn.com/apis/site/v2/sports/${pathSeg}/scoreboard?dates=${fmt(start)}-${fmt(end)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) { console.error(`ESPN ${league} status ${r.status}`); return []; }
    const data = await r.json();
    const events = data.events || [];
    _leagueScheduleCache.set(league, { events, ts: Date.now() });
    return events;
  } catch (e) {
    console.error(`ESPN ${league} fetch:`, e.message);
    return [];
  }
}

async function fetchSportsEventsNear(lat, lng, radiusKm = 3) {
  const lt = +lat, ln = +lng;
  const nearby = SPORTS_VENUES.filter(v => haversineKm(lt, ln, v.lat, v.lng) <= radiusKm);
  if (!nearby.length) return [];
  const leaguesNeeded = [...new Set(nearby.flatMap(v => v.leagues))];
  const schedules = await Promise.all(
    leaguesNeeded.map(async l => ({ l, events: await fetchLeagueSchedule(l) }))
  );
  const out = [];
  for (const venue of nearby) {
    const dist = haversineKm(lt, ln, venue.lat, venue.lng);
    const venueKeyLower = venue.key.toLowerCase();
    for (const { l, events } of schedules) {
      if (!venue.leagues.includes(l)) continue;
      for (const ev of events) {
        const comp = ev.competitions?.[0] || {};
        const venueName = String(comp.venue?.fullName || "").toLowerCase();
        if (!venueName.includes(venueKeyLower)) continue;
        const home = (comp.competitors || []).find(c => c.homeAway === "home");
        const away = (comp.competitors || []).find(c => c.homeAway === "away");
        const startIso = ev.date || "";
        const daysAway = Math.max(0, Math.floor((new Date(startIso) - new Date()) / 86400000));
        out.push({
          source: `espn_${l}`,
          league: l.toUpperCase(),
          venue: venue.key,
          venueLat: venue.lat,
          venueLng: venue.lng,
          distanceKm: +dist.toFixed(2),
          home: home?.team?.displayName || "",
          away: away?.team?.displayName || "",
          startDate: startIso.slice(0,10),
          startDateTime: startIso,
          daysAway,
        });
      }
    }
  }
  // Dedupe games at multi-league venues (MSG hosts Knicks + Rangers; we don't
  // want to double-count if an event shows up in both feeds for any reason).
  const seen = new Set();
  const deduped = out.filter(e => {
    const k = `${e.venue}|${e.startDateTime}|${e.home}|${e.away}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  deduped.sort((a,b) => new Date(a.startDateTime) - new Date(b.startDateTime));
  return deduped;
}

function parseSignText(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!upper.includes("STREET CLEANING") && !upper.includes("NO PARKING")) return null;
  const dayMap = { MON:"Mon", TUE:"Tue", WED:"Wed", THU:"Thu", FRI:"Fri", SAT:"Sat", SUN:"Sun" };
  const days = Object.entries(dayMap).filter(([k]) => new RegExp(`\\b${k}`,"i").test(text)).map(([,v]) => v);
  const tm = text.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*(?:[-]|TO|THRU)\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
  return { days, time: tm ? `${tm[1].trim()} - ${tm[2].trim()}` : null, raw: text };
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter(r => { const k = `${r.days}-${r.time}-${r.side}`; return seen.has(k) ? false : seen.add(k); });
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ─── NEIGHBORHOOD STREET CATALOG ─────────────────────────────────────────────
// Hardcoded verified streets for major neighborhoods — instant, reliable
const NEIGHBORHOOD_STREETS = {
  // NYC - Brooklyn
  "williamsburg": ["BEDFORD AVENUE","BERRY STREET","BROADWAY","DIVISION AVENUE","DRIGGS AVENUE","FLUSHING AVENUE","FROST STREET","GRAND STREET","HAVEMEYER STREET","HOOPER STREET","KENT AVENUE","LEE AVENUE","LORIMER STREET","LYNCH STREET","MANHATTAN AVENUE","MARCY AVENUE","METROPOLITAN AVENUE","MONTROSE AVENUE","MOORE STREET","MYRTLE AVENUE","NORTH 1 STREET","NORTH 10 STREET","NORTH 11 STREET","NORTH 12 STREET","NORTH 3 STREET","NORTH 4 STREET","NORTH 5 STREET","NORTH 6 STREET","NORTH 7 STREET","NORTH 8 STREET","NORTH 9 STREET","PENN STREET","PETERSFIELD STREET","POWERS STREET","ROEBLING STREET","SOUTH 1 STREET","SOUTH 2 STREET","SOUTH 3 STREET","SOUTH 4 STREET","SOUTH 5 STREET","SOUTH 8 STREET","UNION AVENUE","VARET STREET","WALTON STREET","WHIPPLE STREET","WILSON STREET","WITHERS STREET","WYTHE AVENUE"],
  "brooklyn heights": ["ATLANTIC AVENUE","CLARK STREET","COLUMBIA HEIGHTS","CRANBERRY STREET","FULTON STREET","GRACE COURT","GRACE COURT ALLEY","HENRY STREET","HICKS STREET","JORALEMON STREET","LOVE LANE","MIDDAGH STREET","MONTAGUE STREET","MONTAGUE TERRACE","ORANGE STREET","PIERREPONT PLACE","PIERREPONT STREET","PINEAPPLE STREET","POPLAR STREET","REMSEN STREET","VINE STREET","WILLOW PLACE","WILLOW STREET"],
  "park slope": ["1 STREET","2 STREET","3 STREET","4 STREET","5 STREET","6 STREET","7 STREET","8 STREET","9 STREET","BERKELEY PLACE","CARROLL STREET","DEGRAW STREET","EAST DRIVE","FIFTH AVENUE","FLATBUSH AVENUE","GARFIELD PLACE","LINCOLN PLACE","MONTGOMERY PLACE","PARK PLACE","PLAZA STREET WEST","POLHEMUS PLACE","PRESIDENT STREET","PROSPECT PARK WEST","SAINT JOHNS PLACE","SEVENTH AVENUE","SIXTH AVENUE","STERLING PLACE","UNION STREET","WARREN STREET","WINDSOR PLACE"],
  "the slope": ["1 STREET","2 STREET","3 STREET","4 STREET","5 STREET","6 STREET","7 STREET","8 STREET","9 STREET","BERKELEY PLACE","CARROLL STREET","DEGRAW STREET","EAST DRIVE","FIFTH AVENUE","FLATBUSH AVENUE","GARFIELD PLACE","LINCOLN PLACE","MONTGOMERY PLACE","PARK PLACE","PLAZA STREET WEST","PRESIDENT STREET","PROSPECT PARK WEST","SAINT JOHNS PLACE","SEVENTH AVENUE","SIXTH AVENUE","STERLING PLACE","UNION STREET","WARREN STREET","WINDSOR PLACE"],
  "greenpoint": ["ASH STREET","BOX STREET","CALYER STREET","EAGLE STREET","FREEMAN STREET","GREENPOINT AVENUE","HURON STREET","INDIA STREET","JAVA STREET","KENT STREET","KINGSLAND AVENUE","LORIMER STREET","MANHATTAN AVENUE","MCGUINNESS BOULEVARD","MESEROLE AVENUE","MONITOR STREET","MOULTRIE STREET","NASSAU AVENUE","NEWEL STREET","NOBLE STREET","NORMAN AVENUE","PROVOST STREET","RICHARDSON STREET","RUSSELL STREET","VAN DAM STREET","WEST STREET"],
  "bushwick": ["BLEECKER STREET","BROADWAY","BUSHWICK AVENUE","CENTRAL AVENUE","CORNELIA STREET","DEKALB AVENUE","ELDERT STREET","EVERGREEN AVENUE","FLUSHING AVENUE","FOREST STREET","GATES AVENUE","GROVE STREET","HART STREET","HIMROD STREET","IRVING AVENUE","JEFFERSON STREET","KNICKERBOCKER AVENUE","LINDEN STREET","MADISON STREET","MELROSE STREET","MOFFAT STREET","MORGAN AVENUE","SCHAEFER STREET","STOCKHOLM STREET","STANHOPE STREET","TROUTMAN STREET","WILSON AVENUE","WEIRFIELD STREET"],
  "dumbo": ["ADAMS STREET","ANCHORAGE PLACE","BRIDGE STREET","CONCORD STREET","DOCK STREET","FERRY STREET","FRONT STREET","FULTON STREET","GOLD STREET","JAY STREET","JOHN STREET","MAIN STREET","MARSHALL STREET","MIDDAGH STREET","PEARL STREET","PLYMOUTH STREET","PROSPECT STREET","SANDS STREET","WATER STREET","WASHINGTON STREET"],
  "cobble hill": ["AMITY STREET","ATLANTIC AVENUE","BALTIC STREET","BOURUM PLACE","CHEEVER PLACE","CLINTON STREET","CONGRESS STREET","DEGRAW STREET","HENRY STREET","HICKS STREET","KANE STREET","PACIFIC STREET","PRESIDENT STREET","STRONG PLACE","TOMPKINS PLACE","WARREN STREET","WYCKOFF STREET"],
  "carroll gardens": ["1 PLACE","2 PLACE","3 PLACE","4 PLACE","ATLANTIC AVENUE","BALTIC STREET","CLINTON STREET","COURT STREET","DEGRAW STREET","HENRY STREET","HUNTINGTON STREET","LUQUER STREET","NELSON STREET","PRESIDENT STREET","SACKETT STREET","SMITH STREET","UNION STREET","WARREN STREET","WYCKOFF STREET"],
  "bed stuy": ["AUBURN PLACE","BAINBRIDGE STREET","BEDFORD AVENUE","BROADWAY","CHAUNCEY STREET","CLIFTON PLACE","DECATUR STREET","DEKALB AVENUE","FULTON STREET","GATES AVENUE","GREENE AVENUE","HALSEY STREET","HANCOCK STREET","HART STREET","JEFFERSON AVENUE","KOSCIUSZKO STREET","LAFAYETTE AVENUE","LEX AVENUE","LEWIS AVENUE","LEXINGTON AVENUE","MACON STREET","MACDONOUGH STREET","MADISON STREET","MARCUS GARVEY BOULEVARD","MONROE STREET","NOSTRAND AVENUE","PUTNAM AVENUE","REID AVENUE","SARATOGA AVENUE","STUYVESANT AVENUE","SUMNER AVENUE","THROOP AVENUE","TOMPKINS AVENUE","VAN BUREN STREET","WEIRFIELD STREET"],
  // NYC - Manhattan
  "west village": ["BANK STREET","BARROW STREET","BEDFORD STREET","BETHUNE STREET","CHARLES STREET","CHRISTOPHER STREET","CLARKSON STREET","COMMERCE STREET","CORNELIA STREET","GROVE STREET","HORATIO STREET","HUDSON STREET","JANE STREET","LEROY STREET","MORTON STREET","PERRY STREET","WASHINGTON STREET","WAVERLY PLACE","WEST 10 STREET","WEST 11 STREET","WEST 12 STREET","WEST 13 STREET","WEST 4 STREET","WEST STREET","WEEHAWKEN STREET"],
  "east village": ["1 AVENUE","2 AVENUE","3 AVENUE","AVENUE A","AVENUE B","AVENUE C","AVENUE D","EAST 10 STREET","EAST 11 STREET","EAST 12 STREET","EAST 13 STREET","EAST 14 STREET","EAST 1 STREET","EAST 2 STREET","EAST 3 STREET","EAST 4 STREET","EAST 5 STREET","EAST 6 STREET","EAST 7 STREET","EAST 8 STREET","EAST 9 STREET","SAINT MARKS PLACE","STUYVESANT STREET","TOMPKINS SQUARE"],
  "greenwich village": ["6 AVENUE","7 AVENUE SOUTH","BARROW STREET","BEDFORD STREET","BLEECKER STREET","CHRISTOPHER STREET","CORNELIA STREET","DOWNING STREET","GROVE STREET","HUDSON STREET","JANE STREET","JONES STREET","KING STREET","LEROY STREET","MACDOUGAL STREET","MINETTA LANE","MINETTA STREET","MORTON STREET","PERRY STREET","PRINCE STREET","SULLIVAN STREET","THOMPSON STREET","WASHINGTON SQUARE EAST","WASHINGTON SQUARE NORTH","WASHINGTON SQUARE SOUTH","WASHINGTON SQUARE WEST","WAVERLY PLACE","WEST 10 STREET","WEST 11 STREET","WEST 12 STREET","WEST 13 STREET","WEST 14 STREET","WEST 3 STREET","WEST 4 STREET","WEST 8 STREET","WEST 9 STREET"],
  "soho": ["BROADWAY","BROOME STREET","CANAL STREET","CROSBY STREET","GRAND STREET","GREENE STREET","HOWARD STREET","HOUSTON STREET","KING STREET","LAGUARDIA PLACE","MERCER STREET","PRINCE STREET","SPRING STREET","SULLIVAN STREET","THOMPSON STREET","VANDAM STREET","WEST BROADWAY","WOOSTER STREET"],
  "tribeca": ["AVENUE OF THE AMERICAS","BEACH STREET","BROADWAY","CANAL STREET","CHAMBERS STREET","CHURCH STREET","DESBROSSES STREET","DUANE STREET","FRANKLIN STREET","GREENWICH STREET","HARRISON STREET","HUDSON STREET","JAY STREET","LAIGHT STREET","LEONARD STREET","LISPENARD STREET","MOORE STREET","MURRAY STREET","N MOORE STREET","READE STREET","STAPLE STREET","THOMAS STREET","VESTRY STREET","WALKER STREET","WARREN STREET","WASHINGTON STREET","WATTS STREET","WHITE STREET","WORTH STREET"],
  "hell's kitchen": ["10 AVENUE","11 AVENUE","8 AVENUE","9 AVENUE","WEST 42 STREET","WEST 43 STREET","WEST 44 STREET","WEST 45 STREET","WEST 46 STREET","WEST 47 STREET","WEST 48 STREET","WEST 49 STREET","WEST 50 STREET","WEST 51 STREET","WEST 52 STREET","WEST 53 STREET","WEST 54 STREET","WEST 55 STREET","WEST 56 STREET","WEST 57 STREET","WEST 58 STREET","WEST 59 STREET"],
  "upper west side": ["AMSTERDAM AVENUE","BROADWAY","CENTRAL PARK WEST","COLUMBUS AVENUE","RIVERSIDE DRIVE","WEST END AVENUE","WEST 59 STREET","WEST 60 STREET","WEST 61 STREET","WEST 62 STREET","WEST 63 STREET","WEST 64 STREET","WEST 65 STREET","WEST 66 STREET","WEST 67 STREET","WEST 68 STREET","WEST 69 STREET","WEST 70 STREET","WEST 71 STREET","WEST 72 STREET","WEST 73 STREET","WEST 74 STREET","WEST 75 STREET","WEST 76 STREET","WEST 77 STREET","WEST 78 STREET","WEST 79 STREET","WEST 80 STREET","WEST 81 STREET","WEST 82 STREET","WEST 83 STREET","WEST 84 STREET","WEST 85 STREET","WEST 86 STREET","WEST 87 STREET","WEST 88 STREET","WEST 89 STREET","WEST 90 STREET","WEST 91 STREET","WEST 92 STREET","WEST 93 STREET","WEST 94 STREET","WEST 95 STREET","WEST 96 STREET","WEST 97 STREET","WEST 98 STREET","WEST 99 STREET","WEST 100 STREET"],
  "upper east side": ["1 AVENUE","2 AVENUE","3 AVENUE","5 AVENUE","EAST 59 STREET","EAST 60 STREET","EAST 61 STREET","EAST 62 STREET","EAST 63 STREET","EAST 64 STREET","EAST 65 STREET","EAST 66 STREET","EAST 67 STREET","EAST 68 STREET","EAST 69 STREET","EAST 70 STREET","EAST 71 STREET","EAST 72 STREET","EAST 73 STREET","EAST 74 STREET","EAST 75 STREET","EAST 76 STREET","EAST 77 STREET","EAST 78 STREET","EAST 79 STREET","EAST 80 STREET","EAST 81 STREET","EAST 82 STREET","EAST 83 STREET","EAST 84 STREET","EAST 85 STREET","EAST 86 STREET","EAST 87 STREET","EAST 88 STREET","EAST 89 STREET","EAST 90 STREET","EAST 91 STREET","EAST 92 STREET","EAST 93 STREET","EAST 94 STREET","EAST 95 STREET","EAST 96 STREET","LEXINGTON AVENUE","MADISON AVENUE","PARK AVENUE","YORK AVENUE"],
  "harlem": ["ADAM CLAYTON POWELL JR BOULEVARD","AMSTERDAM AVENUE","BRADHURST AVENUE","BROADWAY","CONVENT AVENUE","EDGECOMBE AVENUE","EIGHTH AVENUE","FREDERICK DOUGLASS BOULEVARD","HAMILTON TERRACE","LENOX AVENUE","LEXINGTON AVENUE","MADISON AVENUE","MANHATTAN AVENUE","MORNINGSIDE AVENUE","NICHOLAS AVENUE","PARK AVENUE","SAINT NICHOLAS AVENUE","SEVENTH AVENUE","STRIVERS ROW","WEST 110 STREET","WEST 111 STREET","WEST 112 STREET","WEST 113 STREET","WEST 114 STREET","WEST 115 STREET","WEST 116 STREET","WEST 117 STREET","WEST 118 STREET","WEST 119 STREET","WEST 120 STREET","WEST 121 STREET","WEST 122 STREET","WEST 123 STREET","WEST 124 STREET","WEST 125 STREET","WEST 126 STREET","WEST 127 STREET","WEST 128 STREET","WEST 129 STREET","WEST 130 STREET"],
  "chelsea": ["10 AVENUE","11 AVENUE","8 AVENUE","9 AVENUE","WEST 14 STREET","WEST 15 STREET","WEST 16 STREET","WEST 17 STREET","WEST 18 STREET","WEST 19 STREET","WEST 20 STREET","WEST 21 STREET","WEST 22 STREET","WEST 23 STREET","WEST 24 STREET","WEST 25 STREET","WEST 26 STREET","WEST 27 STREET","WEST 28 STREET","WEST 29 STREET"],
  "lower east side": ["ALLEN STREET","ATTORNEY STREET","BROOME STREET","CANAL STREET","CHRYSTIE STREET","CLINTON STREET","DELANCEY STREET","ELDRIDGE STREET","ESSEX STREET","FORSYTH STREET","GRAND STREET","HESTER STREET","HOUSTON STREET","LUDLOW STREET","MADISON STREET","MONROE STREET","NORFOLK STREET","ORCHARD STREET","PITT STREET","RIVINGTON STREET","RUTGERS STREET","STANTON STREET","SUFFOLK STREET","WILLET STREET"],
  "financial district": ["BATTERY PLACE","BEEKMAN STREET","BOWLING GREEN","BROADWAY","CEDAR STREET","CORTLANDT STREET","DEY STREET","EXCHANGE PLACE","FULTON STREET","GOLD STREET","JOHN STREET","LIBERTY STREET","MAIDEN LANE","NASSAU STREET","NEW STREET","PEARL STREET","PINE STREET","RECTOR STREET","STONE STREET","WALL STREET","WATER STREET","WHITEHALL STREET","WILLIAM STREET"],
  "gramercy park": ["1 AVENUE","2 AVENUE","3 AVENUE","EAST 14 STREET","EAST 15 STREET","EAST 16 STREET","EAST 17 STREET","EAST 18 STREET","EAST 19 STREET","EAST 20 STREET","EAST 21 STREET","EAST 22 STREET","EAST 23 STREET","EAST 24 STREET","EAST 25 STREET","GRAMERCY PARK EAST","GRAMERCY PARK NORTH","GRAMERCY PARK SOUTH","GRAMERCY PARK WEST","IRVING PLACE","LEXINGTON AVENUE","PARK AVENUE SOUTH","STUYVESANT SQUARE"],
  "midtown": ["5 AVENUE","6 AVENUE","7 AVENUE","8 AVENUE","BROADWAY","EAST 42 STREET","EAST 43 STREET","EAST 44 STREET","EAST 45 STREET","EAST 46 STREET","EAST 47 STREET","EAST 48 STREET","EAST 49 STREET","EAST 50 STREET","LEXINGTON AVENUE","MADISON AVENUE","PARK AVENUE","VANDERBILT AVENUE","WEST 42 STREET","WEST 43 STREET","WEST 44 STREET","WEST 45 STREET","WEST 46 STREET","WEST 47 STREET","WEST 48 STREET","WEST 49 STREET","WEST 50 STREET"],
  // NYC - Queens
  "astoria": ["21 STREET","23 STREET","29 STREET","31 STREET","33 STREET","35 STREET","36 AVENUE","37 AVENUE","38 AVENUE","ASTORIA BOULEVARD","BROADWAY","DITMARS BOULEVARD","HOYT AVENUE NORTH","HOYT AVENUE SOUTH","NEWTOWN AVENUE","NORTHERN BOULEVARD","STEINWAY STREET","VERMONT PLACE"],
  "long island city": ["21 STREET","22 STREET","23 STREET","24 STREET","44 DRIVE","44 ROAD","45 AVENUE","45 ROAD","46 AVENUE","47 AVENUE","48 AVENUE","BORDEN AVENUE","COURT SQUARE","DAVIS STREET","DUTCH KILLS STREET","JACKSON AVENUE","NORTHERN BOULEVARD","PURVES STREET","QUEENS BOULEVARD","QUEENS PLAZA NORTH","QUEENS PLAZA SOUTH","SKILLMAN AVENUE","THOMPSON AVENUE","THOMSON AVENUE","VERNON BOULEVARD","VAN DAM STREET","WATER STREET","YOUNG STREET"],
  "court square": ["21 STREET","23 STREET","44 DRIVE","44 ROAD","45 AVENUE","45 ROAD","BORDEN AVENUE","COURT SQUARE","DAVIS STREET","JACKSON AVENUE","PURVES STREET","QUEENS PLAZA NORTH","QUEENS PLAZA SOUTH","SKILLMAN AVENUE","THOMPSON AVENUE","THOMSON AVENUE","VAN DAM STREET","YOUNG STREET"],
  "hunters point": ["BORDEN AVENUE","CENTER BOULEVARD","COURT SQUARE","DAVIS STREET","DUTCH KILLS STREET","HUNTERS POINT AVENUE","JACKSON AVENUE","WATER STREET","VERNON BOULEVARD","VAN DAM STREET","45 AVENUE","45 ROAD","46 AVENUE","47 AVENUE","48 AVENUE","2 STREET","5 STREET","11 STREET"],
  "vernon jackson": ["JACKSON AVENUE","VERNON BOULEVARD","PURVES STREET","QUEENS PLAZA NORTH","QUEENS PLAZA SOUTH","44 DRIVE","44 ROAD","45 AVENUE","23 STREET","21 STREET","SKILLMAN AVENUE","THOMSON AVENUE"],
  "dutch kills": ["DUTCH KILLS STREET","JACKSON AVENUE","NORTHERN BOULEVARD","QUEENS PLAZA NORTH","SKILLMAN AVENUE","37 AVENUE","38 AVENUE","39 AVENUE","40 ROAD","41 AVENUE","CRESCENT STREET","QUEENSBORO PLAZA"],
  "queensboro plaza": ["JACKSON AVENUE","NORTHERN BOULEVARD","QUEENS PLAZA NORTH","QUEENS PLAZA SOUTH","QUEENSBORO BRIDGE","21 STREET","BRIDGE PLAZA NORTH","BRIDGE PLAZA SOUTH"],
  "flushing": ["BOWNE STREET","CHERRY AVENUE","COLLEGE POINT BOULEVARD","ELM AVENUE","FRANKLIN AVENUE","GERANIUM AVENUE","HOLLY AVENUE","KISSENA BOULEVARD","LINDEN PLACE","MAIN STREET","MAPLE AVENUE","MURRAY STREET","NORTHERN BOULEVARD","PARSONS BOULEVARD","PRINCE STREET","PSUEDO PLACE","ROSE AVENUE","SANFORD AVENUE","UNION STREET","UTOPIA PARKWAY","VLEIGH PLACE","WHITESTONE EXPRESSWAY"],
  "jackson heights": ["34 AVENUE","35 AVENUE","37 AVENUE","74 STREET","75 STREET","76 STREET","77 STREET","78 STREET","79 STREET","80 STREET","81 STREET","82 STREET","83 STREET","84 STREET","85 STREET","86 STREET","JUNCTION BOULEVARD","NATIONAL STREET","NORTHERN BOULEVARD","QUEENS BOULEVARD","ROOSEVELT AVENUE"],
  // NYC - Bronx
  "fordham": ["ARTHUR AVENUE","BELMONT AVENUE","BRIGGS AVENUE","CRESTON AVENUE","DAVIDSON AVENUE","FORDHAM ROAD","GRAND AVENUE","GRAND CONCOURSE","JEROME AVENUE","KINGSBRIDGE ROAD","LORING PLACE","MORRIS AVENUE","RYER AVENUE","SOUTHERN BOULEVARD","VALENTINE AVENUE","WEBB AVENUE"],
  "riverdale": ["ARLINGTON AVENUE","BROADWAY","CAMBRIDGE AVENUE","DELAFIELD AVENUE","FIELDSTON ROAD","HENRY HUDSON PARKWAY","INDEPENDENCE AVENUE","JOHNSON AVENUE","KAPPOCK STREET","LIVINGSTON AVENUE","PALISADE AVENUE","RIVERDALE AVENUE","SEMINARY AVENUE","SYCAMORE AVENUE","OXFORD AVENUE","WEST 232 STREET","WEST 236 STREET","WEST 238 STREET","WEST 239 STREET","WEST 240 STREET","WEST 242 STREET","WEST 246 STREET","WEST 247 STREET","WEST 248 STREET","WEST 252 STREET","WEST 254 STREET","WEST 259 STREET","WEST 261 STREET","WALDO AVENUE"],
  // Chicago
  "wicker park": ["AUGUSTA BOULEVARD","BLOOMINGDALE AVENUE","CORTEZ STREET","DIVISION STREET","ELM STREET","HONORE STREET","LEAVITT STREET","LEMOYNE STREET","LINDEN PLACE","MAPLEWOOD AVENUE","MILWAUKEE AVENUE","NORTH AVENUE","PAULINA STREET","PIERCE AVENUE","SCHILLER STREET","THOMAS STREET","WABANSIA AVENUE","WALTON STREET","WICKER PARK AVENUE","WINCHESTER AVENUE","WOLCOTT AVENUE"],
  "logan square": ["ALBANY AVENUE","ARMITAGE AVENUE","CALIFORNIA AVENUE","CENTRAL PARK AVENUE","DIVERSEY AVENUE","DRAKE AVENUE","FULLERTON AVENUE","HAMLIN AVENUE","HARDING AVENUE","KEDZIE AVENUE","KIMBALL AVENUE","LOGAN BOULEVARD","MEDILL AVENUE","MILWAUKEE AVENUE","PALMER SQUARE","SAWYER AVENUE","SPAULDING AVENUE","ST LOUIS AVENUE","WRIGHTWOOD AVENUE"],
  "lincoln park": ["ARMITAGE AVENUE","BELDEN AVENUE","BISSELL STREET","BREWSTER PLACE","BURLING STREET","CLARK STREET","CLEVELAND AVENUE","DAYTON STREET","DEMING PLACE","DICKENS AVENUE","DIVERSEY PARKWAY","FULLERTON AVENUE","HALSTED STREET","KEMPER PLACE","LAKEWOOD AVENUE","LINCOLN AVENUE","MOHAWK STREET","NORTH AVENUE","ORCHARD STREET","SEMINARY AVENUE","SHEFFIELD AVENUE","WAYNE AVENUE","WISCONSIN STREET","WRIGHTWOOD AVENUE"],
  "andersonville": ["BERWYN AVENUE","BALMORAL AVENUE","BOWMANVILLE AVENUE","BRYN MAWR AVENUE","CATALPA AVENUE","CLARK STREET","EDGEWATER AVENUE","FOSTER AVENUE","GLENWOOD AVENUE","GRANVILLE AVENUE","HIGHLAND AVENUE","JEROME STREET","KENMORE AVENUE","LAKEWOOD AVENUE","LUNT AVENUE","MAGNOLIA AVENUE","MORSE AVENUE","PAULINA STREET","RASCHER AVENUE","RIDGE AVENUE","ROSEMONT AVENUE","WAYNE AVENUE","WINTHROP AVENUE"],
  "lakeview": ["ADDISON STREET","BELMONT AVENUE","BROADWAY","BUCKINGHAM PLACE","CLARK STREET","CORNELIA AVENUE","DIVERSEY PARKWAY","EDDY STREET","FLETCHER STREET","FULLERTON AVENUE","GEORGE STREET","GRACE STREET","HALSTED STREET","HAWTHORNE PLACE","LAKEWOOD AVENUE","LINCOLN AVENUE","NEWPORT AVENUE","OAKDALE AVENUE","PATTERSON AVENUE","RACINE AVENUE","ROSCOE STREET","SEMINARY AVENUE","SHEFFIELD AVENUE","SURF STREET","WELLINGTON AVENUE","WOLFRAM STREET"],
  "pilsen": ["16 STREET","17 STREET","18 STREET","19 STREET","21 STREET","ALLPORT STREET","ASHLAND AVENUE","BISHOP STREET","BLUE ISLAND AVENUE","CARPENTER STREET","CERMAK ROAD","CULLERTON STREET","DAMEN AVENUE","HALSTED STREET","LOOMIS STREET","LUMBER STREET","MORGAN STREET","NEWBERRY AVENUE","PEORIA STREET","RACINE AVENUE","SANGAMON STREET","UNION AVENUE","WESTERN AVENUE","WOLCOTT AVENUE","WOOD STREET"],
  "chinatown chicago": ["ARCHER AVENUE","CERMAK ROAD","PRINCETON AVENUE","SHIELDS AVENUE","SOUTH CANAL STREET","SOUTH CLARK STREET","SOUTH WENTWORTH AVENUE","WELLS STREET","WENTWORTH AVENUE"],
  "chinatown boston": ["BEACH STREET","EDINBORO STREET","ESSEX STREET","HARRISON AVENUE","HUDSON STREET","KNEELAND STREET","LINCOLN STREET","NASSAU STREET","OXFORD STREET","PING ON STREET","STUART STREET","SURFACE ROAD","TYLER STREET","WASHINGTON STREET"],
  "chinatown philadelphia": ["ARCH STREET","CHERRY STREET","FILBERT STREET","MARKET STREET","NORTH 8TH STREET","NORTH 9TH STREET","NORTH 10TH STREET","RACE STREET","VINE STREET"],
  "chinatown dc": ["G STREET NW","H STREET NW","I STREET NW","6TH STREET NW","7TH STREET NW","8TH STREET NW","INDIANA AVENUE NW"],
  // San Francisco
  "the mission": ["16 STREET","17 STREET","18 STREET","19 STREET","20 STREET","21 STREET","22 STREET","23 STREET","24 STREET","25 STREET","26 STREET","BARTLETT STREET","CAPP STREET","CHURCH STREET","DOLORES STREET","GUERRERO STREET","HARRISON STREET","MISSION STREET","SHOTWELL STREET","SOUTH VAN NESS AVENUE","VALENCIA STREET"],
  "tenderloin": ["EDDY STREET","ELLIS STREET","GOLDEN GATE AVENUE","JONES STREET","LARKIN STREET","LEAVENWORTH STREET","MCALLISTER STREET","OFARRELL STREET","POLK STREET","POST STREET","TURK STREET","TURK BOULEVARD","TAYLOR STREET","HYDE STREET"],
  "chinatown san francisco": ["BROADWAY","CLAY STREET","COLUMBUS AVENUE","COMMERCIAL STREET","GRANT AVENUE","JACKSON STREET","KEARNY STREET","PACIFIC AVENUE","SACRAMENTO STREET","STOCKTON STREET","VALLEJO STREET","WAVERLY PLACE"],
  "haight ashbury": ["ASHBURY STREET","BELVEDERE STREET","BUENA VISTA AVENUE EAST","BUENA VISTA AVENUE WEST","CENTRAL AVENUE","CLAYTON STREET","COLE STREET","DELMAR STREET","DIVISADERO STREET","FREDERICK STREET","GRATTAN STREET","HAIGHT STREET","HEIGHT STREET","LYON STREET","MASONIC AVENUE","PAGE STREET","PIERCE STREET","SHRADER STREET","STANYAN STREET","STATES STREET","WALLER STREET"],
  "castro": ["18 STREET","19 STREET","20 STREET","21 STREET","CASTRO STREET","COLLINGWOOD STREET","CORWIN STREET","DANVERS STREET","DIAMOND STREET","DOUGLASS STREET","EUREKA STREET","FAIR OAKS STREET","FLINT STREET","FORD STREET","HANCOCK STREET","HARTFORD STREET","HENRY STREET","JERSEY STREET","LIBERTY STREET","MARKET STREET","NANDINA STREET","NOE STREET","SANCHEZ STREET","STATES STREET","THRIFT STREET","VALLEY STREET"],
  "noe valley": ["24 STREET","25 STREET","26 STREET","27 STREET","28 STREET","29 STREET","30 STREET","CLIPPER STREET","CHURCH STREET","DIAMOND STREET","DOLORES STREET","DOUGLASS STREET","ELIZABETH STREET","EUREKA STREET","FAIR OAKS STREET","HOFFMAN AVENUE","JERSEY STREET","LIBERTY STREET","NOE STREET","SANCHEZ STREET","VALLEY STREET","VICKSBURG STREET","WHITNEY STREET"],
  "soma": ["1 STREET","2 STREET","3 STREET","4 STREET","5 STREET","6 STREET","7 STREET","8 STREET","9 STREET","10 STREET","BRANNAN STREET","BRYANT STREET","CHANNEL STREET","CLEMENTINA STREET","FOLSOM STREET","FREELON STREET","HARRISON STREET","HOWARD STREET","KING STREET","MINNA STREET","MISSION STREET","NATOMA STREET","RAUSCH STREET","RINCON STREET","SHIPLEY STREET","STILLMAN STREET","TEHAMA STREET","TOWNSEND STREET","WELSH STREET"],
  // Los Angeles
  "silver lake": ["AARON STREET","ADELBERT AVENUE","ANGUS STREET","BERKELEY AVENUE","BRIER AVENUE","CLINTON STREET","COVE AVENUE","DUANE STREET","EAST SILVER LAKE DRIVE","EFFIE STREET","ELKWOOD STREET","FARGO STREET","FOUNTAIN AVENUE","GLENDALE BOULEVARD","GRIFFITH PARK BOULEVARD","HAMLIN STREET","HYPERION AVENUE","IVAN HILL TERRACE","KENILWORTH AVENUE","LEMOYNE STREET","LESLER PLACE","MALTMAN AVENUE","MARATHON STREET","MICHELTORENA STREET","MORENO DRIVE","REDCLIFF STREET","ROWENA AVENUE","SANBORN AVENUE","SILVER LAKE BOULEVARD","SUNSET BOULEVARD","TESLA AVENUE","TREMAINE AVENUE","WAVERLY DRIVE"],
  "echo park": ["AARON STREET","ALLESANDRO STREET","BAXTER STREET","BELLEVUE AVENUE","BERKELEY AVENUE","CLINTON STREET","COURT STREET","DELTA STREET","ECHO PARK AVENUE","ELSINORE STREET","FILIPINOTOWN","GLENDALE BOULEVARD","KENT STREET","LAKE SHORE AVENUE","LAVETA TERRACE","LEMOYNE STREET","LOGAN STREET","LUCRETIA AVENUE","MORTON AVENUE","PARK DRIVE","PARKMAN AVENUE","PORTIA STREET","ROSEMONT AVENUE","SCOTT AVENUE","SUNSET BOULEVARD","TEMPLE STREET","VESTAL AVENUE","WATERLOO STREET"],
  "west hollywood": ["ALTA LOMA ROAD","BEST AVENUE","CYNTHIA STREET","DOHENY DRIVE","FOUNTAIN AVENUE","GARDNER STREET","GENESEE AVENUE","HAVENHURST DRIVE","HILLDALE AVENUE","HOLLOWAY DRIVE","LA JOLLA AVENUE","LARRABEE STREET","LAUREL AVENUE","LEICESTER PLACE","NORMA PLACE","NORTH VISTA STREET","PALM AVENUE","ROBERTSON BOULEVARD","SAN VICENTE BOULEVARD","SANTA MONICA BOULEVARD","SHERBOURNE DRIVE","SUNSET BOULEVARD","SWEETZER AVENUE","VISTA DEL MAR","WETHERLY DRIVE"],
  "koreatown": ["8 STREET","9 STREET","10 STREET","11 STREET","12 STREET","ARDMORE AVENUE","BERENDO STREET","CATALINA STREET","COMMONWEALTH AVENUE","GATES STREET","HARVARD BOULEVARD","IROLO STREET","KENMORE AVENUE","KINGSLEY DRIVE","MANHATTAN PLACE","MARIPOSA AVENUE","NORMANDIE AVENUE","OXFORD AVENUE","SERRANO AVENUE","SHATTO PLACE","VERMONT AVENUE","WESTERN AVENUE","WILSHIRE BOULEVARD"],
  "chinatown los angeles": ["BERNARD STREET","BROADWAY","CASTELAR STREET","COLLEGE STREET","HILL STREET","KOHLER STREET","LOS ANGELES STREET","MAIN STREET","NORTH SPRING STREET","ORD STREET","YALE STREET"],
  // NYC Koreatown + Chinatown
  "k-town nyc": ["WEST 32ND STREET","5TH AVENUE","BROADWAY","6TH AVENUE","WEST 31ST STREET","WEST 33RD STREET","WEST 34TH STREET"],
  "koreatown nyc": ["WEST 32ND STREET","5TH AVENUE","BROADWAY","6TH AVENUE","WEST 31ST STREET","WEST 33RD STREET"],
  "chinatown nyc": ["BAYARD STREET","BOWERY","CANAL STREET","CENTRE STREET","CHATHAM SQUARE","DOYERS STREET","DIVISION STREET","EAST BROADWAY","ELDRIDGE STREET","HENRY STREET","HESTER STREET","MADISON STREET","MOTT STREET","MULBERRY STREET","PARK ROW","PELL STREET","WALKER STREET"],
  "chinatown manhattan": ["BAYARD STREET","BOWERY","CANAL STREET","DOYERS STREET","EAST BROADWAY","MOTT STREET","MULBERRY STREET","PELL STREET"],
  "flushing chinatown": ["MAIN STREET","KISSENA BOULEVARD","NORTHERN BOULEVARD","UNION STREET","ROOSEVELT AVENUE","37 AVENUE","38 AVENUE","39 AVENUE"],
  // Boston
  "south end": ["APPLETON STREET","BERKELEY STREET","BLACKWOOD STREET","BRADDOCK PARK","CAMDEN STREET","CHANDLER STREET","CLARENDON STREET","COLUMBUS AVENUE","DARTMOUTH STREET","DEDHAM STREET","DWIGHT STREET","EAST BROOKLINE STREET","EAST CANTON STREET","EAST CONCORD STREET","EAST NEWTON STREET","EAST SPRINGFIELD STREET","EDGERLY ROAD","GRAY STREET","MASSACHUSETTS AVENUE","MILFORD STREET","MONTGOMERY STREET","NORTHAMPTON STREET","PEMBROKE STREET","RUTLAND SQUARE","RUTLAND STREET","SHAWMUT AVENUE","TREMONT STREET","UNION PARK STREET","WALTHAM STREET","WARREN AVENUE","WEST BROOKLINE STREET","WEST CANTON STREET","WEST CONCORD STREET","WEST DEDHAM STREET","WEST NEWTON STREET","WORCESTER SQUARE"],
  "back bay": ["ARLINGTON STREET","BEACON STREET","BERKELEY STREET","BOYLSTON STREET","CLARENDON STREET","COMMONWEALTH AVENUE","DARTMOUTH STREET","EXETER STREET","FAIRFIELD STREET","GLOUCESTER STREET","HEREFORD STREET","HUNTINGTON AVENUE","MASSACHUSETTS AVENUE","MARLBOROUGH STREET","NEWBURY STREET","RING ROAD","STORROW DRIVE"],
  "jamaica plain": ["CENTRE STREET","CHESTNUT AVENUE","CHILD STREET","CIRCUIT STREET","CITY VIEW STREET","CONGRESS STREET","ELEANOR STREET","ESMOND STREET","FOREST HILLS STREET","GREEN STREET","GREENWAY","GREENWICH PARK","HALL STREET","HEATH STREET","HIGH STREET","JAMAICA WAY","LAMARTINE STREET","LAWN STREET","LONDON STREET","LOUISBURG SQUARE","MCBRIDE STREET","MONTEBELLO ROAD","MOSS HILL ROAD","PARLEY VALE","PERKINS STREET","POND STREET","PRINCE STREET","SOUTH HUNTINGTON AVENUE","SOUTH STREET","SUMNER STREET","SUNNYSIDE STREET","WASHINGTON STREET"],
  "jp": ["CENTRE STREET","CHESTNUT AVENUE","CHILD STREET","CIRCUIT STREET","FOREST HILLS STREET","GREEN STREET","HEATH STREET","JAMAICA WAY","LAMARTINE STREET","MCBRIDE STREET","PERKINS STREET","POND STREET","SOUTH HUNTINGTON AVENUE","SOUTH STREET","SUNNYSIDE STREET","WASHINGTON STREET"],
  "beacon hill": ["ACORN STREET","ANDERSON STREET","BOWDOIN STREET","CAMBRIDGE STREET","CEDAR LANE WAY","CHESTNUT STREET","DERNE STREET","HANCOCK STREET","JOY STREET","LOUISBURG SQUARE","MARGARET STREET","MYRTLE STREET","MT VERNON STREET","OLIVE STREET","PHILLIPS STREET","PINCKNEY STREET","REVERE STREET","RIVER STREET","SPRUCE STREET","TEMPLE STREET","WALNUT STREET","WEST CEDAR STREET"],
  // Philadelphia
  "fishtown": ["ALLEN STREET","ARABELLA STREET","BERKS STREET","COLUMBIA AVENUE","CORK STREET","CREASE STREET","EAST BERKS STREET","EAST GIRARD AVENUE","EAST MASTER STREET","EAST MONTGOMERY AVENUE","EAST SUSQUEHANNA AVENUE","HAGERT STREET","HEMP STREET","HOMER STREET","MARLBOROUGH STREET","MASTER STREET","MEMPHIS STREET","MOYER STREET","NORRIS STREET","RICHMOND STREET","SHACKAMAXON STREET","THOMPSON STREET","VIENNA STREET","WILDEY STREET"],
  "northern liberties": ["AMERICAN STREET","BROWN STREET","BUTTONWOOD STREET","CALLOWHILL STREET","CANAL STREET","FAIRMOUNT AVENUE","GEORGE STREET","GIRARD AVENUE","GREEN STREET","HANCOCK STREET","LAUREL STREET","MELON STREET","NEW MARKET STREET","NOBLE STREET","NORTH SECOND STREET","NORTH THIRD STREET","NORTH FOURTH STREET","NORTH FIFTH STREET","NORTH SIXTH STREET","POPLAR STREET","SPRING GARDEN STREET","SUGAR STREET","THOMPSON STREET","WILDEY STREET"],
  "rittenhouse": ["16 STREET","17 STREET","18 STREET","19 STREET","20 STREET","21 STREET","CHANCELLOR STREET","CHESTNUT STREET","DELANCEY PLACE","LOCUST STREET","MANNING STREET","MORAVIAN STREET","NAUDAIN STREET","PINE STREET","RITTENHOUSE SQUARE","SANSOM STREET","SPRUCE STREET","WALNUT STREET"],
  // Washington DC
  "adams morgan": ["18 STREET NW","BELMONT STREET NW","BILTMORE STREET NW","CALVERT STREET NW","COLUMBIA ROAD NW","EUCLID STREET NW","HARVARD STREET NW","KALORAMA ROAD NW","LANIER PLACE NW","ONTARIO ROAD NW","ONTARIO PLACE NW","PARK ROAD NW","PERRY STREET NW","QUINCY PLACE NW","RIGGS PLACE NW","SWANN STREET NW","Vernon STREET NW","WILLARD STREET NW"],
  "dupont circle": ["19 STREET NW","20 STREET NW","21 STREET NW","22 STREET NW","23 STREET NW","CHURCH STREET NW","CORCORAN STREET NW","CONNECTICUT AVENUE NW","FLORIDA AVENUE NW","MASSACHUSETTS AVENUE NW","NEW HAMPSHIRE AVENUE NW","P STREET NW","Q STREET NW","R STREET NW","S STREET NW","SUNDERLAND PLACE NW","SWANN STREET NW","T STREET NW"],
  "capitol hill": ["1 STREET NE","1 STREET SE","2 STREET NE","2 STREET SE","3 STREET NE","3 STREET SE","4 STREET NE","4 STREET SE","A STREET NE","A STREET SE","B STREET NE","B STREET SE","C STREET NE","C STREET SE","D STREET NE","D STREET SE","E STREET NE","E STREET SE","EAST CAPITOL STREET","F STREET NE","CONSTITUTION AVENUE NE","INDEPENDENCE AVENUE SE","MARYLAND AVENUE NE","MASSACHUSETTS AVENUE NE","NORTH CAROLINA AVENUE SE","PENNSYLVANIA AVENUE SE"],
  // Seattle
  "capitol hill": ["10 AVENUE","11 AVENUE","12 AVENUE","13 AVENUE","14 AVENUE","15 AVENUE","BELLEVUE AVENUE","BOYLSTON AVENUE","BROADWAY","DENNY WAY","E DENNY WAY","E JOHN STREET","E MADISON STREET","E OLIVE WAY","E PIKE STREET","E PINE STREET","E ROY STREET","E SPRING STREET","E UNION STREET","EASTLAKE AVENUE","HARVARD AVENUE","LAKEVIEW BOULEVARD","MELROSE AVENUE","REPUBLICAN STREET","SUMMIT AVENUE","TERRY AVENUE","THOMAS STREET","YALE AVENUE"],
  "fremont": ["1 AVENUE N","2 AVENUE N","3 AVENUE N","4 AVENUE N","34 STREET","35 STREET","36 STREET","37 STREET","38 STREET","39 STREET","40 STREET","41 STREET","AURORA AVENUE N","BURKE AVENUE N","DAYTON AVENUE N","DEXTER AVENUE N","EVANSTON AVENUE N","FREMONT AVENUE N","FREMONT PLACE N","GREENWOOD AVENUE N","INTERLAKE AVENUE N","LINDEN AVENUE N","MERIDIAN AVENUE N","N 34 STREET","N 36 STREET","PALATINE AVENUE N","PHINNEY AVENUE N","STONE WAY N","WOODLAND PARK AVENUE N"],
  "ballard": ["14 AVENUE NW","15 AVENUE NW","17 AVENUE NW","20 AVENUE NW","22 AVENUE NW","24 AVENUE NW","28 AVENUE NW","32 AVENUE NW","56 STREET NW","57 STREET NW","58 STREET NW","59 STREET NW","60 STREET NW","65 STREET NW","MARKET STREET","NW 56 STREET","NW 57 STREET","NW 58 STREET","NW 65 STREET","SHILSHOLE AVENUE NW","SLOOP STREET","STONEWAY N"],
  // New Jersey
  "hoboken": ["1 STREET","2 STREET","3 STREET","4 STREET","5 STREET","6 STREET","7 STREET","8 STREET","9 STREET","10 STREET","11 STREET","12 STREET","13 STREET","14 STREET","ADAMS STREET","BLOOMFIELD STREET","CLINTON STREET","GARDEN STREET","GRAND STREET","HUDSON STREET","JEFFERSON STREET","MADISON STREET","MONROE STREET","OBSERVER HIGHWAY","PARK AVENUE","WASHINGTON STREET"],
  "journal square": ["BERGEN AVENUE","BRAMHALL AVENUE","COMMUNIPAW AVENUE","JOURNAL SQUARE","KENNEDY BOULEVARD","NEWKIRK STREET","SIP AVENUE","SUMMIT AVENUE","WESTSIDE AVENUE"],
  "jersey city heights": ["CENTRAL AVENUE","COLUMBIA AVENUE","GARRISON AVENUE","MANHATTAN AVENUE","NEW YORK AVENUE","NORTH STREET","PALISADE AVENUE","SUMMIT AVENUE"],
  "downtown jersey city": ["BAY STREET","CHRISTOPHER COLUMBUS DRIVE","ERIE STREET","EXCHANGE PLACE","GRAND STREET","GROVE STREET","HENDERSON STREET","HUDSON STREET","MARIN BOULEVARD","MONTGOMERY STREET","MORGAN STREET","NEWARK AVENUE","PACIFIC AVENUE","PAVONIA AVENUE","WAYNE STREET"],
  // San Diego
  "north park san diego": ["30TH STREET","ADAMS AVENUE","BOUNDARY STREET","EL CAJON BOULEVARD","MADISON AVENUE","MEADE AVENUE","NORTH PARK WAY","OREGON STREET","POLK AVENUE","RAY STREET","UNIVERSITY AVENUE","UPAS STREET","UTAH STREET"],
  "north park": ["30TH STREET","ADAMS AVENUE","BOUNDARY STREET","EL CAJON BOULEVARD","MADISON AVENUE","MEADE AVENUE","NORTH PARK WAY","OREGON STREET","POLK AVENUE","RAY STREET","UNIVERSITY AVENUE","UPAS STREET","UTAH STREET"],
  "hillcrest": ["4TH AVENUE","5TH AVENUE","6TH AVENUE","BROOKES AVENUE","CLEVELAND AVENUE","HARVEY MILK STREET","LINCOLN AVENUE","ROBINSON AVENUE","UNIVERSITY AVENUE","WASHINGTON STREET","OHIO STREET","MICHIGAN STREET"],
  "ocean beach": ["ABBOTT STREET","BACON STREET","CABLE STREET","CAPE MAY AVENUE","CHATSWORTH BOULEVARD","DOG BEACH","FROUDE STREET","NIAGARA AVENUE","NEWPORT AVENUE","SUNSET CLIFFS BOULEVARD","VOLTAIRE STREET","WEST POINT LOMA BOULEVARD"],
  "pacific beach": ["BAYARD STREET","CASS STREET","CHALCEDONY STREET","DIAMOND STREET","EMERALD STREET","FANUEL STREET","GARNET AVENUE","GRAND AVENUE","INGRAHAM STREET","LAMONT STREET","MISSION BOULEVARD","OLIVER AVENUE","PACIFIC BEACH DRIVE","THOMAS AVENUE","TURQUOISE STREET"],
  "mission beach": ["BAYSIDE WALK","MISSION BOULEVARD","OCEAN FRONT WALK","SANTA CLARA PLACE","VENTURA PLACE","WAVE STREET"],
  "la jolla": ["COAST BOULEVARD","DRAPER AVENUE","FERN GLEN","GIRARD AVENUE","HERSCHEL AVENUE","IVANHOE AVENUE","KLINE STREET","LA JOLLA BOULEVARD","NAUTILUS STREET","PROSPECT STREET","SILVERADO STREET","TORREY PINES ROAD","WALL STREET"],
  "gaslamp quarter": ["4TH AVENUE","5TH AVENUE","6TH AVENUE","BROADWAY","F STREET","G STREET","HARBOR DRIVE","ISLAND AVENUE","J STREET","K STREET","L STREET","MARKET STREET"],
  "little italy san diego": ["ASH STREET","BEECH STREET","CEDAR STREET","DATE STREET","GRAPE STREET","HAWTHORN STREET","INDIA STREET","KETTNER BOULEVARD","LAUREL STREET","UNION STREET","W BROADWAY"],
  "east village san diego": ["10TH AVENUE","11TH AVENUE","12TH AVENUE","13TH STREET","14TH STREET","15TH STREET","16TH STREET","BROADWAY","F STREET","G STREET","IMPERIAL AVENUE","J STREET","K STREET","L STREET","MARKET STREET","NEWTON AVENUE","PARK BOULEVARD"],
  "south park san diego": ["28TH STREET","29TH STREET","30TH STREET","BEECH STREET","CEDAR STREET","ELM STREET","FERN STREET","GRAPE STREET","IVY STREET","JUNIPER STREET","KALMIA STREET","LAUREL STREET"],
};

function lookupNeighborhoodStreets(name) {
  const key = name.toLowerCase().trim()
    .replace(/,?\s*(brooklyn|manhattan|queens|bronx|staten island|chicago|los angeles|la|san francisco|sf|boston|philadelphia|philly|washington dc|dc|seattle|new york|nyc|ny|new jersey|nj|hoboken|jersey city|newark)\s*$/i, "")
    .trim();
  return NEIGHBORHOOD_STREETS[key] || null;
}

// ─── GET STREETS FOR ANY AREA VIA OSM ────────────────────────────────────────
async function getNeighborhoodStreets(name, lat, lng) {
  // 1. Check hardcoded catalog first — instant
  const hardcoded = lookupNeighborhoodStreets(name);
  if (hardcoded && hardcoded.length > 0) {
    console.log(`Catalog hit for "${name}": ${hardcoded.length} streets`);
    return hardcoded;
  }

  if (!lat || !lng) return [];

  // 2. Fire boundary lookup AND radius lookups simultaneously — take best result
  const cleanName = name.replace(/"/g,"").replace(/^the /i,"").replace(/\bSF\b/gi,"San Francisco").trim();

  const boundaryPromise = (async () => {
    try {
      const boundaryQuery = `[out:json][timeout:20];(relation["boundary"="administrative"]["name"~"${cleanName}",i](around:2000,${lat},${lng});relation["place"~"^(neighbourhood|quarter|suburb|district|city_block)$"]["name"~"${cleanName}",i](around:2000,${lat},${lng}););out ids;`;
      const br = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(boundaryQuery)}`, {headers:{'User-Agent':'StreetParkNow/1.0'}});
      if (!br.ok) return [];
      const bd = await br.json();
      const relations = bd.elements || [];
      if (relations.length === 0) return [];
      const relId = relations[0].id;
      const streetsQuery = `[out:json][timeout:25];area(id:${3600000000+relId})->.a;way(area.a)["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street|pedestrian|trunk)$"]["name"];out tags;`;
      const sr = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(streetsQuery)}`, {headers:{'User-Agent':'StreetParkNow/1.0'}});
      if (!sr.ok) return [];
      const sd = await sr.json();
      return [...new Set((sd.elements||[]).map(w=>w.tags?.name?.toUpperCase()).filter(Boolean))].sort();
    } catch(e) { return []; }
  })();

  const radius600Promise = (async () => {
    try {
      const q = `[out:json][timeout:15];way(around:600,${lat},${lng})["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street|pedestrian|trunk)$"]["name"];out tags;`;
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, {headers:{'User-Agent':'StreetParkNow/1.0'}});
      if (!r.ok) return [];
      const d = await r.json();
      return [...new Set((d.elements||[]).map(w=>w.tags?.name?.toUpperCase()).filter(Boolean))].sort();
    } catch(e) { return []; }
  })();

  const radius1200Promise = (async () => {
    try {
      const q = `[out:json][timeout:15];way(around:1200,${lat},${lng})["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street|pedestrian|trunk)$"]["name"];out tags;`;
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, {headers:{'User-Agent':'StreetParkNow/1.0'}});
      if (!r.ok) return [];
      const d = await r.json();
      return [...new Set((d.elements||[]).map(w=>w.tags?.name?.toUpperCase()).filter(Boolean))].sort();
    } catch(e) { return []; }
  })();

  // Race all three — return first one with 3+ streets
  const [boundary, radius600, radius1200] = await Promise.all([boundaryPromise, radius600Promise, radius1200Promise]);

  if (boundary.length >= 3) { console.log(`OSM boundary for "${name}": ${boundary.length} streets`); return boundary; }
  if (radius600.length >= 3) { console.log(`OSM radius 600 for "${name}": ${radius600.length} streets`); return radius600; }
  if (radius1200.length >= 3) { console.log(`OSM radius 1200 for "${name}": ${radius1200.length} streets`); return radius1200; }

  return boundary.length ? boundary : radius600.length ? radius600 : radius1200;
}

// ─── SMART GEOCODE ────────────────────────────────────────────────────────────
app.get("/api/geocode", async (req, res) => {
  const { q, userLat, userLng } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;
  // Strip unit / apt / suite / floor / # before geocoding — handle both
  // "395 Leonard St Unit 333" and the comma-prefixed "395 Leonard St, Unit 333"
  // plus "#333" shorthand. Alternation order matters: "apartment" before
  // "apt", "floor" before "fl" — otherwise the shorter prefix matches first.
  const UNIT_WORD = "(?:apartment|apt|unit|suite|ste|floor|fl|rm|room)";
  const qClean = q.trim()
    .replace(new RegExp(`,\\s*${UNIT_WORD}\\b\\.?\\s*[\\w-]+`, "gi"), "")
    .replace(/,\s*#\s*[\w-]+/g, "")
    .replace(new RegExp(`\\b${UNIT_WORD}\\b\\.?\\s*[\\w-]+`, "gi"), "")
    .replace(/#\s*[\w-]+/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/^[,\s]+/, "")
    .replace(/,\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // ── STEP 0: Catalog check FIRST — instant, no API calls needed ───────────
  const catalogStreets = lookupNeighborhoodStreets(qClean);
  if (catalogStreets && catalogStreets.length > 0) {
    console.log(`Catalog fast-path for "${qClean}": ${catalogStreets.length} streets`);
    // Still need coords — use known coords from catalog or fall through to Google for coords only
    const coordsMap = {
      "the mission": { lat:37.7599, lng:-122.4148, label:"Mission District, San Francisco", borough:"", neighborhood:"Mission District", city:"San Francisco" },
      "the slope": { lat:40.6681, lng:-73.9800, label:"Park Slope, Brooklyn", borough:"Brooklyn", neighborhood:"Park Slope", city:"New York" },
      "jp": { lat:42.3100, lng:-71.1128, label:"Jamaica Plain, Boston", borough:"", neighborhood:"Jamaica Plain", city:"Boston" },
      "tenderloin": { lat:37.7832, lng:-122.4147, label:"Tenderloin, San Francisco", borough:"", neighborhood:"Tenderloin", city:"San Francisco" },
      "chinatown nyc": { lat:40.7158, lng:-73.9970, label:"Chinatown, Manhattan", borough:"Manhattan", neighborhood:"Chinatown", city:"New York" },
      "chinatown manhattan": { lat:40.7158, lng:-73.9970, label:"Chinatown, Manhattan", borough:"Manhattan", neighborhood:"Chinatown", city:"New York" },
      "k-town nyc": { lat:40.7484, lng:-73.9878, label:"Koreatown, Manhattan", borough:"Manhattan", neighborhood:"Koreatown", city:"New York" },
      "koreatown nyc": { lat:40.7484, lng:-73.9878, label:"Koreatown, Manhattan", borough:"Manhattan", neighborhood:"Koreatown", city:"New York" },
      "chinatown san francisco": { lat:37.7941, lng:-122.4078, label:"Chinatown, San Francisco", borough:"", neighborhood:"Chinatown", city:"San Francisco" },
      "chinatown chicago": { lat:41.8527, lng:-87.6324, label:"Chinatown, Chicago", borough:"", neighborhood:"Chinatown", city:"Chicago" },
      "chinatown boston": { lat:42.3497, lng:-71.0622, label:"Chinatown, Boston", borough:"", neighborhood:"Chinatown", city:"Boston" },
      "chinatown philadelphia": { lat:39.9536, lng:-75.1573, label:"Chinatown, Philadelphia", borough:"", neighborhood:"Chinatown", city:"Philadelphia" },
      "chinatown dc": { lat:38.9006, lng:-77.0213, label:"Chinatown, Washington DC", borough:"", neighborhood:"Chinatown", city:"Washington DC" },
      "flushing chinatown": { lat:40.7675, lng:-73.8330, label:"Flushing, Queens", borough:"Queens", neighborhood:"Flushing", city:"New York" },
    };
    const coords = coordsMap[qClean.toLowerCase()] || null;
    if (coords) {
      return res.json({ type:"neighborhood", isNeighborhood:true, isZip:false, isPark:false, isEstablishment:false, zipStreets:catalogStreets, originalQuery:q, ...coords });
    }
  }

  // ── STEP 1: Google Places/Geocoding API — handles EVERYTHING ─────────────
  // Wrigley Field, MetLife, Court Square, West Village, 90210, The MET — all of it
  if (GOOGLE_KEY) {
    try {
      // Build location bias from user's GPS if available — critical for address disambiguation
      const biasParam = userLat && userLng
        ? `&location=${userLat},${userLng}&radius=50000`  // 50km radius around user
        : "";
      const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(qClean)}&key=${GOOGLE_KEY}&region=us${biasParam}`;
      const gr = await fetch(gUrl);
      if (gr.ok) {
        const gd = await gr.json();
        if (gd.status === "OK" && gd.results?.length > 0) {
          // Filter to US or Canada results only
          const usResult = gd.results.find(r => {
            const c = r.address_components?.find(c => c.types.includes("country"))?.short_name;
            return ["US", "CA"].includes(c);
          });
          if (!usResult) {
            console.log(`Google geocode "${q}": no US/CA result, falling through`);
          } else {
          const result = usResult;
          const { lat, lng } = result.geometry.location;
          const comps = result.address_components || [];
          const get = (type) => comps.find(c => c.types.includes(type))?.long_name || "";
          const types = result.types || [];

          const street      = get("route")?.toUpperCase() || "";
          const streetNum   = get("street_number");
          const neighborhood = get("neighborhood") || get("sublocality_level_2") || "";
          const borough     = get("sublocality_level_1") || get("sublocality") || "";
          const city        = get("locality") || get("administrative_area_level_2") || "";
          const state       = get("administrative_area_level_1") || "";
          const zip         = get("postal_code") || "";
          const label       = result.formatted_address?.split(",").slice(0,2).join(",") || q;
          const country     = get("country") || "";

          console.log(`Google geocode "${q}": types=${types.join(",")}, lat=${lat}, lng=${lng}`);

          // ZIP code
          if (types.includes("postal_code") || /^\d{5}$/.test(qClean)) {
            const streets = await getNeighborhoodStreets(q, lat, lng);
            return res.json({ type:"zip", isZip:true, label:`${zip} ${city}`, street, borough, neighborhood, city, state, lat, lng, zipStreets:streets, originalQuery:q });
          }

          // Always get streets from OSM for the coordinates — works for everything
          const streets = await getNeighborhoodStreets(qClean, lat, lng);
          const isArea = streets.length >= 6;

          // Is it a named neighborhood/area?
          const isNeighborhoodType = types.some(t => ["neighborhood","sublocality","sublocality_level_1","sublocality_level_2","political"].includes(t));
          // Is it a point of interest / establishment / landmark?
          const isEstabType = types.some(t => ["establishment","point_of_interest","stadium","park","museum","university","airport","transit_station","train_station"].includes(t));
          // Is it a street address?
          const isAddress = !!streetNum || types.includes("street_address") || types.includes("premise");

          if (isNeighborhoodType || (isArea && !isEstabType)) {
            return res.json({ type:"neighborhood", isNeighborhood:true, isZip:false, isPark:false, isEstablishment:false, label:`${neighborhood || borough || city}`, street, borough, neighborhood, city, state, lat, lng, zipStreets:streets, originalQuery:q });
          }

          // For everything else — establishments, landmarks, addresses, parks
          // Always return nearby streets so user is never stranded
          const nearbyWithPrimary = streets.length > 0
            ? (street && !streets.includes(street) ? [street, ...streets] : streets)
            : [street].filter(Boolean);
          return res.json({ type:"location", isGPS:true, isNeighborhood:false, isZip:false, isPark:false, isEstablishment:false, label, street, borough, neighborhood, city, state, lat, lng, nearbyStreets:nearbyWithPrimary, originalQuery:q });
          } // end usResult
        }
      }
    } catch(e) { console.error("Google geocode error:", e.message); }
  }

  // ── STEP 2: Claude fallback — only for ambiguous/slang that Google can't resolve ─
  let raw = "";
  try {
    raw = await askClaude(`You are a US urban geography and parking expert. A driver typed: "${q}"

Supported cities: NYC, LA, Chicago, SF, Boston, Philadelphia, DC, Seattle, Miami, Atlanta, Toronto, Denver, Portland, Nashville, Austin, Minneapolis, Dallas, Sacramento, New Jersey, San Diego.

LOCAL SLANG:
NYC: "BK"=Brooklyn | "LIC"=Long Island City | "UWS"=Upper West Side | "UES"=Upper East Side | "the village"=Greenwich Village | "alphabet city"=East Village NY | "the slope"=Park Slope Brooklyn | "bed stuy"=Bedford-Stuyvesant Brooklyn | "bedstuy"=Bedford-Stuyvesant Brooklyn | "bedford stuyvesant"=Bedford-Stuyvesant Brooklyn | "washington heights"=Washington Heights Manhattan | "sunset park"=Sunset Park Brooklyn | "the heights"=Washington Heights Manhattan | "Ditmas"=Ditmas Park Brooklyn | "PLG"=Prospect Lefferts Gardens Brooklyn | "crown heights"=Crown Heights Brooklyn | "inwood"=Inwood Manhattan | "bay ridge"=Bay Ridge Brooklyn | "forest hills"=Forest Hills Queens | "ridgewood"=Ridgewood Queens | "woodside"=Woodside Queens | "corona"=Corona Queens | "elmhurst"=Elmhurst Queens | "riverdale"=Riverdale Bronx | "k-town nyc"=Koreatown Manhattan 32nd Street | "koreatown nyc"=Koreatown Manhattan 32nd Street | "chinatown nyc"=Chinatown Manhattan | "chinatown brooklyn"=Sunset Park Brooklyn | "flushing chinatown"=Flushing Queens
LA: "WeHo"=West Hollywood CA | "SaMo"=Santa Monica CA | "DTLA"=Downtown Los Angeles | "K-town"=Koreatown Los Angeles | "koreatown"=Koreatown Los Angeles | "Sil Lake"=Silver Lake Los Angeles | "echo"=Echo Park Los Angeles | "Bev Hills"=Beverly Hills CA | "the valley"=Van Nuys CA | "Boyle Heights"=Boyle Heights Los Angeles | "Highland Park"=Highland Park Los Angeles | "Eagle Rock"=Eagle Rock Los Angeles | "Atwater Village"=Atwater Village Los Angeles | "Leimert Park"=Leimert Park Los Angeles | "Crenshaw"=Crenshaw Los Angeles
Chicago: "the loop"=Loop Chicago | "Wicker"=Wicker Park Chicago | "Boystown"=Lakeview East Chicago | "Logan"=Logan Square Chicago | "Bucktown"=Bucktown Chicago | "River North"=River North Chicago | "West Loop"=West Loop Chicago | "South Loop"=South Loop Chicago | "Bronzeville"=Bronzeville Chicago | "Andersonville"=Andersonville Chicago | "RoNo"=Rogers Park Chicago | "Uptown"=Uptown Chicago | "Pilsen"=Pilsen Chicago | "Humboldt"=Humboldt Park Chicago
SF: "the mish"=Mission District San Francisco | "the TL"=Tenderloin San Francisco | "SOMA"=South of Market San Francisco | "Noe"=Noe Valley San Francisco | "the haight"=Haight-Ashbury San Francisco | "the castro"=Castro San Francisco | "the richmond"=Richmond District San Francisco | "the sunset"=Outer Sunset San Francisco | "dogpatch"=Dogpatch San Francisco | "potrero"=Potrero Hill San Francisco | "bernal"=Bernal Heights San Francisco | "oracle park"=China Basin San Francisco | "chase center"=Mission Bay San Francisco | "outer richmond"=Outer Richmond San Francisco | "russian hill"=Russian Hill San Francisco | "pacific heights"=Pacific Heights San Francisco | "north beach"=North Beach San Francisco
Boston: "JP"=Jamaica Plain Boston | "Dot"=Dorchester Boston | "Southie"=South Boston MA | "Eastie"=East Boston MA | "the north end"=North End Boston | "the back bay"=Back Bay Boston | "beacon hill"=Beacon Hill Boston | "the south end"=South End Boston | "Rozzie"=Roslindale Boston | "West Rox"=West Roxbury Boston | "Charlestown"=Charlestown Boston | "fenway park"=Kenmore Square Boston | "mission hill"=Mission Hill Boston | "roxbury"=Roxbury Boston
Philadelphia: "Fishtown"=Fishtown Philadelphia | "NoLibs"=Northern Liberties Philadelphia | "Fairmount"=Fairmount Philadelphia | "south philly"=South Philadelphia | "Rittenhouse"=Rittenhouse Square Philadelphia | "citizens bank park"=South Philadelphia PA | "passyunk"=East Passyunk Philadelphia | "bella vista"=Bella Vista Philadelphia | "point breeze"=Point Breeze Philadelphia | "graduate hospital"=Graduate Hospital Philadelphia
DC: "Adams Morgan"=Adams Morgan Washington DC | "U Street"=U Street NW Washington DC | "the Hill"=Capitol Hill Washington DC | "Navy Yard"=Navy Yard Washington DC | "Georgetown"=Georgetown Washington DC | "Dupont"=Dupont Circle Washington DC | "Columbia Heights"=Columbia Heights Washington DC | "Petworth"=Petworth Washington DC | "Shaw"=Shaw Washington DC | "NoMa"=NoMa Washington DC | "nationals park"=Navy Yard Washington DC | "Brookland"=Brookland Washington DC | "Anacostia"=Anacostia Washington DC
Seattle: "Cap Hill"=Capitol Hill Seattle | "Fremont"=Fremont Seattle | "Ballard"=Ballard Seattle | "SLU"=South Lake Union Seattle | "the CD"=Central District Seattle | "SODO"=SoDo Seattle | "Belltown"=Belltown Seattle | "Queen Anne"=Queen Anne Seattle | "Greenlake"=Green Lake Seattle | "Wallingford"=Wallingford Seattle | "U District"=University District Seattle | "t-mobile park"=SoDo Seattle | "lumen field"=SoDo Seattle | "Magnolia"=Magnolia Seattle
Miami: "Wynwood"=Wynwood Miami FL | "wynwood"=Wynwood Miami FL | "south beach"=South Beach Miami Beach FL | "little havana"=Little Havana Miami FL | "Coconut Grove"=Coconut Grove Miami FL | "Design District"=Design District Miami FL | "Edgewater"=Edgewater Miami FL | "Little Haiti"=Little Haiti Miami FL | "hard rock stadium"=Miami Gardens FL | "kaseya center"=Brickell Miami FL
Atlanta: "Little Five Points"=Little Five Points Atlanta GA | "little five points"=Little Five Points Atlanta GA | "Buckhead"=Buckhead Atlanta GA | "Old Fourth Ward"=Old Fourth Ward Atlanta GA | "old fourth ward"=Old Fourth Ward Atlanta GA | "Inman Park"=Inman Park Atlanta GA | "Cabbagetown"=Cabbagetown Atlanta GA | "Grant Park"=Grant Park Atlanta GA | "mercedes-benz stadium"=Vine City Atlanta GA | "state farm arena"=Downtown Atlanta GA | "truist park"=Cumberland GA
NJ: "Hobo"=Hoboken NJ | "hoboken"=Hoboken NJ | "JC"=Jersey City NJ | "JC heights"=Jersey City Heights NJ | "jersey city heights"=Jersey City Heights NJ | "journal square"=Journal Square Jersey City NJ | "downtown jersey city"=Downtown Jersey City NJ | "grove street"=Grove Street Jersey City NJ | "metlife stadium"=East Rutherford NJ | "prudential center"=Newark NJ | "newark"=Newark NJ | "montclair"=Montclair NJ | "the heights"=Jersey City Heights NJ
Dallas: "Deep Ellum"=Deep Ellum Dallas TX | "deep ellum"=Deep Ellum Dallas TX | "Bishop Arts"=Bishop Arts District Dallas TX | "bishop arts"=Bishop Arts District Dallas TX | "uptown dallas"=Uptown Dallas TX | "Knox Henderson"=Knox Henderson Dallas TX | "Lower Greenville"=Lower Greenville Dallas TX | "Oak Cliff"=Oak Cliff Dallas TX | "at&t stadium"=Arlington TX | "american airlines center"=Victory Park Dallas TX
Nashville: "East Nashville"=East Nashville TN | "east nashville"=East Nashville TN | "12 south"=12South Nashville TN | "The Gulch"=The Gulch Nashville TN | "the gulch"=The Gulch Nashville TN | "Germantown"=Germantown Nashville TN | "bridgestone arena"=Downtown Nashville TN | "nissan stadium"=East Bank Nashville TN
Austin: "East Austin"=East Austin TX | "east austin"=East Austin TX | "South Congress"=South Congress Austin TX | "south congress"=South Congress Austin TX | "Rainey Street"=Rainey Street Austin TX | "rainey street"=Rainey Street Austin TX | "moody center"=University of Texas Austin TX | "North Loop"=North Loop Austin TX | "Travis Heights"=Travis Heights Austin TX | "Clarksville"=Clarksville Austin TX
Sacramento: "midtown sacramento"=Midtown Sacramento CA | "east sacramento"=East Sacramento CA | "Land Park"=Land Park Sacramento CA | "Oak Park"=Oak Park Sacramento CA | "golden 1 center"=Downtown Sacramento CA | "sutter health park"=West Sacramento CA
Minneapolis: "uptown minneapolis"=Uptown Minneapolis MN | "northeast minneapolis"=Northeast Minneapolis MN | "North Loop"=North Loop Minneapolis MN | "Dinkytown"=Dinkytown Minneapolis MN | "Seward"=Seward Minneapolis MN | "us bank stadium"=Downtown Minneapolis MN | "target field"=Downtown Minneapolis MN
Portland: "pearl district"=Pearl District Portland OR | "alberta arts district"=Alberta Arts District Portland OR | "alberta arts"=Alberta Arts District Portland OR | "Hawthorne"=Hawthorne Portland OR | "Division"=Division Street Portland OR | "Mississippi Ave"=Mississippi Avenue Portland OR | "moda center"=Rose Quarter Portland OR | "providence park"=Goose Hollow Portland OR | "St Johns"=Saint Johns Portland OR
San Diego: "North Park"=North Park San Diego CA | "north park"=North Park San Diego CA | "Hillcrest"=Hillcrest San Diego CA | "hillcrest"=Hillcrest San Diego CA | "Ocean Beach"=Ocean Beach San Diego CA | "ocean beach"=Ocean Beach San Diego CA | "OB"=Ocean Beach San Diego CA | "Mission Beach"=Mission Beach San Diego CA | "mission beach"=Mission Beach San Diego CA | "Pacific Beach"=Pacific Beach San Diego CA | "pacific beach"=Pacific Beach San Diego CA | "PB"=Pacific Beach San Diego CA | "La Jolla"=La Jolla San Diego CA | "la jolla"=La Jolla San Diego CA | "East Village"=East Village San Diego CA | "Gaslamp"=Gaslamp Quarter San Diego CA | "gaslamp"=Gaslamp Quarter San Diego CA | "Little Italy"=Little Italy San Diego CA | "little italy sd"=Little Italy San Diego CA | "South Park"=South Park San Diego CA | "Normal Heights"=Normal Heights San Diego CA | "Kensington"=Kensington San Diego CA | "City Heights"=City Heights San Diego CA | "Barrio Logan"=Barrio Logan San Diego CA | "Golden Hill"=Golden Hill San Diego CA | "Bankers Hill"=Bankers Hill San Diego CA | "petco park"=East Village San Diego CA | "snapdragon stadium"=Mission Valley San Diego CA | "pechanga arena"=Midway San Diego CA
Toronto: "Kensington"=Kensington Market Toronto ON | "Queen West"=Queen Street West Toronto ON | "Distillery"=Distillery District Toronto ON | "Annex"=The Annex Toronto ON | "Yorkville"=Yorkville Toronto ON | "Leslieville"=Leslieville Toronto ON | "Roncesvalles"=Roncesvalles Toronto ON | "Parkdale"=Parkdale Toronto ON | "scotiabank arena"=Entertainment District Toronto ON | "rogers centre"=Entertainment District Toronto ON
Denver: "RiNo"=River North Denver CO | "rino"=River North Denver CO | "LoDo"=LoDo Denver CO | "lodo"=LoDo Denver CO | "Highland"=Highland Denver CO | "highland denver"=Highland Denver CO | "Wash Park"=Washington Park Denver CO | "Cherry Creek"=Cherry Creek Denver CO | "Five Points"=Five Points Denver CO | "Baker"=Baker Denver CO | "coors field"=LoDo Denver CO | "ball arena"=Downtown Denver CO | "empower field"=Sun Valley Denver CO

Return JSON: { "type": "neighborhood"|"location"|"ambiguous"|"zip", "lat": number, "lng": number, "label": string, "borough": string, "neighborhood": string, "city": string, "street": string, "isNeighborhood": bool, "options": [] }
Return ONLY the JSON.`, 1500);

    const loc = JSON.parse(raw.replace(/```json|```/g,"").trim());
    if (loc.type === "ambiguous") {
      // Before returning ambiguous, check if we have catalog streets for this query
      const catalogStreets = lookupNeighborhoodStreets(q);
      if (catalogStreets && catalogStreets.length > 0 && loc.lat && loc.lng) {
        return res.json({ ...loc, type:"neighborhood", isNeighborhood:true, isZip:false, isPark:false, isEstablishment:false, zipStreets:catalogStreets, originalQuery:q });
      }
      return res.json({ ...loc, originalQuery: q });
    }
    if (loc.lat && loc.lng) {
      const streets = await getNeighborhoodStreets(q, loc.lat, loc.lng);
      const isArea = streets.length >= 6;
      return res.json({ ...loc, isNeighborhood: isArea || loc.isNeighborhood, isZip:false, isPark:false, isEstablishment:false, zipStreets: isArea ? streets : undefined, nearbyStreets: !isArea ? streets : undefined, originalQuery: q });
    }
  } catch(e) { console.error("Claude geocode error:", e.message); }

  return res.status(404).json({ error: `Couldn't find "${q}". Try a street name, neighborhood, or landmark in one of our supported cities.` });
});

// Reverse geocode — uses Google for accuracy, returns nearby streets sorted by distance
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  let primaryStreet = "", borough = "", neighborhood = "", label = "", city = "";

  try {
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}&region=us&language=en`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data.status === "OK" && data.results?.length > 0) {
        // Find first result that's in US or Canada
        const usResult = data.results.find(result => {
          const comps = result.address_components || [];
          const country = comps.find(c => c.types.includes("country"))?.short_name || "";
          return ["US", "CA"].includes(country);
        }) || data.results[0];

        const comps = usResult.address_components || [];
        const get = (type) => comps.find(c => c.types.includes(type))?.long_name || "";
        primaryStreet = get("route").toUpperCase();
        borough       = get("sublocality_level_1") || get("sublocality") || "";
        neighborhood  = get("neighborhood") || get("sublocality_level_2") || "";
        city          = get("locality") || "";
        label         = usResult.formatted_address?.split(",").slice(0,2).join(",") || "";
        console.log(`Reverse geocode: ${label} (country: ${comps.find(c=>c.types.includes("country"))?.short_name})`);
      }
    }
  } catch (e) { console.error("Google reverse geocode error:", e.message); }

  if (!primaryStreet) return res.status(502).json({ error: "Could not identify your street" });

  // Get nearby streets sorted by distance using Nominatim search in bounding box
  let nearbyStreets = [];
  try {
    const raw = await askClaude(`You are an urban geography expert. Given coordinates lat=${lat}, lng=${lng} (${neighborhood}, ${borough}), list the 12 nearest streets sorted from closest to farthest. The primary street is "${primaryStreet}".

Return ONLY a JSON array of street names in ALL CAPS. Include cross streets and parallel streets within a 6-block radius.
Return ONLY the JSON array.`, 1000);
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        nearbyStreets = parsed;
      }
    }
  } catch (e) { console.error("Nearby streets error:", e.message); }

  // Fallback if Claude fails
  if (nearbyStreets.length === 0) nearbyStreets = [primaryStreet];
  // Always ensure primary street is included
  if (primaryStreet && !nearbyStreets.includes(primaryStreet)) {
    nearbyStreets = [primaryStreet, ...nearbyStreets];
  }

  return res.json({
    street: primaryStreet,
    borough, neighborhood, city, label,
    lat: parseFloat(lat), lng: parseFloat(lng),
    isGPS: true,
    nearbyStreets,
  });
});

// Helper: get next N upcoming dates for given day abbreviations
function getUpcomingDates(days, weeksAhead = 2) {
  const dayIndex = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  const today = new Date();
  today.setHours(0,0,0,0);
  const dates = [];
  for (let i = 0; i <= weeksAhead * 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const abbr = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
    if (days.includes(abbr)) {
      dates.push(d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" }));
    }
  }
  return dates.slice(0, 6); // next 6 occurrences
}
app.get("/api/cleaning", async (req, res) => {
  const { street, lat, lng, borough } = req.query;
  if (!street) return res.json([]);

  try {
    const locationCtx = lat && lng ? `at approximately lat=${lat}, lng=${lng}` : `in ${borough || "the city"}`;
    const text = await askClaude(`You are a US alternate side parking and street cleaning expert. Return ONLY a raw JSON array, no other text.

Street: "${street}" ${locationCtx}

Determine which city this street is in based on coordinates or context, then return accurate street cleaning schedules.

CITY PATTERNS:
- NYC (Manhattan): Mon+Thu OR Tue+Fri, typically 8-9:30AM or 8:30-10AM or 11:30AM-1PM
- NYC (Brooklyn/Queens/Bronx): Mon+Thu OR Tue+Fri, similar times, some areas Sat
- Los Angeles: typically once/week per side, Mon-Sat between 8AM-6PM varies by zone
- Chicago: typically once/week per side, 7AM-9AM or 9AM-12PM varies by neighborhood
- San Francisco: typically once/week per side, 8AM-9AM or 10AM-12PM varies by block
- Boston: typically once/week, 8AM-11AM varies by neighborhood
- Philadelphia: typically once/week per side, 8AM-9:30AM varies by zone
- Washington DC: typically once/week per side, 7:30AM-9:30AM or 9:30AM-11AM
- Seattle: typically once/week per side, 8AM-10AM varies by zone

Rules:
- Return a JSON array of cleaning schedules
- If unknown, return exactly: []
- Do NOT write any explanation, preamble, or prose
- Start your response with [ and end with ]

Each item: {"days":["Mon","Thu"],"time":"8 AM - 9:30 AM","side":"Left / Even side","raw":"NO PARKING 8AM-9:30AM MON & THUR"}

Respond with ONLY the JSON array starting with [:`);

    // Extract JSON array even if Claude added any surrounding text
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const schedule = JSON.parse(match[0]);
      if (Array.isArray(schedule) && schedule.length > 0) {
        return res.json(schedule.map(s => ({ ...s, upcomingDates: getUpcomingDates(s.days || []) })));
      }
    }
  } catch (e) { console.error("Claude cleaning error:", e.message); }

  // DOT Socrata fallback
  try {
    const name = street.toUpperCase().trim();
    const r = await fetch(`${SOCRATA}/xswq-wnv9.json?$where=upper(street)%20LIKE%20'%25${encodeURIComponent(name)}%25'&$limit=200`);
    if (r.ok) {
      const raw = await r.json();
      const results = raw.map(row => {
        const parsed = parseSignText(row.signdesc || row.description || "");
        if (!parsed || !parsed.days.length) return null;
        return { street: row.street || name, side: row.side_of_street || "", days: parsed.days, time: parsed.time, raw: parsed.raw, upcomingDates: getUpcomingDates(parsed.days) };
      }).filter(Boolean);
      return res.json(dedupe(results));
    }
  } catch (e) { console.error("DOT fallback error:", e.message); }

  res.json([]);
});

// ─── BATCH CLEANING (for neighborhoods/zips — one Claude call for many streets) ─
app.get("/api/cleaning-batch", async (req, res) => {
  const { streets: streetsParam, lat, lng, borough } = req.query;
  if (!streetsParam) return res.json({});

  const streets = streetsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 30);
  const locationCtx = lat && lng ? `near lat ${lat}, lng ${lng}` : `in ${borough || "the city"}`;

  // Chicago branch: use real city data. Find the ward-section for the
  // center point, and apply its scheduled dates to each street in the batch.
  // (Single-zone approximation — streets crossing a ward-section boundary
  // will get the center's zone schedule. Close enough for the common case
  // where a search surfaces streets in the same neighborhood.)
  if (lat && lng && isChicago(+lat, +lng)) {
    try {
      const zones = await loadChicagoZones();
      const zone = findChicagoZone(+lat, +lng, zones);
      if (zone && zone.dates.length) {
        const today = new Date(); today.setHours(0,0,0,0);
        const upcoming = zone.dates.filter(d => d >= today);
        if (upcoming.length) {
          const DAY_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
          const upcomingLabels = upcoming.slice(0, 6).map(d =>
            d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" })
          );
          const entry = [{
            days: [DAY_ABBR[upcoming[0].getDay()]],
            time: "9 AM - 2 PM",
            side: "",
            raw: `Chicago Ward ${zone.ward} Sec ${zone.section} street sweeping — check posted signs for exact hours`,
            upcomingDates: upcomingLabels,
          }];
          const result = {};
          for (const s of streets) result[s] = entry;
          return res.json(result);
        }
      }
    } catch (e) { console.error("Chicago cleaning-batch error:", e.message); }
  }

  try {
    const todayISO = new Date().toISOString().slice(0,10);
    const text = await askClaude(`You are a US urban parking expert. Today is ${todayISO}. Return weekly posted parking schedules currently in effect for these streets ${locationCtx}.

Streets:
${streets.map((s, i) => `${i+1}. ${s}`).join("\n")}

INCLUDE these regimes:
- NYC / Boston / DC / Philly / Baltimore alternate-side parking (Mon/Thu or Tue/Fri typical)
- LA / SF / Seattle / Portland / Oakland weekly posted sweeping
- Chicago residential street cleaning (posted signs, Apr 1 - Nov 30 ONLY — if today's month is Dec-Mar, return [] for Chicago residential)
- Chicago winter overnight snow routes on arterials (3 AM - 7 AM, Dec 1 - Apr 1 ONLY — use days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"])
- Toronto weekly cleaning (Apr - Nov only)

DO NOT include metered zones, permit-only zones without weekly time windows, or rules out of season. Return [] for highways/private roads or when no rule applies.

Return ONLY a JSON object. Each key = exact street name from the list above, value = array of schedule objects.

Example:
{"BEDFORD AVENUE":[{"days":["Mon","Thu"],"time":"8 AM - 9:30 AM","side":"East","raw":"NO PARKING 8AM-9:30AM MON & THUR"}],"SOUTH MICHIGAN AVENUE":[{"days":["Tue"],"time":"9 AM - 12 PM","side":"","raw":"STREET CLEANING TUE 9AM-12PM"}]}

Return ONLY the JSON object starting with {:`, 3000);

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      // Add upcoming dates to each result
      const result = {};
      for (const [street, schedules] of Object.entries(data)) {
        result[street] = (schedules || []).map(s => ({ ...s, upcomingDates: getUpcomingDates(s.days || []) }));
      }

      // For any streets Claude returned empty, try Socrata DOT data
      const emptyStreets = streets.filter(s => !result[s] || result[s].length === 0);
      if (emptyStreets.length > 0) {
        await Promise.all(emptyStreets.map(async street => {
          try {
            const name = street.toUpperCase().trim();
            const r = await fetch(`${SOCRATA}/xswq-wnv9.json?$where=upper(street)%20LIKE%20'%25${encodeURIComponent(name)}%25'&$limit=50`);
            if (!r.ok) return;
            const raw = await r.json();
            const parsed = raw.map(row => {
              const p = parseSignText(row.signdesc || row.description || "");
              if (!p || !p.days.length) return null;
              return { days: p.days, time: p.time, side: row.side_of_street || "", raw: p.raw, upcomingDates: getUpcomingDates(p.days) };
            }).filter(Boolean);
            if (parsed.length > 0) result[street] = parsed;
          } catch(e) {}
        }));
      }

      return res.json(result);
    }
  } catch(e) { console.error("Batch cleaning error:", e.message); }

  // Full Socrata fallback if Claude fails entirely
  try {
    const result = {};
    await Promise.all(streets.map(async street => {
      try {
        const name = street.toUpperCase().trim();
        const r = await fetch(`${SOCRATA}/xswq-wnv9.json?$where=upper(street)%20LIKE%20'%25${encodeURIComponent(name)}%25'&$limit=50`);
        if (!r.ok) return;
        const raw = await r.json();
        const parsed = raw.map(row => {
          const p = parseSignText(row.signdesc || row.description || "");
          if (!p || !p.days.length) return null;
          return { days: p.days, time: p.time, side: row.side_of_street || "", raw: p.raw, upcomingDates: getUpcomingDates(p.days) };
        }).filter(Boolean);
        result[street] = parsed;
      } catch(e) {}
    }));
    return res.json(result);
  } catch(e) { console.error("Batch Socrata fallback error:", e.message); }

  res.json({});
});
// ─── HEATMAP CACHE ───────────────────────────────────────────────────────────
const heatmapCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in memory

async function fetchOverpass(query) {
  // Try GET first (original working method), then POST fallbacks
  const attempts = [
    { url: `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, method: "GET" },
    { url: "https://overpass.kumi.systems/api/interpreter", method: "POST", body: `data=${encodeURIComponent(query)}` },
    { url: "https://overpass-api.de/api/interpreter", method: "POST", body: `data=${encodeURIComponent(query)}` },
  ];
  for (const { url, method, body } of attempts) {
    try {
      const r = await fetch(url, {
        method,
        headers: {
          "User-Agent": "StreetParkNow/1.0 (streetparknow.vercel.app; contact: support@streetparknow.app)",
          "Accept": "application/json",
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok) { console.log(`Overpass success via ${method} ${url.split("?")[0]}`); return await r.json(); }
      console.error(`Overpass ${url.split("?")[0]}: ${r.status}`);
    } catch(e) { console.error(`Overpass error:`, e.message); }
  }
  return null;
}

// ─── OTHER PARKING RESTRICTIONS (NYC — Parking Regulation Signs) ─────────────
// Real per-sign data from NYC DOT's official Parking Regulation Locations and
// Signs dataset (nfid-uabd). Excludes street cleaning signs (those are shown
// in the dedicated cleaning section) and categorizes the remainder into the
// buckets the results-page card renders: no_parking_always, no_parking_hours,
// time_limit, loading_zone, bus_stop, tow_away, permit_only, fire_zone.
function categorizeSign(desc) {
  const u = (desc || "").toUpperCase();
  if (!u) return null;
  // Filter out street cleaning — those belong to the /api/cleaning category.
  if (u.includes("STREET CLEANING") || u.includes("BROOM")) return null;
  if (u.includes("NO PARKING ANYTIME") || u.includes("NO STANDING ANYTIME")) return "no_parking_always";
  if (u.includes("FIRE ")) return "fire_zone";
  if (u.includes("BUS STOP")) return "bus_stop";
  if (u.includes("TOW AWAY") || u.includes("TOW-AWAY")) return "tow_away";
  if (u.includes("LOADING") || u.includes("TRUCK")) return "loading_zone";
  if (u.includes("AUTHORIZED") || u.includes("PERMIT")) return "permit_only";
  // "2 HMP", "1 HR PARKING", "HOUR METERED", "HOUR PARKING"
  if (/\b\d+\s*(HMP|HR|HOUR)\b/.test(u)) return "time_limit";
  if (u.includes("NO PARKING") && (u.includes("AM") || u.includes("PM"))) return "no_parking_hours";
  if (u.includes("NO STANDING") && (u.includes("AM") || u.includes("PM"))) return "no_parking_hours";
  return null;
}

function cleanSignText(desc) {
  // Strip noisy suffixes NYC DOT uses like "--> (SUPERSEDES SP-854CA)" and arrows.
  return String(desc || "")
    .replace(/\s*\(SUPERSEDES[^)]*\)\s*/gi, "")
    .replace(/<->|-->|<--/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Extract the weekday set encoded in a sign description. NYC sign text uses
// compact forms like "8AM-7PM MON THRU FRI", "MON & THU", "EXCEPT SUN", etc.
// Returns an array of 3-letter day abbreviations, or null if no days detected.
const DAY_TOKENS = { MON:"Mon", TUE:"Tue", TUES:"Tue", WED:"Wed", THU:"Thu", THUR:"Thu", THURS:"Thu", FRI:"Fri", SAT:"Sat", SUN:"Sun" };
const DAYS_WEEK = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function extractSignDays(desc) {
  const u = (desc || "").toUpperCase();
  if (!u) return null;
  // "MON THRU FRI" / "MON-FRI" ranges
  const rangeMatch = u.match(/\b(MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)\s*(?:THRU|THROUGH|TO|-|&|AND)\s*(MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)\b/);
  const days = new Set();
  if (rangeMatch) {
    const startIdx = DAYS_WEEK.indexOf(DAY_TOKENS[rangeMatch[1]]);
    const endIdx = DAYS_WEEK.indexOf(DAY_TOKENS[rangeMatch[2]]);
    if (startIdx >= 0 && endIdx >= 0) {
      // Wrap-around range (e.g., SAT-MON goes Sat, Sun, Mon)
      let i = startIdx;
      while (true) {
        days.add(DAYS_WEEK[i]);
        if (i === endIdx) break;
        i = (i + 1) % 7;
        if (i === startIdx) break;
      }
    }
  }
  // Individual day tokens (catch MON & THU patterns, or THU alongside a range)
  for (const [token, abbr] of Object.entries(DAY_TOKENS)) {
    if (new RegExp(`\\b${token}\\b`).test(u)) days.add(abbr);
  }
  // "EXCEPT SUN" — invert
  const exceptMatch = u.match(/\bEXCEPT\s+(MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)\b/);
  if (exceptMatch && !days.size) {
    const excluded = DAY_TOKENS[exceptMatch[1]];
    for (const d of DAYS_WEEK) if (d !== excluded) days.add(d);
  }
  return days.size ? [...days] : null;
}

// EPSG:2263 (NY State Plane Long Island, NAD83, US survey ft) → WGS84.
// nfid-uabd stores sign positions as sign_x_coord / sign_y_coord in this
// projection; converting gives us tappable dot markers for the map.
// Verified against three known NYC points (Empire State, Hendrix St,
// 3 Ave & E 85 St) at ~0.001° accuracy.
function nyspToLatLng(xFt, yFt) {
  if (xFt == null || yFt == null) return null;
  const x = +xFt, y = +yFt;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return null;
  const a = 6378137.0, f = 1/298.257222101, e2 = 2*f - f*f, e = Math.sqrt(e2);
  const p1 = (40 + 40/60) * Math.PI/180;
  const p2 = (41 + 2/60)  * Math.PI/180;
  const p0 = (40 + 10/60) * Math.PI/180;
  const lam0 = -74 * Math.PI/180;
  const FE_m = 300000, FN_m = 0;  // EPSG:2263 false easting is 300 km (= 984,251.97 US ft)
  const usFoot = 1200/3937;
  const xM = x * usFoot, yM = y * usFoot;
  const m = p => Math.cos(p) / Math.sqrt(1 - e2*Math.sin(p)**2);
  const t = p => Math.tan(Math.PI/4 - p/2) / Math.pow((1 - e*Math.sin(p))/(1 + e*Math.sin(p)), e/2);
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * Math.pow(t(p1), n));
  const r0 = a * F * Math.pow(t(p0), n);
  const dx = xM - FE_m;
  const dy = r0 - (yM - FN_m);
  const rho = Math.sign(n) * Math.sqrt(dx*dx + dy*dy);
  const theta = Math.atan2(dx, dy);
  const tp = Math.pow(rho / (a * F), 1/n);
  let phi = Math.PI/2 - 2*Math.atan(tp);
  for (let i = 0; i < 10; i++) {
    const sp = Math.sin(phi);
    const np = Math.PI/2 - 2*Math.atan(tp * Math.pow((1 - e*sp)/(1 + e*sp), e/2));
    if (Math.abs(np - phi) < 1e-11) break;
    phi = np;
  }
  const lat = phi * 180/Math.PI;
  const lng = (theta/n + lam0) * 180/Math.PI;
  // Sanity-clamp to NYC bbox; anything outside is a bad input we don't want on the map.
  if (lat < 40.4 || lat > 40.95 || lng < -74.3 || lng > -73.65) return null;
  return { lat, lng };
}

// Fetch per-point restrictions (always-active signs with real coords) near a
// lat/lng for dot-marker rendering. Only returns signs that sit within a
// rough bbox around the user's heatmap center so we don't ship thousands of
// markers per request. Types: hydrant (fire_zone), bus_stop, no_parking_always,
// tow_away — the kinds of per-spot restrictions you can't see by polyline.
async function nycPointRestrictions(lat, lng, radiusKm = 1) {
  const lt = +lat, ln = +lng;
  if (!Number.isFinite(lt) || !Number.isFinite(ln)) return [];
  // Approximate degrees-per-km for bbox pre-filter (coarse but fast).
  const latRange = radiusKm / 111;
  const lngRange = radiusKm / (111 * Math.cos(lt * Math.PI / 180));
  const minLat = lt - latRange, maxLat = lt + latRange;
  const minLng = ln - lngRange, maxLng = ln + lngRange;

  // nfid-uabd indexes by borough text, not coords, so we figure out the
  // borough from the search center and query that subset — much smaller.
  const NYC_BOROUGH_CENTROIDS = {
    "Manhattan":    [40.7831, -73.9712],
    "Brooklyn":     [40.6782, -73.9442],
    "Queens":       [40.7282, -73.7949],
    "Bronx":        [40.8448, -73.8648],
    "Staten Island":[40.5795, -74.1502],
  };
  let borough = null, bestDist = Infinity;
  for (const [name, [blat, blng]] of Object.entries(NYC_BOROUGH_CENTROIDS)) {
    const dist = haversineKm(lt, ln, blat, blng);
    if (dist < bestDist) { bestDist = dist; borough = name; }
  }
  if (!borough || bestDist > 30) return [];

  // Only the sign types worth showing as map dots — the point-specific
  // restrictions whose spot a user couldn't otherwise see.
  const typeFilter = "(upper(sign_description) LIKE '%NO PARKING ANYTIME%' " +
    "OR upper(sign_description) LIKE '%NO STANDING ANYTIME%' " +
    "OR upper(sign_description) LIKE '%BUS STOP%' " +
    "OR upper(sign_description) LIKE '%FIRE%' " +
    "OR upper(sign_description) LIKE '%TOW AWAY%' " +
    "OR upper(sign_description) LIKE '%TOW-AWAY%')";
  const where = `record_type='Current' AND borough='${borough}' AND ${typeFilter}`;
  const url = `https://data.cityofnewyork.us/resource/nfid-uabd.json?$where=${encodeURIComponent(where)}&$select=on_street,sign_description,sign_x_coord,sign_y_coord&$limit=5000`;

  let rows = [];
  try {
    const r = await fetch(url);
    if (!r.ok) { console.error("point-restrictions fetch:", r.status); return []; }
    rows = await r.json();
  } catch (e) { console.error("point-restrictions fetch error:", e.message); return []; }

  const seen = new Set();
  const points = [];
  for (const row of rows) {
    const coords = nyspToLatLng(row.sign_x_coord, row.sign_y_coord);
    if (!coords) continue;
    if (coords.lat < minLat || coords.lat > maxLat || coords.lng < minLng || coords.lng > maxLng) continue;
    const type = categorizeSign(row.sign_description);
    if (!type) continue;
    if (!["no_parking_always","fire_zone","tow_away","bus_stop"].includes(type)) continue;
    // Dedupe nearby duplicate signs (same type within ~5m) so overlapping
    // sign records on a single post don't produce a cluster of dots.
    const key = `${type}|${coords.lat.toFixed(4)}|${coords.lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({
      lat: coords.lat,
      lng: coords.lng,
      type,
      description: cleanSignText(row.sign_description).slice(0,60),
    });
  }
  return points;
}

// For each NYC street in the batch, look up active sign restrictions from
// nfid-uabd and return the urgency that signs alone would suggest:
//   "red"    — restriction covers today
//   "yellow" — restriction covers tomorrow or the day after
//   null     — no actionable elevation
// Also returns a short sample of the sign text so the heatmap's nextClean
// field can show "NO PARKING 7-9AM MON" next to the urgency color.
async function nycSignsForHeatmap(streets, borough) {
  if (!streets.length || !borough) return {};
  const boroughProper = borough.toLowerCase().includes("staten") ? "Staten Island"
                      : borough.charAt(0).toUpperCase() + borough.slice(1).toLowerCase();
  const namePredicates = streets
    .map(s => `upper(on_street) LIKE '%${String(s).replace(/'/g,"''").toUpperCase()}%'`)
    .join(" OR ");
  const where = `record_type='Current' AND borough='${boroughProper}' AND (${namePredicates})`;
  const url = `https://data.cityofnewyork.us/resource/nfid-uabd.json?$where=${encodeURIComponent(where)}&$select=on_street,sign_description&$limit=1500`;
  let rows = [];
  try {
    const r = await fetch(url);
    if (!r.ok) { console.error("nfid-uabd heatmap fetch:", r.status); return {}; }
    rows = await r.json();
  } catch (e) { console.error("nfid-uabd heatmap fetch error:", e.message); return {}; }

  const todayAbbr    = DAYS_WEEK[new Date().getDay()];
  const tomorrowAbbr = DAYS_WEEK[new Date(Date.now()+86400000).getDay()];
  const in2Abbr      = DAYS_WEEK[new Date(Date.now()+86400000*2).getDay()];
  const in3Abbr      = DAYS_WEEK[new Date(Date.now()+86400000*3).getDay()];

  const result = {}; // { street: { urgency, sample } }
  for (const row of rows) {
    const onStreet = String(row.on_street || "").toUpperCase().trim();
    if (!onStreet) continue;
    const match = streets.find(s => onStreet === s || onStreet.includes(s) || s.includes(onStreet));
    if (!match) continue;
    const type = categorizeSign(row.sign_description);
    if (!type) continue;
    // Skip always-active signs ("NO PARKING ANYTIME", fire zones, tow-away,
    // bus stops) here. These apply to specific points on the curb (hydrants,
    // driveway cuts, bus stop zones) — elevating an entire street polyline
    // to red because one such sign exists makes the map unusable. They still
    // show per-block in the /api/restrictions "Other Parking Restrictions"
    // card where the spatial granularity fits.
    if (type === "no_parking_always" || type === "fire_zone" || type === "tow_away" || type === "bus_stop") {
      continue;
    }
    // Day-based: red if today is listed, yellow if tomorrow or 2-3 days.
    const days = extractSignDays(row.sign_description);
    if (!days || !days.length) continue;
    let up = null;
    if (days.includes(todayAbbr)) up = "red";
    else if (days.includes(tomorrowAbbr) || days.includes(in2Abbr) || days.includes(in3Abbr)) up = "yellow";
    if (!up) continue;
    const cur = result[match];
    if (!cur || (cur.urgency === "yellow" && up === "red")) {
      result[match] = { urgency: up, sample: cleanSignText(row.sign_description).slice(0,60) };
    }
  }
  return result;
}

// Point-specific NYC sign locations as tappable dots. Separate endpoint so
// the frontend can zoom-gate fetching (only pull when the user is zoomed in
// past level 15). Cached in-memory per (lat.3,lng.3) for 24h since sign
// locations rarely change.
const _pointRestrictionsCache = new Map();
const POINT_RESTRICTIONS_TTL = 24 * 3600 * 1000;
app.get("/api/point-restrictions", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json([]);
  const lt = +lat, ln = +lng;
  const NYC_BBOX = { minLat:40.49, maxLat:40.92, minLng:-74.26, maxLng:-73.69 };
  if (lt < NYC_BBOX.minLat || lt > NYC_BBOX.maxLat || ln < NYC_BBOX.minLng || ln > NYC_BBOX.maxLng) {
    return res.json([]);
  }
  const key = `${lt.toFixed(3)},${ln.toFixed(3)}`;
  const cached = _pointRestrictionsCache.get(key);
  if (cached && Date.now() - cached.ts < POINT_RESTRICTIONS_TTL) return res.json(cached.data);
  try {
    const points = await nycPointRestrictions(lt, ln, 1);
    _pointRestrictionsCache.set(key, { data: points, ts: Date.now() });
    console.log(`Point restrictions: ${points.length} dots at ${key}`);
    res.json(points);
  } catch (e) {
    console.error("Point restrictions error:", e.message);
    res.json([]);
  }
});

app.get("/api/restrictions", async (req, res) => {
  const { streets: streetsParam, borough } = req.query;
  if (!streetsParam) return res.json({});
  const streets = streetsParam.split(",").map(s => s.trim()).filter(Boolean).slice(0, 30);
  if (!streets.length) return res.json({});
  if (!borough) return res.json({});
  const bor = String(borough).toLowerCase();

  // Chicago branch: real city permit-zone data from u9xt-hiju. Each row is
  // keyed by street name + address range + zone number. We surface them as
  // permit_only entries so the frontend card renders them the same way it
  // renders NYC DOT sign data.
  if (bor.includes("chicago") || bor.includes("cook county")) {
    try {
      const byStreet = await chicagoPermitZones(streets);
      const TYPE_RANK = { permit_only: 7 };
      const result = {};
      for (const s of streets) result[s] = [];
      for (const [street, entries] of Object.entries(byStreet)) {
        for (const e of entries) {
          result[street].push({
            type: "permit_only",
            side: e.side,
            block: e.lowAddr && e.highAddr ? `${e.lowAddr}–${e.highAddr}` : "",
            description: `Permit Zone ${e.zone} — residents/permitted vehicles only`,
          });
        }
        result[street].sort((a,b) => (TYPE_RANK[a.type] ?? 99) - (TYPE_RANK[b.type] ?? 99));
      }
      return res.json(result);
    } catch (e) {
      console.error("Chicago restrictions error:", e.message);
      return res.json({});
    }
  }

  // NYC branch: query the DOT Parking Regulation Signs dataset.
  const nycBoroughs = ["brooklyn","manhattan","queens","bronx","staten island"];
  if (!nycBoroughs.some(b => bor.includes(b))) return res.json({});

  const boroughProper = bor.includes("staten") ? "Staten Island"
                      : bor.charAt(0).toUpperCase() + bor.slice(1);

  try {
    // One Socrata call for all requested streets via OR'd LIKE matches.
    const namePredicates = streets
      .map(s => `upper(on_street) LIKE '%${s.replace(/'/g, "''").toUpperCase()}%'`)
      .join(" OR ");
    const where = `record_type='Current' AND borough='${boroughProper}' AND (${namePredicates})`;
    const url = `https://data.cityofnewyork.us/resource/nfid-uabd.json?$where=${encodeURIComponent(where)}&$select=on_street,side_of_street,from_street,to_street,sign_description&$limit=1500`;
    const r = await fetch(url);
    if (!r.ok) { console.error("nfid-uabd fetch:", r.status); return res.json({}); }
    const rows = await r.json();

    const result = {};
    for (const s of streets) result[s] = [];
    const seen = new Map();

    for (const row of rows) {
      const onStreet = String(row.on_street || "").toUpperCase().trim();
      if (!onStreet) continue;
      // Match against the requested street (normalized contains-check).
      const match = streets.find(s => onStreet === s || onStreet.includes(s) || s.includes(onStreet));
      if (!match) continue;
      const type = categorizeSign(row.sign_description);
      if (!type) continue;
      const cleaned = cleanSignText(row.sign_description);
      // Dedupe by (street, side, type, cleaned description) so a block with
      // five identical "NO PARKING ANYTIME" signs shows up once.
      const key = `${match}|${row.side_of_street || ""}|${type}|${cleaned}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      result[match].push({
        type,
        side: row.side_of_street || "",
        block: [row.from_street, row.to_street].filter(Boolean).join(" to "),
        description: cleaned,
      });
    }
    // Sort each street's list by urgency bucket so the worst restrictions
    // surface first when the frontend caps a list.
    const TYPE_RANK = {
      tow_away: 0, fire_zone: 1, no_parking_always: 2, bus_stop: 3,
      no_parking_hours: 4, time_limit: 5, loading_zone: 6, permit_only: 7,
    };
    for (const k of Object.keys(result)) {
      result[k].sort((a, b) => (TYPE_RANK[a.type] ?? 99) - (TYPE_RANK[b.type] ?? 99));
    }
    res.json(result);
  } catch (e) {
    console.error("Restrictions error:", e.message);
    res.json({});
  }
});

// Inspect an Overpass way's tags for parking-restriction signals. Returns
// {urgency, source} when a restriction is present, or null when none found.
// Handles both the old parking:lane:* schema and the newer parking:left /
// parking:right / parking:both schema, plus common truck/standing variants.
function osmParkingStatus(tags) {
  if (!tags) return null;
  const RESTRICTION_VALUES = new Set(["no_parking", "no_stopping", "no_standing", "fire_lane"]);
  const keys = Object.keys(tags);
  // Pass 1: absolute-restriction values on any parking-ish key.
  for (const k of keys) {
    if (!/^(parking[:_]|no_parking$)/.test(k)) continue;
    const v = String(tags[k] ?? "").toLowerCase();
    if (RESTRICTION_VALUES.has(v) || (k === "no_parking" && (v === "yes" || v === "true"))) {
      return { urgency: "red", source: `${k}=${v}` };
    }
  }
  // Pass 2: time-limited parking via maxstay.
  for (const k of keys) {
    if (!k.toLowerCase().includes("maxstay")) continue;
    return { urgency: "yellow", source: `${k}=${tags[k]}` };
  }
  // Pass 3: named restriction relations / access limits surfaced on ways.
  if (tags["restriction"] && /no_parking|no_stopping/i.test(tags["restriction"])) {
    return { urgency: "red", source: `restriction=${tags["restriction"]}` };
  }
  return null;
}

// ─── PARKING HEAT MAP — OpenStreetMap via Overpass ───────────────────────────
app.get("/api/heatmap", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json([]);

  const cacheKey = `v17:${parseFloat(lat).toFixed(3)},${parseFloat(lng).toFixed(3)}`;

  const cached = heatmapCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data);

  try {
    const { rows } = await db.query("SELECT data FROM heatmap_cache WHERE cache_key=$1 AND updated_at > NOW() - INTERVAL '6 hours'", [cacheKey]);
    if (rows.length > 0) {
      const data = rows[0].data;
      heatmapCache.set(cacheKey, { data, ts: Date.now() });
      return res.json(data);
    }
  } catch(e) {}

  try {
    const overpassQuery = `[out:json][timeout:25];way(around:1000,${lat},${lng})["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street)$"]["name"];out geom;`;
    const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`, {
      headers: { "User-Agent": "StreetParkNow/1.0 (streetparknow.vercel.app)" }
    });
    if (!r.ok) { console.error("Overpass status:", r.status); return res.json([]); }
    const data = await r.json();
    const ways = (data.elements || []).filter(w => w.tags?.name && w.geometry?.length > 1);
    console.log(`Overpass: ${ways.length} ways`);

    const streetNames = [...new Set(ways.map(w => normStreet(w.tags.name)))].slice(0, 80);
    if (!streetNames.length) return res.json([]);

    // City allowlist: only ask Claude for cleaning schedules where weekly
    // street-sweeping / alt-side regimes genuinely exist. Outside these
    // bboxes, streets default to green rather than receiving hallucinated
    // schedules (Dallas, Austin, Nashville, Atlanta, Denver, Miami, etc.
    // don't have block-level weekly sweeping; Claude was making it up).
    // Chicago is handled by its own real-data branch earlier in this function.
    const CLEANING_CITY_BBOXES = [
      { name:"NYC",      minLat:40.49, maxLat:40.92, minLng:-74.26, maxLng:-73.69 },
      { name:"Boston",   minLat:42.20, maxLat:42.45, minLng:-71.20, maxLng:-70.85 },
      { name:"DC",       minLat:38.80, maxLat:39.00, minLng:-77.15, maxLng:-76.90 },
      { name:"Philly",   minLat:39.87, maxLat:40.14, minLng:-75.28, maxLng:-74.96 },
      { name:"SF",       minLat:37.70, maxLat:37.83, minLng:-122.52,maxLng:-122.35 },
      { name:"LA",       minLat:33.70, maxLat:34.35, minLng:-118.65,maxLng:-118.15 },
      { name:"Seattle",  minLat:47.45, maxLat:47.73, minLng:-122.46,maxLng:-122.22 },
      { name:"Portland", minLat:45.43, maxLat:45.65, minLng:-122.81,maxLng:-122.44 },
      { name:"Baltimore",minLat:39.20, maxLat:39.38, minLng:-76.72, maxLng:-76.52 },
      { name:"Toronto",  minLat:43.58, maxLat:43.86, minLng:-79.64, maxLng:-79.11 },
    ];
    const cleaningCity = CLEANING_CITY_BBOXES.find(b =>
      +lat >= b.minLat && +lat <= b.maxLat && +lng >= b.minLng && +lng <= b.maxLng
    );
    if (!cleaningCity) {
      // "Strict 24-hour" cities: municipal ordinance caps overnight parking
      // on any city street. Default to yellow (not green) so we don't
      // falsely imply "safe for 4+ days." Each entry cites the actual
      // ordinance + has a downtown-metered allowlist pulled from the city
      // parking authority's published street list.
      const STRICT_24H_CITIES = [
        // Dallas SEC 28-84 — https://codelibrary.amlegal.com/codes/dallas/latest/dallas_tx/0-0-0-112892
        { name:"Dallas", bbox:{ minLat:32.61, maxLat:32.99, minLng:-96.99, maxLng:-96.57 },
          ordinance:"SEC 28-84",
          note:"Dallas 24-hour street parking limit · move within a day or risk tow",
          meteredStreets: new Set([
            "MAIN STREET", "ELM STREET", "COMMERCE STREET",
            "AKARD STREET", "ERVAY STREET", "FIELD STREET",
            "HARWOOD STREET", "GRIFFIN STREET", "LAMAR STREET",
            "PEARL STREET", "ROSS AVENUE", "SAINT PAUL STREET",
            "BRYAN STREET", "JACKSON STREET", "WOOD STREET",
          ]),
          meteredBbox:{ minLat:32.77, maxLat:32.79, minLng:-96.81, maxLng:-96.79 },
          meteredText:"Metered · Mon-Sat business hours (check meter)",
        },
        // Nashville Metro Code 12.40 — move every 24h per NDOT Parking
        // Enforcement (nashville.gov). Downtown CBD meters enforced 24/7
        // per Nashville Downtown Partnership guide.
        { name:"Nashville", bbox:{ minLat:36.03, maxLat:36.35, minLng:-87.05, maxLng:-86.53 },
          ordinance:"Metro Code 12.40",
          note:"Nashville 24-hour street parking limit · move every day or risk tow",
          meteredStreets: new Set([
            "BROADWAY", "CHURCH STREET", "COMMERCE STREET", "UNION STREET",
            "DEMONBREUN STREET", "CHARLOTTE AVENUE", "KOREAN VETERANS BOULEVARD",
            "2ND AVENUE NORTH", "2ND AVENUE SOUTH", "3RD AVENUE NORTH",
            "3RD AVENUE SOUTH", "4TH AVENUE NORTH", "4TH AVENUE SOUTH",
            "5TH AVENUE NORTH", "5TH AVENUE SOUTH", "6TH AVENUE NORTH",
            "6TH AVENUE SOUTH", "7TH AVENUE NORTH", "8TH AVENUE SOUTH",
          ]),
          meteredBbox:{ minLat:36.14, maxLat:36.18, minLng:-86.79, maxLng:-86.76 },
          meteredText:"Metered · Downtown CBD (often enforced 24/7 — check signs)",
        },
        // Houston Ordinance 26-93 — "vehicle cannot legally park on public
        // street for more than 24 hours" (houstontx.gov/parking).
        { name:"Houston", bbox:{ minLat:29.52, maxLat:30.11, minLng:-95.78, maxLng:-95.02 },
          ordinance:"Ordinance 26-93",
          note:"Houston 24-hour street parking limit · move every day or risk tow",
          meteredStreets: new Set([
            "MAIN STREET", "CAPITOL STREET", "RUSK STREET", "TRAVIS STREET",
            "MILAM STREET", "LOUISIANA STREET", "SMITH STREET", "FANNIN STREET",
            "BRAZOS STREET", "CAROLINE STREET", "SAN JACINTO STREET",
            "WALKER STREET", "LAMAR STREET", "PRAIRIE STREET", "TEXAS AVENUE",
            "POLK STREET", "DALLAS STREET", "MCKINNEY STREET", "CLAY STREET",
          ]),
          meteredBbox:{ minLat:29.74, maxLat:29.77, minLng:-95.38, maxLng:-95.35 },
          meteredText:"Metered · Mon-Sat business hours (check meter)",
        },
      ];
      const strict = STRICT_24H_CITIES.find(c =>
        +lat >= c.bbox.minLat && +lat <= c.bbox.maxLat &&
        +lng >= c.bbox.minLng && +lng <= c.bbox.maxLng
      );
      let meteredCount = 0;
      const result = ways.map(w => {
        const name = normStreet(w.tags.name);
        const coords = w.geometry.map(p => [p.lat, p.lon]);
        if (!strict) {
          // No ordinance data — honest green default.
          return { street: name, coords, urgency: "green", nextClean: null };
        }
        // Strict 24h city: default yellow (citywide rule). Elevate to red
        // if this segment is in the downtown metered bbox AND the name
        // matches the posted-meter list from the city's parking pages.
        const mid = w.geometry[Math.floor(w.geometry.length / 2)];
        const inMeteredBox = mid.lat >= strict.meteredBbox.minLat && mid.lat <= strict.meteredBbox.maxLat &&
                             mid.lon >= strict.meteredBbox.minLng && mid.lon <= strict.meteredBbox.maxLng;
        if (inMeteredBox && strict.meteredStreets.has(name)) {
          meteredCount++;
          return { street: name, coords, urgency: "red", nextClean: strict.meteredText };
        }
        return { street: name, coords, urgency: "yellow", nextClean: strict.note };
      });
      heatmapCache.set(cacheKey, { data: result, ts: Date.now() });
      try {
        await db.query(
          `INSERT INTO heatmap_cache (cache_key, data) VALUES ($1, $2) ON CONFLICT (cache_key) DO UPDATE SET data=$2, updated_at=NOW()`,
          [cacheKey, JSON.stringify(result)]
        );
      } catch(e) {}
      const label = strict ? `${strict.name} (strict 24h ordinance ${strict.ordinance})` : "outside cleaning-city allowlist";
      console.log(`Heatmap ${label}: ${result.length} streets · ${meteredCount} metered-red`);
      return res.json(result);
    }

    // Chicago branch: use real city data (zone polygons + scheduled dates)
    // instead of asking Claude. Every residential way that falls inside a
    // ward-section zone gets classified by its next scheduled sweep date.
    // Permit-zone streets get bumped to yellow when the sweeping signal
    // would otherwise say green/gray, so a resident searching a permit
    // block sees "restricted" rather than "safe."
    if (isChicago(+lat, +lng)) {
      const zones = await loadChicagoZones();
      if (zones.length) {
        const today = new Date(); today.setHours(0,0,0,0);
        // Pull permit zones keyed by normalized street name in one batch.
        const permitByStreet = await chicagoPermitZones([...new Set(ways.map(w => normStreet(w.tags.name)))]);
        let permitBoosted = 0;
        const result = ways.map(w => {
          const mid = w.geometry[Math.floor(w.geometry.length / 2)];
          const zone = findChicagoZone(mid.lat, mid.lon, zones);
          const coords = w.geometry.map(p => [p.lat, p.lon]);
          const name = normStreet(w.tags.name);
          const nextDate = zone ? zone.dates.find(d => d >= today) : null;
          let urgency = zone ? chicagoUrgency(nextDate, today) : "gray";
          let nextClean = zone ? chicagoNextCleanLabel(nextDate, today) : null;
          // Permit-zone elevation: only upgrade gray/green, never overrides red/yellow cleaning.
          if ((urgency === "gray" || urgency === "green") && permitByStreet[name]?.length) {
            const zoneNum = permitByStreet[name][0].zone;
            urgency = "yellow";
            nextClean = `Permit Zone ${zoneNum} — residents only`;
            permitBoosted++;
          }
          return { street: name, coords, urgency, nextClean };
        });
        heatmapCache.set(cacheKey, { data: result, ts: Date.now() });
        try {
          await db.query(
            `INSERT INTO heatmap_cache (cache_key, data) VALUES ($1, $2) ON CONFLICT (cache_key) DO UPDATE SET data=$2, updated_at=NOW()`,
            [cacheKey, JSON.stringify(result)]
          );
        } catch(e) {}
        const nonGray = result.filter(r => r.urgency !== "gray").length;
        console.log(`Chicago heatmap: ${result.length} ways, ${nonGray} classified, ${permitBoosted} permit-boosted`);
        return res.json(result);
      }
    }

    const todayISO = new Date().toISOString().slice(0,10);
    const schedulesRaw = await askClaude(`You are a US urban parking expert with deep knowledge of NYC alternate-side parking, LA / SF / Seattle / Portland street sweeping, Chicago snow routes, and metered downtown zones. Today is ${todayISO}. For each street near lat=${lat}, lng=${lng}, return every weekly posted parking rule currently in effect. Include what you know — most residential streets in NYC, Boston, DC, Philly, Baltimore DO have weekly alternate-side cleaning; residential streets in Chicago Apr-Nov and LA year-round DO have weekly sweeping. Do not return [] just because you are not 100% certain — best-known pattern is acceptable.

Streets (names are in canonical UPPERCASE with full words — "AVENUE" not "AVE"):
${streetNames.map((s,i) => `${i+1}. ${s}`).join("\n")}

Each rule has a "kind" tag:

kind="cleaning" — weekly street cleaning / alternate-side (you must move the car):
  NYC/Boston/DC/Philly: usually Mon+Thu OR Tue+Fri, 8-9:30 AM or 11:30 AM - 1 PM
  LA: once/week per side, 8 AM - 12 PM typical
  SF: once/week per side, 8-10 AM or 10 AM - 12 PM
  Chicago residential (Apr 1 - Nov 30 ONLY)
  Chicago winter overnight snow routes (Dec 1 - Apr 1 ONLY, 3 AM - 7 AM all 7 days)
  Toronto weekly cleaning (Apr - Nov only)

kind="metered" — downtown metered / pay-by-hour enforcement during posted weekly hours:
  Dallas: Commerce/Elm/Main/Akard downtown Mon-Sat 7 AM - 6 PM
  Austin: Congress/2nd/6th downtown Mon-Sat 8 AM - 6 PM
  Nashville: Broadway/Commerce downtown Mon-Sat 8 AM - 6 PM
  Denver: 16th Mall / Colfax downtown Mon-Sat 8 AM - 10 PM
  Atlanta: Peachtree downtown Mon-Fri 7 AM - 7 PM
  Any recognizable commercial arterial

kind="rush_hour" — time-of-day no-parking on arterials (e.g., Mon-Fri 7-9 AM / 4-6 PM)

DO NOT include: highways/interstates/expressways, private roads, zones without a defined weekly time window. Return [] for those.

Days must be 3-letter abbreviations: Mon Tue Wed Thu Fri Sat Sun.

Examples:
{"BEDFORD AVENUE":[{"kind":"cleaning","days":["Mon","Thu"],"time":"8 AM - 9:30 AM"}],
 "BERRY STREET":[{"kind":"cleaning","days":["Tue","Fri"],"time":"11:30 AM - 1 PM"}],
 "COMMERCE STREET":[{"kind":"metered","days":["Mon","Tue","Wed","Thu","Fri","Sat"],"time":"7 AM - 6 PM"}],
 "BROOKLYN QUEENS EXPRESSWAY":[]}

Return ONLY the JSON object:`, 4000);

    let schedules = {};
    try {
      const m = schedulesRaw.match(/\{[\s\S]*\}/);
      if (m) schedules = JSON.parse(m[0]);
      else console.error("Heatmap: no JSON in Claude response:", schedulesRaw.substring(0, 300));
    } catch(e) {
      console.error("Heatmap: JSON parse failed:", e.message, "- raw:", schedulesRaw.substring(0, 300));
    }

    // Normalize Claude's keys so lookup is robust to case/abbreviation drift.
    const schedulesByKey = {};
    for (const [k, v] of Object.entries(schedules)) {
      if (Array.isArray(v)) schedulesByKey[normStreet(k)] = v;
    }
    const matched = Object.keys(schedulesByKey).filter(k => schedulesByKey[k].length > 0).length;
    console.log(`Heatmap: Claude returned ${Object.keys(schedules).length} keys, ${matched} with schedules`);

    const today    = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()];
    const tomorrow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+86400000).getDay()];
    const in2days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+172800000).getDay()];
    const in3days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+259200000).getDay()];

    // Classification is honest about what we actually know. For each street:
    //   - If Claude returned a "cleaning" rule with a matching day → red/yellow/green
    //   - If Claude returned a non-cleaning rule (metered / permit / rush_hour)
    //     active today → yellow ("restrictions apply, check signs/meters")
    //   - If OSM tags flag no-parking / time-limit → red / yellow
    //   - If nothing from any source → gray ("we don't know"), regardless of
    //     city. Earlier iteration of this defaulted to green outside NYC,
    //     which lied to users about cities like Dallas where no structured
    //     data exists. Gray is the honest answer when we have no signal.
    let osmRedCount = 0, osmYellowCount = 0;
    const result = ways.map(w => {
      const name = normStreet(w.tags.name);
      const sch = schedulesByKey[name] || [];
      const coords = w.geometry.map(p => [p.lat, p.lon]);
      let urgency = "gray";
      let nextClean = null;

      if (sch.length) {
        // Only `kind: "cleaning"` rules drive color. Metered / rush-hour /
        // permit entries come back from the same Claude call but are
        // informational — they surface in /api/cleaning-batch for the
        // results-page card, not here. Coloring entire streets yellow
        // because Claude guessed "metered" turned Dallas into a sea of
        // yellow from hallucinated coverage.
        let cleaningRed = null;
        let cleaningSoon = null;
        let anyCleaning = false;
        for (const s of sch) {
          const isCleaning = !s.kind || s.kind === "cleaning";
          if (!isCleaning) continue;
          anyCleaning = true;
          const days = s.days || [];
          if (!cleaningRed && days.includes(today))         cleaningRed  = { when: "Today",    time: s.time || "" };
          else if (!cleaningRed && days.includes(tomorrow)) cleaningRed  = { when: "Tomorrow", time: s.time || "" };
          else if (!cleaningSoon && (days.includes(in2days) || days.includes(in3days))) {
            cleaningSoon = { when: "In 2-3 days", time: s.time || "" };
          }
        }
        if (cleaningRed) {
          urgency = "red";
          nextClean = `${cleaningRed.when} ${cleaningRed.time}`.trim();
        } else if (cleaningSoon) {
          urgency = "yellow";
          nextClean = `${cleaningSoon.when} ${cleaningSoon.time}`.trim();
        } else if (anyCleaning) {
          urgency = "green";
        } else {
          // Schedule entries returned but no cleaning among them — treat as
          // no-known-restriction → green (was gray, which read as "missing data").
          urgency = "green";
        }
      } else {
        const osm = osmParkingStatus(w.tags);
        if (osm) {
          urgency = osm.urgency;
          nextClean = `OSM tag: ${osm.source}`;
          if (osm.urgency === "red") osmRedCount++; else if (osm.urgency === "yellow") osmYellowCount++;
        } else {
          // No schedule and no OSM tag — default to green ("no known
          // scheduled restriction"). Yellow is reserved for actual
          // scheduled restriction data (cleaning in 2-3 days).
          urgency = "green";
        }
      }
      return { street: name, coords, urgency, nextClean };
    });
    if (osmRedCount + osmYellowCount > 0) {
      console.log(`OSM tag classification: red=${osmRedCount} yellow=${osmYellowCount}`);
    }

    // NYC-only post-pass: consult nfid-uabd signs and elevate per-street
    // urgency when a sign's day set matches today (red) or the next 3 days
    // (yellow). Red for signs never overrides a cleaning-red; yellow only
    // elevates from green/gray. Sign-derived nextClean carries the actual
    // posted text so users can see why the color changed.
    const NYC_BOROUGH_CENTROIDS = {
      "Manhattan":    [40.7831, -73.9712],
      "Brooklyn":     [40.6782, -73.9442],
      "Queens":       [40.7282, -73.7949],
      "Bronx":        [40.8448, -73.8648],
      "Staten Island":[40.5795, -74.1502],
    };
    let nycBorough = null, bestDist = Infinity;
    for (const [name, [blat, blng]] of Object.entries(NYC_BOROUGH_CENTROIDS)) {
      const dist = haversineKm(+lat, +lng, blat, blng);
      if (dist < bestDist) { bestDist = dist; nycBorough = name; }
    }
    if (nycBorough && bestDist < 30) {
      try {
        const signUrgency = await nycSignsForHeatmap(streetNames, nycBorough);
        let signElevated = 0;
        for (const r of result) {
          const s = signUrgency[r.street];
          if (!s) continue;
          const before = r.urgency;
          if (s.urgency === "red" && r.urgency !== "red") {
            r.urgency = "red";
            r.nextClean = `Sign: ${s.sample}`;
            signElevated++;
          } else if (s.urgency === "yellow" && (r.urgency === "green" || r.urgency === "gray")) {
            r.urgency = "yellow";
            r.nextClean = `Sign: ${s.sample}`;
            signElevated++;
          }
        }
        if (signElevated > 0) console.log(`NYC signs elevated ${signElevated} streets (borough=${nycBorough})`);
      } catch (e) { console.error("NYC signs elevation error:", e.message); }
    }

    heatmapCache.set(cacheKey, { data: result, ts: Date.now() });
    try {
      await db.query(
        `INSERT INTO heatmap_cache (cache_key, data) VALUES ($1, $2) ON CONFLICT (cache_key) DO UPDATE SET data=$2, updated_at=NOW()`,
        [cacheKey, JSON.stringify(result)]
      );
    } catch(e) {}

    console.log(`Heatmap: ${result.length} streets`);
    res.json(result);
  } catch(e) { console.error("Heatmap error:", e.message); res.json([]); }
});

// Strategy: search by street name fragments, nearby cross streets, and borough-wide
// NYC Open Data dataset tg4x-b46p is the official Mayor's Office of Media & Entertainment permits
app.get("/api/films", async (req, res) => {
  const { street, borough, lat, lng } = req.query;
  const from = new Date(); from.setDate(from.getDate() - 1);
  const to   = new Date(); to.setDate(to.getDate() + 21); // 3 weeks out
  const fmt  = d => d.toISOString().split(".")[0];
  const dateFilter = `startdatetime >= '${fmt(from)}' AND startdatetime <= '${fmt(to)}'`;

  const results = new Map(); // dedupe by eventid

  const addResults = (permits) => {
    permits.forEach(f => {
      if (!results.has(f.eventid)) {
        results.set(f.eventid, {
          id:          f.eventid,
          type:        f.category || "Film/TV",
          subtype:     f.subcategoryname || f.eventtype || f.zipcode_s || "Production",
          start:       f.startdatetime,
          end:         f.enddatetime,
          parkingHeld: f.parkingheld || "",
          borough:     f.borough || "",
          address:     f.address || "",
          country:     f.country || "",
        });
      }
    });
  };

  try {
    // Search 1: exact street name in parkingheld field
    if (street) {
      const name = street.toUpperCase().trim();
      // Try multiple variations of the street name
      const variants = [name];
      // "WEST 46 STREET" → also try "W 46", "46TH", "46 ST"
      const numMatch = name.match(/^(WEST|EAST|NORTH|SOUTH)?\s*(\d+)\s*(STREET|AVENUE|BOULEVARD|DRIVE|PLACE|ROAD)?$/i);
      if (numMatch) {
        const num = numMatch[2];
        variants.push(num + " ST", num + "TH", num + "ND", num + "RD", "W " + num, "E " + num);
      }
      // Also strip directional prefix for broad match
      const stripped = name.replace(/^(WEST|EAST|NORTH|SOUTH)\s+/i, "");
      if (stripped !== name) variants.push(stripped);

      for (const v of variants) {
        const encoded = encodeURIComponent(v);
        const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(parkingheld)%20LIKE%20'%25${encoded}%25'%20AND%20${dateFilter}&$limit=50&$order=startdatetime%20ASC`;
        const r = await fetch(url);
        if (r.ok) addResults(await r.json());
      }
    }

    // Search 2: borough-wide recent/upcoming permits (catches everything nearby)
    if (borough) {
      const boroughMap = {
        "manhattan": "Manhattan", "brooklyn": "Brooklyn", "queens": "Queens",
        "bronx": "Bronx", "the bronx": "Bronx", "staten island": "Staten Island"
      };
      const boroughNorm = boroughMap[borough.toLowerCase()] || borough;
      const encoded = encodeURIComponent(boroughNorm.toUpperCase());
      const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(borough)%20LIKE%20'%25${encoded}%25'%20AND%20${dateFilter}&$limit=100&$order=startdatetime%20ASC`;
      const r = await fetch(url);
      if (r.ok) addResults(await r.json());
    }

    // Search 3: if we have coordinates, also search by zip code area
    // The dataset has zipcode_s field
    if (lat && lng) {
      // Round to ~0.5 mile bounding box
      const latD = 0.007, lngD = 0.009;
      const latMin = parseFloat(lat) - latD, latMax = parseFloat(lat) + latD;
      const lngMin = parseFloat(lng) - lngD, lngMax = parseFloat(lng) + lngD;
      // Can't query by coords directly but we can get all current borough permits (already done above)
      // So this is a no-op if borough was provided
    }

    const all = Array.from(results.values())
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    res.json(all);
  } catch (e) {
    console.error("Films error:", e.message);
    res.json([]);
  }
});

// ─── PUBLIC EVENTS ────────────────────────────────────────────────────────────
app.get("/api/events", async (req, res) => {
  const { borough, lat, lng } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const toDate = new Date(); toDate.setDate(toDate.getDate()+14);
  const toDateStr = toDate.toISOString().split("T")[0];

  const results = new Map();

  // NYC bbox detection — only hit NYC-specific Socrata sources when the search
  // is actually in NYC. Avoids pointless API calls from LA/Chicago/etc.
  const NYC_BBOX = { minLat: 40.49, maxLat: 40.92, minLng: -74.26, maxLng: -73.69 };
  const inNYC = lat && lng &&
    +lat >= NYC_BBOX.minLat && +lat <= NYC_BBOX.maxLat &&
    +lng >= NYC_BBOX.minLng && +lng <= NYC_BBOX.maxLng;
  // Borough-only fallback: if we have a borough string matching a NYC borough,
  // treat it as NYC even without coords (older clients only send borough).
  const nycBoroughs = ["brooklyn","manhattan","queens","bronx","staten island"];
  const boroughIsNYC = borough && nycBoroughs.some(b => String(borough).toLowerCase().includes(b));
  const shouldHitNYCSources = inNYC || boroughIsNYC;

  // Chicago Park District: pulls events at Soldier Field / Grant Park /
  // Millennium Park / Maggie Daley when the user's coords are within ~0.5 mi.
  // Surfaces these as event entries with the venue name and parking-impact
  // flag so the frontend can highlight "Parking restricted during X."
  if (lat && lng && isChicago(+lat, +lng)) {
    try {
      const events = await chicagoNearbyEvents(+lat, +lng, 0.5);
      for (const ev of events) {
        const id = `chi-park-${ev.venue}-${ev.startDate}-${ev.name}`;
        if (!results.has(id)) results.set(id, {
          name: ev.name,
          type: `Chicago Park District @ ${ev.venue}`,
          start: ev.startDate,
          end: ev.endDate || ev.startDate,
          location: ev.venue,
          borough: "Chicago",
          distance: `${ev.distanceKm} km`,
          daysAway: ev.daysAway,
          parkingImpacted: true,
        });
      }
    } catch(e) { console.error("Chicago events:", e.message); }
  }

  // ESPN sports schedules — NFL / NBA / MLB / NHL home games at major venues
  // (Soldier Field, Wrigley, United Center, MSG, Yankee/Citi, MetLife, SoFi,
  // Crypto.com, Dodger Stadium). Only fires when user's coords are within 3 km
  // of a known venue, so there's no "Lakers game" noise from a Chicago search.
  if (lat && lng) {
    try {
      const sports = await fetchSportsEventsNear(+lat, +lng, 3);
      for (const ev of sports) {
        const id = `espn-${ev.league}-${ev.venue}-${ev.startDateTime}`;
        if (!results.has(id)) results.set(id, {
          name: `${ev.away} @ ${ev.home}`,
          type: `${ev.league} @ ${ev.venue}`,
          start: ev.startDate,
          end: ev.startDate,
          location: ev.venue,
          distance: `${ev.distanceKm} km`,
          daysAway: ev.daysAway,
          parkingImpacted: true,
        });
      }
    } catch(e) { console.error("Sports events:", e.message); }
  }

  if (shouldHitNYCSources) try {
    // Source 1: NYC Special Events (tvpp-9vvx) — parades, street fairs, etc.
    const bf = borough ? `%20AND%20upper(borough)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'` : "";
    const url1 = `${SOCRATA}/tvpp-9vvx.json?$where=startdate%20>=%20'${today}'%20AND%20startdate%20<=%20'${toDateStr}'${bf}&$limit=30&$order=startdate%20ASC`;
    const r1 = await fetch(url1);
    if (r1.ok) {
      const data = await r1.json();
      data.forEach(ev => {
        const id = ev.uniquekey || ev.eventid || ev.eventname;
        if (!results.has(id)) results.set(id, {
          name: ev.eventname || ev.name || "City Event",
          type: ev.eventtype || "Event",
          start: ev.startdate,
          end: ev.enddate,
          location: ev.eventlocation || ev.streetname || "",
          borough: ev.borough || "",
          parkingImpacted: !!(ev.parkingimpacted || ev.street_closure_type)
        });
      });
    }
  } catch(e) { console.error("Events source 1:", e.message); }

  if (shouldHitNYCSources) try {
    // Source 2: NYC Street Closures (uiay-nctp)
    const bf2 = borough ? `%20AND%20upper(borough_name)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'` : "";
    const url2 = `${SOCRATA}/uiay-nctp.json?$where=work_start_date%20>=%20'${today}'%20AND%20work_start_date%20<=%20'${toDateStr}'${bf2}&$limit=20&$order=work_start_date%20ASC`;
    const r2 = await fetch(url2);
    if (r2.ok) {
      const data = await r2.json();
      data.forEach(ev => {
        const id = `closure-${ev.objectid || ev.work_order_id}`;
        if (!results.has(id)) results.set(id, {
          name: ev.work_order_type || "Street Closure",
          type: "Street Closure",
          start: ev.work_start_date?.split("T")[0],
          end: ev.work_end_date?.split("T")[0],
          location: `${ev.on_street || ""} ${ev.from_street ? `from ${ev.from_street}` : ""}`.trim(),
          borough: ev.borough_name || "",
          parkingImpacted: true
        });
      });
    }
  } catch(e) { console.error("Events source 2:", e.message); }

  if (shouldHitNYCSources) try {
    // Source 3: NYC Parade permits (from special events dataset filtered by type)
    const bf3 = borough ? `%20AND%20upper(borough)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'` : "";
    const url3 = `${SOCRATA}/tvpp-9vvx.json?$where=upper(eventtype)%20LIKE%20'%25PARADE%25'%20AND%20startdate%20>=%20'${today}'${bf3}&$limit=10`;
    const r3 = await fetch(url3);
    if (r3.ok) {
      const data = await r3.json();
      data.forEach(ev => {
        const id = `parade-${ev.uniquekey || ev.eventname}`;
        if (!results.has(id)) results.set(id, {
          name: ev.eventname || "Parade",
          type: "Parade",
          start: ev.startdate,
          location: ev.eventlocation || "",
          borough: ev.borough || "",
          parkingImpacted: true
        });
      });
    }
  } catch(e) {}

  const all = Array.from(results.values())
    .filter(e => e.start)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, 20);

  res.json(all);
});

// ─── WEATHER ──────────────────────────────────────────────────────────────────
app.get("/api/weather", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json(null);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&hourly=temperature_2m,weather_code,precipitation_probability&daily=weather_code,precipitation_sum,snowfall_sum&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=3&timezone=auto`;
    const r = await fetch(url);
    res.json(r.ok ? await r.json() : null);
  } catch { res.json(null); }
});

// ─── ASP STATUS ───────────────────────────────────────────────────────────────
app.get("/api/asp", async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-CA");
    const r = await fetch(`https://api.nyc.gov/public/api/GetCalendar?calendarTypes=AltSideParking&startDate=${today}&endDate=${today}`);
    if (r.ok) return res.json({ suspended: JSON.stringify(await r.json()).toLowerCase().includes("suspended") });
  } catch (e) { console.error("ASP error:", e.message); }
  res.json({ suspended: false });
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Email signup
app.post("/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const hash = crypto.createHash("sha256").update(password + JWT_SECRET).digest("hex");
    const tier = email.toLowerCase() === "bassklaft@gmail.com" ? "unlimited" : "free";
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, tier) VALUES ($1, $2, $3, $4) 
       ON CONFLICT (email) DO NOTHING RETURNING id, email, name, tier, search_count`,
      [email.toLowerCase(), hash, name || email.split("@")[0], tier]
    );
    if (!rows.length) return res.status(409).json({ error: "Email already registered" });
    const user = rows[0];
    const token = signToken({ userId: user.id, tier: user.tier });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier, searchCount: user.search_count } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Email login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const hash = crypto.createHash("sha256").update(password + JWT_SECRET).digest("hex");
    // Always ensure bassklaft@gmail.com has unlimited tier
    if (email.toLowerCase() === "bassklaft@gmail.com") {
      await db.query(`UPDATE users SET tier='unlimited' WHERE email=$1`, [email.toLowerCase()]).catch(() => {});
    }
    const { rows } = await db.query(
      `UPDATE users SET last_seen=NOW() WHERE email=$1 AND password_hash=$2 AND active=true RETURNING id, email, name, tier, search_count`,
      [email.toLowerCase(), hash]
    );
    if (!rows.length) return res.status(401).json({ error: "Invalid email or password" });
    const user = rows[0];
    const token = signToken({ userId: user.id, tier: user.tier });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier, searchCount: user.search_count } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Apple Sign In
app.post("/auth/apple", async (req, res) => {
  const { appleId, email, name } = req.body;
  if (!appleId) return res.status(400).json({ error: "Apple ID required" });
  try {
    const { rows } = await db.query(
      `INSERT INTO users (apple_id, email, name, tier) VALUES ($1, $2, $3, 'free')
       ON CONFLICT (apple_id) DO UPDATE SET last_seen=NOW(), email=COALESCE(EXCLUDED.email, users.email), name=COALESCE(EXCLUDED.name, users.name)
       RETURNING id, email, name, tier, search_count`,
      [appleId, email || null, name || "Apple User"]
    );
    const user = rows[0];
    const token = signToken({ userId: user.id, tier: user.tier });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier, searchCount: user.search_count } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get current user
app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, email, name, tier, search_count FROM users WHERE id=$1",
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ user: { ...rows[0], searchCount: rows[0].search_count } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Track a search/interaction
app.post("/auth/track", authMiddleware, async (req, res) => {
  const { lat, lng, label, locData } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE users SET search_count=search_count+1, last_seen=NOW() WHERE id=$1 RETURNING search_count, tier`,
      [req.userId]
    );
    const { search_count, tier } = rows[0];
    const limit = TIER_LIMITS[tier]?.searches || 8;
    const exceeded = tier === "free" && search_count > limit;

    // Save to recent searches (keep last 2)
    if (lat && lng) {
      await db.query(
        `INSERT INTO recent_searches (user_id, label, lat, lng, loc_data) VALUES ($1,$2,$3,$4,$5)`,
        [req.userId, label, lat, lng, JSON.stringify(locData || {})]
      );
      await db.query(
        `DELETE FROM recent_searches WHERE user_id=$1 AND id NOT IN (SELECT id FROM recent_searches WHERE user_id=$1 ORDER BY searched_at DESC LIMIT 2)`,
        [req.userId]
      );
    }

    res.json({ searchCount: search_count, exceeded, tier, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get recent searches (for map pins)
app.get("/auth/recent", authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT label, lat, lng, loc_data FROM recent_searches WHERE user_id=$1 ORDER BY searched_at DESC LIMIT 2`,
      [req.userId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SAVED SEARCHES (Unlimited+Save tier only) ────────────────────────────────
app.get("/saved-searches", authMiddleware, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, label, street, lat, lng, borough, neighborhood, city, loc_data, checked FROM saved_searches WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/saved-searches", authMiddleware, async (req, res) => {
  const { label, street, lat, lng, borough, neighborhood, city, locData } = req.body;
  try {
    // Check tier
    const { rows: user } = await db.query("SELECT tier FROM users WHERE id=$1", [req.userId]);
    if (user[0]?.tier !== "unlimited") return res.status(403).json({ error: "Upgrade to Unlimited+Save to save searches" });
    // Check limit
    const { rows: count } = await db.query("SELECT COUNT(*) FROM saved_searches WHERE user_id=$1", [req.userId]);
    if (parseInt(count[0].count) >= 10) return res.status(400).json({ error: "Maximum 10 saved searches. Uncheck one to make room." });
    const { rows } = await db.query(
      `INSERT INTO saved_searches (user_id, label, street, lat, lng, borough, neighborhood, city, loc_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.userId, label, street, lat, lng, borough, neighborhood, city, JSON.stringify(locData || {})]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/saved-searches/:id", authMiddleware, async (req, res) => {
  const { checked } = req.body;
  try {
    await db.query(
      `UPDATE saved_searches SET checked=$1 WHERE id=$2 AND user_id=$3`,
      [checked, req.params.id, req.userId]
    );
    // Delete unchecked ones (they shouldn't persist)
    await db.query(`DELETE FROM saved_searches WHERE user_id=$1 AND checked=false`, [req.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/saved-searches/:id", authMiddleware, async (req, res) => {
  try {
    await db.query(`DELETE FROM saved_searches WHERE id=$1 AND user_id=$2`, [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  const body = req.body || {};
  const { phone, street, borough, lat, lng } = body;
  if (!phone) return res.status(400).json({ error: "phone required" });

  const digits = String(phone).replace(/\D/g,"");
  if (digits.length < 10) return res.status(400).json({ error: "invalid phone" });
  const e164 = digits.startsWith("1") ? `+${digits}` : `+1${digits}`;

  // Street is optional: unlimited-tier users may subscribe without a tracked
  // location. Normalize to NULL (not "") so it's semantically clear and
  // alert jobs can filter subscribers that opted in for weather/ASP only.
  const streetNorm = street ? String(street).toUpperCase() : null;
  const boroughNorm = borough ? String(borough) : null;
  const latNum = lat != null && !isNaN(+lat) ? +lat : null;
  const lngNum = lng != null && !isNaN(+lng) ? +lng : null;

  try {
    await db.query(
      `INSERT INTO subscribers (phone,street,borough,lat,lng) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (phone) DO UPDATE SET street=EXCLUDED.street, borough=EXCLUDED.borough, lat=EXCLUDED.lat, lng=EXCLUDED.lng, active=true`,
      [e164, streetNorm, boroughNorm, latNum, lngNum]
    );
  } catch (dbErr) {
    console.error("Subscribe DB error:", dbErr.message, { phone: e164, street: streetNorm, borough: boroughNorm });
    return res.status(500).json({ error: `db: ${dbErr.message}` });
  }

  try {
    await twilioClient.messages.create({
      body: `🚗 Street Park Now: Data rates may apply. Your SMS Alert feature is now active! We'll text you before street cleaning, film shoots, and bad weather. Reply STOP to unsubscribe.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: e164,
    });
  } catch (twErr) {
    // Subscriber row is already saved; surface the Twilio-specific failure
    // so the frontend can distinguish it from a total failure.
    console.error("Subscribe Twilio error:", twErr.message, { code: twErr.code, status: twErr.status, to: e164 });
    return res.status(502).json({ error: `sms: ${twErr.message}`, code: twErr.code });
  }

  res.json({ ok: true });
});

// ─── STRIPE CHECKOUT ───────────────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { plan, userId, email } = req.body;
  const PRICES = {
    "basic-monthly":     process.env.STRIPE_PRICE_BASIC_MONTHLY,
    "basic-annual":      process.env.STRIPE_PRICE_BASIC_ANNUAL,
    "premium-monthly":   process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
    "premium-annual":    process.env.STRIPE_PRICE_PREMIUM_ANNUAL,
    "unlimited-monthly": process.env.STRIPE_PRICE_UNLIMITED_MONTHLY,
    "unlimited-annual":  process.env.STRIPE_PRICE_UNLIMITED_ANNUAL,
    // Legacy
    "monthly": process.env.STRIPE_PRICE_BASIC_MONTHLY,
    "annual":  process.env.STRIPE_PRICE_BASIC_ANNUAL,
  };
  const priceId = PRICES[plan];
  if (!priceId) return res.status(400).json({ error: "Invalid plan" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId: userId || "", plan },
      customer_email: email || undefined,
      success_url: `${process.env.FRONTEND_URL}?subscribed=true&plan=${plan}`,
      cancel_url: process.env.FRONTEND_URL,
    });
    res.json({ url: session.url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/webhook", async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { userId, plan } = session.metadata || {};
    const tier = plan?.includes("unlimited") ? "unlimited" : plan?.includes("premium") ? "premium" : "basic";
    if (userId) {
      await db.query(
        `UPDATE users SET tier=$1, stripe_customer_id=$2, stripe_subscription_id=$3, stripe_price_id=$4 WHERE id=$5`,
        [tier, session.customer, session.subscription, plan, userId]
      ).catch(console.error);
    }
    // Also update legacy subscribers table
    await db.query(
      `UPDATE subscribers SET stripe_customer_id=$1, stripe_subscription_id=$2, plan=$3, active=true WHERE phone=$4`,
      [session.customer, session.subscription, tier, session.metadata?.phone || ""]
    ).catch(() => {});
  }

  if (event.type === "customer.subscription.deleted") {
    await db.query(
      `UPDATE users SET tier='free' WHERE stripe_subscription_id=$1`,
      [event.data.object.id]
    ).catch(console.error);
    await db.query("UPDATE subscribers SET active=false WHERE stripe_subscription_id=$1", [event.data.object.id]).catch(console.error);
  }

  res.json({ received: true });
});

// ─── NIGHTLY ALERTS ───────────────────────────────────────────────────────────
async function sendNightlyAlerts() {
  const { rows: subs } = await db.query("SELECT * FROM subscribers WHERE active=true");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
  const tomorrowAbbr = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][tomorrow.getDay()];
  const tomorrowStr = tomorrow.toLocaleDateString("en-US",{ weekday:"long", month:"long", day:"numeric" });
  for (const sub of subs) {
    const msgs = [];
    try {
      const base = `http://localhost:${PORT}`;
      const [cResp,fResp,wxResp] = await Promise.allSettled([
        fetch(`${base}/api/cleaning?street=${encodeURIComponent(sub.street)}&lat=${sub.lat}&lng=${sub.lng}`).then(r=>r.json()),
        fetch(`${base}/api/films?street=${encodeURIComponent(sub.street)}`).then(r=>r.json()),
        fetch(`${base}/api/weather?lat=${sub.lat}&lng=${sub.lng}`).then(r=>r.json()),
      ]);
      const cleaning = cResp.status==="fulfilled" ? cResp.value : [];
      const films = fResp.status==="fulfilled" ? fResp.value : [];
      const wx = wxResp.status==="fulfilled" ? wxResp.value : null;
      const cleanTomorrow = cleaning.find(c=>c.days?.includes(tomorrowAbbr));
      if (cleanTomorrow) msgs.push(`🧹 Street cleaning on ${sub.street} tomorrow${cleanTomorrow.time ? ` from ${cleanTomorrow.time}` : ""}. Move your car!`);
      if (films.length) msgs.push(`🎬 Film shoot near ${sub.street} — parking may be restricted.`);
      const code=wx?.daily?.weather_code?.[1], snow=wx?.daily?.snowfall_sum?.[1], rain=wx?.daily?.precipitation_sum?.[1];
      if ([71,73,75,77,85,86].includes(code)&&snow>0.5) msgs.push(`❄️ Snow tomorrow (${snow.toFixed(1)}"). Move your car early.`);
      else if ([61,63,65,80,81,82].includes(code)&&rain>0.5) msgs.push(`🌧️ Heavy rain tomorrow. Street cleaning may still be enforced.`);
      else if ([95,96,99].includes(code)) msgs.push(`⛈️ Thunderstorms tomorrow. Check parking rules.`);
      if (msgs.length) await twilioClient.messages.create({ body:`Street Park Now — ${tomorrowStr}:\n\n${msgs.join("\n\n")}\n\nReply STOP to cancel.`, from:process.env.TWILIO_PHONE_NUMBER, to:sub.phone });
    } catch (err) { console.error(`Alert failed for ${sub.phone}:`, err.message); }
    await new Promise(r=>setTimeout(r,150));
  }
  console.log(`✅ Alerts done for ${subs.length} subscribers`);
}

cron.schedule("0 20 * * *", sendNightlyAlerts, { timezone: "America/New_York" });
cron.schedule("*/14 * * * *", () => { fetch(`https://${process.env.RENDER_SERVICE_URL||`localhost:${PORT}`}/health`).catch(()=>{}); });
app.post("/admin/trigger-alerts", async (req,res) => { if(req.body.secret!==process.env.ADMIN_SECRET) return res.status(401).json({error:"unauthorized"}); sendNightlyAlerts().catch(console.error); res.json({ok:true}); });

// ─── DB + START ────────────────────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY, phone TEXT NOT NULL UNIQUE, street TEXT NOT NULL,
      borough TEXT DEFAULT '', lat DOUBLE PRECISION, lng DOUBLE PRECISION,
      stripe_customer_id TEXT, stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'trial', trial_ends_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
      active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alert_log (
      id SERIAL PRIMARY KEY, subscriber_id INTEGER REFERENCES subscribers(id),
      message TEXT, sent_at TIMESTAMPTZ DEFAULT NOW(), type TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      apple_id TEXT UNIQUE,
      name TEXT,
      tier TEXT DEFAULT 'free',
      search_count INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS saved_searches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      street TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      borough TEXT,
      neighborhood TEXT,
      city TEXT,
      loc_data JSONB,
      checked BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS recent_searches (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      label TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      loc_data JSONB,
      searched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS heatmap_cache (
      cache_key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Idempotent migration: street was originally NOT NULL. Unlimited-tier
  // subscribers may have no tracked street, so allow NULL.
  await db.query(`ALTER TABLE subscribers ALTER COLUMN street DROP NOT NULL`).catch(() => {});

  // Production subscribers.phone is missing its UNIQUE constraint, which
  // makes `ON CONFLICT (phone) DO UPDATE` in /subscribe fail with
  // "there is no unique or exclusion constraint matching the ON CONFLICT
  // specification". Dedupe any duplicates first (keep the newest row per
  // phone), then add the constraint. Both steps swallow errors so startup
  // never wedges — the logs will show why if a future migration matters.
  await db.query(
    `DELETE FROM subscribers a USING subscribers b WHERE a.id < b.id AND a.phone = b.phone`
  ).catch(e => console.error("Subscribers dedupe failed:", e.message));
  await db.query(
    `ALTER TABLE subscribers ADD CONSTRAINT subscribers_phone_key UNIQUE (phone)`
  ).catch(e => {
    if (!/already exists/i.test(e.message)) {
      console.error("Add UNIQUE on subscribers.phone failed:", e.message);
    }
  });
  console.log("✅ DB ready");
}

initDB().then(() => app.listen(PORT, () => console.log(`🚗 Street Park Now running on port ${PORT}`)));

