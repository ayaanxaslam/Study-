/* ============================================================
   Vercel serverless function — /api/chat
   ------------------------------------------------------------
   Holds the OpenAI key server-side so it never reaches the
   browser. Set OPENAI_API_KEY in your Vercel project settings
   (Settings -> Environment Variables), then redeploy.

   The browser posts { model, messages } here; this forwards it
   to OpenAI with the key attached and streams the reply back.
   ============================================================ */

export const config = { runtime: "edge" };

const MAX_MESSAGES  = 40;     // keeps one conversation from growing unbounded
const MAX_CHARS     = 8000;   // per message, guards against huge pastes
const FREE_LIMIT    = 30;     // questions per calendar month on the free plan
const PLUS_LIMIT    = 1000;   // a ceiling on "unlimited", so one account cannot
                              // run up an unbounded OpenAI bill. Raise if needed.

// Short-window limits, on top of the monthly allowance. These stop one person
// (or one machine making many accounts) hammering the endpoint.
const PER_USER_MAX    = 12;   // requests
const PER_USER_WINDOW = 60;   // seconds
// Deliberately generous: a whole school or library shares one connection, so a
// low number here would lock out a classroom. Real cost control is the monthly
// per-account cap; this only slows down scripted abuse.
const PER_IP_MAX      = 200;  // requests
const PER_IP_WINDOW   = 600;  // seconds

const SB_URL  = process.env.SUPABASE_URL || "https://dklkiwltrtvqlbpzrmui.supabase.co";
const SB_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_acGeTcCVhbZzqez5QxSUKw_xTG5b7t_";

/* IPs are hashed before being stored, so the table never holds an address in
   the clear but can still recognise a repeat caller. */
async function hashIp(ip) {
  const data = new TextEncoder().encode("studydrill:" + ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).slice(0, 16)
    .map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

async function bump(bucket, windowSeconds, serviceKey) {
  const res = await fetch(SB_URL + "/rest/v1/rpc/bump_rate_limit", {
    method: "POST",
    headers: {
      "apikey": serviceKey,
      "Authorization": "Bearer " + serviceKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_bucket: bucket, p_window_seconds: windowSeconds })
  });
  if (!res.ok) return 0;              // never block on the limiter failing
  return parseInt(await res.text(), 10) || 0;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

export default async function handler(req) {
  // A GET is how the front end checks whether this function exists at all.
  if (req.method !== "POST") {
    return json({ ok: true, note: "POST { model, messages } to use this endpoint." }, 405);
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return json({ error: { message: "OPENAI_API_KEY is not set on the server. Add it in Vercel and redeploy." } }, 500);
  }

  // Only signed-in accounts may spend the key. Without this the endpoint is
  // open to anyone who finds the URL.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json({ error: { message: "Sign in to ask a question." } }, 401);
  }

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

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Burst limits first: cheapest checks, and they run before any spending.
  if (serviceKey) {
    const rawIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    try {
      const ipKey = await hashIp(rawIp);
      const [userHits, ipHits] = await Promise.all([
        bump("user:" + user.id, PER_USER_WINDOW, serviceKey),
        bump("ip:" + ipKey,     PER_IP_WINDOW,   serviceKey)
      ]);

      if (userHits > PER_USER_MAX) {
        return json({ error: { message: "That is a lot of questions at once. Wait a minute and try again." } }, 429);
      }
      if (ipHits > PER_IP_MAX) {
        return json({ error: { message: "Too many requests from this connection. Try again shortly." } }, 429);
      }
    } catch (e) { /* a limiter failure must not take the chat down */ }
  }

  // Plan and usage are read server-side, and the month comes from the database
  // clock, so neither a device clock nor edited browser storage can lift the cap.
  let plan = "free";
  let used = 0;

  if (serviceKey) {
    const admin = { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey };
    try {
      const [pRes, uRes] = await Promise.all([
        fetch(SB_URL + "/rest/v1/profiles?select=plan&user_id=eq." + user.id, { headers: admin }),
        fetch(SB_URL + "/rest/v1/rpc/current_question_usage", {
          method: "POST",
          headers: { "apikey": SB_ANON, "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          body: "{}"
        })
      ]);
      const pRows = pRes.ok ? await pRes.json() : [];
      if (pRows[0] && pRows[0].plan === "plus") plan = "plus";
      if (uRes.ok) used = parseInt(await uRes.text(), 10) || 0;
    } catch (e) { /* fall through on the free limit below */ }
  }

  if (plan !== "plus" && used >= FREE_LIMIT) {
    return json({ error: {
      message: "You have used all " + FREE_LIMIT + " free questions this month. Your allowance resets on the 1st."
    } }, 402);
  }

  if (plan === "plus" && used >= PLUS_LIMIT) {
    return json({ error: {
      message: "This account has hit its fair-use ceiling of " + PLUS_LIMIT + " questions this month. Get in touch if you need more."
    } }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: { message: "Request body was not valid JSON." } }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : null;
  if (!messages || !messages.length) {
    return json({ error: { message: "No messages were sent." } }, 400);
  }
  for (const m of messages) {
    if (typeof m.content === "string" && m.content.length > MAX_CHARS) {
      return json({ error: { message: "That message is too long." } }, 400);
    }
  }

  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        model: typeof body.model === "string" && body.model ? body.model : "gpt-4o-mini",
        stream: true,
        messages: messages
      })
    });
  } catch (e) {
    return json({ error: { message: "Could not reach OpenAI from the server." } }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    let message = "OpenAI returned an error (" + upstream.status + ").";
    try { message = JSON.parse(text).error.message || message; } catch (e) { /* keep default */ }
    return json({ error: { message: message } }, upstream.status);
  }

  // The answer is on its way, so count it. Done here rather than in the browser
  // so the number cannot be edited by the person being counted.
  try {
    await fetch(SB_URL + "/rest/v1/rpc/increment_question_usage", {
      method: "POST",
      headers: { "apikey": SB_ANON, "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: "{}"
    });
  } catch (e) { /* never fail the answer over the counter */ }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    }
  });
}
