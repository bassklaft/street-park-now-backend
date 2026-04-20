/**
 * Street Park Info — Backend Server
 * Express + Stripe + Twilio + node-cron + PostgreSQL
 * Deploy to Render.com (free tier)
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
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
// Raw body needed for Stripe webhook signature verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ─── DB INIT ─────────────────────────────────────────────────────────────────
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      street TEXT NOT NULL,
      borough TEXT DEFAULT '',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      plan TEXT DEFAULT 'trial',         -- trial | monthly | annual
      trial_ends_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
      active BOOLEAN DEFAULT TRUE,
      addresses TEXT[] DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id SERIAL PRIMARY KEY,
      subscriber_id INTEGER REFERENCES subscribers(id),
      message TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      type TEXT  -- cleaning | film | weather | event
    );
  `);
  console.log("✅ DB ready");
}

// ─── HEALTH (keeps Render free tier awake via UptimeRobot) ───────────────────
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── SUBSCRIBE ────────────────────────────────────────────────────────────────
// Called when user enters their phone on the frontend
app.post("/subscribe", async (req, res) => {
  const { phone, street, borough, lat, lng } = req.body;
  if (!phone || !street) return res.status(400).json({ error: "phone and street required" });

  // Normalize phone to E.164
  const normalized = phone.replace(/\D/g, "");
  const e164 = normalized.startsWith("1") ? `+${normalized}` : `+1${normalized}`;

  try {
    // Upsert subscriber (idempotent on phone number)
    const result = await db.query(
      `INSERT INTO subscribers (phone, street, borough, lat, lng)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [e164, street.toUpperCase(), borough || "", lat || null, lng || null]
    );

    // Send welcome SMS
    await twilioClient.messages.create({
      body: `🚗 Street Park Info activated for ${street}! We'll text you before street cleaning, film shoots, and bad weather. Reply STOP to cancel.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: e164,
    });

    res.json({ ok: true, message: "Subscribed! Check your phone." });
  } catch (err) {
    console.error("Subscribe error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── STRIPE: CREATE CHECKOUT SESSION ─────────────────────────────────────────
app.post("/create-checkout-session", async (req, res) => {
  const { plan, phone, street } = req.body; // plan: 'monthly' | 'annual'

  const priceId =
    plan === "annual"
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { phone, street },
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      subscription_data: {
        trial_period_days: 30,
      },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
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
    const session = event.data.object;
    const { phone, street } = session.metadata;
    await db.query(
      `UPDATE subscribers
       SET stripe_customer_id = $1,
           stripe_subscription_id = $2,
           plan = $3,
           active = true
       WHERE phone = $4`,
      [
        session.customer,
        session.subscription,
        session.amount_total < 500 ? "monthly" : "annual",
        phone,
      ]
    );
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await db.query(
      "UPDATE subscribers SET active = false WHERE stripe_subscription_id = $1",
      [sub.id]
    );
  }

  res.json({ received: true });
});

// ─── UNSUBSCRIBE ──────────────────────────────────────────────────────────────
app.post("/unsubscribe", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  await db.query("UPDATE subscribers SET active = false WHERE phone = $1", [phone]);
  res.json({ ok: true });
});

// ─── ALERT LOGIC ─────────────────────────────────────────────────────────────

const SOCRATA = "https://data.cityofnewyork.us/resource";

async function fetchCleaningForStreet(street) {
  const name = street.trim().toUpperCase();
  const url = `${SOCRATA}/xswq-wnv9.json?$where=upper(street)=%27${encodeURIComponent(name)}%27 AND upper(description) LIKE %27%25STREET CLEANING%25%27&$limit=20`;
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

async function fetchFilmPermitsForStreet(street) {
  const name = street.trim().toUpperCase();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
  const fmt = d => d.toISOString().split("T")[0] + "T00:00:00.000";

  const url = `${SOCRATA}/tg4x-b46p.json?$where=upper(parkingheld) LIKE %27%25${encodeURIComponent(name)}%25%27 AND startdatetime >= %27${fmt(tomorrow)}%27 AND startdatetime <= %27${fmt(dayAfter)}%27&$limit=5`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  } catch { return []; }
}

async function fetchWeatherAlert(lat, lng) {
  if (!lat || !lng) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code,precipitation_sum,snowfall_sum&forecast_days=2&timezone=America%2FNew_York`;
    const res = await fetch(url);
    const data = await res.json();
    // Tomorrow's forecast (index 1)
    const code = data.daily?.weather_code?.[1];
    const snow = data.daily?.snowfall_sum?.[1];
    const rain = data.daily?.precipitation_sum?.[1];

    const SEVERE = [51,53,55,61,63,65,71,73,75,77,80,81,82,85,86,95,96,99];
    if (SEVERE.includes(code)) {
      if (snow > 0.5) return `❄️ Snow forecast tomorrow (${snow.toFixed(1)} inches). Move your car early.`;
      if (rain > 0.5) return `🌧️ Heavy rain forecast tomorrow (${rain.toFixed(2)} inches).`;
      return `⚠️ Severe weather forecast tomorrow. Check conditions before parking.`;
    }
    return null;
  } catch { return null; }
}

function parseCleaningDays(row) {
  const desc = row.description || "";
  const days = [];
  [["MON","Mon"],["TUE","Tue"],["WED","Wed"],["THU","Thu"],["FRI","Fri"],["SAT","Sat"],["SUN","Sun"]]
    .forEach(([re,label]) => { if (new RegExp(re,"i").test(desc)) days.push(label); });
  const timeMatch = desc.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[-–TO]+\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
  return { days, time: timeMatch ? `${timeMatch[1].trim()} – ${timeMatch[2].trim()}` : null };
}

function getTomorrowAbbr() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
}

// Send alerts to all active subscribers — runs nightly at 8PM ET
async function sendNightlyAlerts() {
  console.log("🚨 Running nightly alert job...");
  const { rows: subscribers } = await db.query(
    "SELECT * FROM subscribers WHERE active = true"
  );

  const tomorrowAbbr = getTomorrowAbbr();
  const tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  for (const sub of subscribers) {
    const messages = [];

    try {
      // 1. Check street cleaning
      const cleaningData = await fetchCleaningForStreet(sub.street);
      for (const row of cleaningData) {
        const { days, time } = parseCleaningDays(row);
        if (days.includes(tomorrowAbbr)) {
          messages.push(`🧹 Street cleaning on ${sub.street} tomorrow${time ? ` from ${time}` : ""}. Move your car!`);
          break;
        }
      }

      // 2. Check film permits
      const films = await fetchFilmPermitsForStreet(sub.street);
      if (films.length > 0) {
        messages.push(`🎬 Film shoot on ${sub.street} tomorrow — parking may be restricted.`);
      }

      // 3. Check weather
      const wxAlert = await fetchWeatherAlert(sub.lat, sub.lng);
      if (wxAlert) messages.push(wxAlert);

      // Send combined SMS if there's anything to say
      if (messages.length > 0) {
        const body = `Street Park Info Alert for ${sub.street} — ${tomorrowStr}:\n\n${messages.join("\n\n")}\n\nReply STOP to cancel.`;
        await twilioClient.messages.create({
          body,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: sub.phone,
        });

        // Log it
        for (const msg of messages) {
          await db.query(
            "INSERT INTO alert_log (subscriber_id, message, type) VALUES ($1, $2, $3)",
            [sub.id, msg, "nightly"]
          );
        }

        console.log(`✅ Alerted ${sub.phone} for ${sub.street}: ${messages.length} alerts`);
      }
    } catch (err) {
      console.error(`❌ Failed to alert ${sub.phone}:`, err.message);
    }

    // Rate limit: 1 SMS per 100ms to avoid Twilio limits
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`✅ Alert job complete. ${subscribers.length} subscribers checked.`);
}

// ─── CRON JOBS ────────────────────────────────────────────────────────────────
// Nightly alerts at 8PM Eastern
cron.schedule("0 20 * * *", sendNightlyAlerts, { timezone: "America/New_York" });

// Self-ping every 14 minutes to keep Render free tier awake
cron.schedule("*/14 * * * *", () => {
  fetch(`https://${process.env.RENDER_SERVICE_URL || "localhost:" + PORT}/health`)
    .catch(() => {}); // silent — just keeping alive
});

// ─── MANUAL TRIGGER (for testing) ────────────────────────────────────────────
app.post("/admin/trigger-alerts", async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: "unauthorized" });
  sendNightlyAlerts().catch(console.error);
  res.json({ ok: true, message: "Alert job triggered" });
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚗 Street Park Info backend running on port ${PORT}`));
});
