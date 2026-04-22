/**
 * Move My Car — Backend
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

// ─── GET REAL STREETS FOR A NEIGHBORHOOD VIA OSM BOUNDARY ───────────────────
async function getNeighborhoodStreets(neighborhoodName, lat, lng) {
  try {
    // Step 1: Find the official neighborhood boundary in OSM by name
    const boundaryQuery = `
      [out:json][timeout:20];
      (
        relation["boundary"="administrative"]["name"~"${neighborhoodName}",i]["admin_level"~"^(8|9|10|11)$"](around:2000,${lat},${lng});
        relation["place"~"^(neighbourhood|quarter|suburb)$"]["name"~"${neighborhoodName}",i](around:2000,${lat},${lng});
      );
      out ids;
    `;
    const br = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(boundaryQuery)}`, {
      headers: { "User-Agent": "MoveMyCar/1.0" }
    });

    let streets = [];

    if (br.ok) {
      const bd = await br.json();
      const relations = bd.elements || [];

      if (relations.length > 0) {
        // Step 2: Get all streets INSIDE the boundary polygon
        const relId = relations[0].id;
        const streetsQuery = `
          [out:json][timeout:25];
          area(id:${3600000000 + relId})->.a;
          way(area.a)["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street|pedestrian|trunk)$"]["name"];
          out tags;
        `;
        const sr = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(streetsQuery)}`, {
          headers: { "User-Agent": "MoveMyCar/1.0" }
        });
        if (sr.ok) {
          const sd = await sr.json();
          streets = [...new Set(
            (sd.elements || []).map(w => w.tags?.name?.toUpperCase()).filter(Boolean)
          )].sort();
          console.log(`OSM boundary for "${neighborhoodName}": ${streets.length} streets`);
        }
      }
    }

    // Fallback: if no boundary found, use a tighter radius
    if (streets.length === 0) {
      console.log(`No OSM boundary for "${neighborhoodName}", using radius fallback`);
      const fallbackQuery = `
        [out:json][timeout:15];
        way(around:600,${lat},${lng})["highway"~"^(residential|secondary|tertiary|primary|unclassified|living_street|pedestrian)$"]["name"];
        out tags;
      `;
      const fr = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(fallbackQuery)}`, {
        headers: { "User-Agent": "MoveMyCar/1.0" }
      });
      if (fr.ok) {
        const fd = await fr.json();
        streets = [...new Set(
          (fd.elements || []).map(w => w.tags?.name?.toUpperCase()).filter(Boolean)
        )].sort();
      }
    }

    return streets;
  } catch(e) {
    console.error("OSM neighborhood streets error:", e.message);
    return [];
  }
}

// ─── SMART GEOCODE ────────────────────────────────────────────────────────────
app.get("/api/geocode", async (req, res) => {
  const { q, userLat, userLng } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;

  // ── STEP 1: If it looks like a full address, go straight to Google ────────
  const looksLikeAddress = /^\d+\s+\w/.test(q.trim());
  if (looksLikeAddress && GOOGLE_KEY) {
    try {
      const stripped = q.replace(/\s*(apt|apartment|unit|suite|ste|fl|floor|#)\s*[\w-]+/gi, "").replace(/\(.*?\)/g, "").trim();
      const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(stripped)}&key=${GOOGLE_KEY}&region=us&components=country:US`;
      const gr = await fetch(gUrl);
      if (gr.ok) {
        const gd = await gr.json();
        if (gd.status === "OK" && gd.results?.length > 0) {
          const result = gd.results[0];
          const loc = result.geometry.location;
          const lat = loc.lat, lng = loc.lng;
          const comps = result.address_components || [];
          const get = (type) => comps.find(c => c.types.includes(type))?.long_name || "";
          const street = (get("route") || q).toUpperCase();
          const neighborhood = get("neighborhood") || get("sublocality_level_2") || "";
          const borough = get("sublocality_level_1") || get("sublocality") || "";
          const city = get("locality") || "";
          const label = result.formatted_address?.split(",").slice(0,2).join(",") || q;

          // Get nearby streets sorted by proximity
          let nearbyStreets = [street];
          try {
            const raw = await askClaude(`Urban geography expert. Coordinates lat=${lat}, lng=${lng} in ${neighborhood || borough || city}. List 12 nearest streets sorted closest to farthest. Primary street: "${street}". Return ONLY a JSON array of street names in ALL CAPS.`, 800);
            const match = raw.match(/\[[\s\S]*\]/);
            if (match) { const parsed = JSON.parse(match[0]); if (Array.isArray(parsed) && parsed.length > 0) nearbyStreets = parsed; }
          } catch(e) {}

          return res.json({ type:"location", isGPS:true, isEstablishment:false, isPark:false, isZip:false, street, borough, neighborhood, city, label, originalQuery:q, lat, lng, nearbyStreets });
        }
      }
    } catch(e) { console.error("Google address geocode error:", e.message); }
  }

  let raw = "";
  try {
    raw = await askClaude(`You are a US urban geography and parking expert covering all major cities. A driver typed: "${q}"

First detect the CITY this refers to. Supported cities: New York City, Los Angeles, Chicago, San Francisco, Boston, Philadelphia, Washington DC, Seattle.
If no city is clear from the query, default to New York City.

Then classify the query using the same types as before.

LOCAL SLANG AND NICKNAMES BY CITY:
NYC: "the city"=Manhattan | "BK"=Brooklyn | "the bronx"=Bronx | "SI"=Staten Island | "LIC"=Long Island City | "UWS"=Upper West Side | "UES"=Upper East Side | "HK" or "Hell's Kitchen"=Clinton | "Noho","Soho","Tribeca","Dumbo","Nolita"=neighborhoods | "the village"=Greenwich Village | "alphabet city"=East Village | "the slope"=Park Slope | "the heights"=Washington Heights or Brooklyn Heights | "Ditmas"=Ditmas Park | "Prospect-Lefferts"=PLG
LA: "WeHo"=West Hollywood | "SaMo"=Santa Monica | "DTLA"=Downtown LA | "the valley"=San Fernando Valley | "Los Feliz"=Los Feliz | "Sil Lake"=Silver Lake | "echo"=Echo Park | "Bev Hills"=Beverly Hills | "Palms"=Palms | "Mar Vista"=Mar Vista | "Culver"=Culver City | "K-town"=Koreatown | "MacArthur Park"=Westlake | "the eastside"=East LA/Boyle Heights
Chicago: "the loop"=Loop | "Wicker"=Wicker Park | "Boystown"=Lakeview East | "the mag mile"=Magnificent Mile | "Pilsen"=Pilsen | "Little Village"=South Lawndale | "Bridgeport"=Bridgeport | "Lincoln Square"=Lincoln Square | "RoNo"=Rogers Park | "Andersonville"=Andersonville | "Uptown"=Uptown | "Humboldt"=Humboldt Park | "Logan"=Logan Square | "Ukrainian Village"=Ukrainian Village | "Noble Square"=Noble Square
SF: "the mish"=Mission District | "the haight"=Haight-Ashbury | "SOMA"=South of Market | "the TL"=Tenderloin | "Noe"=Noe Valley | "the castro"=Castro | "the avenues"=Sunset/Richmond | "the sunset"=Outer Sunset | "inner sunset"=Inner Sunset | "the richmond"=Richmond District | "dogpatch"=Dogpatch | "potrero"=Potrero Hill | "bernal"=Bernal Heights | "glen park"=Glen Park | "excelsior"=Excelsior | "visitacion"=Visitacion Valley | "bayview"=Bayview | "hunters point"=Hunters Point
Boston: "JP"=Jamaica Plain | "Dot"=Dorchester | "Southie"=South Boston | "Eastie"=East Boston | "the north end"=North End | "Allston/Brighton"=Allston | "the fenway"=Fenway | "the back bay"=Back Bay | "beacon hill"=Beacon Hill | "the south end"=South End | "Rozzie"=Roslindale | "West Rox"=West Roxbury | "Hyde Park"=Hyde Park | "Charlestown"=Charlestown | "Camberville"=Cambridge/Somerville
Philadelphia: "Fishtown"=Fishtown | "NoLibs"=Northern Liberties | "Fairmount"=Fairmount | "the Italian market"=South Philly | "Rittenhouse"=Rittenhouse Square | "Old City"=Old City | "Manayunk"=Manayunk | "Kensington"=Kensington | "West Philly"=West Philadelphia | "Mt Airy"=Mount Airy | "Chestnut Hill"=Chestnut Hill | "East Falls"=East Falls | "Roxborough"=Roxborough
DC: "Adams Morgan"=Adams Morgan | "U Street"=U Street Corridor | "H Street"=H Street NE | "the Hill"=Capitol Hill | "Navy Yard"=Navy Yard | "Georgetown"=Georgetown | "Dupont"=Dupont Circle | "Woodley"=Woodley Park | "Columbia Heights"=Columbia Heights | "Petworth"=Petworth | "Shaw"=Shaw | "Logan"=Logan Circle | "NoMa"=North of Massachusetts Ave | "Brookland"=Brookland
Seattle: "Cap Hill"=Capitol Hill | "Fremont"=Fremont | "Ballard"=Ballard | "the CD"=Central District | "SLU"=South Lake Union | "Beacon"=Beacon Hill | "Columbia City"=Columbia City | "Georgetown"=Georgetown | "SODO"=South of Downtown | "Belltown"=Belltown | "Queen Anne"=Queen Anne | "Magnolia"=Magnolia | "Greenlake"=Green Lake | "Wallingford"=Wallingford | "U District"=University District | "Ravenna"=Ravenna

KEY COORDS BY CITY:
NYC: times sq=40.7580,-73.9855 | central park=40.7851,-73.9683 | brooklyn heights=40.6960,-73.9951 | williamsburg=40.7081,-73.9571 | astoria=40.7721,-73.9302 | greenpoint=40.7282,-73.9542 | park slope=40.6681,-73.9800 | lic=40.7447,-73.9485 | harlem=40.8116,-73.9465 | flushing=40.7675,-73.8330 | washington heights=40.8448,-73.9387
LA: dtla=34.0522,-118.2437 | santa monica=34.0195,-118.4912 | west hollywood=34.0900,-118.3617 | silver lake=34.0870,-118.2695 | echo park=34.0780,-118.2606 | los feliz=34.1064,-118.2931 | koreatown=34.0586,-118.3005 | culver city=34.0211,-118.3965 | venice=33.9850,-118.4695 | pasadena=34.1478,-118.1445 | long beach=33.7701,-118.1937
Chicago: loop=41.8827,-87.6233 | wicker park=41.9088,-87.6797 | lincoln park=41.9214,-87.6513 | lakeview=41.9400,-87.6553 | logan square=41.9217,-87.7079 | pilsen=41.8543,-87.6576 | hyde park=41.7943,-87.5907 | andersonville=41.9812,-87.6680 | humboldt park=41.9006,-87.7226 | boystown=41.9436,-87.6490
SF: mission=37.7599,-122.4148 | haight=37.7692,-122.4481 | soma=37.7785,-122.3948 | castro=37.7609,-122.4350 | noe valley=37.7502,-122.4337 | richmond=37.7780,-122.4830 | sunset=37.7525,-122.4875 | bernal heights=37.7390,-122.4153 | dogpatch=37.7596,-122.3902 | potrero hill=37.7590,-122.4014
Boston: back bay=42.3503,-71.0810 | south end=42.3398,-71.0746 | beacon hill=42.3588,-71.0707 | cambridge=42.3736,-71.1097 | jamaica plain=42.3100,-71.1128 | dorchester=42.3014,-71.0641 | south boston=42.3388,-71.0447 | charlestown=42.3782,-71.0602 | allston=42.3540,-71.1323 | fenway=42.3467,-71.0972
Philadelphia: center city=39.9526,-75.1652 | fishtown=39.9748,-75.1338 | northern liberties=39.9637,-75.1416 | south philly=39.9186,-75.1687 | west philly=39.9484,-75.2182 | manayunk=40.0278,-75.2266 | germantown=40.0359,-75.1724 | fairmount=39.9685,-75.1768 | rittenhouse=39.9496,-75.1727
DC: georgetown=38.9076,-77.0723 | dupont=38.9096,-77.0434 | adams morgan=38.9211,-77.0419 | capitol hill=38.8897,-77.0038 | u street=38.9177,-77.0319 | columbia heights=38.9284,-77.0317 | navy yard=38.8762,-77.0053 | shaw=38.9122,-77.0231 | brookland=38.9344,-76.9941 | petworth=38.9394,-77.0269
Seattle: capitol hill=47.6253,-122.3222 | fremont=47.6510,-122.3500 | ballard=47.6685,-122.3829 | belltown=47.6148,-122.3468 | queen anne=47.6373,-122.3565 | slu=47.6261,-122.3353 | central district=47.6062,-122.3014 | beacon hill=47.5693,-122.3070 | georgetown=47.5485,-122.3237 | u district=47.6614,-122.3152

Return the same JSON format as before but include a "city" field in every response.
For NEIGHBORHOOD type include the city in the label e.g. "Wicker Park, Chicago".
For LOCATION type include city and state e.g. "Silver Lake, Los Angeles".

AMBIGUOUS EXAMPLES (cross-city):
- "lincoln park" → ambiguous: neighborhood Chicago + park NYC
- "georgetown" → ambiguous: neighborhood DC + neighborhood Seattle
- "mission" → ambiguous: neighborhood SF (Mission District) + could be other cities

NEIGHBORHOOD EXAMPLES — ALWAYS return as neighborhood type with ALL streets listed in neighborhoodStreets:
- "west village" → neighborhood Manhattan: BANK ST, BARROW ST, BEDFORD ST, BETHUNE ST, CHARLES ST, CHRISTOPHER ST, CLARKSON ST, COMMERCE ST, CORNELIA ST, GROVE ST, HORATIO ST, HUDSON ST, JANE ST, LEROY ST, MORTON ST, PERRY ST, TENTH AVENUE, WASHINGTON ST, WEST 10 STREET, WEST 11 STREET, WEST 12 STREET, WEST 4 STREET, WEST STREET
- "east village" → neighborhood Manhattan with all streets
- "brooklyn heights" → neighborhood Brooklyn with all streets
- "park slope" → neighborhood Brooklyn with all streets
- "upper west side" → neighborhood Manhattan with all streets
- "hell's kitchen" → neighborhood Manhattan with all streets
- "greenwich village" → neighborhood Manhattan with all streets
- "soho" → neighborhood Manhattan with all streets
- "tribeca" → neighborhood Manhattan with all streets
- "dumbo" → neighborhood Brooklyn with all streets
- "williamsburg" → neighborhood Brooklyn with all streets
- "bushwick" → neighborhood Brooklyn with all streets
- "wicker park" → neighborhood Chicago with all streets
- "logan square" → neighborhood Chicago with all streets
- "silver lake" → neighborhood LA with all streets
- "echo park" → neighborhood LA with all streets
- "mission district" → neighborhood SF with all streets
- "haight ashbury" → neighborhood SF with all streets
- "capitol hill" → neighborhood Seattle with all streets
- "adams morgan" → neighborhood DC with all streets
- "south end" → neighborhood Boston with all streets
- "fishtown" → neighborhood Philadelphia with all streets
- "northern liberties" → neighborhood Philadelphia with all streets

LOCATION EXAMPLES (landmarks/plazas/squares — return as location type with coords):
- "court square" → location in LIC Queens, lat=40.7472, lng=-73.9454
- "times square" → location Manhattan, lat=40.7580, lng=-73.9855
- "union square" → location Manhattan OR SF depending on context
- "the met" → establishment (Metropolitan Museum) on 5th Ave Manhattan
- "wrigley field" → establishment in Chicago
- "grand army plaza" → location Brooklyn, lat=40.6742, lng=-73.9700

Return ONLY the JSON, no markdown.`, 3000);

    const loc = JSON.parse(raw.replace(/```json|```/g,"").trim());

    if (loc.type === "ambiguous") return res.json({ ...loc, originalQuery: q });

    // Neighborhood — get real streets from OpenStreetMap
    if (loc.type === "neighborhood" || loc.isNeighborhood) {
      const streets = await getNeighborhoodStreets(q, loc.lat, loc.lng);
      console.log(`Neighborhood "${q}": ${streets.length} streets from OSM`);
      return res.json({ ...loc, isNeighborhood: true, isZip: false, isPark: false, isEstablishment: false, zipStreets: streets, originalQuery: q });
    }

    // If Claude returned a location but it's a well-known neighborhood name, treat as neighborhood
    if (loc.type === "location" && loc.lat) {
      const neighborhoodKeywords = /village|heights|slope|park|hill|garden|square|place|town|side|point|field|wood|grove|bridge|haven|beach|bay|harbor|quarter|district|corridor|triangle|oval|circle|loop|row|mish|haight|dumbo|soho|tribeca|noho|nolita|bushwick|williamsburg|astoria|flushing|sunnyside/i;
      const isLikelyNeighborhood = neighborhoodKeywords.test(q) && !q.match(/^\d+/) && !q.includes("&") && q.split(" ").length <= 4;
      if (isLikelyNeighborhood) {
        console.log(`Treating "${q}" as neighborhood, fetching OSM streets`);
        const streets = await getNeighborhoodStreets(q, loc.lat, loc.lng);
        if (streets.length > 0) {
          return res.json({ ...loc, isNeighborhood: true, isZip: false, isPark: false, isEstablishment: false, zipStreets: streets, originalQuery: q });
        }
      }
    }

    if (loc.isEstablishment && loc.establishments?.length > 0 && userLat && userLng) {
      const uLat = parseFloat(userLat), uLng = parseFloat(userLng);
      loc.establishments.sort((a,b) => haversineKm(uLat,uLng,a.lat,a.lng) - haversineKm(uLat,uLng,b.lat,b.lng));
    }

    // For single locations (landmarks, plazas, intersections), return nearby streets
    if (!loc.isEstablishment && !loc.isPark && !loc.isZip && loc.lat && loc.lng) {
      try {
        const raw = await askClaude(`You are an urban geography expert. Given coordinates lat=${loc.lat}, lng=${loc.lng} near "${q}" (${loc.neighborhood || loc.borough || loc.city || ""}), list the 12 nearest streets sorted closest to farthest. The primary street is "${loc.street}".

Return ONLY a JSON array of street names in ALL CAPS. Include cross streets and parallel streets within a 6-block radius.
Return ONLY the array.`, 1000);
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return res.json({ ...loc, isGPS: true, nearbyStreets: parsed, originalQuery: q });
          }
        }
      } catch(e) { console.error("Nearby streets for location error:", e.message); }
    }

    if (loc.isEstablishment || loc.isPark || loc.isZip || loc.lat) {
      return res.json({ ...loc, originalQuery: q });
    }
  } catch (e) { console.error("Claude geocode error:", e.message); }

  // Google Geocoding API — handles landmarks, abbreviations, full addresses, neighborhoods
  try {
    let stripped = q
      .replace(/\s*(apt|apartment|unit|suite|ste|fl|floor|#)\s*[\w-]+/gi, "")
      .replace(/\(.*?\)/g, "")
      .trim();

    const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;
    const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(stripped)}&key=${GOOGLE_KEY}&region=us&components=country:US`;
    const gr = await fetch(gUrl);
    if (gr.ok) {
      const gd = await gr.json();
      if (gd.status === "OK" && gd.results?.length > 0) {
        const result = gd.results[0];
        const loc = result.geometry.location;
        const lat = loc.lat, lng = loc.lng;
        const comps = result.address_components || [];
        const get = (type) => comps.find(c => c.types.includes(type))?.long_name || "";
        const street = (get("route") || q).toUpperCase();
        const streetNum = get("street_number");
        const neighborhood = get("neighborhood") || get("sublocality_level_2") || "";
        const borough = get("sublocality_level_1") || get("sublocality") || "";
        const city = get("locality") || "";
        const label = result.formatted_address?.split(",").slice(0,2).join(",") || q;

        // If it's a street address, return surrounding streets sorted by proximity
        const isAddress = /^\d+\s+\w/.test(stripped.trim()) || !!streetNum;
        if (isAddress) {
          let nearbyStreets = [street];
          try {
            const raw = await askClaude(`You are an urban geography expert. Given coordinates lat=${lat}, lng=${lng} in ${neighborhood || borough || city}, list the 12 nearest streets sorted closest to farthest. The primary street is "${street}".

Return ONLY a JSON array of street names in ALL CAPS. Include cross streets and parallel streets within a 6-block radius.
Return ONLY the array.`, 1000);
            const match = raw.match(/\[[\s\S]*\]/);
            if (match) {
              const parsed = JSON.parse(match[0]);
              if (Array.isArray(parsed) && parsed.length > 0) nearbyStreets = parsed;
            }
          } catch(e) { console.error("Nearby streets error:", e.message); }

          return res.json({
            type: "location", isGPS: true, isEstablishment: false, isPark: false, isZip: false,
            street, borough, neighborhood, city, label, originalQuery: q, lat, lng, nearbyStreets,
          });
        }

        return res.json({ type:"location", isEstablishment:false, isPark:false, isZip:false, street, borough, neighborhood, city, label, originalQuery:q, lat, lng });
      }
    }
  } catch (e) { console.error("Google geocode error:", e.message); }

  res.status(404).json({ error: `Couldn't find "${q}". Try a street name, zip code, or neighborhood in NYC, LA, Chicago, SF, Boston, Philadelphia, DC, or Seattle.` });
});

// Reverse geocode — uses Google for accuracy, returns nearby streets sorted by distance
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  let primaryStreet = "", borough = "", neighborhood = "", label = "", city = "";

  try {
    const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data.status === "OK" && data.results?.length > 0) {
        const result = data.results[0];
        const comps = result.address_components || [];
        const get = (type) => comps.find(c => c.types.includes(type))?.long_name || "";
        primaryStreet = get("route").toUpperCase();
        borough       = get("sublocality_level_1") || get("sublocality") || "";
        neighborhood  = get("neighborhood") || get("sublocality_level_2") || "";
        city          = get("locality") || "";
        label         = result.formatted_address?.split(",").slice(0,2).join(",") || "";
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

  try {
    const text = await askClaude(`You are a US alternate side parking expert covering NYC, LA, Chicago, SF, Boston, Philadelphia, DC, and Seattle. Return cleaning schedules for ALL these streets ${locationCtx}:

${streets.map((s, i) => `${i+1}. ${s}`).join("\n")}

Determine the city from coordinates or context, then return accurate schedules.
Return ONLY a JSON object where each key is the EXACT street name and value is an array of schedules.
If unknown use [].

{"BEDFORD AVENUE": [{"days":["Mon","Thu"],"time":"8 AM - 9:30 AM","side":"","raw":"NO PARKING 8AM-9:30AM MON & THUR"}], "BERRY STREET": []}

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
    await twilioClient.messages.create({ body:`🚗 Move My Car activated for ${street}! We'll text you before street cleaning, film shoots, and bad weather. Reply STOP to cancel.`, from:process.env.TWILIO_PHONE_NUMBER, to:e164 });
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
      if (msgs.length) await twilioClient.messages.create({ body:`Move My Car — ${tomorrowStr}:\n\n${msgs.join("\n\n")}\n\nReply STOP to cancel.`, from:process.env.TWILIO_PHONE_NUMBER, to:sub.phone });
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

initDB().then(() => app.listen(PORT, () => console.log(`🚗 Move My Car running on port ${PORT}`)));
