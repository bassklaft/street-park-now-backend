/**
 * Street Park Info — Backend
 * Smart NYC parking intelligence — works like a local who knows every street
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

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db           = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors({ origin: "*" }));
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

const SOCRATA = "https://data.cityofnewyork.us/resource";

// ─── CLAUDE AI HELPER ─────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 1024) {
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
  if (!r.ok) throw new Error(`Claude API error: ${r.status}`);
  const d = await r.json();
  return d.content?.[0]?.text || "";
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── SMART GEOCODE ────────────────────────────────────────────────────────────
// Accepts anything a stressed NYC driver would type:
// "intrepid", "34th and broadway", "uws", "bdwy & 72", "the high line", etc.
app.get("/api/geocode", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  // Step 1: Use Claude to resolve natural language to a precise NYC location
  let resolvedQuery = q.trim();
  try {
    const interpretation = await askClaude(`You are an NYC geography expert. A driver typed: "${q}"

Resolve this to the most specific NYC street address or intersection for parking purposes.
Examples:
- "intrepid" → "Pier 86, West 46th Street and 12th Avenue, Manhattan"
- "34th and bdwy" → "34th Street and Broadway, Manhattan"  
- "uws" → "Upper West Side, Manhattan"
- "high line" → "West 20th Street and 10th Avenue, Manhattan"
- "lic" → "Long Island City, Queens"
- "ues" → "Upper East Side, Manhattan"
- "hudson yards" → "West 30th Street and 10th Avenue, Manhattan"

Respond with ONLY the resolved location string, nothing else. Keep it under 60 characters.`);

    if (interpretation && interpretation.trim().length > 3) {
      resolvedQuery = interpretation.trim();
    }
  } catch (e) {
    console.error("Claude resolve error:", e.message);
  }

  // Step 2: Geocode the resolved query with Nominatim
  const withCity = /new york|nyc|brooklyn|manhattan|bronx|queens|staten island/i.test(resolvedQuery)
    ? resolvedQuery : `${resolvedQuery}, New York City`;

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(withCity)}&format=json&limit=1&addressdetails=1&countrycodes=us`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0 contact@streetparkinfo.com" } });
    if (r.ok) {
      const data = await r.json();
      if (data.length > 0) {
        const item = data[0];
        const addr = item.address || {};
        const street = addr.road || addr.pedestrian || addr.footway || addr.suburb || resolvedQuery;
        return res.json({
          street: street.toUpperCase(),
          borough: addr.borough || addr.city_district || addr.suburb || addr.county || "",
          neighborhood: addr.neighbourhood || addr.suburb || "",
          label: resolvedQuery,
          originalQuery: q,
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
        });
      }
    }
  } catch (e) {
    console.error("Nominatim error:", e.message);
  }

  // Step 3: Fall back to NYC Planning Labs
  try {
    const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(withCity)}&size=1`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data.features?.length) {
        const p = data.features[0].properties;
        const [lng, lat] = data.features[0].geometry.coordinates;
        return res.json({
          street: (p.street || p.name || q).toUpperCase(),
          borough: p.borough || "",
          neighborhood: p.neighbourhood || p.locality || "",
          label: resolvedQuery,
          originalQuery: q,
          lat, lng,
        });
      }
    }
  } catch (e) {
    console.error("GeoSearch error:", e.message);
  }

  res.status(404).json({ error: `Couldn't locate "${q}" in NYC. Try a street name or address.` });
});

// Reverse geocode
app.get("/api/reverse-geocode", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (r.ok) {
      const item = await r.json();
      const addr = item.address || {};
      return res.json({
        street: (addr.road || addr.pedestrian || addr.footway || "").toUpperCase(),
        borough: addr.borough || addr.city_district || addr.suburb || "",
        neighborhood: addr.neighbourhood || addr.suburb || "",
        label: item.display_name?.split(",").slice(0, 2).join(",") || "",
        lat: parseFloat(lat), lng: parseFloat(lng),
      });
    }
  } catch (e) { console.error("Reverse geocode error:", e.message); }
  res.status(502).json({ error: "Could not identify your street" });
});

// ─── STREET CLEANING ─────────────────────────────────────────────────────────
// Strategy: Claude knows NYC streets cold. Ask it directly, use DOT as verification.
app.get("/api/cleaning", async (req, res) => {
  const { street, lat, lng, borough } = req.query;
  if (!street) return res.json([]);

  // Primary: Ask Claude for the schedule — it has deep NYC street knowledge
  try {
    const locationContext = lat && lng ? `at approximately ${lat}, ${lng}` : `in ${borough || "NYC"}`;
    const text = await askClaude(`You are an NYC alternate side parking expert with knowledge of every street cleaning schedule in all 5 boroughs.

For the street "${street}" ${locationContext}, provide the street cleaning (alternate side parking) schedule.

Important rules:
- Street cleaning happens 1-2x per week on most NYC streets
- Different sides of the street often have different days
- Hours are typically 1-2 hour windows (e.g. 8-9:30 AM, 11:30 AM-1 PM)
- Include BOTH sides if they differ
- If this is a major avenue (Broadway, 5th Ave, etc.), include all known schedule variations
- Base your answer on official NYC DOT alternate side parking regulations

Respond ONLY with a valid JSON array. Each item must have:
{
  "days": ["Mon", "Thu"],  // day abbreviations
  "time": "8 AM – 9:30 AM",  // exact time window
  "side": "Left / Even side",  // or "Right / Odd side" or "" if same both sides
  "raw": "NO PARKING 8AM-9:30AM MON & THUR"  // sign text format
}

If you genuinely don't know this specific street's schedule, return [].
Return ONLY the JSON array.`);

    const cleaned = text.replace(/```json|```/g, "").trim();
    const schedule = JSON.parse(cleaned);
    if (Array.isArray(schedule) && schedule.length > 0) {
      console.log(`Claude returned ${schedule.length} cleaning rules for ${street}`);
      return res.json(schedule);
    }
  } catch (e) {
    console.error("Claude cleaning error:", e.message);
  }

  // Fallback: DOT Socrata by street name
  try {
    const name = street.toUpperCase().replace(/\s+/g, " ").trim();
    const encoded = encodeURIComponent(name);
    const url = `${SOCRATA}/xswq-wnv9.json?$where=upper(street)%20LIKE%20'%25${encoded}%25'&$limit=200`;
    const r = await fetch(url);
    if (r.ok) {
      const raw = await r.json();
      console.log(`DOT fallback: ${raw.length} rows for ${name}`);
      const results = raw.map(row => {
        const txt = row.signdesc || row.description || "";
        const up = txt.toUpperCase();
        if (!up.includes("STREET CLEANING") && !up.includes("NO PARKING")) return null;
        const days = ["MON","TUE","WED","THU","FRI","SAT","SUN"]
          .filter(d => new RegExp(`\\b${d}`, "i").test(txt))
          .map(d => ({ MON:"Mon",TUE:"Tue",WED:"Wed",THU:"Thu",FRI:"Fri",SAT:"Sat",SUN:"Sun" })[d]);
        if (!days.length) return null;
        const tm = txt.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[-–TO]+\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
        return { street: row.street || name, side: row.side_of_street || "", days, time: tm ? `${tm[1].trim()} – ${tm[2].trim()}` : null, raw: txt };
      }).filter(Boolean);
      const seen = new Set();
      return res.json(results.filter(r => { const k = `${r.days}-${r.time}-${r.side}`; return seen.has(k) ? false : seen.add(k); }));
    }
  } catch (e) { console.error("DOT fallback error:", e.message); }

  res.json([]);
});

// ─── FILM PERMITS ─────────────────────────────────────────────────────────────
app.get("/api/films", async (req, res) => {
  const { street } = req.query;
  if (!street) return res.json([]);
  const name = street.toUpperCase().trim();
  const encoded = encodeURIComponent(name);
  const from = new Date(); from.setDate(from.getDate() - 1);
  const to   = new Date(); to.setDate(to.getDate() + 7);
  const fmt  = d => d.toISOString().split(".")[0];
  try {
    const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(parkingheld)%20LIKE%20'%25${encoded}%25'%20AND%20startdatetime%20>=%20'${fmt(from)}'%20AND%20startdatetime%20<=%20'${fmt(to)}'&$limit=20&$order=startdatetime%20ASC`;
    const r = await fetch(url);
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data.map(f => ({
      id: f.eventid, type: f.category || "Film",
      subtype: f.subcategoryname || f.eventtype || "Shoot",
      start: f.startdatetime, end: f.enddatetime,
      parkingHeld: f.parkingheld || "", borough: f.borough || "",
    })));
  } catch { res.json([]); }
});

// ─── PUBLIC EVENTS ────────────────────────────────────────────────────────────
app.get("/api/events", async (req, res) => {
  const { borough } = req.query;
  const today  = new Date().toISOString().split("T")[0];
  const toDate = new Date(); toDate.setDate(toDate.getDate() + 14);
  const toStr  = toDate.toISOString().split("T")[0];
  try {
    const bf  = borough ? `%20AND%20upper(borough)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'` : "";
    const url = `${SOCRATA}/tvpp-9vvx.json?$where=startdate%20>=%20'${today}'%20AND%20startdate%20<=%20'${toStr}'${bf}&$limit=15&$order=startdate%20ASC`;
    const r   = await fetch(url);
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data.map(ev => ({
      name: ev.eventname || ev.name || "City Event",
      type: ev.eventtype || "Event", start: ev.startdate,
      location: ev.eventlocation || "", borough: ev.borough || "",
      parkingImpacted: !!(ev.parkingimpacted),
    })));
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

// ─── ASP STATUS (NYC 311) ─────────────────────────────────────────────────────
app.get("/api/asp", async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-CA");
    // NYC 311 official calendar API
    const url = `https://api.nyc.gov/public/api/GetCalendar?calendarTypes=AltSideParking&startDate=${today}&endDate=${today}`;
    const r = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    if (r.ok) {
      const data = await r.json();
      const txt  = JSON.stringify(data).toLowerCase();
      return res.json({ suspended: txt.includes("suspended"), raw: data });
    }
  } catch (e) { console.error("ASP error:", e.message); }

  // Fallback: check @NYCASP via 311
  try {
    const today = new Date().toLocaleDateString("en-CA");
    const url311 = `${SOCRATA}/erm2-nwe9.json?$where=complaint_type='Alternate%20Side%20Parking'%20AND%20created_date%20>=%20'${today}T00:00:00'&$limit=1`;
    const r = await fetch(url311);
    const data = r.ok ? await r.json() : [];
    res.json({ suspended: false, note: "ASP in effect" });
  } catch { res.json({ suspended: false }); }
});

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  const { phone, street, borough, lat, lng } = req.body;
  if (!phone || !street) return res.status(400).json({ error: "phone and street required" });
  const digits = phone.replace(/\D/g, "");
  const e164   = digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
  try {
    await db.query(
      `INSERT INTO subscribers (phone, street, borough, lat, lng) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (phone) DO UPDATE SET street=$2, borough=$3, lat=$4, lng=$5, active=true`,
      [e164, street.toUpperCase(), borough || "", lat || null, lng || null]
    );
    await twilioClient.messages.create({
      body: `🚗 Street Park Info activated for ${street}! We'll text you before street cleaning, film shoots, and bad weather. Reply STOP to cancel.`,
      from: process.env.TWILIO_PHONE_NUMBER, to: e164,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── STRIPE ───────────────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { plan, phone, street } = req.body;
  const priceId = plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"], mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { phone, street },
      success_url: `${process.env.FRONTEND_URL}?subscribed=true`,
      cancel_url: process.env.FRONTEND_URL,
      subscription_data: { trial_period_days: 30 },
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if (event.type === "checkout.session.completed") {
    const { phone } = event.data.object.metadata;
    await db.query(`UPDATE subscribers SET stripe_customer_id=$1, stripe_subscription_id=$2, plan=$3, active=true WHERE phone=$4`,
      [event.data.object.customer, event.data.object.subscription,
       event.data.object.amount_total < 500 ? "monthly" : "annual", phone]).catch(console.error);
  }
  if (event.type === "customer.subscription.deleted") {
    await db.query("UPDATE subscribers SET active=false WHERE stripe_subscription_id=$1", [event.data.object.id]).catch(console.error);
  }
  res.json({ received: true });
});

// ─── NIGHTLY ALERTS ───────────────────────────────────────────────────────────
async function sendNightlyAlerts() {
  const { rows: subs } = await db.query("SELECT * FROM subscribers WHERE active=true");
  const tomorrow    = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowAbbr = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][tomorrow.getDay()];
  const tomorrowStr  = tomorrow.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});

  for (const sub of subs) {
    const msgs = [];
    try {
      const base = `http://localhost:${PORT}`;
      const [cResp, fResp, wxResp] = await Promise.allSettled([
        fetch(`${base}/api/cleaning?street=${encodeURIComponent(sub.street)}&lat=${sub.lat}&lng=${sub.lng}`).then(r => r.json()),
        fetch(`${base}/api/films?street=${encodeURIComponent(sub.street)}`).then(r => r.json()),
        fetch(`${base}/api/weather?lat=${sub.lat}&lng=${sub.lng}`).then(r => r.json()),
      ]);
      const cleaning = cResp.status === "fulfilled" ? cResp.value : [];
      const films    = fResp.status === "fulfilled" ? fResp.value : [];
      const wx       = wxResp.status === "fulfilled" ? wxResp.value : null;

      const cleanTomorrow = cleaning.find(c => c.days?.includes(tomorrowAbbr));
      if (cleanTomorrow) msgs.push(`🧹 Street cleaning on ${sub.street} tomorrow${cleanTomorrow.time ? ` from ${cleanTomorrow.time}` : ""}. Move your car!`);
      if (films.length) msgs.push(`🎬 Film shoot near ${sub.street} — parking may be restricted.`);

      const code = wx?.daily?.weather_code?.[1];
      const snow = wx?.daily?.snowfall_sum?.[1];
      const rain = wx?.daily?.precipitation_sum?.[1];
      if ([71,73,75,77,85,86].includes(code) && snow > 0.5) msgs.push(`❄️ Snow tomorrow (${snow.toFixed(1)}"). Move your car early — ASP may be suspended then reinstated.`);
      else if ([61,63,65,80,81,82].includes(code) && rain > 0.5) msgs.push(`🌧️ Heavy rain tomorrow. Street cleaning may still be enforced.`);
      else if ([95,96,99].includes(code)) msgs.push(`⛈️ Thunderstorms tomorrow. Check parking rules before heading out.`);

      if (msgs.length) {
        await twilioClient.messages.create({
          body: `Street Park Info — ${tomorrowStr}:\n\n${msgs.join("\n\n")}\n\nReply STOP to cancel.`,
          from: process.env.TWILIO_PHONE_NUMBER, to: sub.phone,
        });
      }
    } catch (err) { console.error(`Alert failed for ${sub.phone}:`, err.message); }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`✅ Alerts done for ${subs.length} subscribers`);
}

cron.schedule("0 20 * * *", sendNightlyAlerts, { timezone: "America/New_York" });
cron.schedule("*/14 * * * *", () => {
  fetch(`https://${process.env.RENDER_SERVICE_URL || `localhost:${PORT}`}/health`).catch(() => {});
});

app.post("/admin/trigger-alerts", async (req, res) => {
  if (req.body.secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "unauthorized" });
  sendNightlyAlerts().catch(console.error);
  res.json({ ok: true });
});

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
