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
├── signin/               # the ONLY Access-protected path (sets the cookie)
├── _headers              # Cloudflare cache/security headers
└── _redirects            # Cloudflare routing (clean URLs are automatic)
```

## URL conventions

- **Tool** = folder: `tools.bantay.co/<tool>/` → `<tool>/index.html`.
- **Real static assets** = real paths, linked directly (best caching).
- **`?f=<name>`** = load a *shipped* asset (a preset/example committed to the
  repo), e.g. `…/mermaid?f=flowchart`. Sanitized/whitelisted before fetching.
- **`?id=<slug>`** = open one of *your saved* files (from D1) by slug, e.g.
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

## Saving to an account (Functions + D1 + Access)

The site and tools are **public**; only *saving* requires login. The model:

- `/api/*` is **not** gated at the edge, so requests always reach the Function,
  which returns a clean **401** when there's no valid session (no cross-origin
  login redirect to break `fetch`).
- `/signin` is the **only** Access-protected path. Visiting it authenticates the
  user and sets the domain-wide `CF_Authorization` cookie, then bounces back
  (`?next=`, same-origin only).
- The middleware reads that cookie on `/api` requests and verifies the JWT.
- Clients call `goSignIn()` (or link to `/signin?next=…`) when they hit a 401.

Tools load statically from Pages, then read/write saved files through
`/api/*` **Pages Functions** bound to **D1** (SQLite — strongly consistent, so a
save shows up immediately in lists; KV's eventual consistency made them lag).

### Autosave (shared across tools)

There is no Save button. `_shared/autosave.js` gives every tool one consistent
behaviour:

- Edits **autosave** automatically (debounced ~1s).
- **Signed in** → saves to your account (D1); **signed out** → saves to
  `localStorage` only, so you can always keep working and lose nothing.
- A fresh doc autosaves under `untitled`; setting/changing the **title** renames
  the saved doc to follow it (old key removed).

A tool wires it up by describing its state:

```js
const store = createStore({
  tool: "mermaid",
  draftKey: "bantay-mermaid-draft",
  getTitle: () => nameInput.value,      // drives the slug; rename on its `change`
  getPayload: () => ({ source: editor.value }),
  onStatus: showStatus,
});
editor.addEventListener("input", () => store.change());        // autosave
nameInput.addEventListener("change", () => store.rename());    // rename on commit
```

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

Rows are keyed by `(user_id, tool, slug)` (the composite primary key), so
collaborators never see each other's saves, and tools never see each other's (a
mermaid diagram and a style guide can share a slug without colliding). This is
account separation, not encryption — the operator can still read the database.

Client side: `import { listAssets, getAsset, saveAsset } from "/_shared/api.js"`
and pass your tool name first, e.g. `saveAsset("mermaid", slug, data)`.

### One-time setup (dashboard / CLI — not in this repo)

1. **D1 database:** `npx wrangler d1 create tools`, paste the `database_id` into
   `wrangler.toml`, then apply the schema:
   `npx wrangler d1 execute tools --remote --file=./schema.sql`.
2. **Cloudflare Access:** Zero Trust → Access → Applications → add a self-hosted
   app whose path is **`tools.bantay.co/signin`** (NOT the whole domain — the
   site stays public). Add a policy listing collaborator emails (or a
   Google/GitHub IdP). Copy the **Application Audience (AUD) Tag** and your team
   domain into `wrangler.toml` `[vars]` (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`).
3. **Deploy** (push to the connected repo, or `npx wrangler pages deploy .`).

## Local dev

**Static only** — view the tools, no save API (the `/api` calls 404 and degrade
quietly). Absolute imports (`/_shared/...`) need a root-served server:

```sh
npm run static            # python3 -m http.server 8000
# http://localhost:8000/style-guide/?f=bantay
```

**Full system** — Functions + D1, faithfully, via Miniflare. Access can't run
locally, so the middleware reads `DEV_USER` from `.dev.vars` to act as a fixed
signed-in user:

```sh
npm install                                            # gets wrangler
echo 'DEV_USER=dev@local' > .dev.vars                  # already created; gitignored
npx wrangler d1 execute tools --local --file=./schema.sql   # once, sets up local DB
npm run dev                                            # wrangler pages dev . --port 8788
# http://localhost:8788/style-guide/  → autosave + "My guides" now work
```

Local D1 persists under `.wrangler/`. Change `DEV_USER` to a different value to
verify account separation (saves land under a different `user_id`).
