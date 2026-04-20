/**
 * Street Park Info — Backend Server
 * Express + Stripe + Twilio + node-cron + PostgreSQL
 * NYC Open Data proxy (fixes 403 CORS issue from browser)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { Pool } = require("pg");
const Stripe = require("stripe");
const twilio = require("twilio");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" })); // allow all origins — frontend is on Vercel
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── NYC OPEN DATA CONFIG ─────────────────────────────────────────────────────
const SOCRATA = "https://data.cityofnewyork.us/resource";
// App token avoids rate limits — register free at data.cityofnewyork.us/profile
// Works without token but slower — add NYC_APP_TOKEN to Render env vars when ready
const NYC_TOKEN = process.env.NYC_APP_TOKEN || "";
const nycHeaders = NYC_TOKEN ? { "X-App-Token": NYC_TOKEN } : {};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Normalize any street name input to match DOT dataset format
// "broadway" → "BROADWAY", "w 72nd st" → "WEST 72 STREET", etc.
function normalizeStreet(raw) {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\bW\.?\s+/g, "WEST ")
    .replace(/\bE\.?\s+/g, "EAST ")
    .replace(/\bN\.?\s+/g, "NORTH ")
    .replace(/\bS\.?\s+/g, "SOUTH ")
    .replace(/\bST\.?$/,  "STREET")
    .replace(/\bAVE?\.?$/, "AVENUE")
    .replace(/\bBLVD\.?$/, "BOULEVARD")
    .replace(/\bDR\.?$/,  "DRIVE")
    .replace(/\bPL\.?$/,  "PLACE")
    .replace(/\bRD\.?$/,  "ROAD")
    .replace(/(\d+)(ST|ND|RD|TH)\b/i, "$1") // "72ND" → "72"
    .replace(/\s+/g, " ")
    .trim();
}

// Parse a DOT sign description into structured day/time data
// Handles formats like "NO PARKING 8AM-10AM MON THRU FRI"
function parseSignText(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!upper.includes("STREET CLEANING") && !upper.includes("NO PARKING")) return null;

  const dayMap = { MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun" };
  const days = Object.entries(dayMap)
    .filter(([abbr]) => new RegExp(`\\b${abbr}`, "i").test(text))
    .map(([, label]) => label);

  const timeMatch = text.match(
    /(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*(?:[-–]|TO|THRU)\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i
  );
  const time = timeMatch ? `${timeMatch[1].trim()} – ${timeMatch[2].trim()}` : null;

  return { days, time, raw: text };
}

// ─── GEOCODING PROXY ──────────────────────────────────────────────────────────
app.get("/api/geocode", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });

  const withCity = /new york|nyc|brooklyn|manhattan|bronx|queens|staten island/i.test(q)
    ? q : `${q}, New York City`;

  // Try Nominatim (OpenStreetMap) first — reliable, free, no key needed
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(withCity)}&format=json&limit=1&addressdetails=1&countrycodes=us`;
    const r = await fetch(url, { headers: { "User-Agent": "StreetParkInfo/1.0" } });
    if (r.ok) {
      const data = await r.json();
      if (data.length > 0) {
        const item = data[0];
        const addr = item.address || {};
        const street = addr.road || addr.pedestrian || addr.footway || q.toUpperCase();
        const borough = addr.borough || addr.city_district || addr.suburb || addr.county || "";
        const neighborhood = addr.neighbourhood || addr.suburb || "";
        return res.json({
          street: street.toUpperCase(),
          borough,
          neighborhood,
          label: item.display_name?.split(",").slice(0, 2).join(",") || q,
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
        });
      }
    }
  } catch (e) {
    console.error("Nominatim error:", e.message);
  }

  // Fallback: NYC Planning Labs GeoSearch
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
          borough: p.borough || p.county || "",
          neighborhood: p.neighbourhood || p.locality || "",
          label: p.label || q,
          lat, lng,
        });
      }
    }
  } catch (e) {
    console.error("GeoSearch error:", e.message);
  }

  res.status(404).json({ error: `Could not find "${q}" in NYC. Try a street name like "Broadway" or an address.` });
});

// Reverse geocode proxy
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
        lat: parseFloat(lat),
        lng: parseFloat(lng),
      });
    }
  } catch (e) {
    console.error("Reverse geocode error:", e.message);
  }

  // Fallback to Planning Labs
  try {
    const url = `https://geosearch.planninglabs.nyc/v2/reverse?point.lat=${lat}&point.lon=${lng}&size=1`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data.features?.length) {
        const p = data.features[0].properties;
        return res.json({
          street: (p.street || p.name || "").toUpperCase(),
          borough: p.borough || "",
          neighborhood: p.neighbourhood || p.locality || "",
          label: p.label || "",
          lat: parseFloat(lat),
          lng: parseFloat(lng),
        });
      }
    }
  } catch (e) {
    console.error("GeoSearch reverse error:", e.message);
  }

  res.status(502).json({ error: "Could not identify your street" });
});



// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
// These run server-side so there's no 403 CORS issue from the browser

// Street cleaning schedule — uses OpenCurb API (free, no key, works by lat/lng)
// Falls back to DOT dataset by street name
app.get("/api/cleaning", async (req, res) => {
  const { street, lat, lng } = req.query;
  if (!street && (!lat || !lng)) return res.json([]);

  // If we have coordinates, use OpenCurb (most accurate — queries by location)
  if (lat && lng) {
    try {
      const url = `https://www.opencurb.nyc/api/v1/signs?lat=${lat}&lng=${lng}&radius=50`;
      const r = await fetch(url, { headers: { "Accept": "application/json" } });
      if (r.ok) {
        const data = await r.json();
        const signs = Array.isArray(data) ? data : (data.signs || data.results || []);
        const results = signs
          .filter(s => {
            const txt = (s.description || s.sign_text || s.regulation || s.text || "").toUpperCase();
            return txt.includes("STREET CLEANING") || txt.includes("NO PARKING");
          })
          .map(s => {
            const text = s.description || s.sign_text || s.regulation || s.text || "";
            const parsed = parseSignText(text);
            if (!parsed || !parsed.days.length) return null;
            return {
              street: street || s.street || "",
              side: s.side || s.curb_side || "",
              days: parsed.days,
              time: parsed.time,
              raw: parsed.raw,
            };
          })
          .filter(Boolean);

        if (results.length > 0) return res.json(dedupe(results));
      }
    } catch (e) {
      console.error("OpenCurb error:", e.message);
    }
  }

  // Fallback: DOT Socrata dataset by street name
  // This dataset is two linked tables — we query both and join on order number
  const name = normalizeStreet(street || "");
  const encoded = encodeURIComponent(name);

  try {
    // Query locations table for the street, get order numbers
    const locUrl = `${SOCRATA}/xswq-wnv9.json?$where=upper(street)%20LIKE%20'%25${encoded}%25'&$limit=200&$select=order_no,street,side_of_street,fromhousenumber,tohousenumber,signdesc`;
    const r = await fetch(locUrl, { headers: nycHeaders });
    if (!r.ok) {
      console.error("DOT API error:", r.status);
      return res.json([]);
    }
    const raw = await r.json();
    console.log(`DOT returned ${raw.length} rows for "${name}"`);

    const results = raw
      .map(row => {
        const text = row.signdesc || row.description || row.sign_text || "";
        const upper = text.toUpperCase();
        if (!upper.includes("STREET CLEANING") && !upper.includes("NO PARKING")) return null;
        const parsed = parseSignText(text);
        if (!parsed || !parsed.days.length) return null;
        return {
          street: row.street || name,
          side: row.side_of_street || "",
          fromHouse: row.fromhousenumber || "",
          toHouse: row.tohousenumber || "",
          days: parsed.days,
          time: parsed.time,
          raw: parsed.raw,
        };
      })
      .filter(Boolean);

    res.json(dedupe(results));
  } catch (err) {
    console.error("Cleaning fetch error:", err.message);
    res.json([]);
  }
});

function dedupe(results) {
  const seen = new Set();
  return results.filter(r => {
    const key = `${r.days.join(",")}-${r.time}-${r.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Film permits — searches parking held field for a street name, upcoming dates
app.get("/api/films", async (req, res) => {
  const { street } = req.query;
  if (!street) return res.json([]);

  const name = normalizeStreet(street);
  const encoded = encodeURIComponent(name);

  const from = new Date(); from.setDate(from.getDate() - 1);
  const to = new Date(); to.setDate(to.getDate() + 7);
  const fmt = d => d.toISOString().replace("T", "T").split(".")[0];

  try {
    const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(parkingheld)%20LIKE%20'%25${encoded}%25'%20AND%20startdatetime%20>=%20'${fmt(from)}'%20AND%20startdatetime%20<=%20'${fmt(to)}'&$limit=20&$order=startdatetime%20ASC`;
    const r = await fetch(url, { headers: nycHeaders });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data.map(f => ({
      id: f.eventid,
      type: f.category || "Film",
      subtype: f.subcategoryname || f.eventtype || "Shoot",
      start: f.startdatetime,
      end: f.enddatetime,
      parkingHeld: f.parkingheld || "",
      borough: f.borough || "",
    })));
  } catch (err) {
    console.error("Films fetch error:", err.message);
    res.json([]);
  }
});

// Public events — returns upcoming permitted events, optionally filtered by borough
app.get("/api/events", async (req, res) => {
  const { borough } = req.query;
  const today = new Date().toISOString().split("T")[0];
  const toDate = new Date(); toDate.setDate(toDate.getDate() + 14);
  const toStr = toDate.toISOString().split("T")[0];

  try {
    const boroughFilter = borough
      ? `%20AND%20upper(borough)%20LIKE%20'%25${encodeURIComponent(borough.toUpperCase())}%25'`
      : "";
    const url = `${SOCRATA}/tvpp-9vvx.json?$where=startdate%20>=%20'${today}'%20AND%20startdate%20<=%20'${toStr}'${boroughFilter}&$limit=15&$order=startdate%20ASC`;
    const r = await fetch(url, { headers: nycHeaders });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data.map(ev => ({
      name: ev.eventname || ev.name || "City Event",
      type: ev.eventtype || "Event",
      start: ev.startdate,
      location: ev.eventlocation || "",
      borough: ev.borough || "",
      parkingImpacted: !!(ev.parkingimpacted),
    })));
  } catch (err) {
    console.error("Events fetch error:", err.message);
    res.json([]);
  }
});

// Weather — proxies Open-Meteo (already CORS-friendly but nice to have server-side)
app.get("/api/weather", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.json(null);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&daily=weather_code,precipitation_sum,snowfall_sum&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=3&timezone=America%2FNew_York`;
    const r = await fetch(url);
    res.json(r.ok ? await r.json() : null);
  } catch { res.json(null); }
});

// ASP suspension status for today
app.get("/api/asp", async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-CA");
    const url = `https://api.nyc.gov/public/api/GetCalendar?calendarTypes=AltSideParking&startDate=${today}&endDate=${today}`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ suspended: false });
    const data = await r.json();
    const suspended = JSON.stringify(data).toLowerCase().includes("suspended");
    res.json({ suspended });
  } catch { res.json({ suspended: false }); }
});

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────
app.post("/subscribe", async (req, res) => {
  const { phone, street, borough, lat, lng } = req.body;
  if (!phone || !street) return res.status(400).json({ error: "phone and street required" });

  const normalized = phone.replace(/\D/g, "");
  const e164 = normalized.startsWith("1") ? `+${normalized}` : `+1${normalized}`;

  try {
    await db.query(
      `INSERT INTO subscribers (phone, street, borough, lat, lng)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [e164, normalizeStreet(street), borough || "", lat || null, lng || null]
    );

    await twilioClient.messages.create({
      body: `🚗 Street Park Info is on! We'll text you before street cleaning, film shoots, and bad weather on ${street}. Reply STOP to cancel.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: e164,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Subscribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE CHECKOUT ─────────────────────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { plan, phone, street } = req.body;
  const priceId = plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { phone, street },
      success_url: `${process.env.FRONTEND_URL}?subscribed=true`,
      cancel_url: process.env.FRONTEND_URL,
      subscription_data: { trial_period_days: 30 },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const { phone, street } = event.data.object.metadata;
    await db.query(
      `UPDATE subscribers SET stripe_customer_id=$1, stripe_subscription_id=$2, plan=$3, active=true WHERE phone=$4`,
      [event.data.object.customer, event.data.object.subscription,
       event.data.object.amount_total < 500 ? "monthly" : "annual", phone]
    ).catch(console.error);
  }
  if (event.type === "customer.subscription.deleted") {
    await db.query("UPDATE subscribers SET active=false WHERE stripe_subscription_id=$1",
      [event.data.object.id]).catch(console.error);
  }
  res.json({ received: true });
});

// ─── NIGHTLY ALERT JOB ────────────────────────────────────────────────────────
async function sendNightlyAlerts() {
  console.log("🚨 Running nightly alert job...");
  const { rows: subs } = await db.query("SELECT * FROM subscribers WHERE active = true");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowAbbr = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][tomorrow.getDay()];
  const tomorrowStr = tomorrow.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });

  for (const sub of subs) {
    const msgs = [];
    try {
      // Street cleaning
      const cleanResp = await fetch(`http://localhost:${PORT}/api/cleaning?street=${encodeURIComponent(sub.street)}`);
      const cleaning = await cleanResp.json();
      const cleaningTomorrow = cleaning.find(c => c.days.includes(tomorrowAbbr));
      if (cleaningTomorrow) {
        msgs.push(`🧹 Street cleaning on ${sub.street} tomorrow${cleaningTomorrow.time ? ` from ${cleaningTomorrow.time}` : ""}. Move your car!`);
      }

      // Film permits
      const filmResp = await fetch(`http://localhost:${PORT}/api/films?street=${encodeURIComponent(sub.street)}`);
      const films = await filmResp.json();
      if (films.length > 0) msgs.push(`🎬 Film shoot on ${sub.street} tomorrow — parking may be restricted.`);

      // Weather
      if (sub.lat && sub.lng) {
        const wxResp = await fetch(`http://localhost:${PORT}/api/weather?lat=${sub.lat}&lng=${sub.lng}`);
        const wx = await wxResp.json();
        const code = wx?.daily?.weather_code?.[1];
        const snow = wx?.daily?.snowfall_sum?.[1];
        const rain = wx?.daily?.precipitation_sum?.[1];
        const SEVERE = [51,53,55,61,63,65,71,73,75,77,80,81,82,85,86,95,96,99];
        if (SEVERE.includes(code)) {
          msgs.push(snow > 0.5 ? `❄️ Snow tomorrow (${snow.toFixed(1)}"). Move your car early.`
            : rain > 0.5 ? `🌧️ Heavy rain tomorrow. Street cleaning may still be enforced.`
            : `⚠️ Severe weather tomorrow. Check parking conditions.`);
        }
      }

      if (msgs.length > 0) {
        await twilioClient.messages.create({
          body: `Street Park Info — ${tomorrowStr}:\n\n${msgs.join("\n\n")}\n\nReply STOP to cancel.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: sub.phone,
        });
        console.log(`✅ Alerted ${sub.phone}: ${msgs.length} alerts`);
      }
    } catch (err) {
      console.error(`❌ Failed ${sub.phone}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`✅ Done. ${subs.length} subscribers checked.`);
}

// ─── CRON ────────────────────────────────────────────────────────────────────
cron.schedule("0 20 * * *", sendNightlyAlerts, { timezone: "America/New_York" });
cron.schedule("*/14 * * * *", () => {
  fetch(`https://${process.env.RENDER_SERVICE_URL || `localhost:${PORT}`}/health`).catch(() => {});
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────
app.post("/admin/trigger-alerts", async (req, res) => {
  if (req.body.secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "unauthorized" });
  sendNightlyAlerts().catch(console.error);
  res.json({ ok: true });
});

// ─── DB INIT + START ──────────────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      street TEXT NOT NULL,
      borough TEXT DEFAULT '',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'trial',
      trial_ends_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alert_log (
      id SERIAL PRIMARY KEY,
      subscriber_id INTEGER REFERENCES subscribers(id),
      message TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      type TEXT
    );
  `);
  console.log("✅ DB ready");
}

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚗 Street Park Info running on port ${PORT}`));
});
