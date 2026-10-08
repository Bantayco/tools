// Bantay Artifact Server — Worker entry.
//
//   GET  /<app>                     page shell: current version's HTML (no state)
//   GET  /<app>/v/<hash>            a specific immutable version (pinning)
//   GET  /admin                     admin page (keys entered in-page)
//   GET  /_bantay/*                 client library + vendored libs
//
//   POST /api/sessions              first save: mint UUID + owner token
//   GET  /api/s/<id>/meta           public salts for a Locked visitor
//   GET  /api/s/<id>/whoami         role for this device's token cookie
//   POST /api/s/<id>/unlock         passcode -> token cookie
//   POST /api/s/<id>/pair           owner: single-use pairing code (~60s)
//   POST /api/s/<id>/redeem         redeem pairing / admin claim code
//   POST /api/s/<id>/agent-token    owner: MCP token (plaintext pages only)
//   POST /api/s/<id>/pin            owner: pin to a version (or null)
//   POST /api/s/<id>/signout        forget this device
//   POST /api/s/<id>/revoke-others  owner: sign out every other device
//   GET  /api/s/<id>/ws             live sync (WebSocket, hibernating)
//
//   (Bearer PUBLISH_KEY)  GET /api/apps, GET /api/apps/<app>/versions[/<hash>],
//                         POST /api/apps/<app>/versions, POST /api/apps/<app>/promote
//   (Bearer ADMIN_KEY)    GET /api/admin/sessions, GET /api/admin/s/<id>,
//                         POST /api/admin/s/<id>/claim
//   POST /mcp             MCP (Streamable HTTP, JSON responses)
//
// Cookie-authenticated POSTs must come from this origin (plus SameSite=Strict).
// No GET creates or redeems anything.

import { handleMcp } from "./mcp.js";
import { registry, session } from "./stubs.js";
import {
  APP_NAME, HASH, HttpError, RESERVED_APPS, UUID_V4,
  clearTokenCookie, hasKey, json, parseCookies, readJson, tokenCookie, unwrap,
} from "./util.js";

export { SessionDO } from "./session.js";
export { RegistryDO } from "./registry.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function secure(response) {
  const r = new Response(response.body, response);
  const h = r.headers;
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if ((h.get("content-type") || "").includes("text/html")) h.set("Content-Security-Policy", CSP);
  return r;
}

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  return origin && origin === new URL(request.url).origin;
}

function requireSameOrigin(request) {
  if (!sameOrigin(request)) throw new HttpError(403, "cross-origin request refused");
}

function cookieToken(request) {
  return parseCookies(request.headers.get("cookie")).bt || null;
}

/** Inject the page's identity + client library into the version's HTML. */
function shell(app, version) {
  const meta = JSON.stringify({ app, version: version.hash }).replace(/</g, "\\u003c");
  const inject =
    `<meta name="robots" content="noindex, nofollow">` +
    `<meta name="referrer" content="no-referrer">` +
    `<script type="application/json" id="bantay-page">${meta}</script>` +
    `<script type="module" src="/_bantay/client.js"></script>`;
  const html = version.html;
  const i = html.search(/<head[^>]*>/i);
  if (i < 0) return inject + html;
  const end = html.indexOf(">", i) + 1;
  return html.slice(0, end) + inject + html.slice(end);
}

async function servePage(env, app, hash) {
  const v = await registry(env).getVersion(app, hash);
  if (!v) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(shell(app, v), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Versions are immutable; the current pointer must always revalidate.
      "cache-control": hash ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

async function sessionApi(request, env, id, action) {
  if (!UUID_V4.test(id)) throw new HttpError(404, "unknown session");
  const s = session(env, id);

  if (action === "ws") {
    if (request.headers.get("upgrade") !== "websocket") throw new HttpError(426, "expected websocket");
    requireSameOrigin(request);
    const meta = await s.meta();
    if (!meta) throw new HttpError(404, "unknown session");
    const cur = await registry(env).currentSchema(meta.app);
    const headers = new Headers(request.headers);
    if (cur) headers.set("x-bantay-version", cur.hash);
    return s.fetch(new Request(request.url, { headers }));
  }

  if (action === "meta" && request.method === "GET") {
    const meta = await s.meta();
    if (!meta) throw new HttpError(404, "unknown session");
    return json(meta);
  }

  if (action === "whoami" && request.method === "GET") {
    const who = await s.whoami(cookieToken(request));
    if (!who) throw new HttpError(401, "not signed in");
    return json(who);
  }

  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  requireSameOrigin(request);
  const body = await readJson(request);
  const token = cookieToken(request);

  switch (action) {
    case "unlock": {
      const r = unwrap(await s.unlock({ verifiers: body.verifiers, keyOnly: !!body.keyOnly }, token));
      const headers = r.token ? { "set-cookie": tokenCookie(id, r.token) } : {};
      return json({ role: r.role, wrapped: r.wrapped }, 200, headers);
    }
    case "redeem": {
      const r = unwrap(await s.redeem(body.code));
      return json({ role: r.role, wrapped: r.wrapped }, 200, { "set-cookie": tokenCookie(id, r.token) });
    }
    case "pair":
      return json(unwrap(await s.pairStart(token, body)));
    case "agent-token":
      return json(unwrap(await s.agentToken(token)));
    case "pin":
      if (body.version != null && !HASH.test(body.version)) throw new HttpError(400, "bad version");
      return json(unwrap(await s.setPin(token, body.version ?? null)));
    case "signout":
      unwrap(await s.signOut(token));
      return json({ ok: true }, 200, { "set-cookie": clearTokenCookie(id) });
    case "revoke-others":
      return json(unwrap(await s.revokeOthers(token)));
  }
  throw new HttpError(404, "not found");
}

async function createSession(request, env) {
  requireSameOrigin(request);
  const body = await readJson(request);
  if (!APP_NAME.test(body.app || "")) throw new HttpError(400, "bad app");
  const cur = await registry(env).currentSchema(body.app);
  if (!cur) throw new HttpError(404, "unknown app");
  const id = crypto.randomUUID(); // v4
  const enc = cur.schema.encryption;
  const r = unwrap(await session(env, id).create({ ...body, id, app: body.app, enc }));
  await registry(env).registerSession(id, body.app, enc);
  return json({ id, enc }, 201, { "set-cookie": tokenCookie(id, r.token) });
}

async function appsApi(request, env, parts) {
  if (!(await hasKey(request, env.PUBLISH_KEY))) throw new HttpError(401, "publish key required");
  const reg = registry(env);
  const [app, sub, hash] = parts;
  if (!app) return json(await reg.listApps());
  if (!APP_NAME.test(app) || RESERVED_APPS.has(app)) throw new HttpError(400, "bad app name");

  if (sub === "versions" && request.method === "GET") {
    if (!hash) return json(await reg.listVersions(app));
    const v = await reg.getVersion(app, hash);
    if (!v) throw new HttpError(404, "unknown version");
    return json(v);
  }
  if (sub === "versions" && request.method === "POST") {
    const body = await readJson(request);
    return json(unwrap(await reg.publish(app, body.html, { note: body.note, promote: !!body.promote })), 201);
  }
  if (sub === "promote" && request.method === "POST") {
    const body = await readJson(request);
    if (!HASH.test(body.version || "")) throw new HttpError(400, "bad version");
    return json(unwrap(await reg.promote(app, body.version)));
  }
  throw new HttpError(404, "not found");
}

async function adminApi(request, env, parts) {
  if (!(await hasKey(request, env.ADMIN_KEY))) throw new HttpError(401, "admin key required");
  const [kind, id, action] = parts;
  if (kind === "sessions" && request.method === "GET") {
    const app = new URL(request.url).searchParams.get("app");
    return json(await registry(env).listSessions(app && APP_NAME.test(app) ? app : null));
  }
  if (kind === "apps" && request.method === "GET") return json(await registry(env).listApps());
  if (kind === "s" && UUID_V4.test(id || "")) {
    const s = session(env, id);
    if (!action && request.method === "GET") {
      const info = await s.info();
      if (!info) throw new HttpError(404, "unknown session");
      return json(info);
    }
    if (action === "claim" && request.method === "POST") {
      // Fresh owner access for a session whose devices were all lost.
      const r = unwrap(await s.adminClaim());
      const meta = await s.meta();
      const url = `${new URL(request.url).origin}/${meta.app}?id=${id}#claim=${r.code}`;
      return json({ ...r, url });
    }
  }
  throw new HttpError(404, "not found");
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith("/_bantay/")) return env.ASSETS.fetch(request);
  if (path === "/admin" || path === "/admin/") return env.ASSETS.fetch(new Request(new URL("/_bantay/admin.html", url), request));
  if (path === "/") return env.ASSETS.fetch(new Request(new URL("/_bantay/index.html", url), request));
  if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
  if (path === "/mcp") return handleMcp(request, env);

  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api") {
    if (parts[1] === "sessions" && parts.length === 2 && request.method === "POST") return createSession(request, env);
    if (parts[1] === "s" && parts.length === 4) return sessionApi(request, env, parts[2], parts[3]);
    if (parts[1] === "apps") return appsApi(request, env, parts.slice(2));
    if (parts[1] === "admin") return adminApi(request, env, parts.slice(2));
    throw new HttpError(404, "not found");
  }

  if (request.method === "GET" && APP_NAME.test(parts[0] || "") && !RESERVED_APPS.has(parts[0])) {
    if (parts.length === 1) return servePage(env, parts[0], null);
    if (parts.length === 3 && parts[1] === "v" && HASH.test(parts[2])) return servePage(env, parts[0], parts[2]);
  }
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}

export default {
  async fetch(request, env) {
    try {
      const res = await route(request, env);
      return res.status === 101 ? res : secure(res);
    } catch (e) {
      if (e instanceof HttpError) return secure(json({ error: e.message, ...(e.extra || {}) }, e.status));
      console.error(e);
      return secure(json({ error: "server error" }, 500));
    }
  },
};
