const express = require("express");
const Stripe = require("stripe");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || "https://form-and-field-3ugr.onrender.com").replace(/\/$/, "");
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PRODUCTS = {
  1: { name: "Arc Ceramic Vase", price: 2800 },
  2: { name: "Everyday Tote", price: 1800 },
  3: { name: "Pebble Desk Lamp", price: 5400 },
  4: { name: "Studio Headphones", price: 7900 },
  5: { name: "Soft Knit Throw", price: 4200 },
  6: { name: "Pocket Notebook Set", price: 1200 },
  7: { name: "Mini Bluetooth Speaker", price: 3500 },
  8: { name: "Stoneware Mug", price: 1600 }
};

function paymentSetupReady() {
  return stripe &&
    process.env.STRIPE_CONNECT_ACCOUNT_A &&
    process.env.STRIPE_CONNECT_ACCOUNT_B &&
    process.env.STRIPE_WEBHOOK_SECRET;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    paymentsConfigured: Boolean(stripe),
    splitConfigured: Boolean(
      process.env.STRIPE_CONNECT_ACCOUNT_A &&
      process.env.STRIPE_CONNECT_ACCOUNT_B
    )
  });
});

// Stripe needs the unmodified request body to verify webhook signatures.
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Stripe webhook is not configured.");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send("Invalid webhook signature.");
  }

  if (event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object;

    // Never send transfers for unpaid or non-GBP sessions.
    if (session.payment_status !== "paid" || session.currency !== "gbp") {
      return res.json({ received: true, skipped: true });
    }

    const accountA = process.env.STRIPE_CONNECT_ACCOUNT_A;
    const accountB = process.env.STRIPE_CONNECT_ACCOUNT_B;
    if (!accountA || !accountB) {
      console.error("Paid session requires configured Connect recipients:", session.id);
      return res.status(500).send("Payout recipients are not configured.");
    }

    const total = session.amount_total;
    if (!Number.isInteger(total) || total < 2) {
      return res.status(400).send("Invalid order total.");
    }

    // Use deterministic idempotency keys so Stripe retries cannot duplicate transfers.
    const halfA = Math.floor(total / 2);
    const halfB = total - halfA;
    try {
      await stripe.transfers.create({
        amount: halfA,
        currency: "gbp",
        destination: accountA,
        transfer_group: session.payment_intent,
        metadata: { checkout_session: session.id, split: "A", percentage: "50" }
      }, { idempotencyKey: "ff-split-A-" + session.id });

      await stripe.transfers.create({
        amount: halfB,
        currency: "gbp",
        destination: accountB,
        transfer_group: session.payment_intent,
        metadata: { checkout_session: session.id, split: "B", percentage: "50" }
      }, { idempotencyKey: "ff-split-B-" + session.id });
    } catch (err) {
      console.error("50/50 transfer failed for session", session.id, err.message);
      return res.status(500).send("Transfers need to be retried.");
    }
  }

  return res.json({ received: true });
});

app.use(express.json({ limit: "20kb" }));

app.post("/create-checkout-session", async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: "Secure checkout is not configured yet. Add the Stripe secret key in the Render environment." });
  }
  if (!paymentSetupReady()) {
    return res.status(503).json({ error: "Payments are not activated yet. Stripe Connect and both 50/50 payout accounts must be configured first." });
  }

  const { name, email, items } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.length > 100) {
    return res.status(400).json({ error: "Enter your full name." });
  }
  if (typeof email !== "string" || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
    return res.status(400).json({ error: "Your bag is empty or invalid." });
  }

  const seen = new Set();
  const line_items = [];
  for (const item of items) {
    const id = Number(item && item.id);
    const qty = Number(item && item.qty);
    const product = PRODUCTS[id];
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20 || seen.has(id)) {
      return res.status(400).json({ error: "One or more bag items are invalid. Please refresh your bag." });
    }
    seen.add(id);
    line_items.push({
      quantity: qty,
      price_data: {
        currency: "gbp",
        unit_amount: product.price,
        product_data: { name: product.name }
      }
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      customer_email: email.trim(),
      billing_address_collection: "required",
      shipping_address_collection: { allowed_countries: ["GB"] },
      metadata: { customer_name: name.trim().slice(0, 100) },
      payment_intent_data: {
        transfer_group: "FF_ORDER_" + Date.now()
      },
      success_url: SITE_URL + "/?payment=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: SITE_URL + "/?payment=cancelled"
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create Stripe Checkout Session:", err.message);
    return res.status(500).json({ error: "Secure checkout could not be started. Please try again." });
  }
});

app.get("/", (_req, res) => {
  res.type("text").send("FORM & FIELD payment service");
});

app.listen(PORT, () => console.log("FORM & FIELD payment service listening on", PORT));
