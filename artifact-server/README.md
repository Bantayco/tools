# Bantay Artifact Server

Live pages addressed by UUID. Two passcodes per page (view, owner). Live sync
over hibernating WebSockets. By default the server stores only ciphertext.

This is a **standalone Cloudflare Worker** with Durable Objects. It is not part of the
Pages site in the repo root. Deploy it from this folder to its own origin, for example
`artifacts.bantay.co`, so its cookies stay separate from `tools.bantay.co`.

```
artifact-server/
├── wrangler.toml          # Worker + DO bindings + static assets
├── src/
│   ├── index.js           # router: page shells, session API, publish/admin API
│   ├── session.js         # SessionDO — one per page UUID (state, log, doc, tokens, sockets)
│   ├── registry.js        # RegistryDO — immutable page versions, app pointers, session index
│   ├── schema.js          # add-only schema validation + diff (enforced at publish)
│   ├── mcp.js             # MCP endpoint (Streamable HTTP, JSON responses)
│   ├── stubs.js / util.js
├── public/_bantay/
│   ├── client.js          # browser library injected into every page
│   ├── admin.html         # /admin
│   └── vendor/            # Yjs + QR generator, bundled by `npm run vendor`
├── apps/picks/index.html  # first tenant: football picks pool
├── scripts/publish.mjs    # CLI publish
├── test/                  # node unit tests (schema rules)
└── e2e/                   # Playwright tests against wrangler dev
```

## How it works

**Pages and sessions are separate.** An *app* is published HTML (for example `picks`). Each
version is stored immutably under its SHA-256 hash and never deleted. A per-app pointer
names the current version. A *session* is one UUID's data for an app. One published
version serves every session.

```
/picks                    Blank: no UUID; edits stay local until the first save
/picks?id=<uuidv4>        Locked → Viewer / Owner (by token cookie or passcode)
/picks/v/<hash>?id=…      a specific version (sessions can pin one)
```

| state  | condition              | access                       |
|--------|------------------------|------------------------------|
| Blank  | no UUID / unknown UUID | empty page, nothing saved    |
| Locked | UUID, no valid token   | empty shell; no state sent   |
| Viewer | view token             | read, live updates           |
| Owner  | owner token            | read, write, sync            |

The built-in bar in the corner of every page handles the transitions:

- **Save** (Blank) sets both passcodes. The server mints the UUID and an owner token. The
  URL updates through `history.replaceState`, and local edits are uploaded.
- **Unlock** checks one typed passcode against both roles.
- **⋯ → Pair a device** shows a QR code holding a single-use code that expires in about 60
  seconds. The new device redeems it only after the user taps **Pair**.
- **⋯ → Sign out other devices** revokes every other token.

### Encryption

These steps apply when the page schema sets `"encryption": "e2e"`, which is the default.

1. The browser creates a random AES-256 data key (DEK). It encrypts state, log entries and
   Yjs updates. The AAD binds each item to its session and position.
2. The browser stretches each passcode with PBKDF2-SHA256 (600k iterations, per-session
   random salt) into a wrapping key and a verifier.
3. The server stores a salted SHA-256 of each verifier, and the DEK wrapped by each
   wrapping key. It never sees a passcode or the DEK.
4. The DEK stays on the device in IndexedDB. Pairing wraps it with a one-time secret that
   travels only in the QR link's `#fragment`. The fragment is never sent to the server.

> The slow hash runs in the browser because Workers cap PBKDF2 and have tight CPU limits.
> Someone holding the stored hashes must still run 600k PBKDF2 rounds per guess. Online
> guessing is rate-limited per session: 5 free attempts, then exponential lockouts
> starting at 30s and capped at 1h.

### Data channels (all in the session's Durable Object)

| channel | client API | conflict rule |
|---|---|---|
| state | `bantay.save(updater)` | Each save names its base version. A stale base is rejected, and the client re-runs the updater against the winning state. |
| numbered log | `bantay.append(type, data, {n})` | The first write of number N wins. Others get `ConflictError({head})`. Use it for moves, votes and picks. Moves never go into Yjs. |
| Yjs doc | `await bantay.doc()` | Concurrent edits merge. Use it for chat and notes. The server stores and relays opaque updates, and clients compact them into encrypted snapshots. |
| presence | `bantay.presence(data)` / `on("presence")` | Relayed only, never stored. |

### Page updates (publish → schema check → promote → notify)

1. **Publish.** Upload HTML with the **publish key**, which is separate from both
   passcodes. You can use the CLI, the admin page, `POST /api/apps/<app>/versions`, or
   MCP.
2. **Schema check.** The server compares the declared schema against *every* earlier
   version of the app. Breaking changes are rejected with 422.
3. **Promote.** The pointer flips in one write. Rolling back moves the pointer to an older
   hash.
4. **Notify.** Open sessions receive `version`. The client reloads once nothing is in
   flight, unless the page handles `bantay.on("version", …)` itself.

### Session data schema (add-only, proto-style)

Each page declares its schema in its HTML:

```html
<script type="application/json" id="bantay-schema">
{
  "encryption": "e2e",
  "state": {
    "title":   { "type": "string", "default": "Picks Pool" },
    "players": { "type": "array",  "default": [] },
    "legacy":  { "type": "number", "default": 0, "deprecated": true }
  },
  "log": {
    "pick": { "fields": { "team": { "type": "string", "default": "" } } }
  }
}
</script>
```

The available types are `string number boolean object array map any`. The server enforces
these rules at publish time:

- Fields can only be added. They are never removed, renamed or retyped.
- Every field declares a default.
- Deprecated fields stay listed, and their names are never reused.
- Log entry types follow the same rules.

The client fills in defaults for missing fields and keeps unknown fields when it saves. A
pinned older version therefore never drops fields that a newer version added.

## Writing a page

```html
<script type="module">
import { bantay } from "/_bantay/client.js";   // injected anyway; importing gives you the instance
const render = () => { /* bantay.state, bantay.log, bantay.role, bantay.canWrite */ };
bantay.on("state", render); bantay.on("log", render); bantay.on("role", render);
await bantay.ready; render();
// writes
await bantay.save((s) => ({ ...s, title: "Week 3" }));
await bantay.append("pick", { team: "KC" });
const chat = (await bantay.doc()).getArray("chat");
</script>
```

Pages are served with a strict CSP. Scripts, connections and images must come from the
same origin, apart from inline code, `data:`/`blob:` images and Google Fonts. Pages
therefore load nothing from third-party CDNs. Vendor any library into
`public/_bantay/vendor/`.

## MCP

Endpoint: `POST https://<host>/mcp` (Streamable HTTP, stateless, JSON responses).

| tool | auth |
|---|---|
| `list_apps`, `list_versions`, `get_version`, `publish_version`, `promote_version` | `Authorization: Bearer <PUBLISH_KEY>` |
| `read_session`, `save_state`, `append_log` | `token` argument: an **agent token** from the page's ⋯ → *Connect an LLM* |

This answers the "MCP vs end-to-end encryption" question: **only pages declared
`"encryption": "none"` can mint agent tokens.** Keys for e2e pages never leave browsers,
so no server-side agent can read or write them. An LLM can still publish code for any
page.

## Admin

`/admin` takes the admin key, plus the publish key for publish, promote and roll back. The
keys are kept in sessionStorage. From the page you can:

- list apps, versions and sessions
- view a session's tokens and counters, but not its data
- **mint a single-use owner link** (valid for 24h) for a session whose devices were all
  lost

On e2e pages that link restores owner *access*. Someone still has to enter a passcode on
the device to decrypt.

## Security rules, as implemented

- The cookie holds a random 256-bit token, never the passcode. It is `HttpOnly; Secure;
  SameSite=Strict` and scoped to `Path=/api/s/<id>`. The server stores only the token's
  SHA-256.
- Cookie-authenticated POSTs and WebSocket upgrades must carry this origin's `Origin`
  header.
- The page HTML never contains session data. State arrives over the socket only after the
  token is checked.
- Every response carries `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, and
  `robots.txt` disallows everything. Pages also get a CSP, `frame-ancestors 'none'`, and
  COOP.
- Session IDs are `crypto.randomUUID()` (v4). Other IDs are rejected.
- No GET creates or redeems anything. Pairing and claim codes are single-use and short-lived,
  and are redeemed by POST after a tap.
- The publish key is separate from both passcodes and from the admin key. Versions are
  immutable and never deleted.
- Revoked tokens stop working at once: every write re-checks the token, and open sockets
  are closed.

## Open questions: what was decided here

| question | choice in this build |
|---|---|
| Game validation | Clients validate. The numbered log orders moves (first write of N wins) and works with e2e. Server-validated games are not built. |
| Seats for games | Not built. Owner tokens can write anything; viewers can only read. |
| Passcode scope | One pair of passcodes per page (session). |
| MCP vs e2e | Per app, through `encryption`: `none` pages are MCP-editable, `e2e` pages are not. |

## Setup

```sh
cd artifact-server
npm install
npx wrangler secret put PUBLISH_KEY      # long random string
npx wrangler secret put ADMIN_KEY        # a different long random string
# optional: uncomment `routes` in wrangler.toml for a custom domain
npm run deploy
PUBLISH_KEY=... node scripts/publish.mjs picks apps/picks/index.html --promote --url https://artifacts.bantay.co
```

## Local dev & tests

```sh
printf 'PUBLISH_KEY=dev-publish\nADMIN_KEY=dev-admin\n' > .dev.vars   # gitignored
npm run dev                                                            # http://127.0.0.1:8787
PUBLISH_KEY=dev-publish node scripts/publish.mjs picks apps/picks/index.html --promote
open http://127.0.0.1:8787/picks

npm test            # schema rules (node:test)
npm run test:e2e    # Playwright against wrangler dev; full flows incl. pairing, conflicts, MCP
                    # (PW_CHROMIUM=/path/to/chrome to use a preinstalled browser)
npm run vendor      # rebuild public/_bantay/vendor after bumping yjs / qrcode-generator
```
