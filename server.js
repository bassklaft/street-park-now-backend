/**
 * Street Park Info — Backend
 * Claude-powered NYC parking intelligence
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const cron    = require("node-cron");
const { Pool }  = require("pg");
const Stripe    = require("stripe");
const twilio    = require("twilio");

const app  = express();
const PORT = process.env.PORT || 3001;

const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db           = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
      model: "claude-opus-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}`);
  const d = await r.json();
  return d.content?.[0]?.text || "";
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
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

// ─── SMART GEOCODE ────────────────────────────────────────────────────────────
app.get("/api/geocode", async (req, res) => {
  const { q, userLat, userLng } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  let raw = "";
  try {
    raw = await askClaude(`You are an NYC geography and parking expert. A driver typed: "${q}"

First decide: is this AMBIGUOUS? (could refer to multiple different things in NYC)
Then decide: is this a NEIGHBORHOOD? (a named NYC neighborhood with multiple streets)

If AMBIGUOUS (could be neighborhood AND street AND/OR landmark):
{
  "type": "ambiguous",
  "label": "Greenpoint",
  "options": [
    { "category": "Neighborhood", "label": "Greenpoint, Brooklyn", "type": "neighborhood", "street": "MANHATTAN AVENUE", "borough": "Brooklyn", "neighborhood": "Greenpoint", "lat": 40.7282, "lng": -73.9542, "neighborhoodStreets": ["ASH STREET","BOX STREET","CALYER STREET","EAGLE STREET","FREEMAN STREET","GREENPOINT AVENUE","HURON STREET","INDIA STREET","JAVA STREET","KENT STREET","LORIMER STREET","MANHATTAN AVENUE","MESEROLE AVENUE","MONITOR STREET","NASSAU AVENUE","NEWEL STREET","NORMAN AVENUE","PROVOST STREET","RICHARDSON STREET","RUSSELL STREET","VAN DAM STREET"] },
    { "category": "Street", "label": "Greenpoint Ave, Brooklyn", "type": "location", "street": "GREENPOINT AVENUE", "borough": "Brooklyn", "neighborhood": "Greenpoint", "lat": 40.7270, "lng": -73.9490 },
    { "category": "Street", "label": "Greenpoint Ave, Queens", "type": "location", "street": "GREENPOINT AVENUE", "borough": "Queens", "neighborhood": "Sunnyside", "lat": 40.7447, "lng": -73.9165 }
  ]
}

If NEIGHBORHOOD (clearly a specific NYC neighborhood, not ambiguous):
{
  "type": "neighborhood",
  "label": "Brooklyn Heights, Brooklyn",
  "isNeighborhood": true,
  "street": "BROOKLYN HEIGHTS PROMENADE",
  "borough": "Brooklyn",
  "neighborhood": "Brooklyn Heights",
  "lat": 40.6960,
  "lng": -73.9951,
  "neighborhoodStreets": ["ATLANTIC AVENUE","BROOKLYN HEIGHTS PROMENADE","CLARK STREET","COLUMBIA HEIGHTS","CRANBERRY STREET","GRACE COURT","HENRY STREET","HICKS STREET","JORALEMON STREET","LOVE LANE","MIDDAGH STREET","MONTAGUE STREET","ORANGE STREET","PIERREPONT STREET","PINEAPPLE STREET","POPLAR STREET","REMSEN STREET","VINE STREET","WILLOW STREET","WILLOW PLACE"]
}
neighborhoodStreets must be ALL streets in the neighborhood, sorted alphabetically.

If ESTABLISHMENT: { "type": "establishment", "label": "McDonald's NYC", "isEstablishment": true, "establishments": [{ "name": "McDonald's Times Square", "street": "WEST 42 STREET", "borough": "Manhattan", "neighborhood": "Midtown", "address": "220 W 42nd St", "lat": 40.7580, "lng": -73.9855 }] }

If PARK: { "type": "park", "label": "Central Park", "isPark": true, "street": "CENTRAL PARK WEST", "borough": "Manhattan", "neighborhood": "Upper West Side", "lat": 40.7851, "lng": -73.9683, "parkStreets": ["CENTRAL PARK WEST","FIFTH AVENUE","CENTRAL PARK NORTH","CENTRAL PARK SOUTH"] }

If ZIP: { "type": "zip", "label": "11211 Williamsburg", "isZip": true, "street": "BEDFORD AVENUE", "borough": "Brooklyn", "neighborhood": "Williamsburg", "lat": 40.7081, "lng": -73.9571, "zipStreets": ["BEDFORD AVENUE","BERRY STREET","WYTHE AVENUE","NORTH 6 STREET","METROPOLITAN AVENUE","GRAND STREET","UNION AVENUE"] }

If specific LOCATION (intersection/address/landmark, not a neighborhood): { "type": "location", "street": "NINTH AVENUE", "borough": "Manhattan", "neighborhood": "Hell's Kitchen", "label": "Hell's Kitchen", "lat": 40.7638, "lng": -73.9918 }

AMBIGUOUS EXAMPLES:
- "greenpoint" → ambiguous: neighborhood BK + street BK + street Queens
- "astoria" → ambiguous: neighborhood Queens + street Astoria Blvd Queens
- "atlantic" → ambiguous: Atlantic Avenue BK (street) + Atlantic Terminal BK (landmark)
- "chelsea" → ambiguous: neighborhood Manhattan + Chelsea Piers + Chelsea Market

NEIGHBORHOOD EXAMPLES (not ambiguous):
- "brooklyn heights" → neighborhood type with all its streets
- "park slope" → neighborhood type with all its streets
- "upper west side" → neighborhood type with all its streets
- "hell's kitchen" → neighborhood type with all its streets
- "greenwich village" → neighborhood type with all its streets
- "flushing" → neighborhood type with all its streets

KEY COORDS: intrepid=40.7648,-74.0079 | times sq=40.7580,-73.9855 | uws=40.7870,-73.9754 | ues=40.7736,-73.9566 | msg=40.7505,-73.9934 | central park=40.7851,-73.9683 | prospect park=40.6602,-73.9690 | west village=40.7339,-74.0042 | east village=40.7265,-73.9815 | soho=40.7233,-74.0030 | dumbo=40.7033,-73.9881 | williamsburg=40.7081,-73.9571 | lic=40.7447,-73.9485 | brooklyn heights=40.6960,-73.9951 | park slope=40.6681,-73.9800 | greenpoint=40.7282,-73.9542 | astoria=40.7721,-73.9302

ZIP STREETS: 10001=[WEST 34 STREET,SEVENTH AVENUE,EIGHTH AVENUE,NINTH AVENUE,TENTH AVENUE] | 10014=[HUDSON STREET,BLEECKER STREET,CHRISTOPHER STREET,WEST 4 STREET] | 10023=[BROADWAY,AMSTERDAM AVENUE,COLUMBUS AVENUE,WEST END AVENUE,RIVERSIDE DRIVE] | 10036=[WEST 42 STREET,EIGHTH AVENUE,NINTH AVENUE,TENTH AVENUE,ELEVENTH AVENUE] | 11211=[BEDFORD AVENUE,BERRY STREET,WYTHE AVENUE,NORTH 6 STREET,METROPOLITAN AVENUE,GRAND STREET] | 11215=[FIFTH AVENUE,SEVENTH AVENUE,FLATBUSH AVENUE,PROSPECT PARK WEST,UNION STREET] | 11101=[JACKSON AVENUE,QUEENS BOULEVARD,NORTHERN BOULEVARD,THOMSON AVENUE,HUNTER STREET]

Return ONLY the JSON, no markdown.`, 3000);

    const loc = JSON.parse(raw.replace(/```json|```/g,"").trim());

    if (loc.type === "ambiguous") return res.json({ ...loc, originalQuery: q });

    // Neighborhood — treat like zip but with neighborhoodStreets
    if (loc.type === "neighborhood" || loc.isNeighborhood) {
      const streets = (loc.neighborhoodStreets || loc.zipStreets || []).sort();
      console.log(`Neighborhood "${q}": ${streets.length} streets`);
      if (streets.length === 0) {
        // Claude didn't return streets — ask again specifically for streets
        try {
          const streetsRaw = await askClaude(`List ALL streets in the ${q} neighborhood of NYC. Return ONLY a JSON array of street names in ALL CAPS, alphabetically sorted. Example: ["ATLANTIC AVENUE","CLINTON STREET","COURT STREET"]. Return ONLY the array.`, 1500);
          const match = streetsRaw.match(/\[[\s\S]*\]/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
              return res.json({ ...loc, isNeighborhood: true, isZip: false, isPark: false, isEstablishment: false, zipStreets: parsed.sort(), originalQuery: q });
            }
          }
        } catch(e) { console.error("Neighborhood streets retry error:", e.message); }
      }
      return res.json({ ...loc, isNeighborhood: true, isZip: false, isPark: false, isEstablishment: false, zipStreets: streets, originalQuery: q });
    }

    if (loc.isEstablishment && loc.establishments?.length > 0 && userLat && userLng) {
      const uLat = parseFloat(userLat), uLng = parseFloat(userLng);
      loc.establishments.sort((a,b) => haversineKm(uLat,uLng,a.lat,a.lng) - haversineKm(uLat,uLng,b.lat,b.lng));
    }

    if (loc.isEstablishment || loc.isPark || loc.isZip || loc.lat) {
      return res.json({ ...loc, originalQuery: q });
    }
  } catch (e) { console.error("Claude geocode error:", e.message); }

  // Nominatim fallback
  try {
    const withCity = /new york|nyc|brooklyn|manhattan|bronx|queens|staten island/i.test(q) ? q : `${q}, New York City NY`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(withCity)}&format=json&limit=1&addressdetails=1&countrycodes=us&viewbox=-74.2591,40.4774,-73.7004,40.9176&bounded=1`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (r.ok) {
      const data = await r.json();
      if (data.length > 0) {
        const item = data[0], addr = item.address || {};
        return res.json({ type:"location", isEstablishment:false, isPark:false, isZip:false, street:(addr.road||addr.pedestrian||addr.suburb||q).toUpperCase(), borough:addr.borough||addr.city_district||addr.suburb||"", neighborhood:addr.neighbourhood||addr.suburb||"", label:q, originalQuery:q, lat:parseFloat(item.lat), lng:parseFloat(item.lon) });
      }
    }
  } catch (e) { console.error("Nominatim error:", e.message); }

  res.status(404).json({ error: `Couldn't find "${q}" in NYC. Try "34th & Broadway", "10036", or "Brooklyn Heights".` });
});

// Reverse geocode — also returns nearby streets sorted by distance
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  let primaryStreet = "", borough = "", neighborhood = "", label = "";

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (r.ok) {
      const item = await r.json(), addr = item.address || {};
      primaryStreet = (addr.road || addr.pedestrian || addr.footway || "").toUpperCase();
      borough      = addr.borough || addr.city_district || addr.suburb || "";
      neighborhood = addr.neighbourhood || addr.suburb || "";
      label        = item.display_name?.split(",").slice(0,2).join(",") || "";
    }
  } catch (e) { console.error("Reverse geocode error:", e.message); }

  if (!primaryStreet) return res.status(502).json({ error: "Could not identify your street" });

  // Get nearby streets sorted by distance using Nominatim search in bounding box
  let nearbyStreets = [];
  try {
    const raw = await askClaude(`You are an NYC geography expert. Given these coordinates: lat ${lat}, lng ${lng} (${neighborhood}, ${borough}), list the 8 nearest streets to this location, sorted from closest to farthest. The primary street is "${primaryStreet}".

Return ONLY a JSON array of street names in ALL CAPS. Start with the primary street, then the nearest cross streets and parallel streets.
Example: ["WEST 46 STREET","ELEVENTH AVENUE","WEST 45 STREET","WEST 47 STREET","TWELFTH AVENUE","TENTH AVENUE","WEST 44 STREET","WEST 48 STREET"]

Return ONLY the JSON array.`);
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

  return res.json({
    street: primaryStreet,
    borough, neighborhood, label,
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
    const locationCtx = lat && lng ? `at approximately ${lat}, ${lng}` : `in ${borough || "NYC"}`;
    const text = await askClaude(`You are an NYC alternate side parking expert. Return ONLY a raw JSON array, no other text.

Street: "${street}" ${locationCtx}

Rules:
- Return a JSON array of cleaning schedules
- If unknown, return exactly: []
- Do NOT write any explanation, preamble, or prose
- Do NOT use markdown code blocks
- Start your response with [ and end with ]

Each item in the array must be exactly this shape:
{"days":["Mon","Thu"],"time":"8 AM - 9:30 AM","side":"Left / Even side","raw":"NO PARKING 8AM-9:30AM MON & THUR"}

Common NYC patterns:
- Most Manhattan streets: Mon+Thu OR Tue+Fri, 8-9:30AM or 8:30-10AM or 11:30AM-1PM
- Include both sides if different days
- side is "Left / Even side" or "Right / Odd side" or ""

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
  const locationCtx = lat && lng ? `near lat ${lat}, lng ${lng}` : `in ${borough || "NYC"}`;

  try {
    const text = await askClaude(`You are an NYC alternate side parking expert. Return cleaning schedules for ALL these streets ${locationCtx}:

${streets.map((s, i) => `${i+1}. ${s}`).join("\n")}

Return ONLY a JSON object where each key is the EXACT street name and value is an array of schedules.
If you don't know a street's schedule, use an empty array [].

{"ATLANTIC AVENUE": [{"days":["Mon","Thu"],"time":"8 AM - 9:30 AM","side":"","raw":"NO PARKING 8AM-9:30AM MON & THUR"}], "HICKS STREET": [], ...}

Return ONLY the JSON object starting with {:`, 3000);

    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const data = JSON.parse(match[0]);
      // Add upcoming dates to each result
      const result = {};
      for (const [street, schedules] of Object.entries(data)) {
        result[street] = (schedules || []).map(s => ({ ...s, upcomingDates: getUpcomingDates(s.days || []) }));
      }
      return res.json(result);
    }
  } catch(e) { console.error("Batch cleaning error:", e.message); }

  res.json({});
});
// ─── PARKING HEAT MAP — real street geometries from OpenStreetMap ─────────────
app.get("/api/heatmap", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json([]);

  try {
    // Step 1: Get real street geometries from Overpass API
    const overpassQuery = `[out:json][timeout:15];way(around:400,${lat},${lng})["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street)$"]["name"];out geom;`;
    const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    const ways = (data.elements || []).filter(w => w.tags?.name && w.geometry?.length > 1);

    // Step 2: Get unique street names
    const streetNames = [...new Set(ways.map(w => w.tags.name.toUpperCase()))].slice(0, 20);
    if (!streetNames.length) return res.json([]);

    // Step 3: One Claude call for all schedules
    const schedulesRaw = await askClaude(`NYC alternate side parking schedules near lat=${lat}, lng=${lng}.

Streets:
${streetNames.map((s,i) => `${i+1}. ${s}`).join("\n")}

Return ONLY a JSON object. Key = street name in CAPS, value = array of schedules (empty array if unknown).
{"BEDFORD AVENUE":[{"days":["Mon","Thu"],"time":"8 AM - 9:30 AM"}],"BERRY STREET":[]}
Return ONLY the JSON object:`, 2000);

    let schedules = {};
    try { const m = schedulesRaw.match(/\{[\s\S]*\}/); if (m) schedules = JSON.parse(m[0]); } catch(e) {}

    const today    = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()];
    const tomorrow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+86400000).getDay()];
    const in2days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+172800000).getDay()];
    const in3days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(Date.now()+259200000).getDay()];

    // Step 4: Merge real geometry with schedule urgency — keep ALL segments
    const result = ways.map(w => {
        const name = w.tags.name.toUpperCase();
        const sch = schedules[name] || [];
        const coords = w.geometry.map(p => [p.lat, p.lon]);
        let urgency = sch.length ? "green" : "gray";
        let nextClean = null;
        for (const s of sch) {
          const days = s.days || [];
          if (days.includes(today))    { urgency = "red";    nextClean = `Today ${s.time||""}`.trim(); break; }
          if (days.includes(tomorrow)) { urgency = "red";    nextClean = `Tomorrow ${s.time||""}`.trim(); break; }
          if (days.includes(in2days) || days.includes(in3days)) {
            if (urgency !== "red") { urgency = "yellow"; nextClean = `In 2-3 days ${s.time||""}`.trim(); }
          }
        }
        return { street: name, coords, urgency, nextClean };
      });

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
  const { borough } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const toDate = new Date(); toDate.setDate(toDate.getDate()+14);
  try {
    const bf = borough ? `%20AND%20upper(borough)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'` : "";
    const url = `${SOCRATA}/tvpp-9vvx.json?$where=startdate%20>=%20'${today}'%20AND%20startdate%20<=%20'${toDate.toISOString().split("T")[0]}'${bf}&$limit=15&$order=startdate%20ASC`;
    const r = await fetch(url);
    if (!r.ok) return res.json([]);
    res.json((await r.json()).map(ev => ({ name:ev.eventname||ev.name||"City Event", type:ev.eventtype||"Event", start:ev.startdate, location:ev.eventlocation||"", borough:ev.borough||"", parkingImpacted:!!(ev.parkingimpacted) })));
  } catch { res.json([]); }
});

// ─── WEATHER ──────────────────────────────────────────────────────────────────
app.get("/api/weather", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json(null);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,precipitation_sum,snowfall_sum&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=3&timezone=America%2FNew_York`;
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

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  const { phone, street, borough, lat, lng } = req.body;
  if (!phone || !street) return res.status(400).json({ error: "phone and street required" });
  const digits = phone.replace(/\D/g,"");
  const e164 = digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
  try {
    await db.query(`INSERT INTO subscribers (phone,street,borough,lat,lng) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (phone) DO UPDATE SET street=$2,borough=$3,lat=$4,lng=$5,active=true`, [e164,street.toUpperCase(),borough||"",lat||null,lng||null]);
    await twilioClient.messages.create({ body:`🚗 Street Park Info activated for ${street}! We'll text you before street cleaning, film shoots, and bad weather. Reply STOP to cancel.`, from:process.env.TWILIO_PHONE_NUMBER, to:e164 });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── STRIPE ───────────────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { plan, phone, street } = req.body;
  const priceId = plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
  try {
    const session = await stripe.checkout.sessions.create({ payment_method_types:["card"], mode:"subscription", line_items:[{ price:priceId, quantity:1 }], metadata:{ phone, street }, success_url:`${process.env.FRONTEND_URL}?subscribed=true`, cancel_url:process.env.FRONTEND_URL, subscription_data:{ trial_period_days:30 } });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/webhook", async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === "checkout.session.completed") {
    await db.query(`UPDATE subscribers SET stripe_customer_id=$1,stripe_subscription_id=$2,plan=$3,active=true WHERE phone=$4`, [event.data.object.customer,event.data.object.subscription,event.data.object.amount_total<500?"monthly":"annual",event.data.object.metadata.phone]).catch(console.error);
  }
  if (event.type === "customer.subscription.deleted") {
    await db.query("UPDATE subscribers SET active=false WHERE stripe_subscription_id=$1",[event.data.object.id]).catch(console.error);
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
      if (msgs.length) await twilioClient.messages.create({ body:`Street Park Info — ${tomorrowStr}:\n\n${msgs.join("\n\n")}\n\nReply STOP to cancel.`, from:process.env.TWILIO_PHONE_NUMBER, to:sub.phone });
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
  `);
  console.log("✅ DB ready");
}

initDB().then(() => app.listen(PORT, () => console.log(`🚗 Street Park Info running on port ${PORT}`)));
