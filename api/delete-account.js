/* ============================================================
   Vercel serverless function — /api/delete-account
   ------------------------------------------------------------
   Deleting a login needs Supabase admin rights, which must never
   be exposed to a browser. This verifies the caller's own token
   first, so it can only ever delete the account that asked.

   Needs SUPABASE_SERVICE_ROLE_KEY in Vercel's environment
   variables (Supabase dashboard -> Settings -> API -> service_role).
   ============================================================ */

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL || "https://dklkiwltrtvqlbpzrmui.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_acGeTcCVhbZzqez5QxSUKw_xTG5b7t_";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

export default async function handler(req) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Diagnostic, so the setup can be checked without deleting anything.
  if (req.method !== "POST") {
    return json({ ok: true, serviceKeyFound: !!serviceKey, needs: "POST with your Authorization header" }, 405);
  }

  if (!serviceKey) {
    return json({ error: { message: "SUPABASE_SERVICE_ROLE_KEY is not set on the server." } }, 500);
  }

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({ error: { message: "Not signed in." } }, 401);
  }

  // Who is asking? The token itself proves it; never trust an id from the body.
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

  if (!user || !user.id) {
    return json({ error: { message: "Could not identify your account." } }, 401);
  }

  const admin = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json" };

  // Cancel any live subscription first. Without this a deleted account would
  // keep being charged every month with no way for them to stop it.
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY || process.env.STRIPE_KEY;
  if (stripeKey) {
    try {
      const look = await fetch(
        SB_URL + "/rest/v1/profiles?select=stripe_subscription_id&user_id=eq." + user.id,
        { headers: admin }
      );
      const rows = look.ok ? await look.json() : [];
      const subId = rows[0] && rows[0].stripe_subscription_id;
      if (subId) {
        await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subId), {
          method: "DELETE",
          headers: { "Authorization": "Bearer " + stripeKey }
        });
      }
    } catch (e) { /* deletion continues even if the cancel call fails */ }
  }

  // Their rows go first; the account delete cascades, but this keeps it tidy
  // even if the cascade is ever changed.
  try {
    await fetch(SB_URL + "/rest/v1/chat_sessions?user_id=eq." + user.id, { method: "DELETE", headers: admin });
    await fetch(SB_URL + "/rest/v1/question_usage?user_id=eq." + user.id, { method: "DELETE", headers: admin });
    await fetch(SB_URL + "/rest/v1/profiles?user_id=eq." + user.id, { method: "DELETE", headers: admin });
  } catch (e) { /* the account delete below is what matters */ }

  let res;
  try {
    res = await fetch(SB_URL + "/auth/v1/admin/users/" + user.id, { method: "DELETE", headers: admin });
  } catch (e) {
    return json({ error: { message: "Could not reach Supabase from the server." } }, 502);
  }

  if (!res.ok) {
    const text = await res.text();
    let message = "Supabase refused the deletion (" + res.status + ").";
    try { message = JSON.parse(text).msg || JSON.parse(text).message || message; } catch (e) {}
    return json({ error: { message: message } }, res.status);
  }

  return json({ deleted: true, email: user.email || null }, 200);
}
