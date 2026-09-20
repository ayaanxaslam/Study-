export const config = { runtime: "edge" };

const MAX_MESSAGES = 40;
const MAX_CHARS    = 8000;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" }
  });
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ ok: true, note: "POST { model, messages } to use this endpoint." }, 405);
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return json({ error: { message: "OPENAI_API_KEY is not set on the server." } }, 500);
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
    try { message = JSON.parse(text).error.message || message; } catch (e) {}
    return json({ error: { message: message } }, upstream.status);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}
