/* ============================================================
   Vercel serverless function — /api/checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session and hands the browser a URL
   to send the customer to. The Stripe secret key stays here and
   never reaches the page.

   Needs STRIPE_SECRET_KEY in Vercel's environment variables.

   A GET returns a short diagnostic (no secrets) so you can check
   the setup from a browser: /api/checkout
   ============================================================ */

export const config = { runtime: "edge" };

const PLANS = {
  plus: {
    name: "Study Piolet Plus",
    blurb: "Unlimited questions, uploads and adaptive quizzes",
    monthly: 900,   // in cents
    yearly:  7200
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

function secret() {
  return process.env.STRIPE_SECRET_KEY ||
         process.env.STRIPE_API_KEY ||
         process.env.STRIPE_KEY || null;
}

export default async function handler(req) {
  const key = secret();

  // Diagnostic view: says what is configured without revealing anything.
  if (req.method !== "POST") {
    return json({
      ok: true,
      stripeKeyFound: !!key,
      mode: key ? (key.startsWith("sk_live") ? "live" : "test") : null,
      checkedNames: ["STRIPE_SECRET_KEY", "STRIPE_API_KEY", "STRIPE_KEY"],
      plans: Object.keys(PLANS)
    }, 200);
  }

  if (!key) {
    return json({ error: { message: "No Stripe secret key on the server. Add STRIPE_SECRET_KEY in Vercel and redeploy." } }, 500);
  }

  let body;
  try { body = await req.json(); }
  catch (e) { return json({ error: { message: "Request body was not valid JSON." } }, 400); }

  const plan = PLANS[body.plan] || PLANS.plus;
  const yearly = body.interval === "year";
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("success_url", origin + "/settings.html?checkout=success#billing");
  form.set("cancel_url", origin + "/pricing.html?checkout=cancelled");
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][product_data][name]", plan.name);
  form.set("line_items[0][price_data][product_data][description]", plan.blurb);
  form.set("line_items[0][price_data][unit_amount]", String(yearly ? plan.yearly : plan.monthly));
  form.set("line_items[0][price_data][recurring][interval]", yearly ? "year" : "month");
  form.set("allow_promotion_codes", "true");

  // Ties the payment back to the signed-in account.
  if (body.email)  form.set("customer_email", String(body.email).slice(0, 200));
  if (body.userId) form.set("client_reference_id", String(body.userId).slice(0, 200));

  let res;
  try {
    res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
  } catch (e) {
    return json({ error: { message: "Could not reach Stripe from the server." } }, 502);
  }

  const data = await res.json();
  if (!res.ok) {
    return json({ error: { message: (data.error && data.error.message) || "Stripe rejected the request." } }, res.status);
  }

  return json({ url: data.url }, 200);
}
