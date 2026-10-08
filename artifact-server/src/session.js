// SessionDO: one Durable Object per page UUID.
//
// Holds everything about one session: passcode verifier hashes, issued tokens,
// the (usually encrypted) data, and every open WebSocket. Three data channels
// run side by side:
//
//   state  one JSON document + version counter. Saves name the version they
//          were based on; a stale base is rejected (client merges, retries).
//   log    numbered entries (moves, votes, picks). The first write of number N
//          wins; any other write of N is rejected. Never stored inside Yjs.
//   doc    opaque Yjs updates, relayed and stored. Concurrent edits merge on
//          the clients (the server can't read them when encrypted).
//   aw     ephemeral awareness/presence, relayed only, never stored.
//
// The server never sees passcodes or data keys. Clients send a verifier
// derived (slowly, PBKDF2) from each passcode; we store a salted SHA-256 of it.
// The data key is random, generated in the browser, and stored here only
// wrapped (encrypted) by each passcode-derived key.

import { DurableObject } from "cloudflare:workers";
import { HttpError, parseCookies, randomToken, rpc, safeEqual, sha256hex } from "./util.js";

const ROLES = ["viewer", "owner"];
const WRITERS = new Set(["owner", "agent"]);
const MAX_PAYLOAD = 900_000; // stay under the 1 MiB WebSocket message cap
const MAX_AWARENESS = 16_000;
const PAIR_TTL = 60_000;
const CLAIM_TTL = 24 * 3600_000;
const FREE_ATTEMPTS = 5;
const MAX_LOCKOUT = 3600_000;
const TOUCH_EVERY = 10 * 60_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

function check(cond, msg, status = 400) {
  if (!cond) throw new HttpError(status, msg);
}

function b64field(v, min, max) {
  return typeof v === "string" && v.length >= min && v.length <= max && B64URL.test(v);
}

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, role TEXT NOT NULL, created INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, label TEXT);
      CREATE TABLE IF NOT EXISTS log (n INTEGER PRIMARY KEY, entry TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS doc (seq INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (
        hash TEXT PRIMARY KEY, role TEXT NOT NULL, wrapped TEXT, expires INTEGER NOT NULL);
    `);
    // Keepalive pings never wake the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // --- tiny kv ---------------------------------------------------------------

  get(k, dflt = null) {
    const row = this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0];
    return row ? JSON.parse(row.v) : dflt;
  }

  set(k, v) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }

  exists() {
    return this.get("app") !== null;
  }

  // --- tokens ----------------------------------------------------------------

  async issue(role, label = null) {
    const token = randomToken();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO tokens (hash, role, created, last_seen, label) VALUES (?, ?, ?, ?, ?)",
      await sha256hex(token), role, now, now, label,
    );
    return token;
  }

  /** Token -> { role, hash } or null. */
  async auth(token) {
    if (!token || typeof token !== "string") return null;
    const hash = await sha256hex(token);
    const row = this.sql.exec("SELECT role FROM tokens WHERE hash = ?", hash).toArray()[0];
    if (!row) return null;
    this.sql.exec("UPDATE tokens SET last_seen = ? WHERE hash = ?", Date.now(), hash);
    return { role: row.role, hash };
  }

  async requireRole(token, roles) {
    const who = await this.auth(token);
    check(who, "not signed in", 401);
    check(roles.includes(who.role), "forbidden", 403);
    return who;
  }

  touch() {
    const last = this.get("last_touch", 0);
    if (Date.now() - last < TOUCH_EVERY) return;
    this.set("last_touch", Date.now());
    const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    this.ctx.waitUntil(reg.touchSession(this.get("id")).catch(() => {}));
  }

  // --- lifecycle (RPC) -------------------------------------------------------

  /**
   * First save. `salts`/`verifiers` per role come from the browser's KDF;
   * `wrapped` holds the data key wrapped by each role's passcode key (e2e only).
   * Returns an owner token for the creating device.
   */
  create(p) {
    return rpc(async () => {
      check(!this.exists(), "session exists", 409);
      check(["e2e", "none"].includes(p.enc), "bad enc");
      for (const r of ["view", "owner"]) {
        check(b64field(p.salts?.[r], 16, 64), `bad salt for ${r}`);
        check(b64field(p.verifiers?.[r], 32, 128), `bad verifier for ${r}`);
        if (p.enc === "e2e") check(b64field(p.wrapped?.[r], 40, 200), `bad wrapped key for ${r}`);
      }
      check(p.verifiers.view !== p.verifiers.owner, "view and owner passcodes must differ");
      const serverSalt = randomToken(16);
      this.set("id", p.id);
      this.set("app", p.app);
      this.set("enc", p.enc);
      this.set("created", Date.now());
      this.set("salts", { view: p.salts.view, owner: p.salts.owner });
      this.set("server_salt", serverSalt);
      this.set("vhash", {
        view: await sha256hex(serverSalt + p.verifiers.view),
        owner: await sha256hex(serverSalt + p.verifiers.owner),
      });
      this.set("wrapped", p.enc === "e2e" ? { view: p.wrapped.view, owner: p.wrapped.owner } : null);
      this.set("state_v", 0);
      this.set("state", null);
      this.set("pinned", null);
      this.set("doc_base", 0);
      this.set("doc_snapshot", null);
      return { token: await this.issue("owner", "creator") };
    });
  }

  /** Role for a token cookie, or null. Read-only. */
  async whoami(token) {
    const who = await this.auth(token);
    return who ? { role: who.role } : null;
  }

  /** Public, non-secret facts a Locked visitor needs to try a passcode. */
  meta() {
    if (!this.exists()) return null;
    return { app: this.get("app"), enc: this.get("enc"), salts: this.get("salts"), pinned: this.get("pinned") };
  }

  /**
   * Try a passcode. The client derives a verifier against both roles' salts
   * from one typed passcode; owner wins if both match. One attempt either way.
   */
  unlock({ verifiers, keyOnly = false } = {}, token = null) {
    return rpc(async () => {
      check(this.exists(), "unknown session", 404);
      const now = Date.now();
      const lockedUntil = this.get("locked_until", 0);
      if (now < lockedUntil) throw new HttpError(429, "too many attempts", { retryAfter: Math.ceil((lockedUntil - now) / 1000) });

      const salt = this.get("server_salt");
      const vhash = this.get("vhash");
      let role = null;
      for (const r of ["owner", "viewer"]) {
        const key = r === "owner" ? "owner" : "view";
        const v = verifiers?.[key];
        if (b64field(v, 32, 128) && (await safeEqual(await sha256hex(salt + v), vhash[key]))) {
          role = r;
          break;
        }
      }
      if (!role) {
        const fails = this.get("fails", 0) + 1;
        this.set("fails", fails);
        if (fails >= FREE_ATTEMPTS) {
          this.set("locked_until", now + Math.min(30_000 * 2 ** (fails - FREE_ATTEMPTS), MAX_LOCKOUT));
        }
        throw new HttpError(403, "wrong passcode", { attemptsLeft: Math.max(0, FREE_ATTEMPTS - fails) });
      }
      this.set("fails", 0);
      this.set("locked_until", 0);
      const wrapped = this.get("wrapped");
      const key = wrapped ? wrapped[role === "owner" ? "owner" : "view"] : null;
      // A device that already holds a token (e.g. an admin claim) but lost its
      // data key asks for the key only, keeping its existing token and role.
      const who = keyOnly ? await this.auth(token) : null;
      if (who) return { role: who.role, token: null, wrapped: key };
      return { role, token: await this.issue(role, "passcode"), wrapped: key };
    });
  }

  /**
   * Owner starts a pairing: a single-use code valid ~60s. `wrapped` is the
   * data key wrapped by a secret that travels only in the QR's URL fragment.
   */
  pairStart(token, { role = "owner", wrapped = null } = {}) {
    return rpc(async () => {
      await this.requireRole(token, ["owner"]);
      check(ROLES.includes(role), "bad role");
      if (this.get("enc") === "e2e") check(b64field(wrapped, 40, 200), "wrapped key required");
      this.sql.exec("DELETE FROM codes WHERE expires < ?", Date.now());
      const code = randomToken(16);
      const expires = Date.now() + PAIR_TTL;
      this.sql.exec("INSERT INTO codes (hash, role, wrapped, expires) VALUES (?, ?, ?, ?)", await sha256hex(code), role, wrapped, expires);
      return { code, expires };
    });
  }

  /** Admin recovery: a single-use owner claim code. Carries no data key. */
  adminClaim() {
    return rpc(async () => {
      check(this.exists(), "unknown session", 404);
      const code = randomToken(16);
      const expires = Date.now() + CLAIM_TTL;
      this.sql.exec("INSERT INTO codes (hash, role, wrapped, expires) VALUES (?, ?, NULL, ?)", await sha256hex(code), "owner", expires);
      return { code, expires };
    });
  }

  /** Redeem a pairing/claim code (POST only, after a tap). Single use. */
  redeem(code) {
    return rpc(async () => {
      check(typeof code === "string" && code.length < 100, "bad code");
      const hash = await sha256hex(code);
      const row = this.sql.exec("SELECT role, wrapped, expires FROM codes WHERE hash = ?", hash).toArray()[0];
      this.sql.exec("DELETE FROM codes WHERE hash = ?", hash);
      check(row && row.expires > Date.now(), "code expired or already used", 410);
      return { role: row.role, wrapped: row.wrapped, token: await this.issue(row.role, "paired") };
    });
  }

  /** Token for an LLM over MCP. Plaintext sessions only: e2e keys never leave browsers. */
  agentToken(token) {
    return rpc(async () => {
      await this.requireRole(token, ["owner"]);
      check(this.get("enc") === "none", "agent tokens need an unencrypted (encryption: none) page", 409);
      return { token: await this.issue("agent", "mcp") };
    });
  }

  setPin(token, hash) {
    return rpc(async () => {
      await this.requireRole(token, ["owner"]);
      this.set("pinned", hash || null);
      return { pinned: hash || null };
    });
  }

  signOut(token) {
    return rpc(async () => {
      const who = await this.auth(token);
      if (who) this.sql.exec("DELETE FROM tokens WHERE hash = ?", who.hash);
      for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.th === who?.hash) ws.close(4001, "signed out");
      return { ok: true };
    });
  }

  /** Owner: sign out every other device (and agent). */
  revokeOthers(token) {
    return rpc(async () => {
      const who = await this.requireRole(token, ["owner"]);
      this.sql.exec("DELETE FROM tokens WHERE hash != ?", who.hash);
      for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.th !== who.hash) ws.close(4001, "revoked");
      return { ok: true };
    });
  }

  notifyVersion(hash) {
    if (this.get("pinned")) return;
    this.broadcast({ t: "version", hash });
  }

  info() {
    if (!this.exists()) return null;
    const count = (q) => this.sql.exec(q).toArray()[0].c;
    return {
      id: this.get("id"),
      app: this.get("app"),
      enc: this.get("enc"),
      created: this.get("created"),
      pinned: this.get("pinned"),
      stateVersion: this.get("state_v"),
      logLength: count("SELECT COUNT(*) AS c FROM log"),
      docUpdates: count("SELECT COUNT(*) AS c FROM doc"),
      tokens: this.sql.exec("SELECT role, created, last_seen, label FROM tokens ORDER BY last_seen DESC").toArray(),
      sockets: this.ctx.getWebSockets().length,
      lockedUntil: this.get("locked_until", 0),
    };
  }

  // --- data ops (shared by WebSockets and MCP) -------------------------------

  checkPayload(p) {
    const size = JSON.stringify(p ?? null).length;
    check(size <= MAX_PAYLOAD, "payload too large", 413);
    if (this.get("enc") === "e2e") check(typeof p === "string" && B64URL.test(p), "e2e payload must be ciphertext");
  }

  snapshot() {
    return {
      state: { v: this.get("state_v"), data: this.get("state") },
      log: this.sql.exec("SELECT n, entry FROM log ORDER BY n").toArray().map((r) => ({ n: r.n, entry: JSON.parse(r.entry) })),
      doc: {
        base: this.get("doc_base"),
        snapshot: this.get("doc_snapshot"),
        updates: this.sql.exec("SELECT seq, u FROM doc ORDER BY seq").toArray(),
      },
    };
  }

  /** Optimistic save: wins only if `base` is the current version. */
  opSave(base, data) {
    this.checkPayload(data);
    const v = this.get("state_v");
    if (base !== v) return { ok: false, v, data: this.get("state") };
    this.set("state_v", v + 1);
    this.set("state", data);
    this.touch();
    return { ok: true, v: v + 1 };
  }

  /** First write of number N wins. */
  opAppend(n, entry) {
    this.checkPayload(entry);
    if (this.get("enc") === "none") check(entry && typeof entry.type === "string", "entry needs a type");
    const head = this.sql.exec("SELECT COALESCE(MAX(n), 0) AS h FROM log").toArray()[0].h;
    if (n !== head + 1) return { ok: false, head };
    this.sql.exec("INSERT INTO log (n, entry, at) VALUES (?, ?, ?)", n, JSON.stringify(entry), Date.now());
    this.touch();
    return { ok: true, n };
  }

  // --- MCP (agent tokens, plaintext sessions) --------------------------------

  mcpRead(token) {
    return rpc(async () => {
      await this.requireRole(token, ["agent", "owner", "viewer"]);
      return { id: this.get("id"), app: this.get("app"), enc: this.get("enc"), ...this.snapshot() };
    });
  }

  mcpSave(token, base, data) {
    return rpc(async () => {
      await this.requireRole(token, ["agent", "owner"]);
      const r = this.opSave(base, data);
      if (r.ok) this.broadcast({ t: "state", v: r.v, data });
      return r;
    });
  }

  mcpAppend(token, n, entry) {
    return rpc(async () => {
      await this.requireRole(token, ["agent", "owner"]);
      if (n == null) n = this.sql.exec("SELECT COALESCE(MAX(n), 0) AS h FROM log").toArray()[0].h + 1;
      const r = this.opAppend(n, entry);
      if (r.ok) this.broadcast({ t: "log", n, entry });
      return r;
    });
  }

  // --- WebSockets (hibernating) ----------------------------------------------

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (!this.exists()) return new Response("unknown session", { status: 404 });
    const who = await this.auth(parseCookies(request.headers.get("cookie")).bt);
    if (!who) return new Response("not signed in", { status: 401 });

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [who.role]);
    server.serializeAttachment({ role: who.role, th: who.hash, sid: randomToken(6) });
    server.send(JSON.stringify({
      t: "hello",
      role: who.role,
      app: this.get("app"),
      enc: this.get("enc"),
      pinned: this.get("pinned"),
      appVersion: request.headers.get("x-bantay-version"),
      ...this.snapshot(),
    }));
    this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    let m;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return ws.send(JSON.stringify({ t: "error", error: "bad message" }));
    }
    const reply = (o) => ws.send(JSON.stringify({ rid: m.rid, ...o }));
    try {
      if (m.t === "aw") {
        check(JSON.stringify(m.d ?? null).length <= MAX_AWARENESS, "awareness too large", 413);
        return this.broadcast({ t: "aw", from: att.sid, d: m.d }, ws);
      }
      // Writes re-check the token so revocation takes effect immediately.
      const live = this.sql.exec("SELECT role FROM tokens WHERE hash = ?", att.th).toArray()[0];
      if (!live) return ws.close(4001, "revoked");
      check(WRITERS.has(live.role), "read-only", 403);

      switch (m.t) {
        case "save": {
          const r = this.opSave(m.base, m.data);
          if (!r.ok) return reply({ t: "conflict", v: r.v, data: r.data });
          reply({ t: "saved", v: r.v });
          return this.broadcast({ t: "state", v: r.v, data: m.data }, ws);
        }
        case "append": {
          const r = this.opAppend(m.n, m.entry);
          if (!r.ok) return reply({ t: "rejected", head: r.head });
          reply({ t: "appended", n: r.n });
          return this.broadcast({ t: "log", n: r.n, entry: m.entry }, ws);
        }
        case "doc": {
          this.checkPayload(m.u);
          check(typeof m.u === "string" && B64URL.test(m.u), "doc update must be base64url");
          this.sql.exec("INSERT INTO doc (u) VALUES (?)", m.u);
          const seq = this.sql.exec("SELECT last_insert_rowid() AS s").toArray()[0].s;
          this.touch();
          reply({ t: "doc-ack", seq });
          return this.broadcast({ t: "doc", seq, u: m.u }, ws);
        }
        case "doc-compact": {
          // Client folded updates <= upTo into one (encrypted) snapshot.
          this.checkPayload(m.snapshot);
          check(typeof m.snapshot === "string" && B64URL.test(m.snapshot), "snapshot must be base64url");
          const max = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM doc").toArray()[0].m;
          check(Number.isInteger(m.upTo) && m.upTo > this.get("doc_base") && m.upTo <= max, "bad upTo");
          this.sql.exec("DELETE FROM doc WHERE seq <= ?", m.upTo);
          this.set("doc_base", m.upTo);
          this.set("doc_snapshot", m.snapshot);
          return reply({ t: "compacted", upTo: m.upTo });
        }
        default:
          throw new HttpError(400, "unknown message type");
      }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      reply({ t: "error", error: e instanceof HttpError ? e.message : "server error" });
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, "closing"); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
  }
}
