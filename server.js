const express = require("express");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 10000;
const SITE_URL = (process.env.SITE_URL || "https://form-and-field-3ugr.onrender.com").replace(/\/$/, "");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PRODUCTS = {
  scholar: { name: "Scholar Studio", amount: 599 },
  bundle: { name: "Scholar Studio + Neurosurgery Guide", amount: 999 }
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === SITE_URL) {
    res.setHeader("Access-Control-Allow-Origin", SITE_URL);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "20kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, paymentsConfigured: Boolean(stripe) });
});

app.post("/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Payments are not configured yet. Add STRIPE_SECRET_KEY in the Render environment settings." });
  }

  const { name, email, product } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: "Enter your full name." });
  }
  if (typeof email !== "string" || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (product !== "scholar" && product !== "bundle") {
    return res.status(400).json({ error: "Invalid product selected. Refresh and try again." });
  }

  const item = PRODUCTS[product];
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: item.amount,
          product_data: { name: item.name }
        }
      }],
      customer_email: email.trim(),
      billing_address_collection: "auto",
      metadata: { customer_name: name.trim(), product },
      success_url: SITE_URL + "/?payment=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: SITE_URL + "/?payment=cancelled"
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe Checkout creation failed:", err.message);
    return res.status(500).json({ error: "Secure checkout could not start. Please try again later." });
  }
});

app.get("/", (_req, res) => res.type("text").send("FORM & FIELD payments API"));
app.listen(PORT, () => console.log("FORM & FIELD payments API listening on", PORT));
