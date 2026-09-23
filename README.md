# RewardTutor — front-end

A static, no-build front end for an AI study app. Plain HTML, CSS and a little
vanilla JavaScript — open any page directly in a browser, or serve the folder.

## Pages

| File | What it is |
| --- | --- |
| `index.html` | Landing page — hero, features, how it works, testimonials, CTA |
| `login.html` | Combined log in / sign up (`login.html#signup` opens the sign-up tab) |
| `dashboard.html` | Main app screen with the large **“What do you need help with?”** input |
| `chat.html` | Ask AI screen — empty state, prompt starters, composer |
| `pricing.html` | Free and Plus plans, monthly/yearly switch, comparison table, FAQ |
| `settings.html` | Account, study preferences, appearance, notifications, billing, privacy |

## Structure

Each page is self-contained: the stylesheet and scripts are embedded in a `<style>`
and two `<script>` blocks inside every HTML file. There are no external asset files
to load, so a page renders correctly wherever it is opened — double-clicked from
Finder, previewed, emailed, or served.

Editing the design means editing the `<style>` block in the page you want to change
(they are identical copies of the same stylesheet).

## Run it

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## Connecting the AI

The chat is live. It calls the OpenAI Chat Completions API directly from the
browser and streams the reply into the page.

1. Open **Settings → Account → AI connection**.
2. Paste your OpenAI API key (`sk-...`) and pick a model (default `gpt-4o-mini`).
3. Press **Save and test** — it sends a one-token request and reports the result.

The key is stored in that browser's `localStorage` under `sp-openai-key`. It is
never written into these files, so each person who uses the site supplies their
own key and questions are billed to their own OpenAI account.

If you ever host this publicly, move the call behind a small server that holds
one key, rather than asking every visitor for theirs.

## Question counter

`sp-usage` in `localStorage` records `{month, used}` and drives the dashboard
card, the sidebar meter, the chat footer and the billing panel. It increments
only when an answer completes, never on an error, and resets by itself the first
time a page loads in a new month. The limit is `MONTHLY_LIMIT` in the page script.

Because it lives in browser storage, the count is per browser, not per account.
Real per-user limits need login plus a server — the login page is still UI only.

## Still front-end only

Nothing is wired to an API and no AI output is simulated:

- Log in / sign up do not authenticate; they link through to the dashboard.
- Numbers on the dashboard, pricing and settings are placeholder copy.
- The only real behaviour is navigation, theming and UI state.

The one piece of data flow that does exist: typing in the dashboard ask box sends
you to `chat.html?q=…`, which pre-fills the composer. Nothing is sent anywhere.

## Theming

Colours, radii and spacing live as variables at the top of `styles.css`. Dark mode
is a `data-theme="dark"` attribute on `<html>`; the choice (light / dark / system)
is stored in `localStorage` under `sp-theme` and is changeable from the header
toggle or Settings → Appearance.

## Wiring it up later

- Replace the `<form onsubmit="return false">` handlers in `login.html`.
- Give `chat.html` a real message list: render into `.chat-inner`, reusing the
  `.msg` / `.msg-avatar` / `.msg-body` markup already in the layout preview.
- The composer and ask box both submit through `initAsk()` in `app.js` — that is
  the single place to hook a request in.
