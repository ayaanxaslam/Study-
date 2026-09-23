/* ============================================================
   Vercel serverless function — /api/portal
   ------------------------------------------------------------
   Opens Stripe's own billing portal for the signed-in customer,
   where they can change card, see invoices, or cancel.

   Cancelling there fires customer.subscription.updated /
   .deleted, which /api/stripe-webhook already handles by moving
   the account back to the free plan. Nothing to do here for it.

   Needs, in Vercel:
     STRIPE_SECRET_KEY
     SUPABASE_SERVICE_ROLE_KEY
   Also needs the portal switched on once, in Stripe:
     Settings -> Billing -> Customer portal -> activate
   ============================================================ */

export const config = { runtime: "edge" };

const SB_URL  = process.env.SUPABASE_URL || "https://dklkiwltrtvqlbpzrmui.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_acGeTcCVhbZzqez5QxSUKw_xTG5b7t_";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status, headers: { "Content-Type": "application/json" }
  });
}

function stripeKey() {
  return process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || process.env.STRIPE_KEY || null;
}

export default async function handler(req) {
  const key = stripeKey();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (req.method !== "POST") {
    return json({ ok: true, stripeKeyFound: !!key, serviceKeyFound: !!serviceKey }, 405);
  }
  if (!key)        return json({ error: { message: "Stripe is not configured on the server." } }, 500);
  if (!serviceKey) return json({ error: { message: "SUPABASE_SERVICE_ROLE_KEY is not set." } }, 500);

  // Identify the caller from their own token, never from the request body.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: { message: "Not signed in." } }, 401);

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

  // Which Stripe customer is this account?
  let customerId = null;
  try {
    const look = await fetch(
      SB_URL + "/rest/v1/profiles?select=stripe_customer_id&user_id=eq." + user.id,
      { headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey } }
    );
    const rows = look.ok ? await look.json() : [];
    customerId = rows[0] && rows[0].stripe_customer_id;
  } catch (e) { /* handled below */ }

  if (!customerId) {
    return json({ error: { message: "There is no subscription on this account to manage." } }, 404);
  }

  // Belt and braces: only open the portal if Stripe actually has a live or
  // recently-ended subscription for this customer.
  try {
    const subs = await fetch(
      "https://api.stripe.com/v1/subscriptions?customer=" + encodeURIComponent(customerId) + "&status=all&limit=1",
      { headers: { "Authorization": "Bearer " + key } }
    );
    const data = subs.ok ? await subs.json() : { data: [] };
    if (!data.data || !data.data.length) {
      return json({ error: { message: "There is no subscription on this account to manage." } }, 404);
    }
  } catch (e) { /* if the check itself fails, fall through to the portal */ }

  const origin = req.headers.get("origin") || new URL(req.url).origin;
  const form = new URLSearchParams();
  form.set("customer", customerId);
  form.set("return_url", origin + "/settings.html#billing");

  let res;
  try {
    res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
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
    return json({ error: { message: (data.error && data.error.message) || "Stripe refused the request." } }, res.status);
  }

  return json({ url: data.url }, 200);
}
