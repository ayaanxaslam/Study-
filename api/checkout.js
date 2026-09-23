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

const SB_URL  = process.env.SUPABASE_URL || "https://dklkiwltrtvqlbpzrmui.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_acGeTcCVhbZzqez5QxSUKw_xTG5b7t_";

const PLANS = {
  plus: {
    name: "RewardTutor Plus",
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

  // Who is paying? Taken from their verified session, never from the request
  // body, or one person could put a payment against someone else's account.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: { message: "Sign in before upgrading." } }, 401);

  let user;
  try {
    const who = await fetch(SB_URL + "/auth/v1/user", {
      headers: { "apikey": SB_ANON, "Authorization": "Bearer " + token }
    });
    if (!who.ok) return json({ error: { message: "Your session has expired. Sign in again." } }, 401);
    user = await who.json();
  } catch (e) {
    return json({ error: { message: "Could not verify your session." } }, 502);
  }
  if (!user || !user.id) return json({ error: { message: "Could not identify your account." } }, 401);

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

  // Ties the payment to the verified account, not to anything the page sent.
  if (user.email) form.set("customer_email", user.email);
  form.set("client_reference_id", user.id);

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
