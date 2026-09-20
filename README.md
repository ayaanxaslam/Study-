# Study Piolet — front-end

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

## Assets

- `assets/css/styles.css` — all styling, driven by CSS custom properties in `:root`
- `assets/js/theme-init.js` — applies the saved theme before first paint
- `assets/js/app.js` — theme toggle, mobile nav and sidebar, tabs, billing switch,
  auto-growing textareas, and carrying the dashboard question over to the chat page

## Run it

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>.

## No backend yet — on purpose

Nothing is wired to an API and no AI output is simulated:

- The chat page shows an empty state and a **message layout preview** with a
  skeleton where a reply would render. It never fabricates an answer.
- Forms do not submit. Log in / sign up buttons simply link to the dashboard so
  the flow can be clicked through.
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
