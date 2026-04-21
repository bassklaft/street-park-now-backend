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

First decide: is this AMBIGUOUS? A query is ambiguous if it could refer to multiple different things in NYC — e.g. "Greenpoint" could be the neighborhood OR Greenpoint Avenue. "Astoria" could be the neighborhood OR Astoria Boulevard. "Atlantic" could be Atlantic Avenue OR Atlantic Terminal area.

If AMBIGUOUS, return:
{
  "type": "ambiguous",
  "label": "Greenpoint",
  "options": [
    { "category": "Neighborhood", "label": "Greenpoint, Brooklyn", "type": "location", "street": "MANHATTAN AVENUE", "borough": "Brooklyn", "neighborhood": "Greenpoint", "lat": 40.7282, "lng": -73.9542 },
    { "category": "Street", "label": "Greenpoint Ave, Queens", "type": "location", "street": "GREENPOINT AVENUE", "borough": "Queens", "neighborhood": "Sunnyside", "lat": 40.7447, "lng": -73.9165 }
  ]
}

Otherwise classify as: establishment | park | zip | location

If ESTABLISHMENT (business/chain - e.g. "McDonald's", "CVS", "Starbucks"):
{ "type": "establishment", "label": "McDonald's NYC locations", "isEstablishment": true, "establishments": [{ "name": "McDonald's Times Square", "street": "WEST 42 STREET", "borough": "Manhattan", "neighborhood": "Midtown", "address": "220 W 42nd St", "lat": 40.7580, "lng": -73.9855 }] }
List ALL known NYC locations (8-15+ for major chains).

If PARK:
{ "type": "park", "label": "Central Park", "isPark": true, "isEstablishment": false, "street": "CENTRAL PARK WEST", "borough": "Manhattan", "neighborhood": "Upper West Side", "lat": 40.7851, "lng": -73.9683, "parkStreets": ["CENTRAL PARK WEST","FIFTH AVENUE","CENTRAL PARK NORTH","CENTRAL PARK SOUTH"] }

If ZIP CODE:
{ "type": "zip", "label": "11211 Williamsburg", "isZip": true, "isEstablishment": false, "street": "BEDFORD AVENUE", "borough": "Brooklyn", "neighborhood": "Williamsburg", "lat": 40.7081, "lng": -73.9571, "zipStreets": ["BEDFORD AVENUE","BERRY STREET","WYTHE AVENUE","NORTH 6 STREET","METROPOLITAN AVENUE","GRAND STREET","UNION AVENUE"] }

If LOCATION (specific intersection/landmark/address with no ambiguity):
{ "type": "location", "label": "Hell's Kitchen", "isEstablishment": false, "isPark": false, "isZip": false, "street": "NINTH AVENUE", "borough": "Manhattan", "neighborhood": "Hell's Kitchen", "lat": 40.7638, "lng": -73.9918 }

AMBIGUOUS EXAMPLES:
- "greenpoint" → 3 options: neighborhood Greenpoint Brooklyn + street Greenpoint Avenue Brooklyn + street Greenpoint Avenue Queens
- "astoria" → neighborhood Astoria Queens + street Astoria Boulevard Queens
- "atlantic" → Atlantic Avenue Brooklyn (street) + Atlantic Terminal Brooklyn (landmark)
- "chelsea" → neighborhood Chelsea Manhattan + Chelsea Piers Manhattan (landmark) + Chelsea Market Manhattan (landmark)
- "park slope" → NOT ambiguous (clearly a neighborhood)
- "broadway" → NOT ambiguous (clearly the street)
- "34th and broadway" → NOT ambiguous (clearly an intersection)

IMPORTANT: If a name is both a neighborhood AND a street in the same borough, include BOTH as separate options.

KEY COORDS: intrepid=40.7648,-74.0079 | times sq=40.7580,-73.9855 | uws=40.7870,-73.9754 | ues=40.7736,-73.9566 | msg=40.7505,-73.9934 | high line=40.7480,-74.0048 | hudson yards=40.7539,-74.0005 | yankee stadium=40.8296,-73.9262 | barclays=40.6826,-73.9754 | 34th+broadway=40.7505,-73.9895 | central park=40.7851,-73.9683 | prospect park=40.6602,-73.9690 | west village=40.7339,-74.0042 | east village=40.7265,-73.9815 | soho=40.7233,-74.0030 | dumbo=40.7033,-73.9881 | williamsburg=40.7081,-73.9571 | lic=40.7447,-73.9485 | greenpoint=40.7282,-73.9542 | astoria neighborhood=40.7721,-73.9302

ZIP STREETS: 10001=[WEST 34 STREET,SEVENTH AVENUE,EIGHTH AVENUE,NINTH AVENUE,TENTH AVENUE] | 10014=[HUDSON STREET,BLEECKER STREET,CHRISTOPHER STREET,WEST 4 STREET] | 10023=[BROADWAY,AMSTERDAM AVENUE,COLUMBUS AVENUE,WEST END AVENUE,RIVERSIDE DRIVE] | 10036=[WEST 42 STREET,EIGHTH AVENUE,NINTH AVENUE,TENTH AVENUE,ELEVENTH AVENUE] | 11211=[BEDFORD AVENUE,BERRY STREET,WYTHE AVENUE,NORTH 6 STREET,METROPOLITAN AVENUE,GRAND STREET] | 11215=[FIFTH AVENUE,SEVENTH AVENUE,FLATBUSH AVENUE,PROSPECT PARK WEST,UNION STREET] | 11101=[JACKSON AVENUE,QUEENS BOULEVARD,NORTHERN BOULEVARD,THOMSON AVENUE,HUNTER STREET]

Return ONLY the JSON, no markdown.`, 2000);

    const loc = JSON.parse(raw.replace(/```json|```/g,"").trim());

    if (loc.type === "ambiguous") {
      return res.json({ ...loc, originalQuery: q });
    }

    if (loc.isEstablishment && loc.establishments?.length > 0 && userLat && userLng) {
      const uLat = parseFloat(userLat), uLng = parseFloat(userLng);
      loc.establishments.sort((a,b) => haversineKm(uLat,uLng,a.lat,a.lng) - haversineKm(uLat,uLng,b.lat,b.lng));
    }

    if (loc.isEstablishment || loc.isPark || loc.isZip || loc.lat) {
      return res.json({ ...loc, originalQuery: q });
    }
  } catch (e) { console.error("Claude geocode error:", e.message); }

  // Nominatim fallback bounded to NYC
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

  res.status(404).json({ error: `Couldn't find "${q}" in NYC. Try "34th & Broadway", "10036", or "West Village".` });
});

// Reverse geocode
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (r.ok) {
      const item = await r.json(), addr = item.address || {};
      return res.json({ street:(addr.road||addr.pedestrian||addr.footway||"").toUpperCase(), borough:addr.borough||addr.city_district||addr.suburb||"", neighborhood:addr.neighbourhood||addr.suburb||"", label:item.display_name?.split(",").slice(0,2).join(",")||"", lat:parseFloat(lat), lng:parseFloat(lng) });
    }
  } catch (e) { console.error("Reverse geocode error:", e.message); }
  res.status(502).json({ error: "Could not identify your street" });
});

// ─── STREET CLEANING ─────────────────────────────────────────────────────────
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
      if (Array.isArray(schedule) && schedule.length > 0) return res.json(schedule);
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
        return { street: row.street || name, side: row.side_of_street || "", days: parsed.days, time: parsed.time, raw: parsed.raw };
      }).filter(Boolean);
      return res.json(dedupe(results));
    }
  } catch (e) { console.error("DOT fallback error:", e.message); }

  res.json([]);
});

// ─── FILM PERMITS ─────────────────────────────────────────────────────────────
app.get("/api/films", async (req, res) => {
  const { street } = req.query;
  if (!street) return res.json([]);
  const encoded = encodeURIComponent(street.toUpperCase().trim());
  const from = new Date(); from.setDate(from.getDate()-1);
  const to = new Date(); to.setDate(to.getDate()+7);
  const fmt = d => d.toISOString().split(".")[0];
  try {
    const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(parkingheld)%20LIKE%20'%25${encoded}%25'%20AND%20startdatetime%20>=%20'${fmt(from)}'%20AND%20startdatetime%20<=%20'${fmt(to)}'&$limit=20&$order=startdatetime%20ASC`;
    const r = await fetch(url);
    if (!r.ok) return res.json([]);
    res.json((await r.json()).map(f => ({ id:f.eventid, type:f.category||"Film", subtype:f.subcategoryname||f.eventtype||"Shoot", start:f.startdatetime, end:f.enddatetime, parkingHeld:f.parkingheld||"", borough:f.borough||"" })));
  } catch { res.json([]); }
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
