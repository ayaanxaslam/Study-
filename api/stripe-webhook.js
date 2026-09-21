/* ============================================================
   Vercel serverless function — /api/stripe-webhook
   ------------------------------------------------------------
   Stripe calls this when a payment succeeds or a subscription
   ends, and it records the plan against the user in Supabase.

   Needs, in Vercel:
     STRIPE_WEBHOOK_SECRET      (Stripe -> Developers -> Webhooks)
     SUPABASE_SERVICE_ROLE_KEY  (already set for account deletion)

   In Stripe, add an endpoint pointing at /api/stripe-webhook and
   subscribe to: checkout.session.completed,
   customer.subscription.updated, customer.subscription.deleted
   ============================================================ */

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL || "https://dklkiwltrtvqlbpzrmui.supabase.co";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status, headers: { "Content-Type": "application/json" }
  });
}

/* Stripe signs "timestamp.body" with the endpoint secret. Recomputing it here
   is what stops anyone from POSTing a fake "they paid" event. */
async function signatureValid(rawBody, header, secret) {
  if (!header) return false;

  const parts = {};
  header.split(",").forEach(function (piece) {
    const [k, v] = piece.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  });
  if (!parts.t || !parts.v1) return false;

  // Reject anything older than five minutes, so a captured request
  // cannot be replayed later.
  const age = Math.abs(Math.floor(Date.now() / 1000) - parseInt(parts.t, 10));
  if (!isFinite(age) || age > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(parts.t + "." + rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");

  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function saveProfile(row) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return fetch(SB_URL + "/rest/v1/profiles?on_conflict=user_id", {
    method: "POST",
    headers: {
      "apikey": serviceKey,
      "Authorization": "Bearer " + serviceKey,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(row)
  });
}

export default async function handler(req) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (req.method !== "POST") {
    return json({
      ok: true,
      webhookSecretFound: !!secret,
      serviceKeyFound: !!process.env.SUPABASE_SERVICE_ROLE_KEY
    }, 405);
  }

  if (!secret) return json({ error: "STRIPE_WEBHOOK_SECRET is not set." }, 500);

  const raw = await req.text();
  const ok = await signatureValid(raw, req.headers.get("stripe-signature"), secret);
  if (!ok) return json({ error: "Bad signature." }, 400);

  let event;
  try { event = JSON.parse(raw); }
  catch (e) { return json({ error: "Bad JSON." }, 400); }

  const obj = (event.data && event.data.object) || {};

  try {
    if (event.type === "checkout.session.completed") {
      // client_reference_id is the Supabase user id the site sent at checkout.
      const userId = obj.client_reference_id;
      if (!userId) return json({ received: true, note: "no user id on session" }, 200);

      await saveProfile({
        user_id: userId,
        plan: "plus",
        stripe_customer_id: obj.customer || null,
        stripe_subscription_id: obj.subscription || null,
        updated_at: new Date().toISOString()
      });
      return json({ received: true, upgraded: userId }, 200);
    }

    if (event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted") {
      const dead = event.type === "customer.subscription.deleted" ||
                   ["canceled", "unpaid", "incomplete_expired"].indexOf(obj.status) !== -1;
      if (!dead) return json({ received: true }, 200);

      // Find whose subscription this is, then drop them back to free.
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const look = await fetch(
        SB_URL + "/rest/v1/profiles?select=user_id&stripe_subscription_id=eq." + encodeURIComponent(obj.id),
        { headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey } }
      );
      const rows = look.ok ? await look.json() : [];
      if (!rows.length) return json({ received: true, note: "no matching profile" }, 200);

      await saveProfile({
        user_id: rows[0].user_id,
        plan: "free",
        stripe_subscription_id: null,
        updated_at: new Date().toISOString()
      });
      return json({ received: true, downgraded: rows[0].user_id }, 200);
    }
  } catch (e) {
    // A 500 tells Stripe to retry, which is what we want on a transient failure.
    return json({ error: String(e.message || e) }, 500);
  }

  return json({ received: true, ignored: event.type }, 200);
}
