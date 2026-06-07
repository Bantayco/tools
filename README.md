# Bantay Tools

Static micro-apps hosted on Cloudflare Pages at `tools.bantay.co`.
Each tool is a self-contained folder served at its own path — **no build step**.

```
helpers/
├── index.html            # dashboard: your files + "start new" (see home.js)
├── home.js               # dashboard logic; TOOLS registry lives here
├── _shared/              # shared, served as-is (underscore = not a tool)
│   ├── tokens.css        # LIVE design system — every tool links this
│   ├── base.css          # reset + element defaults wired to tokens
│   ├── util.js           # common helpers (the ?f= asset loader, etc.)
│   └── tokens/           # saved token sets the style-guide loads via ?f=
│       └── bantay.json
├── style-guide/          # a tool: /style-guide/  (asset: token set)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── mermaid/              # a tool: /mermaid/  (asset: .mmd file)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── examples/         # shipped diagrams loaded via ?f=<name>
├── _headers              # Cloudflare cache/security headers
└── _redirects            # Cloudflare routing (clean URLs are automatic)
```

## URL conventions

- **Tool** = folder: `tools.bantay.co/<tool>/` → `<tool>/index.html`.
- **Real static assets** = real paths, linked directly (best caching).
- **`?f=<name>`** = load a *shipped* asset (a preset/example committed to the
  repo), e.g. `…/mermaid?f=flowchart`. Sanitized/whitelisted before fetching.
- **`?id=<slug>`** = open one of *your saved* files (from KV) by slug, e.g.
  `…/mermaid?id=onboarding`. This is what the dashboard links to.
- **`?new`** = start a fresh file (ignore localStorage and load defaults).
- Precedence on load: `?id` > `?f` > localStorage/default.

The **root dashboard** (`/`) lists your files across all tools via
`GET /api/assets`, and its "start new" cards link to `<tool>/?new=1`. Add a tool
to the `TOOLS` registry in `home.js` and it appears automatically.

## Adding a tool

1. `mkdir <tool>` with its own `index.html` + assets.
2. In the `<head>`, link the design system:
   ```html
   <link rel="stylesheet" href="/_shared/tokens.css">
   <link rel="stylesheet" href="/_shared/base.css">
   <link rel="stylesheet" href="./styles.css">
   ```
3. Need `?f=`? `import { getAssetParam, loadTokenSet } from "/_shared/util.js";`
4. Add a `<li>` for it in the root `index.html`.

## The design-system loop (meta)

The **style-guide** tool is the editor; its **output** is the design system.
Export a set's CSS → commit to `_shared/tokens.css` (what all tools link).
Export/save a set's JSON → `_shared/tokens/<name>.json` (what the editor
reloads via `?f=`). The style guide thus produces the very tokens every
tool — including itself — consumes.

## Saving to an account (Functions + KV + Access)

Tools load statically from Pages, then read/write saved files through
`/api/*` **Pages Functions** bound to **KV**, gated by **Cloudflare Access**.

```
functions/api/
├── _lib.js            # json(), slug sanitize, Access JWT verification
├── _middleware.js     # auth: sets context.data.userId from the Access JWT
└── assets/
    ├── index.js       # GET  /api/assets                 ALL my items (dashboard)
    └── [tool]/
        ├── index.js   # GET  /api/assets/:tool           list one tool's items
        └── [slug].js  # GET/PUT/DELETE /api/assets/:tool/:slug
```

KV keys are namespaced `"<userId>:<tool>:<slug>"`, so collaborators never see
each other's saves, and tools never see each other's (a mermaid diagram and a
style guide can share a slug without colliding). This is account separation, not
encryption — the operator can still read KV.

Client side: `import { listAssets, getAsset, saveAsset } from "/_shared/api.js"`
and pass your tool name first, e.g. `saveAsset("mermaid", slug, data)`.

### One-time setup (dashboard / CLI — not in this repo)

1. **KV namespace:** `npx wrangler kv namespace create GUIDES`, then paste the
   id into `wrangler.toml`.
2. **Cloudflare Access:** Zero Trust → Access → Applications → add a self-hosted
   app for `tools.bantay.co`. Add a policy listing collaborator emails (or a
   Google/GitHub IdP). Copy the **Application Audience (AUD) Tag** and your team
   domain into `wrangler.toml` `[vars]`.
3. **Deploy** (push to the connected repo, or `npx wrangler pages deploy .`).

## Local dev

**Static only** — view the tools, no save API (the `/api` calls 404 and degrade
quietly). Absolute imports (`/_shared/...`) need a root-served server:

```sh
npm run static            # python3 -m http.server 8000
# http://localhost:8000/style-guide/?f=bantay
```

**Full system** — Functions + KV, faithfully, via Miniflare. Access can't run
locally, so the middleware reads `DEV_USER` from `.dev.vars` to act as a fixed
signed-in user:

```sh
npm install               # gets wrangler
echo 'DEV_USER=dev@local' > .dev.vars   # already created; gitignored
npm run dev               # wrangler pages dev . --kv GUIDES --port 8788
# http://localhost:8788/style-guide/  → Save + "My guides" now work
```

Local KV persists under `.wrangler/`. Change `DEV_USER` to a different value to
verify account separation (saves land under a new `<userId>:` prefix).
